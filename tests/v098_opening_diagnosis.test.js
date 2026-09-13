import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as store from '../server/db/store.js';
import { createOpeningFixture, validDiagnosis } from './helpers/opening_fixture.js';

let book, firstScene;

beforeEach(async () => {
  ({ book, firstScene } = createOpeningFixture(store));
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: {
    premise_in_one_breath: '一个孩子学会保护别人', primary_attraction_axis: '保护与成长', secondary_axes: [],
    protagonist_now: { lack: '弱小', immediate_need: '护住家人', agency_pattern: '观察后保护' },
    payoff_ladder: { near: ['有效选择'], middle: ['保护同伴'], long: ['守住山河'] },
    texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
    protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
  } });
});

test('V0.98 openingSlices 返回稳定首屏且本地信号只报告客观事实', async () => {
  const { openingSlices, localOpeningSignals, openingFingerprint } = await import('../server/engine/planning/opening_diagnosis.js');
  const text = '晒场上的秋阳还带着热，天边压着一线暗红。'.repeat(30) + '北边来信了。';
  const slices = openingSlices(text);
  assert.equal(slices.head80.length, 80);
  assert.equal(slices.head300.length, 300);
  assert.equal(slices.head800.length, Math.min(800, text.length));
  assert.equal(slices.head2000.length, Math.min(2000, text.length));
  assert.equal(slices.tail200, text.trim().slice(-200));

  const signals = localOpeningSignals([{ idx: 1, title: '庙会灯影', text }]);
  const chapter = signals.chapters[0];
  assert.equal(chapter.idx, 1);
  assert.equal(Object.hasOwn(chapter, 'flat_opening'), false);
  assert.equal(Object.hasOwn(chapter, 'has_hook'), false);
  assert.equal(Object.hasOwn(chapter, 'reader_will_leave'), false);
  assert.equal(openingFingerprint({ title: 'X' }, [{ idx: 1, title: '庙会灯影', text }]).length, 64);
});

test('V0.98 吸引力本地词表只作信号，不把含蓄历史场景误判为平淡或无钩子', async () => {
  const { attractionLocalRules, countAgencySignals } = await import('../server/engine/quality/attraction.js');
 const text = '晒场上的秋阳还带着热，天边压着一线暗红。主角把弟弟往上颠了颠。北边摊主忽然收担，父亲夜里仍在磨刀。最后，那点红光比先前更亮了。';
  const issues = attractionLocalRules(text, { isHistory: true });
  assert.equal(issues.some(issue => issue.type === '平淡开场'), false);
  assert.equal(issues.some(issue => issue.type === '无章末钩子'), false);
  assert.deepEqual(countAgencySignals('他站着。他看着。他决定回去。'), { active: 1, passive: 0 });
});

test('V0.98 openingFingerprint 对正文和简介敏感、对对象键顺序稳定', async () => {
  const { openingFingerprint } = await import('../server/engine/planning/opening_diagnosis.js');
  const chapters = [{ idx: 1, title: '一', text: '正文' }];
  const a = openingFingerprint({ title: 'X', blurb: '简介' }, chapters);
  const b = openingFingerprint({ blurb: '简介', title: 'X' }, chapters);
  const c = openingFingerprint({ title: 'X', blurb: '改过' }, chapters);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, openingFingerprint({ title: 'X', blurb: '简介' }, [{ ...chapters[0], text: '改文' }]));
});

test('V0.98 启动迁移以当前场景正文自动愈合旧历史漂移', () => {
  const beforeText = store.chapters.fullText(firstScene.chapter_id);
  const historySeq = store.history.append(book.id, 'assistant', firstScene.content);
  store.scenes.update(firstScene.id, { historySeq });
  store.history.replace(book.id, historySeq, 'assistant', '旧版正文，不应再进入后续上下文。');

  const result = store.repairSceneHistoryDrift(book.id);
  const history = store.db().prepare('SELECT role, content FROM history WHERE book_id=? AND seq=?')
    .get(book.id, historySeq);
  assert.equal(result.repaired, 1);
  assert.equal(result.unsafe, 0);
  assert.equal(history.role, 'assistant');
  assert.equal(history.content, store.scenes.get(firstScene.id).content);
  assert.equal(store.chapters.fullText(firstScene.chapter_id), beforeText, '自愈不得修改正文');

  const source = fs.readFileSync('server/db/store.js', 'utf8');
  assert.match(source, /function migrate\(\)[\s\S]*repairSceneHistoryDrift\(\)/);
});

