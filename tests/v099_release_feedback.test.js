import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v099-release-feedback-'));
process.env.NOVEL_NO_OPEN = '1';
process.env.NOVEL_MOCK_LLM = '1';

const store = await import('../server/db/store.js');
const {
  appendPublicationFeedback,
  buildPublicationFeedbackContext,
  parseFanqieBookUrl,
  parseFanqieInitialState,
  publicationDashboard,
  shouldRefreshPublication,
  syncFanqiePublication,
  validateMetricSnapshot,
  validatePublicationProfile,
} = await import('../server/engine/quality/publication_feedback.js');
const {
  assertPublishedRewritePermission,
  baselineRiskForChapter,
  candidateClearlyWins,
  diagnoseRecommendationRecovery,
  executeRecommendationRecovery,
  annotateRecoveryRunsResumability,
  validateRecoveryProseImprovement,
  validateBlindComparison,
  validateRecoveryDiagnosis,
} = await import('../server/engine/recovery/recommendation_recovery.js');
const { hasCompleteCandidateProvenance } = await import('../server/engine/recovery/recovery_contract.js');
const {
  applyValidatedChapterRewrite,
  runPolish,
  splitChapterTextForScenes,
} = await import('../server/engine/quality/polish.js');

let bookA;
let bookB;

/**
 * V0.100.3 段落预算合规候选夹具（句段级）：只改首句段与末句段两个授权槽位，
 * 其余句段逐字保留，再按 5 句一组重组（与各夹具 paragraphs() 的分组一致）。
 * 默认首段内置「主角烧掉退路文书」字面量供引文命中；head/tail 可覆盖槽位文本。
 */
function budgetedCandidate(segs, overrides = {}) {
  const out = segs.slice();
  const tailPrefix = String(out[out.length - 1]).match(/^第\d+段/)?.[0] || '';
 out[0] = overrides.head || '第0段雨幕压下来，主角烧掉退路文书，带人冒雨冲向营门，守门军汉抬枪拦阻。';
 out[out.length - 1] = overrides.tail || `${tailPrefix}主角抹了把脸上的雨水，喝道：“跟我来，退路已经没了。”`;
  const groups = [];
  for (let index = 0; index < out.length; index += 5) groups.push(out.slice(index, index + 5).join(''));
  return groups.join('\n\n');
}

function evidenceProjection(text) {  const evidence = String(text || '').trim().slice(0, 16);
  return {
    summary: '人物采取行动，局势因此发生变化。',
    rolling_update: '人物的行动产生了需要后续承接的结果。',
    outline_actual: {
      goal: '解决眼前问题', conflict: '行动与保留退路不可兼得',
      dramatic_question: '人物是否愿意承担代价？', counterforce: '他人与局势阻止行动',
      turn: '原计划失效', irreversible_change: '行动后无法无成本回到原状',
      choice_cost: '人物选择行动并失去退路', reader_gain: '读者看见行动与后果',
      reader_pull: '行动后果仍待处理', evidence,
      scenes: [{ id: 's1', beat: '人物采取行动并承担后果', evidence }],
    },
    facts: [], character_updates: [], character_notes: [], character_emotional: [],
    timeline: [{ event: '人物采取关键行动', evidence }],
    foreshadow_actions: [], memory_entries: [], new_entities: [],
  };
}

before(() => {
  bookA = store.books.create({ title: '甲书', genre: '历史', platform: '番茄' });
  bookB = store.books.create({ title: '乙书', genre: '悬疑', platform: '番茄' });
});

test('V0.99 番茄作品链接严格白名单，拒绝 SSRF 与路径伪装', () => {
  assert.deepEqual(parseFanqieBookUrl('https://fanqienovel.com/page/7673157174960327705'), {
    url: 'https://fanqienovel.com/page/7673157174960327705',
    bookId: '7673157174960327705',
  });
  for (const bad of [
    'http://fanqienovel.com/page/7673157174960327705',
    'https://evil.fanqienovel.com/page/7673157174960327705',
    'https://fanqienovel.com.evil.example/page/7673157174960327705',
    'https://fanqienovel.com/page/7673157174960327705/extra',
    'https://fanqienovel.com/page/7673157174960327705?next=http://127.0.0.1',
    'https://fanqienovel.com/page/not-a-number',
    'https://127.0.0.1/page/7673157174960327705',
  ]) {
    assert.throws(() => parseFanqieBookUrl(bad), /番茄作品链接/);
  }
});

test('V0.99 从 __INITIAL_STATE__ 解析公开边界，字符串花括号不截断 JSON', () => {
  const state = {
    page: {
      bookId: '7673157174960327705',
 bookName: '示例历史长篇',
      wordNumber: '91414',
      readCount: '1',
      lastPublishTime: '1787532841',
      lastChapterItemId: '7677394769747640857',
      lastChapterTitle: '第22章 夺册 {并非 JSON 结束}',
      chapterListWithVolume: [
        {
          volumeName: '第一卷',
          chapterList: [
            { itemId: '1001', title: '第1章 庙会灯影' },
            { itemId: '1002', title: '第2章 军报' },
          ],
        },
        {
          volumeName: '第三卷',
          chapterList: Array.from({ length: 20 }, (_, index) => ({
            itemId: String(2000 + index),
            title: `第${index + 3}章 测试`,
          })),
        },
      ],
    },
  };
  const html = `<html><script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script><script>{broken}</script></html>`;
  const parsed = parseFanqieInitialState(html, '7673157174960327705');
  assert.equal(parsed.externalBookId, '7673157174960327705');
 assert.equal(parsed.bookTitle, '示例历史长篇');
  assert.equal(parsed.publishedWordCount, 91414);
  assert.equal(parsed.readerCount, 1);
  assert.equal(parsed.publishedChapterCount, 22);
  assert.equal(parsed.latestChapterTitle, '第22章 夺册 {并非 JSON 结束}');
  assert.equal(parsed.latestChapterItemId, '7677394769747640857');
  assert.equal(parsed.lastPublishTime, 1787532841000, '秒级时间戳归一化为毫秒');
  assert.equal(parsed.chapters.at(-1).index, 22);

  const sparseState = structuredClone(state);
  delete sparseState.page.wordNumber;
  delete sparseState.page.readCount;
  const sparse = parseFanqieInitialState(
    `<script>window.__INITIAL_STATE__=${JSON.stringify(sparseState)};</script>`,
    '7673157174960327705',
  );
  assert.equal(sparse.publishedWordCount, null, '页面缺字段时不能伪造 0 字');
  assert.equal(sparse.readerCount, null, '页面缺字段时不能伪造 0 读者');
});

test('V0.99 公开页结构漂移、书籍 ID 不符、缺少章节时显式失败', () => {
  assert.throws(() => parseFanqieInitialState('<html></html>'), /页面结构已变化/);
  const wrong = `<script>window.__INITIAL_STATE__=${JSON.stringify({ page: {
    bookId: '999', bookName: '别的书', chapterListWithVolume: [{ chapterList: [{ itemId: '1', title: '第1章' }] }],
  } })};</script>`;
  assert.throws(() => parseFanqieInitialState(wrong, '7673157174960327705'), /作品 ID 不一致/);
  const missing = `<script>window.__INITIAL_STATE__=${JSON.stringify({ page: {
    bookId: '7673157174960327705', bookName: '空书', chapterListWithVolume: [],
  } })};</script>`;
  assert.throws(() => parseFanqieInitialState(missing, '7673157174960327705'), /公开章节列表/);
});

test('V0.99 公开页暂缺可选数据时保留上次成功值，不把未知写成 0 或清空快照', async () => {
  const book = store.books.create({ title: '保留公开快照', genre: '历史', platform: '番茄' });
  const workUrl = 'https://fanqienovel.com/page/123456789';
  store.publicationProfiles.upsert(book.id, {
    workUrl, publishedWordCount: 88888, publicReaderCount: 7, lastPublishTime: 1787000000000,
  });
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ page: {
    bookId: '123456789', bookName: book.title,
    chapterListWithVolume: [{ chapterList: [{ itemId: 'c1', title: '第1章' }] }],
  } })};</script>`;
  const result = await syncFanqiePublication(book.id, {
    fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(result.snapshot.publishedWordCount, null);
  assert.equal(result.snapshot.readerCount, null);
  assert.equal(result.profile.published_word_count, 88888);
  assert.equal(result.profile.public_reader_count, 7);
  assert.equal(result.profile.last_publish_time, 1787000000000);
});

test('V0.99 发布档案、审核历史、指标和返工运行按作品隔离并级联清理', () => {
  const profile = store.publicationProfiles.upsert(bookA.id, {
    platform: 'fanqie',
    workUrl: 'https://fanqienovel.com/page/7673157174960327705',
    externalBookId: '7673157174960327705',
    recommendationStage: 'failed',
    remainingAttempts: 2,
    editorFeedback: '当前内容未达推荐标准',
    authorDiagnosis: '前五六章或勉强可读，之后越来越水',
    suspectedTurnChapter: 7,
  });
  assert.equal(profile.recommendation_stage, 'failed');
  assert.equal(profile.remaining_attempts, 2);
  assert.deepEqual(profile.pending_sync_chapters, []);

  store.publicationProfiles.upsert(bookB.id, { recommendationStage: 'not_applied' });
  const review = store.recommendationReviews.add(bookA.id, {
    stage: 'failed', remainingAttempts: 2, feedback: '前20章不合格', source: 'platform_notice',
  });
  const metric = store.publicationMetrics.add(bookA.id, {
    exposureStatus: 'not_exposed', readers: 0, impressions: 0, bookshelfAdds: 0,
    readThroughRate: null, followRate: null, note: '推流前零读者正常', observedAt: 1787532841000,
  });
  const run = store.recommendationRecoveryRuns.create(bookA.id, {
    startChapter: 1, endChapter: 20, status: 'diagnosing', confirmedPublishedRewrite: true,
  });
  store.recommendationRecoveryRuns.update(run.id, {
    status: 'planned', qualityCurve: [{ chapter: 7, risk: 'high' }],
    workOrders: [{ chapter: 7, action: 'rebuild' }], snapshotId: 'snap-test',
  });

  assert.equal(review.book_id, bookA.id);
  assert.equal(metric.exposure_status, 'not_exposed');
  assert.equal(store.recommendationReviews.list(bookB.id).length, 0);
  assert.equal(store.publicationMetrics.list(bookB.id).length, 0);
  assert.equal(store.recommendationRecoveryRuns.list(bookB.id).length, 0);
  assert.deepEqual(store.recommendationRecoveryRuns.get(run.id).quality_curve, [{ chapter: 7, risk: 'high' }]);

  store.books.remove(bookA.id);
  assert.equal(store.publicationProfiles.get(bookA.id), undefined);
  assert.equal(store.recommendationReviews.list(bookA.id).length, 0);
  assert.equal(store.publicationMetrics.list(bookA.id).length, 0);
  assert.equal(store.recommendationRecoveryRuns.list(bookA.id).length, 0);
  assert.ok(store.books.get(bookB.id), '删除甲书不能影响乙书');
});

test('V0.99 推荐状态、剩余机会与作品数据采用 fail-closed 校验', () => {
  assert.equal(validatePublicationProfile({ recommendationStage: 'failed', remainingAttempts: 2 }).remainingAttempts, 2);
  assert.throws(() => validatePublicationProfile({ recommendationStage: 'mystery', remainingAttempts: 2 }), /推荐阶段/);
  assert.throws(() => validatePublicationProfile({ recommendationStage: 'failed', remainingAttempts: 4 }), /剩余申请次数/);
  assert.throws(() => validatePublicationProfile({ recommendationStage: 'failed', remainingAttempts: -1 }), /剩余申请次数/);
  assert.throws(() => validatePublicationProfile({
    recommendationStage: 'failed', editorFeedback: '坏'.repeat(4001),
  }), /编辑反馈.*过长/);

  assert.equal(validateMetricSnapshot({ exposureStatus: 'not_exposed', readers: 0 }).readers, 0);
  assert.throws(() => validateMetricSnapshot({ exposureStatus: 'validation', readers: -1 }), /读者数/);
  assert.throws(() => validateMetricSnapshot({ exposureStatus: 'validation', readThroughRate: 101 }), /读完率/);
  assert.throws(() => validateMetricSnapshot({ exposureStatus: 'unknown', readers: 0 }), /曝光状态/);
  assert.throws(() => validateMetricSnapshot({ exposureStatus: 'not_exposed', note: '长'.repeat(2001) }), /备注.*过长/);
});

test('V0.99 动态反馈将审核失败解释为质量事故，不拿零读者或楔子替正文背锅', () => {
  const book = store.books.create({ title: '反馈上下文测试', genre: '历史', platform: '番茄' });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', remainingAttempts: 2,
    editorFeedback: '编辑认为前20章整体不合格，不予推流',
    authorDiagnosis: '签约曾通过，前1—6章或勉强可用；第7—20章越来越水',
    suspectedTurnChapter: 7,
    publishedChapterCount: 22,
    publishedWordCount: 91414,
    publicReaderCount: 1,
    pendingSyncChapters: [8, 9],
  });
  store.publicationMetrics.add(book.id, {
    exposureStatus: 'not_exposed', readers: 0, impressions: 0, note: '推荐验证前',
  });

  const context = buildPublicationFeedbackContext(book.id, { targetChapterIdx: 23 });
  assert.match(context, /P0 内容质量事故/);
  assert.match(context, /第 1—6 章.*疑似基线.*仍需证据验证/s);
  assert.match(context, /第 7—22 章.*高风险/s);
  assert.match(context, /楔子.*不能.*抵消/s);
  assert.match(context, /未获曝光.*0.*中性/s);
  assert.match(context, /页面公开读者字段：1.*不替代作者后台/s);
  assert.match(context, /待线上同步.*第8章、第9章/s);
  assert.match(context, /禁止虚构.*阈值.*概率/s);
  assert.match(context, /当前规划第 23 章/);

  const laterTurnBook = store.books.create({ title: '动态拐点范围测试', genre: '历史', platform: '番茄' });
  store.publicationProfiles.upsert(laterTurnBook.id, {
    recommendationStage: 'failed', remainingAttempts: 1,
    suspectedTurnChapter: 12, publishedChapterCount: 34,
  });
  const laterContext = buildPublicationFeedbackContext(laterTurnBook.id, { targetChapterIdx: 35 });
  assert.match(laterContext, /第 1—11 章.*疑似基线/s);
  assert.match(laterContext, /第 12—34 章.*高风险/s);
  assert.doesNotMatch(laterContext, /第 1—6 章|第 7—20 章/, '风险范围不能无视作者填写的拐点和当前发布边界');

  const unknownBook = store.books.create({ title: '未知数据测试', genre: '历史', platform: '番茄' });
  store.publicationProfiles.upsert(unknownBook.id, { recommendationStage: 'failed', remainingAttempts: 2 });
  store.publicationMetrics.add(unknownBook.id, { exposureStatus: 'not_exposed', note: '尚未填写读者数' });
  const unknownContext = buildPublicationFeedbackContext(unknownBook.id);
  assert.match(unknownContext, /读者数未填.*中性/s);
  assert.doesNotMatch(unknownContext, /读者数\s*0/, '未填写不能被动态反馈伪造成 0 读者');
});

test('V0.99 质量拐点只是审查先验，诊断仍须逐章给出可定位证据', () => {
  assert.equal(baselineRiskForChapter(3, 7).prior, 'suspected_baseline');
  assert.equal(baselineRiskForChapter(7, 7).prior, 'high_risk');
  const chapters = [
 { idx: 5, title: '旧约', text: '主角把最后一碗粥递给阿弟，自己走向营门。守门军汉抬枪拦住他。' },
    { idx: 8, title: '空转', text: '众人围着火盆反复商量，天色从黄昏拖到深夜，最终还是没有人作出决定。' },
  ];
  const valid = validateRecoveryDiagnosis({
    quality_curve: [
      {
        chapter: 5, score: 72, action: 'keep',
 evidence: ['主角把最后一碗粥递给阿弟'], effective_events: ['主角让出食物并主动去营门'],
        irreversible_change: '主角离开相对安全的落脚处', character_cost: '失去食物与安全',
        promise_delivery: '人物责任感得到一次行动兑现', filler_signals: [], ending_pull: '守门人为何拦他',
        reason: '行动和代价同场成立', rebuild_objective: '',
      },
      {
        chapter: 8, score: 28, action: 'rebuild',
        evidence: ['最终还是没有人作出决定'], effective_events: [], irreversible_change: '', character_cost: '',
        promise_delivery: '', filler_signals: ['同一议题反复商量但局势不变'], ending_pull: '',
        reason: '整章没有产生可见变化', rebuild_objective: '让主角在争执中作出有代价的决定，并让结果改变下一章局势',
      },
    ],
    segment_verdict: { deterioration_found: true, turn_chapter: 7, reason: '第7章后有效事件与章末追读力持续下降' },
  }, chapters);
  assert.equal(valid.quality_curve[0].prior, 'suspected_baseline');
  assert.equal(valid.quality_curve[1].prior, 'high_risk');
  assert.throws(() => validateRecoveryDiagnosis({
    quality_curve: [{ ...valid.quality_curve[1], evidence: ['原文里不存在的证据'] }],
    segment_verdict: valid.segment_verdict,
  }, [chapters[1]]), /无法在原文定位/);
  assert.throws(() => validateRecoveryDiagnosis({ quality_curve: [], segment_verdict: {} }, chapters), /逐章覆盖/);
});

test('V0.100.1 诊断证据：引号风格差异不误杀，短引文精确命中豁免，幻觉仍判废', () => {
 // 实测 ch16 实证：正文用全角单引号，模型引文用全角双引号，内容逐字一致
  const quoteStyleChapters = [
    { idx: 16, title: '报信', text: '雨下了一夜。他蹲下身看了看，该报的是‘此处石缝有湿痕，草叶倒伏’。众人点头。' },
  ];
  const buildRow = (chapter, evidence) => ({
    chapter, score: 40, action: 'tune',
    evidence, effective_events: ['主角查看痕迹并报信'],
    irreversible_change: '痕迹已上报', character_cost: '', promise_delivery: '',
    filler_signals: [], ending_pull: '', reason: '有行动但张力不足',
    rebuild_objective: '强化痕迹带来的紧迫感',
  });
  const verdict = { deterioration_found: false, turn_chapter: null, reason: '未见系统性下坠' };
  const relocated = validateRecoveryDiagnosis({
    quality_curve: [buildRow(16, ['该报的是“此处石缝有湿痕，草叶倒伏”'])],
    segment_verdict: verdict,
  }, quoteStyleChapters);
  assert.match(relocated.quality_curve[0].evidence[0], /该报的是‘此处石缝有湿痕，草叶倒伏’/, '重定位后引文以正文原句为准');

 // 实测 ch18 实证：正文独立成段的三字短句，模型带引号引用时不应被 4 字下限误杀
  const shortQuoteChapters = [
    { idx: 18, title: '山口', text: '风从谷口灌进来。老人望着远处的官道，只说了三个字。路会变。众人沉默。' },
  ];
  const shortOk = validateRecoveryDiagnosis({
    quality_curve: [buildRow(18, ['“路会变”'])],
    segment_verdict: verdict,
  }, shortQuoteChapters);
  assert.equal(shortOk.quality_curve[0].evidence[0], '路会变');

  // 防回归：内容不一致的幻觉引文依旧判废
  assert.throws(() => validateRecoveryDiagnosis({
    quality_curve: [buildRow(16, ['此处石缝有积水，草叶挺拔'])],
    segment_verdict: verdict,
  }, quoteStyleChapters), /无法在原文定位/);
  assert.throws(() => validateRecoveryDiagnosis({
    quality_curve: [buildRow(18, ['“路会断”'])],
    segment_verdict: verdict,
  }, shortQuoteChapters), /无法在原文定位/);
});

test('V0.99 双向盲审必须双方有原文证据，且换位后仍明确选择新稿', () => {
  const oldText = '旧稿里众人商量到深夜，事情没有发生变化。';
 const newText = '新稿里主角烧掉退路文书，带着十个人冲出营门。';
  const first = validateBlindComparison({
    winner: 'B', margin: 18,
    scores: { A: { progression: 25, consequence: 20, character: 35, pull: 20 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } },
    evidence: { A: ['事情没有发生变化'], B: ['烧掉退路文书'] },
    reason: 'B 发生不可逆行动并改变下一章局势',
  }, { candidateA: oldText, candidateB: newText });
  const second = validateBlindComparison({
    winner: 'A', margin: 16,
    scores: { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 25, consequence: 20, character: 35, pull: 20 } },
    evidence: { A: ['冲出营门'], B: ['商量到深夜'] },
    reason: 'A 明显更有推进与代价',
  }, { candidateA: newText, candidateB: oldText });
  assert.equal(first.winner, 'B');
  assert.equal(second.winner, 'A');
  assert.throws(() => validateBlindComparison({
    winner: 'B', margin: 20, scores: first.scores,
    evidence: { A: ['不存在'], B: ['烧掉退路文书'] }, reason: '无效证据',
  }, { candidateA: oldText, candidateB: newText }), /A.*无法在正文定位/);

  const merelyLessBadFirst = {
    ...first,
    margin: 10,
    scores: { A: { progression: 10, consequence: 8, character: 20, pull: 9 }, B: { progression: 28, consequence: 24, character: 34, pull: 26 } },
  };
  const merelyLessBadSecond = {
    ...second,
    margin: 9,
    scores: { A: { progression: 28, consequence: 24, character: 34, pull: 26 }, B: { progression: 10, consequence: 8, character: 20, pull: 9 } },
  };
  assert.equal(candidateClearlyWins(merelyLessBadFirst, merelyLessBadSecond), false,
    '新稿即使相对胜出，绝对质量仍低时也不能落盘');
});

test('V0.100.1 盲审证据：短引文精确命中与引号风格差异不误杀，幻觉仍判废', () => {
 // 实测 ch8 实证：模型证据「“是七。”」被旧的 <4 字闸判废，两轮盲审全死在这条上。
  const text = '城外烽烟又起。斥候跪地回报，只说了两个字：是七。众人面面相觑，该报的是‘此处石缝有湿痕’。';
  const dims = { progression: 70, consequence: 68, character: 72, pull: 66 };
  const ok = validateBlindComparison({
    winner: 'tie', margin: 4,
    scores: { A: dims, B: dims },
    evidence: { A: ['“是七。”'], B: ['该报的是“此处石缝有湿痕”'] },
    reason: '两稿证据均可逐字定位',
  }, { candidateA: text, candidateB: text });
  assert.equal(ok.winner, 'tie');
  assert.throws(() => validateBlindComparison({
    winner: 'tie', margin: 4, scores: { A: dims, B: dims },
    evidence: { A: ['“是八。”'], B: ['该报的是“此处石缝有湿痕”'] }, reason: '幻觉证据',
  }, { candidateA: text, candidateB: text }), /无法在正文定位/);
});

test.skip('V0.100.1 候选篇幅不达标先退回模型重答一次，第二次仍短才拒收', async () => {
  const book = store.books.create({ title: '篇幅重答测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const oldText = paragraphs(Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`), 5);
  const fullText = paragraphs([
 ...Array.from({ length: 21 }, (_, index) => `第${index}段主角烧掉退路文书，带人冒雨冲向营门，守门军汉抬枪拦阻。`),
 '主角抹了把脸上的雨水，喝道：“跟我来，退路已经没了。”',
  ], 5);
 const shortText = '主角烧掉文书冲向营门。';
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '让主角行动并付出代价', evidence: ['雨声一阵紧过一阵'] }],
  });
  const rewritePrompts = [];
  let compareRound = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      rewritePrompts.push(prompt);
      return { content: rewritePrompts.length === 1 ? shortText : fullText, finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工匿名对照审稿')) {
      compareRound++;
      const first = compareRound === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 16,
        scores: first
          ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
          : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
        evidence: first
          ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
          : { A: ['冲向营门'], B: ['走过芦苇荡'] },
        reason: '候选有不可逆行动与代价',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl, projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(rewritePrompts.length, 2, '首次缩水必须退回模型重答一次');
  assert.match(rewritePrompts[0], /篇幅底线：旧稿约 \d+ 字；成稿不得低于 \d+ 字/, '重写指令必须给出量化篇幅底线');
  assert.match(rewritePrompts[1], /上轮输出被本地校验拒绝.*低于安全下限/s, '重答必须带本地拒绝原因');
  assert.equal(result.applied.length, 1, '重答达标后候选应正常进入盲审并落盘');
});