test('V0.98 诊断提示词先做冷读，再整理证据，不用平均分或平台概率裁决', async () => {
  const { openingDiagnosisInstruction } = await import('../server/engine/prompts.js');
  const text = openingDiagnosisInstruction({
 book: { title: '本作', blurb: '九岁流民走到钓鱼城' },
    storyPromise: '核心吸引轴：保护与成长',
 fullChapters: [{ idx: 1, title: '庙会灯影', text: '主角护住弟弟。' }],
    laterChapters: [{ idx: 4, title: '饿殍路', summary: '流亡', head300: '路上', tail200: '向北' }],
    localSignals: { chapters: [{ idx: 1, chars: 8 }] },
    platformGuidance: '【官方创作指导（不是审核阈值）】先呈现吸引点',
    genreProfile: '【题材样本观察（不是因果规则）】具体困局中的人物选择',
  });
  assert.match(text, /先以第一次阅读者|冷读/);
  assert.match(text, /我以为主角是谁/);
  assert.match(text, /哪.*开始.*注意力|attention_drop/s);
  assert.match(text, /分不清.*说话人|speaker_confusion/s);
  assert.match(text, /模板|AI拼接|artificial_or_ai_feel/s);
  assert.match(text, /strongest_axis/);
  assert.match(text, /chapter.*start.*end.*quote.*cause.*smallest_fix/s);
  assert.match(text, /baseline/);
  assert.match(text, /禁止用平均分自动/);
  assert.match(text, /smallest_fix[\s\S]*不得新增人物、事件、冲突、物件或设定/);
  assert.match(text, /只是另一类读者的偏好[\s\S]*tradeoffs/);
  assert.match(text, /无法从原文逐字复制[\s\S]*宁可不报/);
  assert.doesNotMatch(text, /预计.*留存|签约概率\s*[><=]|根据平均分自动|平均分超过/);
});

test('V0.98 诊断保存双指纹，正文或创作画像变化后自动陈旧', async () => {
  const { diagnoseOpening, openingDiagnosisStatus } = await import('../server/engine/planning/opening_diagnosis.js');
  const { lockStoryPromiseFields } = await import('../server/engine/planning/story_promise.js');
  const first = await diagnoseOpening(book.id, { data: validDiagnosis });
  assert.equal(first.ok, true);
  assert.equal(first.report.version, 3);
  assert.equal(first.report.source_fingerprint.length, 64);
  assert.equal(first.report.promise_profile_fingerprint.length, 64);
  assert.equal(openingDiagnosisStatus(book.id).stale, false);

  store.scenes.update(firstScene.id, { content: '变更后的正文' });
  assert.equal(openingDiagnosisStatus(book.id).stale, true);
 store.scenes.update(firstScene.id, { content: '天边压着一线暗红。主角把弟弟往上颠了颠。' });
  assert.equal(openingDiagnosisStatus(book.id).stale, false);
  lockStoryPromiseFields(book.id, { primary_attraction_axis: '人物选择' });
  assert.equal(openingDiagnosisStatus(book.id).stale, true);
});

test('V0.98 坏诊断 fail-closed，保留旧报告并记录失败', async () => {
  const { diagnoseOpening, openingDiagnosisStatus } = await import('../server/engine/planning/opening_diagnosis.js');
  await diagnoseOpening(book.id, { data: validDiagnosis });
  const before = store.materials.get(book.id, 'opening_diagnosis').content;
  await assert.rejects(
    diagnoseOpening(book.id, { data: { cold_read: {}, rubric: {}, hard_failures: [] } }),
    error => error?.code === 'OPENING_DIAG_INVALID',
  );
  assert.equal(store.materials.get(book.id, 'opening_diagnosis').content, before);
  assert.ok(openingDiagnosisStatus(book.id).last_attempt_failed?.error);
});

test('V0.98 单条 issue 引文无法核验时隔离该意见，其他有效诊断照常保存', async () => {
  const { diagnoseOpening, openingDiagnosisStatus } = await import('../server/engine/planning/opening_diagnosis.js');
  const report = structuredClone(validDiagnosis);
  report.strategies.push({
    kind: 'head_rewrite', creative_hypothesis: '依赖第二条意见', expected_gain: '未知', risks: [],
  });
  report.recommendation = { kind: 'head_rewrite', reason: '依赖第二条无法核验的意见' };
  report.issues = [
    {
      severity: 'medium', chapter: 1, start: 999, end: 1008,
 quote: '主角把弟弟往上颠了颠', cause: '真实问题', smallest_fix: '压缩这句',
    },
    {
      severity: 'low', chapter: 2, start: 0, end: 8,
      quote: '不存在于第二章的模型改写句', cause: '猜测', smallest_fix: '改',
    },
  ];

  const result = await diagnoseOpening(book.id, { data: report });
  assert.equal(result.ok, true);
  assert.equal(result.report.issues.length, 1);
 assert.equal(result.report.issues[0].quote, '主角把弟弟往上颠了颠');
  assert.deepEqual(result.report.validation_warnings, [{
    kind: 'issue', index: 1, chapter: 2, code: 'quote_not_found',
  }]);
  assert.deepEqual(result.report.recommendation, {
    kind: 'baseline', reason: '部分模型意见缺少可核对的正文引文，已隔离；本次不据此建议修改原稿。',
  });
  assert.equal(openingDiagnosisStatus(book.id).last_attempt_failed, null);
});

test('V0.98 含平台流量预测字段时仍然拒绝保存', async () => {
  const { diagnoseOpening } = await import('../server/engine/planning/opening_diagnosis.js');
  const prediction = structuredClone(validDiagnosis);
  prediction.expected_retention = '60%';
  await assert.rejects(diagnoseOpening(book.id, { data: prediction }), error => error?.code === 'OPENING_DIAG_INVALID');
});

test('V0.98 tradeoff 引文无法核验时同样隔离，不让软意见拖垮诊断', async () => {
  const { validateOpeningDiagnosis } = await import('../server/engine/planning/opening_diagnosis.js');
  const report = structuredClone(validDiagnosis);
  report.tradeoffs = [{
    chapter: 2, start: 0, end: 8, quote: '模型概括出的近似句', reason: '某类读者可能偏好更快节奏',
  }];

  const result = validateOpeningDiagnosis(report, [{ idx: 1, text: store.chapters.fullText(firstScene.chapter_id) }]);
  assert.deepEqual(result.tradeoffs, []);
  assert.deepEqual(result.validation_warnings, [{
    kind: 'tradeoff', index: 0, chapter: 2, code: 'quote_not_found',
  }]);
  assert.equal(result.recommendation.kind, 'baseline');
});

test('V0.98 issue 引文真实但模型字符范围错误时由本地正文精确校准', async () => {
  const { validateOpeningDiagnosis } = await import('../server/engine/planning/opening_diagnosis.js');
  const text = store.chapters.fullText(firstScene.chapter_id);
 const quote = '主角把弟弟往上颠了颠';
  const report = structuredClone(validDiagnosis);
  report.issues = [{
    severity: 'high', chapter: 1, start: 999, end: 1008, quote,
    cause: '人物行动出现偏晚', smallest_fix: '提前行动',
  }];

  const issue = validateOpeningDiagnosis(report, [{ idx: 1, text }]).issues[0];
  assert.equal(issue.start, text.indexOf(quote));
  assert.equal(issue.end, text.indexOf(quote) + quote.length);
  assert.equal(issue.quote, quote);
  assert.equal(issue.evidence_alignment, 'local_exact');
  assert.equal(issue.range_repaired, true);
});