test.skip('V0.100.1 文风闸命中带具体命中项分层退回重答，第三轮干净后通过', async () => {
  const book = store.books.create({ title: '文风重答测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const oldText = paragraphs(Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`), 5);
  // V0.100.3 段落预算：tune 章授权槽位=P1（证据首击所在段）与 P4（章末段）。
  // 必须按 paragraphs() 的分组语义整组替换，保持其余段落逐字一致。
  const patchCandidate = (headGroup, tailGroup) => {
 const segs = Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
    if (headGroup) segs.splice(0, 1, headGroup);
    if (tailGroup) segs.splice(19, 1, tailGroup);
    return paragraphs(segs, 5);
  };
  const cleanText = patchCandidate(
 '第0段雨幕压下来，主角烧掉退路文书，带人冒雨冲向营门，守门军汉抬枪拦阻。',
 '第19段主角抹了把脸上的雨水，喝道：“跟我来，退路已经没了。”',
  );
  // 3 处「微微」触发确定性文风闸（每章 ≤2 次红线），且全部落在授权段落内——
  // 其余三段保持旧稿原文（改动预算通过），失败维度只有文风一处。
  const noisyText = patchCandidate(
 '第0段雨幕压下来，主角微微一笑，又微微敛容——随即烧掉退路文书，带人冒雨冲向营门。',
 '第19段守门军汉还没合围，众人只微微一滞，主角已抹了把脸上的雨水。',
  );
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动并付出代价', evidence: ['雨声一阵紧过一阵'] }],
  });
  const rewritePrompts = [];
  let compareRound = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      rewritePrompts.push(prompt);
      return { content: rewritePrompts.length >= 3 ? cleanText : noisyText, finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工匿名对照审稿')) {
      compareRound++;
      const first = compareRound === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 16,
        scores: first
          ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
          : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
        evidence: first
          ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
          : { A: ['冲向营门'], B: ['走过芦苇荡'] },
        reason: '候选有不可逆行动与代价',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl, projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(rewritePrompts.length, 3, '文风闸命中必须退回重答：1 次初稿 + 2 次定向重答');
  assert.match(rewritePrompts[1], /确定性文风闸未通过/, '第一次重答必须带文风闸反馈');
  assert.match(rewritePrompts[1], /微微/, '反馈必须列出具体命中词，模型才知道改哪里');
  assert.match(rewritePrompts[1], /同量级的全文（旧稿约 \d+ 字）/, '重答必须回显完整章节篇幅量级，防缩水成概括');
  assert.doesNotMatch(rewritePrompts[1], /最后一次重答机会/, '第一轮反馈不提前升级');
  assert.match(rewritePrompts[2], /最后一次重答机会.*硬性禁用清单/s, '第二轮反馈必须升级为硬性禁用清单');
  assert.match(rewritePrompts[1], /上一版候选全文.*实际修订底稿/s, '重答必须把刚被拒候选作为真实底稿，不能对着旧稿重抽');
  assert.match(rewritePrompts[1], /其他场景保持事件、顺序和人物选择不变/, '第一次文风纠错仍须守住场景与事实边界');
  assert.match(rewritePrompts[2], /其他场景的事件、顺序、人物选择和篇幅不得删减或换线/, '升级反馈同样守住叙事边界，但不再要求逐字段落锁死');
  assert.doesNotMatch(rewritePrompts[2], /未命中段落逐字原样保留/, '逐字锁死会让真正的文风重写无法收敛');
  assert.equal(result.applied.length, 1, '第三轮干净候选应正常进入盲审并落盘');
});

test.skip('V0.100.1 文风闸重答耗尽才拒收：最多 3 次生成，旧稿逐字保留', async () => {
  const book = store.books.create({ title: '文风耗尽测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const oldText = paragraphs(Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`), 5);
  // 命中收敛在授权槽位段内（P1 与 P4 整组替换），其余两段逐字保留——只有文风闸这一层在拦截。
  const noisyText = (() => {
 const segs = Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
 segs[0] = '第0段雨幕压下来，主角微微一笑，又微微敛容——随即烧掉退路文书，带人冒雨冲向营门。';
 segs[19] = '第19段守门军汉还没合围，众人只微微一滞，主角已抹了把脸上的雨水。';
    return paragraphs(segs, 5);
  })();
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动并付出代价', evidence: ['雨声一阵紧过一阵'] }],
  });
  let rewriteCalls = 0;
  let compareCalls = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      rewriteCalls++;
      return { content: noisyText, finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工匿名对照审稿')) { compareCalls++; }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl, projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(rewriteCalls, 3, '重答最多 2 次，第 3 次仍带命中立即拒收，不无界烧费');
  assert.equal(compareCalls, 0, '文风闸不过的候选不得进入盲审');
  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected[0]?.code, 'RECOVERY_PROSE_GATE_FAILED');
  assert.match(store.chapters.fullText(chapter.id), /雨声一阵紧过一阵/, '拒收后旧稿逐字保留');
});

test.skip('V0.100.2 盲审近 miss 进入决胜轮：第三轮明确胜出则接受，旧稿胜出轮不补救', async () => {
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  // beforeChars 控制在 500 以下跳过锚点覆盖率检查；每例独立成书，避免邻章串章判废干扰
 const baseSegs = Array.from({ length: 17 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
  const oldText = paragraphs(baseSegs, 5);
  const newText = budgetedCandidate(baseSegs);
  const dimsGood = { progression: 70, consequence: 68, character: 72, pull: 66 };
  const dimsWeak = { progression: 40, consequence: 35, character: 45, pull: 40 };
  const evidenceFor = round => (round % 2 === 1
    ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
    : { A: ['烧掉退路文书'], B: ['雨声一阵紧过一阵'] });
  const proj = async ({ text }) => evidenceProjection(text);

  const runCase = async (title, plan) => {
    const book = store.books.create({ title, genre: '历史', platform: '番茄' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
    store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
    store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
    let compareCalls = 0;
    const roundsSeen = new Set();
    const runTaskImpl = async ({ messages, jsonMode }) => {
      const prompt = messages.at(-1)?.content || '';
      if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: newText, finishReason: 'stop' };
      if (prompt.includes('匿名对照审稿')) {
        const round = Number(prompt.match(/第(\d+)轮/)?.[1]);
        compareCalls++;
        roundsSeen.add(round);
        const cell = plan[round - 1];
        return { content: JSON.stringify({
          winner: cell.winner, margin: cell.margin,
          scores: {
            A: cell.winner === 'A' || cell.winner === 'tie' ? dimsGood : dimsWeak,
            B: cell.winner === 'B' || cell.winner === 'tie' ? dimsGood : dimsWeak,
          },
          evidence: evidenceFor(round),
          reason: `第${round}轮判定`,
        }), finishReason: 'stop' };
      }
      if (prompt.includes('推荐返工整段复核')) {
        return { content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
        }), finishReason: 'stop' };
      }
      throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
    };
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'planned',
      workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
    });
    const result = await executeRecommendationRecovery(book.id, run.id, { runTaskImpl, projectionImpl: proj });
    return { result, compareCalls, roundsSeen, chapter };
  };

  // 情形一：两轮近 miss（B/4、A/3）+ 决胜轮明确胜出（B/8）→ 接受落盘
  const acceptedCase = await runCase('决胜轮接受', [{ winner: 'B', margin: 4 }, { winner: 'A', margin: 3 }, { winner: 'B', margin: 8 }]);
  assert.deepEqual(acceptedCase.result.applied.map(item => item.chapter), [1], '决胜轮明确胜出的候选必须被接受');
  assert.equal(acceptedCase.compareCalls, 3, '近 miss 必须触发第 3 轮决胜');

  // 情形二：近 miss + 决胜轮分差仍不足（B/3）→ 打回重生 + 补救二扫均同样结果 → 拒收，旧稿保留
  const rejectedCase = await runCase('决胜轮拒绝', [{ winner: 'B', margin: 4 }, { winner: 'A', margin: 3 }, { winner: 'B', margin: 3 }]);
  assert.equal(rejectedCase.result.applied.length, 0);
  assert.equal(rejectedCase.result.rejected[0]?.code, 'RECOVERY_NO_CLEAR_IMPROVEMENT');
  assert.match(rejectedCase.result.rejected[0]?.reason, /补救二扫仍不过关/, '拒绝原因必须标明二扫仍败');
  assert.match(rejectedCase.result.rejected[0]?.reason, /决胜轮 B\/3/, '拒绝原因必须包含决胜轮结果');
  assert.equal(rejectedCase.compareCalls, 9, '首扫+重生+二扫各一次生成，每次 = 两轮换位 + 一次决胜轮');
  assert.match(store.chapters.fullText(rejectedCase.chapter.id), /雨声一阵紧过一阵/, '拒收后旧稿逐字保留');

  // 情形三：第二轮旧稿胜出（换位后 B=旧稿）→ 不触发决胜轮；打回重生与二扫仍同结果才最终拒收
  const noSalvageCase = await runCase('决胜轮不补救', [{ winner: 'tie', margin: 0 }, { winner: 'B', margin: 3 }]);
  assert.equal(noSalvageCase.result.applied.length, 0);
  assert.equal(noSalvageCase.compareCalls, 6, '三次生成各两轮换位盲审（首扫+重生+二扫）');
  assert.equal(noSalvageCase.roundsSeen.has(3), false, '旧稿胜出的轮次是真实信号，任何一次生成都不得触发决胜轮');
});