test('V0.98 smallest_fix 不得把正文外的新人物事件带入候选链', async () => {
  const { validateOpeningDiagnosis } = await import('../server/engine/planning/opening_diagnosis.js');
  const text = store.chapters.fullText(firstScene.chapter_id);
 const quote = '主角把弟弟往上颠了颠';
  const report = structuredClone(validDiagnosis);
  report.issues = [{
    severity: 'medium', chapter: 1, start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote,
    cause: '起步重复', smallest_fix: '删减重复描写，直接进入新冲突（如刘癞子夺粮）。',
  }];

  const issue = validateOpeningDiagnosis(report, [{ idx: 1, text }]).issues[0];
  assert.equal(issue.fix_sanitized, true);
  assert.doesNotMatch(issue.smallest_fix, /刘癞子|夺粮|新冲突/);
  assert.match(issue.smallest_fix, /只使用.*已有/);
});

test('V0.98 只针对另一类读者偏好的速度意见不进自动修改链', async () => {
  const { validateOpeningDiagnosis } = await import('../server/engine/planning/opening_diagnosis.js');
  const text = store.chapters.fullText(firstScene.chapter_id);
  const quote = '天边压着一线暗红';
  const preference = structuredClone(validDiagnosis);
  preference.issues = [{
    severity: 'medium', chapter: 1, start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote,
    cause: '依恋铺垫较慢，追求快节奏的读者可能会走神。',
    smallest_fix: '把威胁提前，压缩家庭日常。',
  }];
  const moved = validateOpeningDiagnosis(preference, [{ idx: 1, text }]);
  assert.equal(moved.issues.length, 0);
  assert.equal(moved.tradeoffs.length, 1);
  assert.equal(moved.tradeoffs[0].source, 'reader_preference');

  const concrete = structuredClone(preference);
  concrete.issues[0].cause = '说话人指代不清，即使快节奏读者也需要回读。';
  const kept = validateOpeningDiagnosis(concrete, [{ idx: 1, text }]);
  assert.equal(kept.issues.length, 1, '可确定的理解障碍不得被偏好分流掉');
});

test('V0.98 issue 只有换行空白差异时校准为正文中的逐字引文', async () => {
  const { validateOpeningDiagnosis } = await import('../server/engine/planning/opening_diagnosis.js');
 const text = '天边压着一线暗红。\n\n主角把弟弟往上颠了颠。';
  const report = structuredClone(validDiagnosis);
  report.issues = [{
    severity: 'medium', chapter: 1, start: 0, end: 3,
 quote: '天边压着一线暗红。主角把弟弟往上颠了颠。',
    cause: '段间承接需要核对', smallest_fix: '只调整承接',
  }];

  const issue = validateOpeningDiagnosis(report, [{ idx: 1, text }]).issues[0];
  assert.equal(issue.start, 0);
  assert.equal(issue.end, text.length);
  assert.equal(issue.quote, text);
  assert.equal(issue.evidence_alignment, 'local_whitespace');
});

test('V0.98 诊断材料不进入历史堆或普通下一章消息', async () => {
  const { diagnoseOpening } = await import('../server/engine/planning/opening_diagnosis.js');
  const { ensureHistory, rebuildHistory } = await import('../server/engine/planning/outline.js');
  const { assembleMessages } = await import('../server/llm/cache.js');
  const report = structuredClone(validDiagnosis);
  report.recommendation.reason = 'DIAGNOSIS_PRIVATE_MARKER';
  await diagnoseOpening(book.id, { data: report });
  ensureHistory(book.id);
  rebuildHistory(book.id, '诊断隔离测试');
  const messages = assembleMessages(book.id, [{ role: 'user', content: '生成下一章' }]);
  const joined = messages.map(item => item.content).join('\n');
  assert.doesNotMatch(joined, /DIAGNOSIS_PRIVATE_MARKER|smallest_fix|chapter1_cold_open/);
});