test.skip('V0.100.2 盲审未明确胜出带评审意见打回重写一次，第二次过审则落盘', async () => {
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const baseSegs = Array.from({ length: 17 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
  const oldText = paragraphs(baseSegs, 5);
  const newText = budgetedCandidate(baseSegs);
  const dimsGood = { progression: 78, consequence: 74, character: 76, pull: 72 };
  const dimsWeak = { progression: 40, consequence: 35, character: 45, pull: 40 };
  const proj = async ({ text }) => evidenceProjection(text);

  const runCase = async (title, regenPasses) => {
    const book = store.books.create({ title, genre: '历史', platform: '番茄' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
    store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
    store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
    const rewritePrompts = [];
    let compareRound = 0;
    const regenEvents = [];
    const runTaskImpl = async ({ messages, jsonMode }) => {
      const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
        rewritePrompts.push(prompt);
        return { content: newText, finishReason: 'stop' };
      }
      if (prompt.includes('匿名对照审稿')) {
        compareRound++;
        // 第一轮生成：两轮都是旧稿胜出（第1轮 A=旧，第2轮 B=旧）；重生后轮次候选明确胜出
        const regened = rewritePrompts.length >= 2;
        const good = regenPasses ? regened : false;
        const winner = good ? (compareRound % 2 === 1 ? 'B' : 'A') : (compareRound % 2 === 1 ? 'A' : 'B');
        return { content: JSON.stringify({
          winner, margin: good ? 8 : 6,
          scores: {
            A: (winner === 'A' ? dimsGood : dimsWeak),
            B: (winner === 'B' ? dimsGood : dimsWeak),
          },
          evidence: compareRound % 2 === 1
            ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
            : { A: ['烧掉退路文书'], B: ['雨声一阵紧过一阵'] },
          reason: good ? '新稿推进果断，代价落地' : '新稿只是换了说法，局势没有实质推进',
        }), finishReason: 'stop' };
      }
      if (prompt.includes('推荐返工整段复核')) {
        return { content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
        }), finishReason: 'stop' };
      }
      throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
    };
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'planned',
      workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
    });
    const result = await executeRecommendationRecovery(book.id, run.id, {
      runTaskImpl, projectionImpl: proj,
      onEvent: event => { if (event.type === 'recovery_regenerate') regenEvents.push(event); },
    });
    return { result, rewritePrompts, regenEvents, chapter };
  };

  // 打回后第二次过审：落盘 + 重生指令带评审意见 + 事件可见
  const won = await runCase('打回重生接受', true);
  assert.deepEqual(won.result.applied.map(item => item.chapter), [1], '打回重写后过审的候选必须落盘');
  assert.equal(won.rewritePrompts.length, 2, '盲审未明确胜出必须打回重写一次');
  assert.match(won.rewritePrompts[1], /上轮候选经匿名双审未证明明显优于旧稿/, '重生指令必须带评审结论');
  assert.match(won.rewritePrompts[1], /局势没有实质推进/, '重生指令必须带评审具体意见');
  assert.match(won.rewritePrompts[1], /上一版候选全文/, '重生反馈必须附上一版候选正文，否则模型只能对着旧稿另写一章');
  assert.match(won.rewritePrompts[1], /分差显示新稿最弱的是：后果代价（-\d+ 分）、情节推进（-\d+ 分）/, '败因靶子必须来自真实评审分差，且按最弱排序');
  assert.match(won.rewritePrompts[1], /允许重写导致败选的完整场景/, '败选后必须能重做真正失分的场景，而不是只换几个词');
  assert.match(won.rewritePrompts[1], /已成立的剧情走向、人物身份、时间地点、相邻章接口/, '放开场景重写时仍须锁住事实与接口边界');
  assert.doesNotMatch(won.rewritePrompts[1], /其余段落逐字保留|定点修补/, '不得复活已被实证为无效的逐字段落预算');
  assert.equal(won.regenEvents.length, 1, '打回重生必须对前端可见');

  // 打回后第二次仍未胜出：补救二扫再试一次仍败才拒收，旧稿保留，原因标明
  const lost = await runCase('打回重生仍拒', false);
  assert.equal(lost.result.applied.length, 0);
  assert.match(lost.result.rejected[0]?.reason, /补救二扫仍不过关/, '拒绝原因必须标明二扫仍败');
  assert.equal(lost.rewritePrompts.length, 3, '首扫+打回重生+补救二扫共 3 次生成，不无界烧费');
  assert.match(store.chapters.fullText(lost.chapter.id), /雨声一阵紧过一阵/, '旧稿逐字保留');
});

test('V0.100.3 连败冻结止损：同工单同旧稿连续被拒的章默认跳过，全部重新诊断可解冻', async () => {
  const book = store.books.create({ title: '连败冻结测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const baseSegs = Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
  const oldText = paragraphs(baseSegs, 5);
  const cleanText = budgetedCandidate(baseSegs);
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const freezeOrder = {
    chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'],
  };

  // 两轮完整执行都拒绝同一章（同工单 + 同一份旧稿）→ 连败旧账成立
  const rejectedAudit = {
    chapter: 1, before: oldText, after: '另一版候选正文', order: freezeOrder,
    status: 'rejected', rejection: { chapter: 1, code: 'RECOVERY_NO_CLEAR_IMPROVEMENT', reason: '盲审未胜出' },
    comparisons: [],
  };
  for (const label of ['连败旧账一', '连败旧账二']) {
    const prior = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'failed',
      workOrders: [freezeOrder],
    });
    store.recommendationRecoveryRuns.update(prior.id, { result: { candidates: [{ ...rejectedAudit, before: oldText }], note: label } });
  }

  // 第三次执行默认冻结跳过：零生成、零盲审、旧稿原样保留，事件与原因对前端可见
  let generateCalled = false;
  const frozenEvents = [];
  const frozenRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [freezeOrder],
  });
  const frozenResult = await executeRecommendationRecovery(book.id, frozenRun.id, {
    reusePriorCandidates: true,
    runTaskImpl: async () => { generateCalled = true; throw new Error('冻结章不得再消耗模型调用'); },
    projectionImpl: async ({ text }) => evidenceProjection(text),
    onEvent: event => { if (event.type === 'recovery_chapter_frozen') frozenEvents.push(event); },
  });
  assert.equal(generateCalled, false, '冻结章必须零模型调用');
  assert.equal(frozenEvents.length, 1, '冻结必须对前端可见');
  assert.equal(frozenResult.applied?.length || 0, 0);
  assert.equal(frozenResult.rejected?.[0]?.code, 'RECOVERY_CHAPTER_FROZEN');
  assert.match(frozenResult.rejected?.[0]?.reason, /自动跳过止损/);
  assert.match(store.chapters.fullText(chapter.id), /雨声一阵紧过一阵/, '冻结章旧稿逐字保留');

  // "全部重新诊断"（reusePriorCandidates=false）不认旧账：同一章重新生成并走完整流程落盘
  let compareRound = 0;
  const freshRunTask = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: cleanText, finishReason: 'stop' };
    if (prompt.includes('匿名对照审稿')) {
      compareRound++;
      const winner = compareRound % 2 === 1 ? 'B' : 'A';
      return { content: JSON.stringify({
        winner, margin: 9,
        scores: winner === 'A'
          ? { A: { progression: 80, consequence: 76, character: 78, pull: 74 }, B: { progression: 40, consequence: 35, character: 45, pull: 40 } }
          : { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 80, consequence: 76, character: 78, pull: 74 } },
        evidence: compareRound % 2 === 1
          ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
          : { A: ['烧掉退路文书'], B: ['雨声一阵紧过一阵'] },
        reason: '新稿推进果断',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const freshEvents = [];
  const freshRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [freezeOrder],
  });
  const freshResult = await executeRecommendationRecovery(book.id, freshRun.id, {
    reusePriorCandidates: false,
    runTaskImpl: freshRunTask,
    projectionImpl: async ({ text }) => evidenceProjection(text),
    onEvent: event => { if (event.type === 'recovery_chapter_frozen') freshEvents.push(event); },
  });
  assert.deepEqual(freshResult.applied.map(item => item.chapter), [1], '选全部重新诊断时冻结不生效，正常生成落盘');
  assert.equal(freshEvents.length, 0, '解冻路径不得再发冻结事件');
});

test('V0.100.3 连败动态冷却：本书有章节成功落盘后，此前拒收旧账清零，冻结章下一轮自动重试', async () => {
  const book = store.books.create({ title: '连败冷却测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const baseSegs = Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
  const oldText = paragraphs(baseSegs, 5);
  const cleanText = budgetedCandidate(baseSegs);
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  // 两轮拒收旧账（创建时间早于随后的"成功落盘"水位行）
  for (const label of ['冷却旧账一', '冷却旧账二']) {
    const prior = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'failed',
      workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
    });
    store.recommendationRecoveryRuns.update(prior.id, {
      result: {
        candidates: [{
          chapter: 1, before: oldText, after: '另一版候选正文', order: { chapter: 1, action: 'tune' },
          status: 'rejected', rejection: { chapter: 1, code: 'RECOVERY_NO_CLEAR_IMPROVEMENT', reason: '盲审未胜出' },
          comparisons: [],
        }], note: label,
      },
    });
  }
  // 水位：本书有一次完成且实际落盘的运行（哪怕不是同一章——上下文变了就该再给机会）
  const appliedRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'completed',
    workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
  });
  store.recommendationRecoveryRuns.update(appliedRun.id, { result: { applied: [{ chapter: 1 }], candidates: [] } });

  // 第 3 次执行：动态冷却生效，同一工单同一份旧稿照常进入生成（reusePriorCandidates=true 路径）
  let generateCalled = false;
  let compareRound = 0;
  const frozenEvents = [];
  const winningMock = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) { generateCalled = true; return { content: cleanText, finishReason: 'stop' }; }
    if (prompt.includes('匿名对照审稿')) {
      compareRound++;
      const winner = compareRound % 2 === 1 ? 'B' : 'A';
      return { content: JSON.stringify({
        winner, margin: 9,
        scores: winner === 'A'
          ? { A: { progression: 80, consequence: 76, character: 78, pull: 74 }, B: { progression: 40, consequence: 35, character: 45, pull: 40 } }
          : { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 80, consequence: 76, character: 78, pull: 74 } },
        evidence: compareRound % 2 === 1
          ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
          : { A: ['烧掉退路文书'], B: ['雨声一阵紧过一阵'] },
        reason: '新稿推进果断',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const retryRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
  });
  const retryResult = await executeRecommendationRecovery(book.id, retryRun.id, {
    reusePriorCandidates: true,
    runTaskImpl: winningMock,
    projectionImpl: async ({ text }) => evidenceProjection(text),
    onEvent: event => { if (event.type === 'recovery_chapter_frozen') frozenEvents.push(event); },
  });
  assert.equal(generateCalled, true, '成功落盘后旧账清零，冻结不得触发');
  assert.equal(frozenEvents.length, 0);
  assert.deepEqual(retryResult.applied.map(item => item.chapter), [1], '解冻后的重试走完整流程并落盘');
});

test.skip('V0.100.3 盲审证据重答必须授权“删掉无逐字支撑的条目换引原句”，防同一坏引文复发', async () => {
  const book = store.books.create({ title: '盲审证据重答测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const baseSegs = Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
  const oldText = paragraphs(baseSegs, 5);
  const cleanText = budgetedCandidate(baseSegs);
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  const compareCalls = [];
  let compareRound = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: cleanText, finishReason: 'stop' };
    if (prompt.includes('匿名对照审稿')) {
      compareRound++;
      compareCalls.push({ round: compareRound, prompt });
 // 第 1 轮首次响应引用不存在于正文的复述句（实测 ch9 实证形态）；重答后改引可逐字
      // 定位的原句通过——授权"删坏条目换原句"后，重答不再在同一处反复摔倒。
      if (compareCalls.length === 1) {
        return { content: JSON.stringify({
          winner: 'B', margin: 9,
          scores: { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 80, consequence: 76, character: 78, pull: 74 } },
 evidence: { A: ['量的是斜坡，不是平距。什长乙把木尺竖起来'], B: ['烧掉退路文书'] },
          reason: '新稿推进果断',
        }), finishReason: 'stop' };
      }
      const winner = compareRound % 2 === 1 ? 'B' : 'A';
      return { content: JSON.stringify({
        winner, margin: 9,
        scores: winner === 'A'
          ? { A: { progression: 80, consequence: 76, character: 78, pull: 74 }, B: { progression: 40, consequence: 35, character: 45, pull: 40 } }
          : { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 80, consequence: 76, character: 78, pull: 74 } },
        evidence: compareRound % 2 === 1
          ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
          : { A: ['烧掉退路文书'], B: ['雨声一阵紧过一阵'] },
        reason: '新稿推进果断',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
  });
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl,
    projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.match(compareCalls[1].prompt, /确实没有逐字支撑.*直接删掉/s, '重答反馈必须授权删除无支撑条目');
  assert.match(compareCalls[1].prompt, /凭记忆复述大意/, '重答反馈必须禁止复述大意');
  assert.deepEqual(result.applied.map(item => item.chapter), [1], '重答改引原句后候选应继续走完流程');
});

test('V0.100.5 盲审证据跨对白闭合引号：模型省略定界符不得误杀真引文，语序颠倒仍判废', () => {
 // 实测 ch9 实证原文形态（对白在前、叙述句紧随其后）：模型引用时唯一省略的字符
  // 是对白闭合引号——旧实现的剥壳投影要求”引文自身含引号才启用”，导致该真引文每轮必死。
 const oldText = '“量的是斜坡，不是平距。”什长乙把木尺竖起来，把尺收进工具袋。';
  const dims = { progression: 70, consequence: 68, character: 72, pull: 66 };
  validateBlindComparison({
    winner: 'B', margin: 12,
    scores: { A: dims, B: dims },
 evidence: { A: ['队伍没有停'], B: ['量的是斜坡，不是平距。什长乙把木尺竖起来'] },
    reason: '跨闭合引号的连续真引文',
  }, { candidateA: '雨声打在斗笠上，队伍没有停。', candidateB: oldText });

  // 语序颠倒的拼接仍然是幻觉，必须照旧判废
  assert.throws(() => validateBlindComparison({
    winner: 'B', margin: 12,
    scores: { A: dims, B: dims },
 evidence: { A: ['队伍没有停'], B: ['把尺收进工具袋。什长乙把木尺竖起来'] },
    reason: '语序颠倒不可定位',
  }, { candidateA: '雨声打在斗笠上，队伍没有停。', candidateB: oldText }), /无法在正文定位/);
});

test('V0.100.5 慢性败选熔断：同一旧稿累计 4 轮质量性败选后无视成功水印直接冻结', async () => {
  const book = store.books.create({ title: '终身熔断测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const baseSegs = Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
  const oldText = paragraphs(baseSegs, 5);
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const lifetimeOrder = { chapter: 1, action: 'tune', objective: '让主角行动', evidence: [] };

  const rejectAudit = {
    chapter: 1, before: oldText, after: '另一版候选正文', order: lifetimeOrder,
    status: 'rejected', rejection: { chapter: 1, code: 'RECOVERY_COMPARE_INVALID', reason: '盲审结构失败' },
    comparisons: [],
  };
  // 四轮败选全部早于成功水位：动态冷却的 recent 计数=0，只有终身熔断能拦住它
  for (const label of ['累计一', '累计二', '累计三']) {
    const prior = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'failed',
      workOrders: [lifetimeOrder],
    });
    store.recommendationRecoveryRuns.update(prior.id, {
      result: { candidates: [{ ...rejectAudit, note: label }] },
    });
  }
  const appliedRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'completed',
    workOrders: [lifetimeOrder],
  });
  store.recommendationRecoveryRuns.update(appliedRun.id, { result: { applied: [{ chapter: 1 }], candidates: [] } });
  const lifetimePrior = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'failed',
    workOrders: [lifetimeOrder],
  });
  store.recommendationRecoveryRuns.update(lifetimePrior.id, {
    result: { candidates: [rejectAudit] },
  });

  let generateCalled = false;
  const frozenEvents = [];
  const frozenRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [lifetimeOrder],
  });
  const frozenResult = await executeRecommendationRecovery(book.id, frozenRun.id, {
    reusePriorCandidates: true,
    runTaskImpl: async () => { generateCalled = true; throw new Error('熔断章不得再消耗模型调用'); },
    projectionImpl: async ({ text }) => evidenceProjection(text),
    onEvent: event => { if (event.type === 'recovery_chapter_frozen') frozenEvents.push(event); },
  });
  assert.equal(generateCalled, false, '慢性败选章累计到熔断线后必须零调用');
  assert.equal(frozenEvents.length, 1);
  assert.equal(frozenEvents[0].lifetimeDriven, true, '本次冻结由终身熔断触发而非动态冷却');
  assert.match(frozenResult.rejected?.[0]?.reason, /熔断止损/);
});

test('V0.100.14 场景窗口替代整章重写：无 P 编号，也不向模型发送旧稿全文', async () => {
  const { recommendationRecoveryRewriteInstruction } = await import('../server/engine/prompts.js');
  // 实证复盘：整章重写让弱模型丢锚、洗稿并反复败选。V0.100.14 改为证据场景窗口，
  // 仍不得复活 P 编号逐段预算，也不得把整章作为作者模型的输出任务。
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const oldText = paragraphs(Array.from({ length: 20 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`), 5);
  const tuneInstruction = recommendationRecoveryRewriteInstruction({
    bookTitle: '形态撤回测试', chapter: { idx: 1, title: '河滩' }, chapterText: oldText,
    workOrder: { action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'], reason: '' },
  });
  assert.doesNotMatch(tuneInstruction, /【改动建议/, 'tune 章不得再有定向修补段');
  assert.doesNotMatch(tuneInstruction, /P\d+：第\d+段/, '旧稿不得再按 P 编号展示');
  assert.doesNotMatch(tuneInstruction, /只改写这些段落|授权段落|改动预算/, '不得再有旧版 P 编号预算话术');
  assert.match(tuneInstruction, /【待替换场景窗口】\n第0段/, '作者模型只接收待替换窗口');
  assert.doesNotMatch(tuneInstruction, /【旧稿全文】/, '不得再要求整章洗稿');
  const rebuildInstruction = recommendationRecoveryRewriteInstruction({
    bookTitle: '形态撤回测试', chapter: { idx: 2, title: '营门' }, chapterText: oldText,
    workOrder: { action: 'rebuild', objective: '重构空转章', evidence: ['始终没有定论'], reason: '' },
  });
  assert.doesNotMatch(rebuildInstruction, /【改动建议|P\d+：第|【旧稿全文】/, 'rebuild 同样使用场景窗口合同');

  // 端到端：单场景章节的窗口候选仍能走完既有门禁落盘。
  const book = store.books.create({ title: '形态撤回流程测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const newText = paragraphs([
 ...Array.from({ length: 21 }, (_, index) => `第${index}段主角烧掉退路文书，带人冒雨冲向营门，守门军汉抬枪拦阻。`),
 '主角抹了把脸上的雨水，喝道：“跟我来，退路已经没了。”',
  ], 5);
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  let compareRound = 0;
  const budgetEvents = [];
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: newText, finishReason: 'stop' };
    if (prompt.includes('匿名对照审稿')) {
      compareRound++;
      const first = compareRound % 2 === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 14,
        scores: first
          ? { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 80, consequence: 76, character: 78, pull: 74 } }
          : { A: { progression: 80, consequence: 76, character: 78, pull: 74 }, B: { progression: 40, consequence: 35, character: 45, pull: 40 } },
        evidence: first ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] } : { A: ['烧掉退路文书'], B: ['雨声一阵紧过一阵'] },
        reason: '新稿推进果断',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
  });
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl,
    projectionImpl: async ({ text }) => evidenceProjection(text),
    onEvent: event => { if (event.type === 'recovery_budget_notice') budgetEvents.push(event); },
  });
  assert.deepEqual(result.applied.map(item => item.chapter), [1], '场景窗口候选正常通过门禁落盘');
  assert.equal(budgetEvents.length, 0, '预算观察事件已随机制一并撤回');
});

test.skip('V0.100.2 补救二扫：首扫被拒章回头再试，通过的一起落盘；仍败有界标注；文风拒收不补救', async () => {
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
 const baseSegs = Array.from({ length: 17 }, (_, index) => `第${index}段主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`);
  const oldText = paragraphs(baseSegs, 5);
  const newText = budgetedCandidate(baseSegs);
  // 文风噪声版：3 处「微微」全部落在授权槽位段内，其余段落预算通过。
  const noisyText = budgetedCandidate(baseSegs, {
 head: '第0段雨幕压下来，主角微微一笑，又微微敛容——随即烧掉退路文书，带人冒雨冲向营门。',
 tail: '第15段守门军汉还没合围，众人只微微一滞，主角已抹了把脸上的雨水。',
  });
  const dimsGood = { progression: 78, consequence: 74, character: 76, pull: 72 };
  const dimsWeak = { progression: 40, consequence: 35, character: 45, pull: 40 };
  const evidenceFor = round => (round % 2 === 1
    ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
    : { A: ['烧掉退路文书'], B: ['雨声一阵紧过一阵'] });
  const proj = async ({ text }) => evidenceProjection(text);
  const makeBook = (title, chapterCount) => {
    const book = store.books.create({ title, genre: '历史', platform: '番茄' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapters = [];
    for (let idx = 1; idx <= chapterCount; idx++) {
      const chapter = store.chapters.create(book.id, volume.id, idx, { title: `章${idx}`, status: 'done', wordCount: 400 });
      store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
      chapters.push(chapter);
    }
    store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
    return { book, chapters };
  };
  const globalReviewOk = () => JSON.stringify({
    verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
  });

  // 情形一：首扫"盲审未胜出"（ch1）与"盲审结构失败被隔离"（ch2）→ 二扫双双通过落盘
  {
    const { book, chapters } = makeBook('二扫通过测试', 2);
    void chapters;
    const rewriteCalls = new Map();
    const sweepEvents = [];
    const runTaskImpl = async ({ messages, jsonMode }) => {
      const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
        const idx = Number(prompt.match(/第(\d+)章《/)?.[1]);
        rewriteCalls.set(idx, (rewriteCalls.get(idx) || 0) + 1);
        return { content: newText, finishReason: 'stop' };
      }
      if (prompt.includes('匿名对照审稿')) {
        const idx = Number(prompt.match(/第(\d+)章《/)?.[1]);
        const round = Number(prompt.match(/第(\d+)轮/)?.[1]);
        const calls = rewriteCalls.get(idx) || 0;
        // ch2 首扫：盲审 evidence 非数组（重答仍坏）→ 隔离；二扫恢复
        if (idx === 2 && calls === 1) {
          return { content: JSON.stringify({
            winner: 'B', margin: 8, scores: { A: dimsWeak, B: dimsGood },
            evidence: { A: 42, B: ['烧掉退路文书'] }, reason: '坏结构',
          }), finishReason: 'stop' };
        }
        // ch1 首扫（含打回重生，calls 1-2）：两轮旧稿胜出；calls≥3（二扫）候选明确胜出
        const good = idx === 1 ? calls >= 3 : calls >= 2;
        const winner = good ? (round % 2 === 1 ? 'B' : 'A') : (round % 2 === 1 ? 'A' : 'B');
        return { content: JSON.stringify({
          winner, margin: good ? 8 : 6,
          scores: { A: winner === 'A' ? dimsGood : dimsWeak, B: winner === 'B' ? dimsGood : dimsWeak },
          evidence: evidenceFor(round),
          reason: good ? '新稿推进果断' : '换汤不换药',
        }), finishReason: 'stop' };
      }
      if (prompt.includes('推荐返工整段复核')) return { content: globalReviewOk(), finishReason: 'stop' };
      throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
    };
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 2, status: 'planned',
      workOrders: [1, 2].map(idx => ({ chapter: idx, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] })),
    });
    const result = await executeRecommendationRecovery(book.id, run.id, {
      runTaskImpl, projectionImpl: proj,
      onEvent: event => { if (event.type === 'recovery_second_sweep') sweepEvents.push(event); },
    });
    assert.deepEqual(result.applied.map(item => item.chapter), [1, 2], '二扫通过的章必须与首扫通过章一起落盘');
    assert.equal(sweepEvents.length, 1, '必须出现一次补救二扫事件');
    assert.deepEqual(sweepEvents[0].chapters, [1, 2], '二扫范围 = 两类可补救失败章');
    assert.equal(rewriteCalls.get(1), 3, '未胜出章 = 首扫生成+打回重生+二扫各一次');
    assert.equal(rewriteCalls.get(2), 2, '被隔离章 = 首扫生成+二扫各一次');
    assert.equal(result.rejected.length, 0, '二扫通过后拒收清单必须清空');
  }

  // 情形二：二扫仍败——有界（每章共 3 次生成）且原因标注，旧稿保留
  {
    const { book, chapters } = makeBook('二扫仍败测试', 1);
    const rewriteCalls = new Map();
    const runTaskImpl = async ({ messages, jsonMode }) => {
      const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
        rewriteCalls.set(1, (rewriteCalls.get(1) || 0) + 1);
        return { content: newText, finishReason: 'stop' };
      }
      if (prompt.includes('匿名对照审稿')) {
        const round = Number(prompt.match(/第(\d+)轮/)?.[1]);
        const winner = round % 2 === 1 ? 'A' : 'B'; // 两轮都是旧稿胜出
        return { content: JSON.stringify({
          winner, margin: 6,
          scores: { A: winner === 'A' ? dimsGood : dimsWeak, B: winner === 'B' ? dimsGood : dimsWeak },
          evidence: evidenceFor(round), reason: '新稿没有实质推进',
        }), finishReason: 'stop' };
      }
      if (prompt.includes('推荐返工整段复核')) return { content: globalReviewOk(), finishReason: 'stop' };
      throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
    };
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'planned',
      workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
    });
    const result = await executeRecommendationRecovery(book.id, run.id, { runTaskImpl, projectionImpl: proj });
    assert.equal(result.applied.length, 0);
    assert.equal(rewriteCalls.get(1), 3, '未胜出章最多 3 次生成（首扫+重生+二扫），不无界烧费');
    assert.match(result.rejected[0]?.reason, /补救二扫仍不过关/, '二扫仍败必须在原因中标注');
    assert.match(store.chapters.fullText(chapters[0].id), /雨声一阵紧过一阵/, '旧稿逐字保留');
  }

  // 情形三：文风闸拒收属确定性门禁（已烧过定向重答），不进二扫
  {
    const { book } = makeBook('二扫不补救文风测试', 1);
    let rewriteCalls = 0;
    const sweepEvents = [];
    const runTaskImpl = async ({ messages, jsonMode }) => {
      const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
        rewriteCalls++;
        return { content: noisyText, finishReason: 'stop' };
      }
      throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
    };
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'planned',
      workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动', evidence: ['雨声一阵紧过一阵'] }],
    });
    const result = await executeRecommendationRecovery(book.id, run.id, {
      runTaskImpl, projectionImpl: proj,
      onEvent: event => { if (event.type === 'recovery_second_sweep') sweepEvents.push(event); },
    });
    assert.equal(result.applied.length, 0);
    assert.equal(result.rejected[0]?.code, 'RECOVERY_PROSE_GATE_FAILED');
    assert.equal(rewriteCalls, 3, '文风闸拒收 = 1 初稿 + 2 定向重答，不再进二扫');
    assert.equal(sweepEvents.length, 0, '文风类拒收不触发补救二扫');
  }
});

test('V0.100.1 中断的返工运行启动自愈复位，执行失败可带工单直接重跑', async () => {
  const book = store.books.create({ title: '中断自愈测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 400 });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  const oldText = paragraphs(Array.from({ length: 20 }, (_, index) => `第${index}段众人围着火盆等消息，雨声一阵紧过一阵。`), 5);
  const fullText = paragraphs([
 ...Array.from({ length: 21 }, (_, index) => `第${index}段主角烧掉退路文书，带人冒雨冲向营门，守门军汉抬枪拦阻。`),
 '主角抹了把脸上的雨水，喝道：“跟我来，退路已经没了。”',
  ], 5);
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  // 进程中断留下的瞬时态：diagnosing 落 failed（批次检查点保留可续跑），rewriting/verifying 回 planned
  const orphanedDiagnosing = store.recommendationRecoveryRuns.create(book.id, { startChapter: 1, endChapter: 5, status: 'diagnosing' });
  const orphanedRewriting = store.recommendationRecoveryRuns.create(book.id, { startChapter: 1, endChapter: 5, status: 'rewriting' });
  const stablePlanned = store.recommendationRecoveryRuns.create(book.id, { startChapter: 1, endChapter: 5, status: 'planned' });
  assert.equal(store.recommendationRecoveryRuns.healOrphanedInFlight(), 2);
  assert.equal(store.recommendationRecoveryRuns.get(orphanedDiagnosing.id).status, 'failed');
  assert.match(store.recommendationRecoveryRuns.get(orphanedDiagnosing.id).error, /断点续跑/);
  assert.equal(store.recommendationRecoveryRuns.get(orphanedRewriting.id).status, 'planned');
  assert.equal(store.recommendationRecoveryRuns.get(stablePlanned.id).status, 'planned', '稳定态不得被动');

  // 执行阶段失败的运行（failed + 工单已生成）不必重跑诊断，可直接重新执行
  const failedRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'failed',
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '让主角行动并付出代价', evidence: ['雨声一阵紧过一阵'] }],
  });
  let compareRound = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: fullText, finishReason: 'stop' };
    if (prompt.includes('推荐返工匿名对照审稿')) {
      compareRound++;
      const first = compareRound === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 16,
        scores: first
          ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
          : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
        evidence: first
          ? { A: ['雨声一阵紧过一阵'], B: ['烧掉退路文书'] }
          : { A: ['冲向营门'], B: ['围着火盆等消息'] },
        reason: '候选有不可逆行动与代价',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角烧掉退路文书'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, failedRun.id, {
    runTaskImpl, projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(result.applied.length, 1, 'failed 运行带工单重跑应正常落盘');
  assert.match(store.chapters.fullText(chapter.id), /烧掉退路文书/);

  // 诊断阶段失败的运行（无工单）仍不允许直接执行
  const diagnoseFailed = store.recommendationRecoveryRuns.create(book.id, { startChapter: 1, endChapter: 1, status: 'failed' });
  await assert.rejects(() => executeRecommendationRecovery(book.id, diagnoseFailed.id, { runTaskImpl }), /不能执行/);
});

test('V0.100.2 盲审指令自带引文纪律（禁止省略号拼接/夹带分析），写审同源降出错率', async () => {
  const { recommendationRecoveryCompareInstruction } = await import('../server/engine/prompts.js');
  const instruction = recommendationRecoveryCompareInstruction({
    chapter: { idx: 1, title: '河滩' }, candidateA: '甲', candidateB: '乙',
  });
  assert.match(instruction, /逐字连续的一段/, '必须要求逐字连续单段引文');
  assert.match(instruction, /禁止用.*省略号.*拼成一条/, '必须显式禁止省略号拼接');
  assert.match(instruction, /说话人标签两侧/, '必须禁止拼接对白标签两侧');
  assert.match(instruction, /夹带章节号、分析或评语/, '必须禁止引文夹带分析');
});

test('V0.100.1 盲审 evidence 裸字符串确定性归一，非数组幻觉结构仍判废', () => {
  const textA = '旧稿里众人商量到深夜，事情没有发生变化。';
 const textB = '新稿里主角烧掉退路文书，带着十个人冲出营门。';
  const dims = { progression: 70, consequence: 68, character: 72, pull: 66 };
  const ok = validateBlindComparison({
    winner: 'B', margin: 12,
    scores: { A: dims, B: dims },
    evidence: { A: '事情没有发生变化', B: ['烧掉退路文书'] },
    reason: '裸字符串引文做形态归一，内容仍逐字校验',
  }, { candidateA: textA, candidateB: textB });
  assert.deepEqual(ok.evidence.A, ['事情没有发生变化']);
  // V0.100.2：对象包装形态（{quote|text|content}）同样确定性归一——内容仍逐字定位，
  // 真正无法提取的形态（数字/无字段对象/幻觉引文）照旧判废。
  const fromObject = validateBlindComparison({
    winner: 'B', margin: 12, scores: { A: dims, B: dims },
    evidence: { A: { quote: '事情没有发生变化' }, B: [{ text: '烧掉退路文书' }] }, reason: '对象包装形态归一',
  }, { candidateA: textA, candidateB: textB });
  assert.deepEqual(fromObject.evidence.A, ['事情没有发生变化']);
  assert.deepEqual(fromObject.evidence.B, ['烧掉退路文书']);
  assert.throws(() => validateBlindComparison({
    winner: 'B', margin: 12, scores: { A: dims, B: dims },
    evidence: { A: 42, B: ['烧掉退路文书'] }, reason: '数字形态不可归一，仍判废',
  }, { candidateA: textA, candidateB: textB }), /A evidence/);
  assert.throws(() => validateBlindComparison({
    winner: 'B', margin: 12, scores: { A: dims, B: dims },
    evidence: { A: { quote: '不存在的幻觉引文' }, B: ['烧掉退路文书'] }, reason: '幻觉引文仍逐字判废',
  }, { candidateA: textA, candidateB: textB }), /无法在正文定位/);
});

test.skip('V0.100.1 盲审重答耗尽：微调章隔离续跑，关键重构章快速失败', async () => {
  const book = store.books.create({ title: '盲审隔离测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  const chapterOne = store.chapters.create(book.id, volume.id, 1, { title: '火盆', status: 'done', wordCount: 400 });
  const chapterTwo = store.chapters.create(book.id, volume.id, 2, { title: '营门', status: 'done', wordCount: 400 });
  const oneSegs = Array.from({ length: 20 }, (_, index) => `第${index}段众人守着火盆反复商量，始终没有定论。`);
  const oldOne = paragraphs(oneSegs, 5);
 const twoSegs = Array.from({ length: 20 }, (_, index) => `第${index}段主角在营门外踱步，雪粒打在甲叶上。`);
  const oldTwo = paragraphs(twoSegs, 5);
  // V0.100.3 段落预算：候选只改 P1 与末段，其余段落逐字保留。
  const newOne = budgetedCandidate(oneSegs, {
 head: '第0段主角拍案定下分批撤退的次序，众人不再空议。',
 tail: '第19段主角环视众人，沉声道：“天明前，先走伤员。”',
  });
  const newTwo = budgetedCandidate(twoSegs, {
 head: '第0段雪夜里，主角劈开锁链，带人冲进营门夺粮。',
 tail: '第19段主角反手把刀插回鞘中，喝道：“粮先分给伤兵。”',
  });
  store.scenes.create(chapterOne.id, 1, { content: oldOne, status: 'done', targetWords: 400 });
  store.scenes.create(chapterTwo.id, 1, { content: oldTwo, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned',
    workOrders: [
      { chapter: 1, action: 'tune', objective: '压缩商议', evidence: ['始终没有定论'] },
      { chapter: 2, action: 'tune', objective: '让行动落地', evidence: ['雪粒打在甲叶上'] },
    ],
  });
  const compareRounds = new Map();
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      if (prompt.includes('第2章《')) return { content: newTwo, finishReason: 'stop' };
      return { content: newOne, finishReason: 'stop' };
    }
    if (prompt.includes('匿名对照审稿')) {
      if (prompt.includes('第1章《')) {
        // 持续返回 evidence 非数组的坏结构：重答一次后仍错，本章候选应被隔离
        const round = (compareRounds.get(1) || 0) + 1;
        compareRounds.set(1, round);
        return { content: JSON.stringify({
          winner: 'B', margin: 12,
          scores: { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 75, consequence: 70, character: 68, pull: 66 } },
          evidence: { A: 42, B: ['定下明日分批撤退'] }, reason: '坏结构',
        }), finishReason: 'stop' };
      }
      const round = (compareRounds.get(2) || 0) + 1;
      compareRounds.set(2, round);
      const first = round === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 16,
        scores: first
          ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
          : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
        evidence: first
          ? { A: ['雪粒打在甲叶上'], B: ['劈开锁链'] }
          : { A: ['冲进营门'], B: ['在营门外踱步'] },
        reason: '候选有不可逆行动',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角劈开锁链'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl, projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(compareRounds.get(1), 4, '首扫第1轮盲审带一次重答仍坏才隔离（2 次），补救二扫再试一轮仍坏才最终拒收（再 2 次）');
  assert.deepEqual(result.applied.map(item => item.chapter), [2], '第1章被隔离不影响第2章正常落盘');
  assert.equal(result.rejected[0]?.code, 'RECOVERY_COMPARE_INVALID');
  assert.match(result.rejected[0]?.reason, /补救二扫仍不过关/, '二扫仍败必须标注');
  assert.match(store.chapters.fullText(chapterOne.id), /守着火盆反复商量/, '被隔离章节旧稿逐字保留');

  // 关键重构章盲审重答耗尽仍立即停（它缺候选整批必保留，继续只白烧费）
  const rebuildRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '重写空转章', evidence: ['始终没有定论'] }],
  });
  await assert.rejects(() => executeRecommendationRecovery(book.id, rebuildRun.id, {
    runTaskImpl, projectionImpl: async ({ text }) => evidenceProjection(text),
  }), /A evidence必须是数组/);
  assert.equal(store.recommendationRecoveryRuns.get(rebuildRun.id).status, 'failed');
});

test('V0.99 推荐返工候选必须减少确定性 AI 腔与动作母题，不能只靠模型自评分', () => {
  const noisy = '他微微一笑。她微微点头。两人微微叹息。';
  const clean = '他笑了一声，把账册推到桌心。她看完最后一行，抬手扣住门闩。';
  const improved = validateRecoveryProseImprovement(noisy, clean);
  assert.equal(improved.ok, true);
  assert.ok(improved.beforeBlocking > improved.afterBlocking);

  const unchangedRisk = validateRecoveryProseImprovement(noisy, `${noisy}他又微微皱眉。`);
  assert.equal(unchangedRisk.ok, false);
  assert.equal(unchangedRisk.code, 'RECOVERY_PROSE_GATE_FAILED');
});

test('V0.100.1 整段复核失败后重跑：已验证候选按指纹复用，只重生断点之后章节', async () => {
  const book = store.books.create({ title: '执行续跑测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  const chapterOne = store.chapters.create(book.id, volume.id, 1, { title: '火盆', status: 'done', wordCount: 400 });
  const chapterTwo = store.chapters.create(book.id, volume.id, 2, { title: '营门', status: 'done', wordCount: 400 });
  const oneSegs = Array.from({ length: 20 }, (_, index) => `第${index}段众人守着火盆反复商量，始终没有定论。`);
  const oldOne = paragraphs(oneSegs, 5);
 const twoSegs = Array.from({ length: 20 }, (_, index) => `第${index}段主角在营门外踱步，雪粒打在甲叶上。`);
  const oldTwo = paragraphs(twoSegs, 5);
  const newOne = budgetedCandidate(oneSegs, {
 head: '第0段主角拍案定下撤退批次，众人分头准备。',
 tail: '第19段主角环视众人，沉声道：“天明前，先走伤员。”',
  });
  const newTwo = budgetedCandidate(twoSegs, {
 head: '第0段雪夜里，主角劈开锁链，带人冲进营门夺粮。',
 tail: '第19段主角反手把刀插回鞘中，喝道：“粮先分给伤兵。”',
  });
  store.scenes.create(chapterOne.id, 1, { content: oldOne, status: 'done', targetWords: 400 });
  store.scenes.create(chapterTwo.id, 1, { content: oldTwo, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned',
    result: { diagnosis_fingerprint: 'same-run-checkpoint-test' },
    workOrders: [
      { chapter: 1, action: 'tune', objective: '压缩商议', evidence: ['始终没有定论'] },
      { chapter: 2, action: 'tune', objective: '让行动落地', evidence: ['雪粒打在甲叶上'] },
    ],
  });

  let firstExecution = true;
  const rewriteCalls = new Map();
  const compareCalls = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const goodComparison = (chapterIdx, round) => {
    const first = round === 1;
    return JSON.stringify({
      winner: first ? 'B' : 'A', margin: 16,
      scores: first
        ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
        : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
      evidence: chapterIdx === 1
        ? (first ? { A: ['始终没有定论'], B: ['拍案定下'] } : { A: ['分头准备'], B: ['守着火盆'] })
        : (first ? { A: ['雪粒打在甲叶上'], B: ['劈开锁链'] } : { A: ['冲进营门'], B: ['在营门外踱步'] }),
      reason: '候选有不可逆行动',
    });
  };
  const proj = async ({ text }) => evidenceProjection(text);
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      const isTwo = prompt.includes('第2章《');
      bump(rewriteCalls, isTwo ? 2 : 1);
      return { content: isTwo ? newTwo : newOne, finishReason: 'stop' };
    }
    if (prompt.includes('匿名对照审稿')) {
      const isOne = prompt.includes('第1章《');
      const key = isOne ? 1 : 2;
      bump(compareCalls, key);
      const round = compareCalls.get(key);
      // 首轮执行里第2章盲审持续返回坏结构（验证隔离）；第二轮执行恢复正常
      if (firstExecution && key === 2) {
        return { content: JSON.stringify({
          winner: 'B', margin: 12,
          scores: { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 75, consequence: 70, character: 68, pull: 66 } },
          evidence: { A: 42, B: ['劈开锁链'] }, reason: '坏结构',
        }), finishReason: 'stop' };
      }
      return { content: goodComparison(key, ((round - 1) % 2) + 1), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      // 首轮执行整段复核持续返回非 JSON（验证检查点落盘）；第二轮执行放行
      if (firstExecution) return { content: '这不是 JSON，模型输出被截断', finishReason: 'stop' };
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角拍案定下'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };

  // 第一轮：第1章候选通过，第2章盲审坏结构被隔离，整段复核连续两次非 JSON → 失败
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, { runTaskImpl, projectionImpl: proj }), /没有返回有效 JSON/);
  const failedRun = store.recommendationRecoveryRuns.get(run.id);
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.result.candidates.filter(item => item.status === 'accepted').length, 1,
    '失败时必须把已验证候选持久化为断点检查点');
  const acceptedCheckpoint = failedRun.result.candidates.find(item => item.status === 'accepted');
  assert.equal(hasCompleteCandidateProvenance(acceptedCheckpoint.provenance), true,
    '本运行新生成的局部通过候选必须带完整来源合同，才能安全断点复用');
  assert.equal(rewriteCalls.get(1), 1);
  assert.equal(compareCalls.get(1), 2);

  // 第二轮：第1章候选指纹复用（零模型调用），只重生第2章，直接进整段复核
  firstExecution = false;
  rewriteCalls.clear();
  compareCalls.clear();
  const reusedEvents = [];
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl, projectionImpl: proj,
    onEvent: event => { if (event.type === 'recovery_candidate_reused') reusedEvents.push(event); },
  });
  assert.equal(rewriteCalls.get(1) || 0, 0, '已验证候选章不得重新烧模型调用');
  assert.equal(compareCalls.get(1) || 0, 0, '已验证候选章不得重跑盲审');
  assert.equal(rewriteCalls.get(2), 1, '断点章正常重新生成');
  assert.deepEqual(reusedEvents.map(event => event.chapter), [1]);
  assert.deepEqual(result.applied.map(item => item.chapter), [1, 2]);
  assert.match(store.chapters.fullText(chapterOne.id), /拍案定下/);
  assert.match(store.chapters.fullText(chapterTwo.id), /劈开锁链/);
});

test('V0.100.1 执行失败后重新诊断幂等复用既有结论，不从零重烧（用户实证事故）', async () => {
  // 用户实证：执行阶段失败后点"重新诊断"，指纹随 failRun 丢失、新运行从零开跑。
  const book = store.books.create({ title: '诊断幂等测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  const chapterOne = store.chapters.create(book.id, volume.id, 1, { title: '火盆', status: 'done', wordCount: 400 });
  const chapterTwo = store.chapters.create(book.id, volume.id, 2, { title: '营门', status: 'done', wordCount: 400 });
  const oneSegs = Array.from({ length: 20 }, (_, index) => `第${index}段众人守着火盆反复商量，始终没有定论。`);
  const oldOne = paragraphs(oneSegs, 5);
 const twoSegs = Array.from({ length: 20 }, (_, index) => `第${index}段主角在营门外踱步，雪粒打在甲叶上。`);
  const oldTwo = paragraphs(twoSegs, 5);
  const newOne = budgetedCandidate(oneSegs, {
 head: '第0段主角拍案定下撤退批次，众人分头准备。',
 tail: '第19段主角环视众人，沉声道：“天明前，先走伤员。”',
  });
  store.scenes.create(chapterOne.id, 1, { content: oldOne, status: 'done', targetWords: 400 });
  store.scenes.create(chapterTwo.id, 1, { content: oldTwo, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const diagnosisPayload = JSON.stringify({
    quality_curve: [
      { chapter: 1, action: 'tune', score: 40, evidence: ['始终没有定论'],
        effective_events: [], filler_signals: ['反复商量'], rebuild_objective: '压缩商议让行动落地',
        irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '空转' },
      { chapter: 2, action: 'keep', score: 80, evidence: ['雪粒打在甲叶上'],
        effective_events: ['营门警戒'], filler_signals: [], rebuild_objective: '',
        irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '达标' },
    ],
    segment_verdict: { deterioration_found: true, turn_chapter: 1, reason: '第1章空转' },
  });
  let diagnosisCalls = 0;
  let rewriteCalls = 0;
  let compareCalls = 0;
  let globalReviewShouldPass = false;
  const proj = async ({ text }) => evidenceProjection(text);
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (jsonMode && prompt.includes('推荐失败返工总诊断')) {
      diagnosisCalls++;
      return { content: diagnosisPayload, finishReason: 'stop' };
    }
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      rewriteCalls++;
      return { content: newOne, finishReason: 'stop' };
    }
    if (prompt.includes('匿名对照审稿')) {
      compareCalls++;
      const first = compareCalls % 2 === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 16,
        scores: first
          ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
          : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
        evidence: first ? { A: ['始终没有定论'], B: ['拍案定下'] } : { A: ['分头准备'], B: ['守着火盆'] },
        reason: '候选有不可逆行动',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      if (!globalReviewShouldPass) return { content: '这不是 JSON，模型输出被截断', finishReason: 'stop' };
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角拍案定下'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  // 第一次诊断：正常建模，生成 1 章工单
  const diagnosed = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 2, runTaskImpl,
  });
  assert.equal(diagnosisCalls, 1);
  assert.equal(diagnosed.status, 'planned');
  assert.equal(diagnosed.work_orders.length, 1);

  // 执行：候选通过盲审，但整段复核连续两次非 JSON → failRun
  await assert.rejects(() => executeRecommendationRecovery(book.id, diagnosed.id, {
    runTaskImpl, projectionImpl: proj,
  }), /没有返回有效 JSON/);
  const failedRun = store.recommendationRecoveryRuns.get(diagnosed.id);
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.result.candidates.filter(item => item.status === 'accepted').length, 1,
    '已验证候选必须持久化');
  assert.ok(failedRun.result.diagnosis_fingerprint, 'failRun 必须保留诊断指纹，否则重新诊断无法幂等复用');

  // 驾驶舱标注：工单在手的失败运行必须标为可直接执行，已验证候选数透出给选择弹窗
  const annotatedBefore = annotateRecoveryRunsResumability(book.id, publicationDashboard(book.id).recoveryRuns);
  const markedRun = annotatedBefore.find(item => item.id === diagnosed.id);
  assert.equal(markedRun.resumeKind, 'execute', '工单在手的失败运行必须标注为可直接执行');
  assert.equal(markedRun.acceptedCandidates, 1, '已验证候选数必须透出给进度选择弹窗');

  // 弹窗钉选路径：错误 id 显式拒绝；钉选该运行幂等交还同一结论，零模型调用
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 2, runTaskImpl, resumeRunId: 'recovery-nonexistent',
  }), /不存在/);
  const pinnedRevive = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 2, runTaskImpl, resumeRunId: diagnosed.id,
  });
  assert.equal(pinnedRevive.id, diagnosed.id, '钉选沿用必须回到同一运行');
  assert.equal(diagnosisCalls, 1, '钉选沿用同样不得重烧诊断');

  // 用户再点"诊断返工"：同范围同指纹 → 直接沿用结论，零模型调用，同一运行回到 planned
  const revived = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 2, runTaskImpl,
  });
  assert.equal(diagnosisCalls, 1, '诊断结论幂等复用，不得重新烧诊断费用');
  assert.equal(revived.id, diagnosed.id, '必须沿用原运行而不是新建');
  assert.equal(revived.status, 'planned');
  assert.equal(revived.work_orders.length, 1);

  // 再执行：已验证候选指纹复用（零重写零盲审），整段复核放行后落盘
  globalReviewShouldPass = true;
  const reusedEvents = [];
  const result = await executeRecommendationRecovery(book.id, revived.id, {
    runTaskImpl, projectionImpl: proj,
    onEvent: event => { if (event.type === 'recovery_candidate_reused') reusedEvents.push(event); },
  });
  assert.equal(rewriteCalls, 1, '已验证候选章不得重新生成');
  assert.equal(reusedEvents.length, 1);
  assert.deepEqual(result.applied.map(item => item.chapter), [1]);
  assert.match(store.chapters.fullText(chapterOne.id), /拍案定下/);
});

test('V0.100.7 跨运行候选隔离：整段复核未完成的局部候选不得被新运行复用', async () => {
  // 用户实证：仅凭正文指纹与 action 复用旧诊断候选，会把不同整体方案拼在一起。
  // 整段复核尚未完成的候选只能续同一运行；即便显式开放精确跨运行复用也必须重生。
  const book = store.books.create({ title: '跨运行复用测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '火盆', status: 'done', wordCount: 400 });
  const fireSegs = Array.from({ length: 20 }, (_, index) => `第${index}段众人守着火盆反复商量，始终没有定论。`);
  const oldText = paragraphs(fireSegs, 5);
  const newText = budgetedCandidate(fireSegs, {
 head: '第0段主角拍案定下撤退批次，众人分头准备。',
 tail: '第19段主角环视众人，沉声道：“天明前，先走伤员。”',
  });
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const proj = async ({ text }) => evidenceProjection(text);
  let compareRound = 0;
  let rewriteCalls = 0;
  let globalReviewShouldPass = false;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      rewriteCalls++;
      return { content: newText, finishReason: 'stop' };
    }
    if (prompt.includes('匿名对照审稿')) {
      compareRound++;
      const first = compareRound % 2 === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 16,
        scores: first
          ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
          : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
        evidence: first ? { A: ['始终没有定论'], B: ['拍案定下'] } : { A: ['分头准备'], B: ['守着火盆'] },
        reason: '候选有不可逆行动',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      if (!globalReviewShouldPass) return { content: '这不是 JSON，模型输出被截断', finishReason: 'stop' };
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角拍案定下'], reason: '整段形成推进', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  // 运行一：候选局部通过，但整段复核没有形成有效结论，只留下 local_passed 检查点
  const runOne = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '压缩商议', evidence: ['始终没有定论'] }],
  });
  await assert.rejects(() => executeRecommendationRecovery(book.id, runOne.id, {
    runTaskImpl, projectionImpl: proj,
  }), /没有返回有效 JSON/);
  assert.equal(rewriteCalls, 1);

  // 运行二：动作一致的全新运行——不得把 local_passed 当成全局已验证候选
  const runTwo = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '压缩商议', evidence: ['始终没有定论'] }],
    executionPolicy: { candidateReuse: 'exact_cross_run', rejectionHistory: 'compatible' },
  });
  globalReviewShouldPass = true;
  const reusedEvents = [];
  const resultTwo = await executeRecommendationRecovery(book.id, runTwo.id, {
    runTaskImpl, projectionImpl: proj,
    onEvent: event => { if (event.type === 'recovery_candidate_reused') reusedEvents.push(event); },
  });
  assert.equal(rewriteCalls, 2, '新运行必须重新生成，不能借用上个运行仅局部通过的候选');
  assert.equal(reusedEvents.length, 0);
  assert.deepEqual(resultTwo.applied.map(item => item.chapter), [1]);

  // 运行三：动作不一致（rebuild≠tune）——不复用，必须重新生成
  // （此时正文已是运行二落盘的新稿，重新生成的候选与旧稿相同会被 unchanged 拒收，属预期）
  const runThree = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '重写空转章', evidence: ['始终没有定论'] }],
  });
  const reusedThree = [];
  await executeRecommendationRecovery(book.id, runThree.id, {
    runTaskImpl, projectionImpl: proj,
    onEvent: event => { if (event.type === 'recovery_candidate_reused') reusedThree.push(event); },
  });
  assert.equal(rewriteCalls, 3, '动作不一致的存档候选不得复用，必须重新生成');
  assert.equal(reusedThree.length, 0);
});

test('V0.100.6 上轮整段复核否决结论进诊断：触发全新诊断并引导 arc 级 rebuild 工单', async () => {
  const book = store.books.create({ title: '复核结论诊断测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  for (let idx = 1; idx <= 2; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, { title: `章${idx}`, status: 'done', wordCount: 400 });
    store.scenes.create(chapter.id, 1, {
 content: paragraphs(Array.from({ length: 17 }, (_, i) => `第${i}段第${idx}章主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。`), 5),
      status: 'done', targetWords: 400,
    });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const diagnosisPayload = JSON.stringify({
    quality_curve: [
      { chapter: 1, action: 'tune', score: 40, evidence: ['雨声一阵紧过一阵'],
        effective_events: [], filler_signals: [], rebuild_objective: '压缩商议',
        irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '空转' },
      { chapter: 2, action: 'keep', score: 80, evidence: ['雨声一阵紧过一阵'],
        effective_events: [], filler_signals: [], rebuild_objective: '',
        irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '达标' },
    ],
    segment_verdict: { deterioration_found: true, turn_chapter: 1, reason: '第1章空转' },
  });
  let diagnosisCalls = 0;
  const diagnosisPrompts = [];
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (jsonMode && prompt.includes('推荐失败返工总诊断')) {
      diagnosisCalls++;
      diagnosisPrompts.push(prompt);
      return { content: diagnosisPayload, finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  // 第一次诊断完成（曲线完整）；随后该运行整段复核被否（globalReview.verdict=fail）
  const first = await diagnoseRecommendationRecovery(book.id, { startChapter: 1, endChapter: 2, runTaskImpl });
  assert.equal(diagnosisCalls, 1);
  store.recommendationRecoveryRuns.update(first.id, {
    status: 'failed', error: '整段推进复核未通过',
    result: {
      ...(first.result || {}),
      globalReview: { verdict: 'fail', reason: '第23—30章重复发现疑点-记录-不行动的循环，局势无实质变化' },
    },
  });
  // 结论进入指纹：同范围旧曲线不再幂等复用，必须触发全新诊断且指令带总审结论与 rebuild 引导
  const second = await diagnoseRecommendationRecovery(book.id, { startChapter: 1, endChapter: 2, runTaskImpl });
  assert.equal(diagnosisCalls, 2, '出现新的整段否决结论后不得幂等复用旧曲线');
  assert.notEqual(second.id, first.id, '新结论必须开新运行而不是复活旧运行');
  assert.match(diagnosisPrompts[1], /上轮返工整段复核未通过的总审结论/, '诊断指令必须带上轮总审结论');
  assert.match(diagnosisPrompts[1], /调查停滞|重复发现疑点|局势无实质变化/, '总审结论原文必须注入');
  assert.match(diagnosisPrompts[1], /工单动作要给 rebuild（重构）/, '必须引导停滞区间给 rebuild 工单');
  assert.match(diagnosisPrompts[1], /让局势发生实质变化的具体手段/, '目标必须要求实质变化手段');
});

test('V0.100.6 诊断曲线超范围行确定性过滤：多章不判废，漏章/重复仍判废', () => {
  // 实测：qwen 把指令里提及的章节号一并编进曲线（5 章输入返回 7 行甚至 34 行）。
  const chapters = [
 { idx: 1, title: '一', text: '主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。' },
 { idx: 2, title: '二', text: '主角烧掉退路文书，带人冒雨冲向营门。' },
  ];
  const row = idx => ({
    chapter: idx, action: 'keep', score: 80, evidence: [idx === 1 ? '雨声一阵紧过一阵' : '烧掉退路文书'],
    effective_events: [], filler_signals: [], rebuild_objective: '',
    irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '达标',
  });
  const verdict = { deterioration_found: false, turn_chapter: null, reason: '段评' };
  // 超范围行（含远超范围的 34 章、evidence 还是幻觉的）被确定性过滤，范围内照常通过
  const wide = validateRecoveryDiagnosis({
    quality_curve: [row(1), row(2), { ...row(3), evidence: ['根本不存在的句子'] }, row(34)],
    segment_verdict: verdict,
  }, chapters);
  assert.deepEqual(wide.quality_curve.map(r => r.chapter), [1, 2], '超范围行必须过滤，不拖死整批');
  assert.throws(() => validateRecoveryDiagnosis({
    quality_curve: [row(1)], segment_verdict: verdict,
  }, chapters), /不能漏章或多章/, '漏章仍判废');
  assert.throws(() => validateRecoveryDiagnosis({
    quality_curve: [row(1), row(1), row(2), row(99)], segment_verdict: verdict,
  }, chapters), /不能漏章或多章|重复或越界/, '范围内重复仍判废');
});

test('V0.100.6 诊断证据分段对齐统一：说话人标签/省略号隔开的真引文不误杀，幻觉与乱序仍判废', () => {
 // 实测 ch1-2 实证原文形态（真实运行里两次判废杀死整批诊断的两条证据）
  const text = '他转过身问：“老张，这才晌午，收什么？”“北边来信了。”老把式直起腰，声音不高，像在跟自己说，“鞑子过了大散关，利州戒了严。不摆了，不摆了。”旁边有个汉子一脚踩住秤杆。'
    + '父亲没回头。“看见了。”“大安军破了。”赵四的声音抖了一下，又稳住了，“散兵举火把连夜往南跑，连成一条线，至少三百根，有人连甲都没卸。鞑子的马队就缀在后面，火光一照，刀尖发亮，走一段就咬掉一截尾巴。”';
  const chapters = [{ idx: 1, title: '河滩', text }];
  const row = evidence => ({
    chapter: 1, action: 'keep', score: 80, evidence: [evidence],
    effective_events: [], filler_signals: [], rebuild_objective: '',
    irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '达标',
  });
  const verdict = { deterioration_found: false, turn_chapter: null, reason: '段评' };
  const okOne = validateRecoveryDiagnosis({ quality_curve: [row('北边来信了。鞑子过了大散关')], segment_verdict: verdict }, chapters);
  assert.equal(okOne.quality_curve[0].chapter, 1, '说话人标签隔开的真引文不得误杀');
  const okTwo = validateRecoveryDiagnosis({ quality_curve: [row('大安军破了。……鞑子的马队就缀在后面')], segment_verdict: verdict }, chapters);
  assert.equal(okTwo.quality_curve[0].chapter, 1, '省略号拼接的真引文不得误杀');
  assert.throws(() => validateRecoveryDiagnosis({ quality_curve: [row('北边来信了。鞑子已经进了城')], segment_verdict: verdict }, chapters),
    /无法在原文定位/, '幻觉引文仍判废');
  assert.throws(() => validateRecoveryDiagnosis({ quality_curve: [row('鞑子过了大散关。北边来信了')], segment_verdict: verdict }, chapters),
    /无法在原文定位/, '乱序拼接仍判废');
});

test('V0.100.6 诊断行级错误聚合 + 两次纠正：一次列全所有坏行，重答不再打地鼠', async () => {
  const book = store.books.create({ title: '聚合纠正测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
 const textOne = '主角沿着河滩走过芦苇荡，雨声一阵紧过一阵。';
 const textTwo = '主角烧掉退路文书，带人冒雨冲向营门。';
  const chapterOne = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 40 });
  const chapterTwo = store.chapters.create(book.id, volume.id, 2, { title: '营门', status: 'done', wordCount: 40 });
  store.scenes.create(chapterOne.id, 1, { content: textOne, status: 'done', targetWords: 40 });
  store.scenes.create(chapterTwo.id, 1, { content: textTwo, status: 'done', targetWords: 40 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  // 单元：两条坏行必须出现在同一个错误里，不能逐条挤牙膏
  const badRowOne = { chapter: 1, action: 'keep', score: 80, evidence: ['根本不存在的句子'], effective_events: [], filler_signals: [], rebuild_objective: '', irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '达标' };
  const badRowTwo = { chapter: 2, action: 'tune', score: 40, evidence: ['烧掉退路文书'], effective_events: [], filler_signals: [], rebuild_objective: '', irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '空转' };
  assert.throws(() => validateRecoveryDiagnosis({
    quality_curve: [badRowOne, badRowTwo], segment_verdict: { deterioration_found: false, turn_chapter: null, reason: 'x' },
  }, [{ idx: 1, text: textOne }, { idx: 2, text: textTwo }]),
  (error) => error.message.includes('第1章证据') && error.message.includes('第2章 rebuild_objective'),
  '同一批的所有坏行必须聚合到一次报错里');

  // 端到端：两轮缺陷依次修好于第三次通过；纠正指令带最小改动纪律
  const goodRowOne = { ...badRowOne, evidence: ['雨声一阵紧过一阵'] };
  const goodRowTwo = { ...badRowTwo, rebuild_objective: '压缩商议让行动落地' };
  const verdict = { deterioration_found: true, turn_chapter: 2, reason: '第2章空转' };
  const diagnosisPrompts = [];
  let calls = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (jsonMode && prompt.includes('推荐失败返工总诊断')) {
      calls++;
      diagnosisPrompts.push(prompt);
      const rows = calls === 1 ? [badRowOne, badRowTwo] : calls === 2 ? [goodRowOne, badRowTwo] : [goodRowOne, goodRowTwo];
      return { content: JSON.stringify({ quality_curve: rows, segment_verdict: verdict }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const run = await diagnoseRecommendationRecovery(book.id, { startChapter: 1, endChapter: 2, runTaskImpl });
  assert.equal(calls, 3, '诊断批次允许两次纠正，第三次通过');
  assert.equal(run.status, 'planned');
  assert.match(diagnosisPrompts[1], /第1章证据.*第2章 rebuild_objective|第2章 rebuild_objective.*第1章证据/s, '首轮纠正必须聚合全部坏行');
  assert.match(diagnosisPrompts[1], /只修复上面列出的问题，其余行与字段保持与上一版一致/, '纠正指令必须带最小改动纪律');
});

test('V0.100.6 诊断两次纠正仍错才失败关闭（有界，不无界自愈）', async () => {
  const book = store.books.create({ title: '纠正耗尽测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '河滩', status: 'done', wordCount: 40 });
 store.scenes.create(chapter.id, 1, { content: '主角沿着河滩走过芦苇荡。', status: 'done', targetWords: 40 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  let calls = 0;
  const runTaskImpl = async ({ messages }) => {
    calls++;
    return { content: JSON.stringify({
      quality_curve: [{ chapter: 1, action: 'keep', score: 80, evidence: ['根本不存在的句子'], effective_events: [], filler_signals: [], rebuild_objective: '', irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '达标' }],
      segment_verdict: { deterioration_found: false, turn_chapter: null, reason: 'x' },
    }), finishReason: 'stop' };
  };
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, { startChapter: 1, endChapter: 1, runTaskImpl }),
    /无法在原文定位/, '两次纠正仍错必须失败关闭');
  assert.equal(calls, 3, '诊断批次 = 1 次初始 + 2 次纠正，有界');
  const run = store.recommendationRecoveryRuns.list(book.id)[0];
  assert.equal(run.status, 'failed');
});

test('V0.100.1 弹窗钉选进度续跑：诊断断点不重跑已完成批次，正文变化后拒绝沿用', async () => {
  const book = store.books.create({ title: '钉选续跑测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  const chapters = [];
  for (let idx = 1; idx <= 6; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, { title: `章${idx}`, status: 'done', wordCount: 400 });
    const text = paragraphs(Array.from({ length: 20 }, (_, i) => `第${i}段第${idx}章独证${idx}号的人在河滩上走。`), 5);
    store.scenes.create(chapter.id, 1, { content: text, status: 'done', targetWords: 400 });
    chapters.push(chapter);
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const diagnosisFor = idxList => JSON.stringify({
    quality_curve: idxList.map(idx => ({
      chapter: idx, action: 'keep', score: 80, evidence: [`独证${idx}号`],
      effective_events: [], filler_signals: [], rebuild_objective: '',
      irreversible_change: '', character_cost: '', promise_delivery: '', ending_pull: '', reason: '达标',
    })),
    segment_verdict: { deterioration_found: false, turn_chapter: null, reason: '无下坠' },
  });
  const batchPrompts = [];
  let failBatchTwoOnce = true;
  const runTaskImpl = async ({ messages }) => {
    const prompt = messages.at(-1)?.content || '';
    if (prompt.includes('推荐失败返工总诊断')) {
      const idxList = [1, 2, 3, 4, 5, 6].filter(idx => prompt.includes(`独证${idx}号`));
      if (failBatchTwoOnce && idxList.length === 1) {
        failBatchTwoOnce = false;
        throw new Error('模拟弱网中断');
      }
      batchPrompts.push(idxList);
      return { content: diagnosisFor(idxList), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  // 第一次诊断：第 2 批（第6章）中断 → failed，前 5 章批次检查点保留
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl,
  }), /模拟弱网中断/);
  const brokenRun = store.recommendationRecoveryRuns.list(book.id)[0];
  assert.equal(brokenRun.status, 'failed');
  assert.equal(brokenRun.quality_curve.length, 5);

  // 驾驶舱标注：断点续跑类，已诊断到第 5 章
  const annotated = annotateRecoveryRunsResumability(book.id, publicationDashboard(book.id).recoveryRuns);
  const marked = annotated.find(item => item.id === brokenRun.id);
  assert.equal(marked.resumeKind, 'diagnose', '诊断中道失败的运行必须标注为可断点续跑');
  assert.equal(marked.diagnosedThrough, 5);

  // 正文变化后同一进度必须拒绝沿用（指纹不匹配）
 const replacement = paragraphs(Array.from({ length: 20 }, (_, i) => `第${i}段主角烧掉第${i}批退路文书，冒雨冲向营门。`), 5);
  const rewrite = applyValidatedChapterRewrite(book.id, chapters[0], replacement);
  assert.equal(rewrite.ok, true);
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl, resumeRunId: brokenRun.id,
  }), /不能沿用/);

  // 恢复原文后钉选续跑：只补第 6 章一批，前 5 章不得重跑
  const original = paragraphs(Array.from({ length: 20 }, (_, i) => `第${i}段第1章独证1号的人在河滩上走。`), 5);
  const restore = applyValidatedChapterRewrite(book.id, chapters[0], original);
  assert.equal(restore.ok, true);
  const resumed = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl, resumeRunId: brokenRun.id,
  });
  assert.equal(resumed.id, brokenRun.id, '钉选续跑必须回到原运行');
  assert.equal(resumed.status, 'planned');
  assert.deepEqual(batchPrompts, [[1, 2, 3, 4, 5], [6]], '续跑只补断点批次，已完成批次不得重跑');
  assert.equal(resumed.work_orders.length, 0, '全部 keep 时工单为空');

  // planned 状态不是失败/中断，钉选必须显式拒绝（防状态机旁路）
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl, resumeRunId: brokenRun.id,
  }), /只有失败\/中断的运行可以沿用/);
});

test('V0.100.1 中断/失败时的存档写入必须与既有候选合并，禁止整体覆盖', async () => {
  // 用户实证：两小时跑出的 8 章已验证候选，被一次中断重跑时的 failRun 整体覆盖销毁。
  const book = store.books.create({ title: '存档合并测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const paragraphs = (segments, size) => Array.from(
    { length: Math.ceil(segments.length / size) },
    (_, index) => segments.slice(index * size, (index + 1) * size).join(''),
  ).join('\n\n');
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '火盆', status: 'done', wordCount: 400 });
  const fireSegs = Array.from({ length: 20 }, (_, index) => `第${index}段众人守着火盆反复商量，始终没有定论。`);
  const oldText = paragraphs(fireSegs, 5);
  const newText = budgetedCandidate(fireSegs, {
 head: '第0段主角拍案定下撤退批次，众人分头准备。',
 tail: '第19段主角环视众人，沉声道：“天明前，先走伤员。”',
  });
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 400 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '压缩商议', evidence: ['始终没有定论'] }],
  });
  let compareRound = 0;
  const proj = async ({ text }) => evidenceProjection(text);
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      return { content: newText, finishReason: 'stop' };
    }
    if (prompt.includes('匿名对照审稿')) {
      compareRound++;
      const first = compareRound % 2 === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 16,
        scores: first
          ? { A: { progression: 30, consequence: 25, character: 35, pull: 28 }, B: { progression: 82, consequence: 80, character: 78, pull: 76 } }
          : { A: { progression: 82, consequence: 80, character: 78, pull: 76 }, B: { progression: 30, consequence: 25, character: 35, pull: 28 } },
        evidence: first ? { A: ['始终没有定论'], B: ['拍案定下'] } : { A: ['分头准备'], B: ['守着火盆'] },
        reason: '候选有不可逆行动',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: '这不是 JSON，模型输出被截断', finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  // 第一轮：候选通过但整段复核失败 → 候选必须持久化在存档里
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, { runTaskImpl, projectionImpl: proj }), /没有返回有效 JSON/);
  const archived = store.recommendationRecoveryRuns.get(run.id).result.candidates;
  assert.equal(archived.filter(item => item.status === 'accepted').length, 1);
  // 第二轮：从头就处于取消态（本轮连一条审计都不会产生）→ 存档必须原样保留
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl, projectionImpl: proj, signal: ctrl.signal,
  }), /已取消/);
  const afterAbort = store.recommendationRecoveryRuns.get(run.id).result.candidates;
  assert.equal(afterAbort.filter(item => item.status === 'accepted').length, 1,
    '中断重跑时本轮审计为空，整体覆盖会把已验证候选全部销毁');
  assert.equal(afterAbort[0].chapter, 1);
});

test('V0.99 已发布返工必须明确确认，确认也不能跳过快照与整体复核', async () => {
  const book = store.books.create({ title: '返工保护测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '空转', status: 'done', wordCount: 80 });
 const oldText = '众人围着火盆反复商量。天色从黄昏拖到深夜。主角望着营门，却始终没有作出决定。事情仍停在原处。';
 const newText = '主角把退路文书按进火盆。火舌卷上纸角时，他点出十个人冲向营门；守门军汉抬枪，阿弟却从身后把短刀塞进他手里。';
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 80 });
  const nextChapter = store.chapters.create(book.id, volume.id, 2, { title: '营门之后', status: 'done', wordCount: 30 });
  store.scenes.create(nextChapter.id, 1, {
 content: '下一章开头锚点：守门军汉倒在门槛边，主角已经没有回头路。', status: 'done', targetWords: 30,
  });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', remainingAttempts: 2, publishedChapterCount: 1,
  });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    qualityCurve: [{ chapter: 1, score: 25, action: 'rebuild' }],
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '让主角行动并付出代价', evidence: ['始终没有作出决定'] }],
  });

  assert.throws(() => assertPublishedRewritePermission({
    publishedChapterCount: 1, startChapter: 1, endChapter: 1, confirmedPublishedRewrite: false,
  }), /已发布.*明确确认/);
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: false,
  }), /已发布.*明确确认/);
  assert.equal(store.chapters.fullText(chapter.id), oldText, '未确认时旧稿必须逐字保留');
  assert.equal(store.snapshots.list(book.id).length, 0, '未获授权前连恢复快照也不制造');

  let compareRound = 0;
  let rewritePrompt = '';
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      rewritePrompt = prompt;
      return { content: newText, finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工匿名对照审稿')) {
      compareRound++;
      return { content: JSON.stringify(compareRound === 1 ? {
        winner: 'B', margin: 20,
        scores: { A: { progression: 20, consequence: 20, character: 35, pull: 20 }, B: { progression: 85, consequence: 82, character: 80, pull: 78 } },
        evidence: { A: ['始终没有作出决定'], B: ['把退路文书按进火盆'] }, reason: 'B 有不可逆行动',
      } : {
        winner: 'A', margin: 18,
        scores: { A: { progression: 85, consequence: 82, character: 80, pull: 78 }, B: { progression: 20, consequence: 20, character: 35, pull: 20 } },
        evidence: { A: ['冲向营门'], B: ['事情仍停在原处'] }, reason: 'A 有明确代价与后果',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角把退路文书按进火盆'],
        reason: '候选段落产生不可逆决定，且章末冲突已启动', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true, runTaskImpl,
    projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(result.applied.length, 1);
  assert.match(rewritePrompt, /下一章开头锚点/, '返工范围末章也必须读取范围外下一章接口，避免改断后续正文');
  assert.equal(store.snapshots.list(book.id).length, 1, '生成候选前必须先有可恢复快照');
  assert.match(store.chapters.fullText(chapter.id), /把退路文书按进火盆/);
  assert.deepEqual(store.publicationProfiles.get(book.id).pending_sync_chapters, [1]);
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'completed');
  const learned = store.narrativeLessons.list(book.id, { status: 'active' });
  assert.equal(learned.length, 1, '只有通过双向盲审、整体复核和状态回放的整改才能激活经验');
  // V0.100.15：rebuild 工单目标中性化后，自进化经验也从中性目标提取（“有代价的选择…实质变化”）。
  assert.match(learned[0].positive_target, /代价|实质变化/);
  assert.ok(learned[0].evidence.length > 0, '经验必须保留能回到旧稿定位的问题证据');
  assert.equal(learned[0].outcome.revision_id, result.narrativeRevision.revisionId);
});

test('V0.99 整段推进复核失败时不落盘，不因已经花费模型调用而覆盖旧稿', async () => {
  const book = store.books.create({ title: '整段失败测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '空转', status: 'done', wordCount: 80 });
 const oldText = '旧稿中所有人都在等待。主角没有选择。局势一动不动。';
 const newText = '主角推开门，暂时走进雨里，但整段主线仍没有形成新的因果。';
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 80 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 1 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned', confirmedPublishedRewrite: true,
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '改变局势', evidence: ['局势一动不动'] }],
  });
  let comparisons = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode) return { content: newText, finishReason: 'stop' };
    if (prompt.includes('匿名对照审稿')) {
      comparisons++;
      const first = comparisons === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 12,
        scores: first
          ? { A: { progression: 20, consequence: 20, character: 30, pull: 20 }, B: { progression: 75, consequence: 72, character: 70, pull: 70 } }
          : { A: { progression: 75, consequence: 72, character: 70, pull: 70 }, B: { progression: 20, consequence: 20, character: 30, pull: 20 } },
        evidence: first
 ? { A: ['局势一动不动'], B: ['主角推开门'] }
 : { A: ['暂时走进雨里'], B: ['主角没有选择'] },
        reason: '候选略有动作',
      }), finishReason: 'stop' };
    }
    return { content: JSON.stringify({
      verdict: 'fail', sustained_progression: false, evidence: ['整段主线仍没有形成新的因果'],
      reason: '局部有动作但整段质量曲线没有形成持续推进', residual_risks: ['仍然空转'],
    }), finishReason: 'stop' };
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true, runTaskImpl,
  });
  assert.equal(result.applied.length, 0);
  assert.equal(result.globalReview.verdict, 'fail');
  assert.equal(store.chapters.fullText(chapter.id), oldText);
  assert.deepEqual(store.publicationProfiles.get(book.id).pending_sync_chapters, []);
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'failed');
});

test('V0.99 盲审淘汰的完整候选仍保留在隔离审计记录，避免重复烧 Token', async () => {
  const book = store.books.create({ title: '失败候选审计测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '空转', status: 'done', wordCount: 80 });
 const oldText = '众人守着营门等到天亮。主角没有选择，局势仍停在原处。';
 const newText = '主角烧掉退路文书，点出十个人冲向营门；守门军汉抬枪时，他却在门前停住。';
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 80 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '让选择真正改变局势', evidence: ['局势仍停在原处'] }],
  });
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode) return { content: newText, finishReason: 'stop' };
    if (prompt.includes('匿名对照审稿')) {
      // V0.100.2：按指令里的轮次定向（奇数轮 A=旧稿 B=候选，偶数轮换位）——
      // 打回重生后调用次数与轮次不再一一对应，用调用次数奇偶会错位。
      const reviewRound = Number(prompt.match(/第(\d+)轮/)?.[1]) || 1;
      const oddRound = reviewRound % 2 === 1;
      return { content: JSON.stringify({
        // 换位后仍选 B，暴露位置偏差；候选必须淘汰，但不应从审计账本消失。
        winner: 'B', margin: 8,
        scores: oddRound
          ? { A: { progression: 40, consequence: 35, character: 45, pull: 40 }, B: { progression: 72, consequence: 68, character: 66, pull: 64 } }
          : { A: { progression: 72, consequence: 68, character: 66, pull: 64 }, B: { progression: 40, consequence: 35, character: 45, pull: 40 } },
        evidence: oddRound
          ? { A: ['局势仍停在原处'], B: ['烧掉退路文书'] }
 : { A: ['冲向营门'], B: ['主角没有选择'] },
        reason: '两轮结论受位置影响，不能采纳',
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };

  const result = await executeRecommendationRecovery(book.id, run.id, { runTaskImpl });
  assert.equal(result.applied.length, 0);
  assert.equal(store.chapters.fullText(chapter.id), oldText, '盲审不一致时旧稿必须逐字保留');
  const stored = store.recommendationRecoveryRuns.get(run.id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.result.candidates.length, 1, '已生成候选必须进入隔离审计记录');
  assert.equal(stored.result.candidates[0].before, oldText);
  assert.equal(stored.result.candidates[0].after, newText);
  assert.equal(stored.result.candidates[0].status, 'rejected');
  assert.equal(stored.result.candidates[0].comparisons.length, 2);
});

test('V0.99 任一 rebuild 关键章没有合格候选时整批失败关闭，不做半套整改', async () => {
  const book = store.books.create({ title: '关键章缺口测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
 const old1 = '众人围着火盆反复商量。主角始终没有作出决定。局势仍停在原处。';
  const old2 = '第二天众人继续商量。所有人都在等待。局势还是没有变化。';
  const chapter1 = store.chapters.create(book.id, volume.id, 1, { title: '空转一', status: 'done', wordCount: 80 });
  const chapter2 = store.chapters.create(book.id, volume.id, 2, { title: '空转二', status: 'done', wordCount: 80 });
  store.scenes.create(chapter1.id, 1, { content: old1, status: 'done', targetWords: 80 });
  store.scenes.create(chapter2.id, 1, { content: old2, status: 'done', targetWords: 80 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 2 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned', confirmedPublishedRewrite: true,
    workOrders: [
      { chapter: 1, action: 'rebuild', objective: '作出选择', evidence: ['没有作出决定'] },
      { chapter: 2, action: 'rebuild', objective: '改变局势', evidence: ['没有变化'] },
    ],
  });
  let compareRound = 0;
  let globalCalls = 0;
 const improved = '主角把退路文书按进火盆。火舌卷上纸角时，他点出十个人冲向营门；守门军汉抬枪，身后的人已经没有退回原处的借口。';
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && prompt.includes('第1章')) return { content: improved, finishReason: 'stop' };
    if (!jsonMode && prompt.includes('第2章')) return { content: old2, finishReason: 'stop' };
    if (prompt.includes('匿名对照审稿')) {
      compareRound++;
      const first = compareRound % 2 === 1;
      return { content: JSON.stringify({
        winner: first ? 'B' : 'A', margin: 20,
        scores: first
          ? { A: { progression: 20, consequence: 20, character: 30, pull: 20 }, B: { progression: 84, consequence: 82, character: 78, pull: 76 } }
          : { A: { progression: 84, consequence: 82, character: 78, pull: 76 }, B: { progression: 20, consequence: 20, character: 30, pull: 20 } },
        evidence: first
          ? { A: ['没有作出决定'], B: ['退路文书按进火盆'] }
          : { A: ['冲向营门'], B: ['局势仍停在原处'] },
        reason: '候选有不可逆行动',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      globalCalls++;
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true, evidence: ['退路文书按进火盆'],
        reason: '测试不应抵达这里', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error('未覆盖任务');
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true, runTaskImpl,
  });
  assert.equal(result.applied.length, 0);
  assert.equal(globalCalls, 0, '关键重构章缺候选时无需再花整段复核调用');
  assert.equal(store.chapters.fullText(chapter1.id), old1, '已通过的单章候选也不能半套落盘');
  assert.equal(store.chapters.fullText(chapter2.id), old2);
  assert.match(store.recommendationRecoveryRuns.get(run.id).error, /关键重构章.*未形成合格候选/);
});

test('V0.99 动态反馈只追加到 L4 最终用户任务，写作与审核从同一函数取数', () => {
  const book = store.books.create({ title: 'L4 注入测试', genre: '历史', platform: '番茄' });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', remainingAttempts: 2, editorFeedback: '前20章不合格',
  });
  const original = '请生成下一章细纲';
  const appended = appendPublicationFeedback(original, book.id, { targetChapterIdx: 21 });
  assert.ok(appended.startsWith(original));
  assert.match(appended, /平台发布与推荐反馈/);
  assert.match(appended, /当前规划第 21 章/);

  for (const file of ['planning/outline.js', 'pipeline/write.js', 'pipeline/audit.js', 'planning/volumereview.js', 'quality/polish.js']) {
    const source = fs.readFileSync(new URL(`../server/engine/${file}`, import.meta.url), 'utf8');
    assert.match(source, /appendPublicationFeedback/, `${file} 必须消费同一份发布反馈函数`);
  }
  const writeSource = fs.readFileSync(new URL('../server/engine/pipeline/write.js', import.meta.url), 'utf8');
  assert.match(writeSource, /instructionWithFeedback\s*=\s*appendPublicationFeedback\(\s*instruction/s,
    '发布反馈应先注入任务，再把中断草稿放回指令末尾，不能破坏续写断点的近因位置');
  assert.ok(writeSource.indexOf('instructionWithFeedback') < writeSource.indexOf('const instructionFinal'),
    '正文草稿必须仍是最终用户指令的最末内容');
});

test('V0.99 推荐返工审稿隔离旧正文历史，避免候选与既有 assistant 稿件串线', () => {
  const source = fs.readFileSync(new URL('../server/engine/recovery/recommendation_recovery.js', import.meta.url), 'utf8');
  assert.match(source, /assembleReviewMessages/);
  assert.doesNotMatch(source, /\bassembleMessages\b/);
});

test('V0.99 整章候选映射回多场景时只在完整句边界切分', () => {
  const text = [
 '主角推开营门，雨水顺着刀背淌下来。他回头看了一眼火盆，退路文书已经烧成灰。',
    '守门军汉横枪拦路，十名同伴却没有后退。阿弟把短刀塞进他手里，自己守住了门轴。',
 '号角从北坡响起，营中的争执终于变成行动。主角点出两人传令，其余人跟他冲进雨幕。',
  ].join('\n\n');
  const pieces = splitChapterTextForScenes(text, [
    { content: '旧场景一'.repeat(10) }, { content: '旧场景二'.repeat(10) }, { content: '旧场景三'.repeat(10) },
  ]);
  assert.equal(pieces.length, 3);
  for (const piece of pieces) assert.match(piece, /[。！？!?；;][”’」』】）]?$/);
  const normalize = value => value.replace(/\s+/g, '');
  assert.equal(normalize(pieces.join('\n\n')), normalize(text), '安全切分不能丢字、重字或把句子截断');
});

test('V0.99 所有常用正文写入路径都会登记已发布章节的线上同步债务', () => {
  for (const file of ['pipeline/write.js', 'quality/polish.js']) {
    const source = fs.readFileSync(new URL(`../server/engine/${file}`, import.meta.url), 'utf8');
    assert.match(source, /markPendingSync/, `${file} 改动已发布正文后必须加入线上待同步清单`);
  }
  const auditSource = fs.readFileSync(new URL('../server/engine/pipeline/audit.js', import.meta.url), 'utf8');
  assert.match(auditSource, /applyValidatedSceneRewrite/,
    'audit.js 必须复用 polish 的场景写入门禁，由单一入口登记线上同步债务与叙事状态失效');
  const workshopSource = fs.readFileSync(new URL('../web/js/views/workshop.js', import.meta.url), 'utf8');
  assert.doesNotMatch(workshopSource, /仅正文，不影响历史堆/,
    '手工编辑提示不能继续声称历史堆不会更新');

  const book = store.books.create({ title: '整章写入债务测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '已发布章', status: 'done', wordCount: 20 });
  store.scenes.create(chapter.id, 1, { content: '旧稿在营门前停住，没有发生变化。', status: 'done' });
  store.publicationProfiles.upsert(book.id, { publishedChapterCount: 1 });
  const applied = applyValidatedChapterRewrite(book.id, chapter, '新稿烧掉退路文书，十个人当夜冲出营门。');
  assert.equal(applied.ok, true);
  assert.deepEqual(store.publicationProfiles.get(book.id).pending_sync_chapters, [1],
    '整章安全落盘函数自身必须原子登记待同步，不能依赖每个调用方记得补记');
});

test('V0.99 普通全书打磨默认跳过已发布边界，必须走专用返工闭环', async () => {
  const book = store.books.create({ title: '普通打磨保护', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '已发布章', status: 'done', wordCount: 20 });
  store.scenes.create(chapter.id, 1, { content: '这是一段已经发布的正文，不应被普通打磨入口悄悄覆盖。', status: 'done' });
  store.publicationProfiles.upsert(book.id, { publishedChapterCount: 1, recommendationStage: 'failed' });
  await assert.rejects(() => runPolish(book.id), /已发布.*专用.*返工/);
  assert.equal(store.snapshots.list(book.id).length, 0, '没有可打磨未发布章时不得创建无意义快照');
});

test('V0.99 自动创作只在发布快照过期时刷新，抓取逻辑必须接入 pilot', () => {
  const now = 1787546000000;
  assert.equal(shouldRefreshPublication(null, { now }), false);
  assert.equal(shouldRefreshPublication({ work_url: '' }, { now }), false);
  assert.equal(shouldRefreshPublication({ work_url: 'https://fanqienovel.com/page/1', last_synced_at: null }, { now }), true);
  assert.equal(shouldRefreshPublication({ work_url: 'https://fanqienovel.com/page/1', last_synced_at: now - 60_000 }, { now }), false);
  assert.equal(shouldRefreshPublication({ work_url: 'https://fanqienovel.com/page/1', last_synced_at: now - 7 * 60 * 60_000 }, { now }), true);
  const pilotSource = fs.readFileSync(new URL('../server/engine/pipeline/pilot.js', import.meta.url), 'utf8');
  assert.match(pilotSource, /syncFanqiePublication/);
  assert.match(pilotSource, /publication_feedback/);
});

test.skip('V0.100.1 盲审结构失败带反馈重答一次后成功，不杀死整批返工', async () => {
  const book = store.books.create({ title: '盲审重答测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '空转', status: 'done', wordCount: 80 });
 const oldText = '众人围着火盆反复商量。天色从黄昏拖到深夜。主角望着营门，却始终没有作出决定。事情仍停在原处。';
 const newText = '主角把退路文书按进火盆。火舌卷上纸角时，他点出十个人冲向营门；守门军汉抬枪，阿弟却从身后把短刀塞进他手里。';
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 80 });
  const nextChapter = store.chapters.create(book.id, volume.id, 2, { title: '营门之后', status: 'done', wordCount: 30 });
  store.scenes.create(nextChapter.id, 1, {
 content: '下一章开头锚点：守门军汉倒在门槛边，主角已经没有回头路。', status: 'done', targetWords: 30,
  });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', remainingAttempts: 2, publishedChapterCount: 1,
  });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    qualityCurve: [{ chapter: 1, score: 25, action: 'rebuild' }],
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '让主角行动并付出代价', evidence: ['始终没有作出决定'] }],
  });

  let compareCalls = 0;
  let correctionPrompt = '';
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: newText, finishReason: 'stop' };
    if (prompt.includes('推荐返工匿名对照审稿')) {
      compareCalls++;
      if (compareCalls === 1) return { content: '模型输出乱码{{{不是JSON', finishReason: 'stop' };
      if (compareCalls === 2) correctionPrompt = prompt;
      return { content: JSON.stringify(compareCalls === 2 ? {
        winner: 'B', margin: 20,
        scores: { A: { progression: 20, consequence: 20, character: 35, pull: 20 }, B: { progression: 85, consequence: 82, character: 80, pull: 78 } },
        evidence: { A: ['始终没有作出决定'], B: ['把退路文书按进火盆'] }, reason: 'B 有不可逆行动',
      } : {
        winner: 'A', margin: 18,
        scores: { A: { progression: 85, consequence: 82, character: 80, pull: 78 }, B: { progression: 20, consequence: 20, character: 35, pull: 20 } },
        evidence: { A: ['冲向营门'], B: ['事情仍停在原处'] }, reason: 'A 有明确代价与后果',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: ['主角把退路文书按进火盆'],
        reason: '候选段落产生不可逆决定，且章末冲突已启动', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true, runTaskImpl,
    projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(result.applied.length, 1, '盲审首轮结构失败重答一次后必须走完返工');
  assert.equal(compareCalls, 3, '第1轮盲审失败+重答，第2轮一次通过');
  assert.match(correctionPrompt, /上轮本地校验未通过/, '重答请求必须带本地校验反馈');
});

test('V0.100.1 整段复核证据定位失败带反馈重答一次后通过', async () => {
  const book = store.books.create({ title: '复核重答测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '空转', status: 'done', wordCount: 80 });
 const oldText = '众人围着火盆反复商量。天色从黄昏拖到深夜。主角望着营门，却始终没有作出决定。事情仍停在原处。';
 const newText = '主角把退路文书按进火盆。火舌卷上纸角时，他点出十个人冲向营门；守门军汉抬枪，阿弟却从身后把短刀塞进他手里。';
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 80 });
  const nextChapter = store.chapters.create(book.id, volume.id, 2, { title: '营门之后', status: 'done', wordCount: 30 });
  store.scenes.create(nextChapter.id, 1, {
 content: '下一章开头锚点：守门军汉倒在门槛边，主角已经没有回头路。', status: 'done', targetWords: 30,
  });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', remainingAttempts: 2, publishedChapterCount: 1,
  });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    qualityCurve: [{ chapter: 1, score: 25, action: 'rebuild' }],
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '让主角行动并付出代价', evidence: ['始终没有作出决定'] }],
  });

  let compareRound = 0;
  let globalCalls = 0;
  let globalCorrection = '';
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: newText, finishReason: 'stop' };
    if (prompt.includes('推荐返工匿名对照审稿')) {
      compareRound++;
      return { content: JSON.stringify(compareRound === 1 ? {
        winner: 'B', margin: 20,
        scores: { A: { progression: 20, consequence: 20, character: 35, pull: 20 }, B: { progression: 85, consequence: 82, character: 80, pull: 78 } },
        evidence: { A: ['始终没有作出决定'], B: ['把退路文书按进火盆'] }, reason: 'B 有不可逆行动',
      } : {
        winner: 'A', margin: 18,
        scores: { A: { progression: 85, consequence: 82, character: 80, pull: 78 }, B: { progression: 20, consequence: 20, character: 35, pull: 20 } },
        evidence: { A: ['冲向营门'], B: ['事情仍停在原处'] }, reason: 'A 有明确代价与后果',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      globalCalls++;
      if (globalCalls === 2) globalCorrection = prompt;
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true,
 evidence: [globalCalls === 1 ? '候选正文里根本不存在这句话' : '主角把退路文书按进火盆'],
        reason: '候选段落产生不可逆决定，且章末冲突已启动', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  const result = await executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true, runTaskImpl,
    projectionImpl: async ({ text }) => evidenceProjection(text),
  });
  assert.equal(result.applied.length, 1, '整段复核幻觉引文重答一次后必须走完返工');
  assert.equal(globalCalls, 2, '整段复核只重答一次');
  assert.match(globalCorrection, /无法在候选正文定位/, '重答反馈必须带原始定位错误');
});

test('V0.100.2 整段复核证据夹带分析前缀：剥出「」内真引文放行，纯幻觉仍判废', async () => {
  const makeCase = (title) => {
    const book = store.books.create({ title, genre: '历史', platform: '番茄' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '空转', status: 'done', wordCount: 80 });
 const oldText = '众人围着火盆反复商量。天色从黄昏拖到深夜。主角望着营门，却始终没有作出决定。事情仍停在原处。';
 const newText = '主角把退路文书按进火盆。火舌卷上纸角时，他点出十个人冲向营门；守门军汉抬枪，阿弟却从身后把短刀塞进他手里。';
    store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 80 });
    store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'planned',
      workOrders: [{ chapter: 1, action: 'tune', objective: '让主角行动并付出代价', evidence: ['始终没有作出决定'] }],
    });
    return { book, chapter, run, oldText, newText };
  };
  const makeMock = (newText, globalEvidence) => {
    let compareRound = 0;
    let globalCalls = 0;
    const state = { get globalCalls() { return globalCalls; } };
    const runTaskImpl = async ({ messages, jsonMode }) => {
      const prompt = messages.at(-1)?.content || '';
      if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: newText, finishReason: 'stop' };
      if (prompt.includes('推荐返工匿名对照审稿')) {
        compareRound++;
        return { content: JSON.stringify(compareRound % 2 === 1 ? {
          winner: 'B', margin: 20,
          scores: { A: { progression: 20, consequence: 20, character: 35, pull: 20 }, B: { progression: 85, consequence: 82, character: 80, pull: 78 } },
          evidence: { A: ['始终没有作出决定'], B: ['把退路文书按进火盆'] }, reason: 'B 有不可逆行动',
        } : {
          winner: 'A', margin: 18,
          scores: { A: { progression: 85, consequence: 82, character: 80, pull: 78 }, B: { progression: 20, consequence: 20, character: 35, pull: 20 } },
          evidence: { A: ['冲向营门'], B: ['事情仍停在原处'] }, reason: 'A 有明确代价与后果',
        }), finishReason: 'stop' };
      }
      if (prompt.includes('推荐返工整段复核')) {
        globalCalls++;
        return { content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          evidence: [globalEvidence], reason: '整段形成推进', residual_risks: [],
        }), finishReason: 'stop' };
      }
      throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
    };
    return { runTaskImpl, state };
  };
  const proj = async ({ text }) => evidenceProjection(text);

  // 分析前缀 + 「真引文」：确定性剥壳后放行，不消耗重答
  const good = makeCase('复核剥壳放行');
 const goodMock = makeMock(good.newText, '第1章布置、第1章兑现的因果接力：「主角把退路文书按进火盆。」');
  const goodResult = await executeRecommendationRecovery(good.book.id, good.run.id, {
    runTaskImpl: goodMock.runTaskImpl, projectionImpl: proj,
  });
  assert.equal(goodResult.applied.length, 1, '剥出真引文后整段复核必须通过');
  assert.equal(goodMock.state.globalCalls, 1, '剥壳成功不再消耗重答');
 assert.deepEqual(goodResult.globalReview.evidence, ['主角把退路文书按进火盆。'], '复核证据必须归一为真引文');

  // 「纯幻觉」：剥出来也定位不到，两次重答后失败关闭，旧稿保留
  const bad = makeCase('复核剥壳判废');
  const badMock = makeMock(bad.newText, '分析：「候选正文里根本不存在这句话」');
  await assert.rejects(() => executeRecommendationRecovery(bad.book.id, bad.run.id, {
    runTaskImpl: badMock.runTaskImpl, projectionImpl: proj,
  }), /无法在候选正文定位/, '幻觉引文剥壳后仍定位不到，必须失败关闭');
  assert.equal(badMock.state.globalCalls, 2, '幻觉引文重答一次后仍错才判废');
  assert.equal(store.chapters.fullText(bad.chapter.id), bad.oldText, '旧稿逐字保留');
  assert.equal(store.recommendationRecoveryRuns.get(bad.run.id).status, 'failed');
});

test('V0.100.1 整段复核重答仍错则失败关闭，旧稿逐字保留', async () => {
  const book = store.books.create({ title: '复核二次失败测试', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '空转', status: 'done', wordCount: 80 });
 const oldText = '众人围着火盆反复商量。天色从黄昏拖到深夜。主角望着营门，却始终没有作出决定。事情仍停在原处。';
 const newText = '主角把退路文书按进火盆。火舌卷上纸角时，他点出十个人冲向营门；守门军汉抬枪，阿弟却从身后把短刀塞进他手里。';
  store.scenes.create(chapter.id, 1, { content: oldText, status: 'done', targetWords: 80 });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', remainingAttempts: 2, publishedChapterCount: 1,
  });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    qualityCurve: [{ chapter: 1, score: 25, action: 'rebuild' }],
    workOrders: [{ chapter: 1, action: 'rebuild', objective: '让主角行动并付出代价', evidence: ['始终没有作出决定'] }],
  });

  let compareRound = 0;
  let globalCalls = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) return { content: newText, finishReason: 'stop' };
    if (prompt.includes('推荐返工匿名对照审稿')) {
      compareRound++;
      return { content: JSON.stringify(compareRound === 1 ? {
        winner: 'B', margin: 20,
        scores: { A: { progression: 20, consequence: 20, character: 35, pull: 20 }, B: { progression: 85, consequence: 82, character: 80, pull: 78 } },
        evidence: { A: ['始终没有作出决定'], B: ['把退路文书按进火盆'] }, reason: 'B 有不可逆行动',
      } : {
        winner: 'A', margin: 18,
        scores: { A: { progression: 85, consequence: 82, character: 80, pull: 78 }, B: { progression: 20, consequence: 20, character: 35, pull: 20 } },
        evidence: { A: ['冲向营门'], B: ['事情仍停在原处'] }, reason: 'A 有明确代价与后果',
      }), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工整段复核')) {
      globalCalls++;
      return { content: JSON.stringify({
        verdict: 'pass', sustained_progression: true, evidence: ['永远定位不到的引文'],
        reason: '持续幻觉', residual_risks: [],
      }), finishReason: 'stop' };
    }
    throw new Error(`未覆盖测试任务：${prompt.slice(0, 60)}`);
  };
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true, runTaskImpl,
    projectionImpl: async ({ text }) => evidenceProjection(text),
  }), /无法在候选正文定位/);
  assert.equal(globalCalls, 2, '只准重答一次，第二次仍错立即失败关闭');
  assert.equal(store.chapters.fullText(chapter.id), oldText, '旧稿必须逐字保留');
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'failed');
});
