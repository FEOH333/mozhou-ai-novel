// V0.100.7：推荐返工运行策略、工单身份与候选血缘的纯状态合同。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  RECOVERY_CONTRACT_VERSION,
  RECOVERY_PLAN_CONTRACT_VERSION,
  normalizeCandidateProvenance,
  normalizeRecoveryPolicy,
  recoveryFailureLedgerKey,
  recoveryWorkOrderFingerprint,
  resolveRecoveryPolicy,
} from '../server/engine/recovery/recovery_contract.js';

const store = await import('../server/db/store.js');
const {
  annotateRecoveryRunsResumability,
  diagnoseRecommendationRecovery,
  validateRecoverySynthesis,
  executeRecommendationRecovery,
  validateRecoveryProseImprovement,
} = await import('../server/engine/recovery/recommendation_recovery.js');
const { publicationDashboard } = await import('../server/engine/quality/publication_feedback.js');
const { validateChapterRewrite } = await import('../server/engine/quality/polish.js');

function recoveryFixtureText() {
  return [
 '雨脚越过东坡时，主角先把木尺压进泥里，再叫何平记下土色和水痕。',
    '石九从下方递来麻绳，绳结沾着细沙，众人因此停下第一辆石车。',
    '梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
 '主角没有急着定案，只让两名军汉分别量坡高和沟深，把数字写在同一张纸上。',
    '“山道还没通，谁也不许催车。”梁茂按住铜锣，负责运料的人只得停在湿土外。',
    '“绕东坡。”何平刚开口，石九便指出那条小路承不住满车青石，两人当场争了起来。',
 '主角把空车推上小路，让众人亲眼看见左轮陷进软泥，争论这才停住。',
    '他们拆下两块车板铺在沟口，又用旧绳把第一块青石分成两段起运。',
    '第一段青石过沟时压弯了车板，梁茂立即挥手停下后车，没有人继续冒险。',
    '“车板裂了。”石九钻到车底查看，确认木板还能承受空车，却不能再承受整块青石。',
 '主角改写运料顺序，先送木料和铁钉，再让工匠在坡下补一座短桥。',
    '午后风从峡口灌进来，旧沟里的积水退了半寸，露出一排被踩乱的草根。',
    '何平在草根旁找到一截黑线，线头打着营中不用的双扣，众人都收住了声音。',
 '“只记位置，不下定论。”主角把黑线装进纸袋，不准先把它说成敌探留下的证据。',
    '梁茂带两人封住东坡入口，石九则回营核对昨夜经过这里的车队和更次。',
    '晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟，没有再压坏车板。',
    '何平把耗时、损料和停工人数写进册页，三项数字都比原方案少。',
 '“名单没回来，先封车。”主角没有庆功，只把黑线和偏斜木桩并排放在灯下。',
    '更鼓响过一遍，石九从营门跑回来，说昨夜登记的七辆车里有一辆没有回签。',
 '主角合上册页，命梁茂封存那辆车的车轴，天亮前任何人不得拆换。',
  ].join('\n\n');
}

function locallyWinningComparisons() {
  const scores = {
    A: { progression: 80, consequence: 80, character: 80, pull: 80 },
    B: { progression: 80, consequence: 80, character: 80, pull: 80 },
  };
  return [
    { winner: 'B', margin: 12, scores, evidence: { A: ['雨脚越过东坡时'], B: ['号角越过东坡时'] }, reason: '候选推进更快' },
    { winner: 'A', margin: 12, scores, evidence: { A: ['号角越过东坡时'], B: ['雨脚越过东坡时'] }, reason: '候选推进更快' },
  ];
}

function explicitCancellation(controller) {
  controller.abort();
  const error = new Error('用户明确停止服务端返工');
  error.name = 'AbortError';
  error.code = 'RECOVERY_CANCELLED';
  return error;
}

test('V0.100.7 fresh 运行中断后恢复仍禁止旧运行候选和旧失败账本', () => {
  const persisted = normalizeRecoveryPolicy({
    candidateReuse: 'none',
    rejectionHistory: 'none',
  });
  const resumed = resolveRecoveryPolicy(persisted, {
    candidateReuse: 'exact_cross_run',
    rejectionHistory: 'compatible',
  });

  assert.deepEqual(resumed, {
    candidateReuse: 'none',
    rejectionHistory: 'none',
  });
});

test('V0.100.7 显式取消诊断必须持久化 cancelled，不能伪装成模型失败', async () => {
  const book = store.books.create({ title: '取消诊断状态', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  store.scenes.create(chapter.id, 1, { content: recoveryFixtureText(), status: 'done', targetWords: 800 });
  const controller = new AbortController();

  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1,
    endChapter: 1,
    signal: controller.signal,
    runTaskImpl: async () => { throw explicitCancellation(controller); },
  }), error => error?.code === 'RECOVERY_CANCELLED');

  const run = store.recommendationRecoveryRuns.list(book.id)[0];
  assert.equal(run.status, 'cancelled');
  assert.equal(run.result?.failure_code, 'RECOVERY_CANCELLED');
  assert.equal(store.publicationProfiles.get(book.id)?.recovery_status, 'cancelled');
});

test('V0.100.7 显式取消候选执行必须持久化 cancelled，并保留旧稿和恢复快照', async () => {
  const book = store.books.create({ title: '取消执行状态', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1,
    endChapter: 1,
    status: 'planned',
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    workOrders: [{
      chapter: 1,
      action: 'tune',
      objective: '压缩测量过程，让失踪车线索更早产生行动后果',
      evidence: ['七辆车里有一辆没有回签'],
      reason: '线索出现偏晚',
    }],
  });
  const controller = new AbortController();

  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true,
    reusePriorCandidates: false,
    signal: controller.signal,
    runTaskImpl: async () => { throw explicitCancellation(controller); },
  }), error => error?.code === 'RECOVERY_CANCELLED');

  const cancelled = store.recommendationRecoveryRuns.get(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.snapshot_id, '开始执行后仍应保留可恢复快照');
  assert.equal(store.chapters.fullText(chapter.id), before, '取消不能把隔离候选或半成品写入正文');
  assert.equal(store.publicationProfiles.get(book.id)?.recovery_status, 'cancelled');
  const resumability = annotateRecoveryRunsResumability(book.id, [cancelled])[0];
  assert.equal(resumability.resumeKind, 'execute', '用户取消后应能继续原工单，而不是被 cancelled 状态永久卡死');
});

test('V0.100.7 同章同 action 但目标或证据不同，不是同一工单或同一冻结账本', () => {
 const before = '主角站在山脊，只把亲眼所见写进薄册。';
  const oldOrder = {
    chapter: 17,
    action: 'tune',
    objective: '站香段压至三分之一，删掉结尾抒情段。',
    evidence: ['站了半炷香'],
    reason: '训练过程拖慢推进。',
  };
  const newOrder = {
    chapter: 17,
    action: 'tune',
    objective: '增加一次具体的辨迹失误或成功案例。',
    evidence: ['只报所见'],
    reason: '缺少能支撑硬核卖点的实战细节。',
  };

  assert.notEqual(recoveryWorkOrderFingerprint(oldOrder), recoveryWorkOrderFingerprint(newOrder));
  assert.notEqual(recoveryFailureLedgerKey(oldOrder, before), recoveryFailureLedgerKey(newOrder, before));
});

test('V0.100.7 工单指纹对展示空白和证据顺序稳定，避免同一方案无谓失配', () => {
  const left = {
    chapter: 8,
    action: 'tune',
    objective: '压缩训练段， 增加外部压力。',
    evidence: ['账上是七', '仓里是九'],
    reason: '事件密度 偏低',
  };
  const right = {
    chapter: '8',
    action: 'TUNE',
    objective: '  压缩训练段， 增加外部压力。 ',
    evidence: ['仓里是九', '账上是七', '账上是七'],
    reason: '事件密度 偏低',
  };

  assert.equal(recoveryWorkOrderFingerprint(left), recoveryWorkOrderFingerprint(right));
});

test('V0.100.7 跨运行候选复制后保留原始来源与局部验证层级', () => {
  const provenance = normalizeCandidateProvenance({
    sourceRunId: 'recovery-old',
    sourceDiagnosisFingerprint: 'diagnosis-old',
    sourceWorkOrderFingerprint: 'order-old',
    sourceBeforeHash: 'before-old',
    validationState: 'local_passed',
  }, { checkpointRunId: 'recovery-current' });

  assert.deepEqual(provenance, {
    sourceRunId: 'recovery-old',
    checkpointRunId: 'recovery-current',
    sourceDiagnosisFingerprint: 'diagnosis-old',
    sourceWorkOrderFingerprint: 'order-old',
    sourceBeforeHash: 'before-old',
    sourceNeighborFingerprint: '',
    contractVersion: RECOVERY_CONTRACT_VERSION,
    validationState: 'local_passed',
  });
});

test('V0.100.7 返工运行把 fresh 执行策略持久化，读取和检查点更新后仍不丢失', () => {
  const book = store.books.create({ title: 'fresh 策略持久化测试', genre: '历史', platform: '番茄' });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1,
    endChapter: 20,
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
  });

  assert.deepEqual(run.execution_policy, {
    candidateReuse: 'none',
    rejectionHistory: 'none',
  });

  store.recommendationRecoveryRuns.update(run.id, {
    result: { diagnosis_fingerprint: 'diagnosis-current' },
  });
  assert.deepEqual(store.recommendationRecoveryRuns.get(run.id).execution_policy, {
    candidateReuse: 'none',
    rejectionHistory: 'none',
  });
});

test('V0.100.7 fresh 运行恢复请求不得把旧运行局部候选重新放宽为零调用复用', async () => {
  const book = store.books.create({ title: 'fresh 恢复不跨运行复用', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  const after = before
    .replace('雨脚越过东坡时', '号角越过东坡时')
    .replace('天亮前任何人不得拆换', '他亲自守到天亮，任何人不得拆换');
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  const oldOrder = {
    chapter: 1, action: 'tune', objective: '压缩测量过程并提前失踪车线索',
    evidence: ['七辆车里有一辆没有回签'], reason: '旧方案认为测量过程偏长',
  };
  const safety = validateChapterRewrite({ before, after, chapterIdx: 1, targetChars: 800, peerChapters: [] });
  const prose = validateRecoveryProseImprovement(before, after);
  assert.equal(safety.ok, true, '夹具必须能通过旧复用安全闸，否则无法证明策略阻止了复用');
  assert.equal(prose.ok, true, `夹具必须能通过旧复用文风闸，否则无法证明策略阻止了复用：${JSON.stringify(prose)}`);

  const oldRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'failed', workOrders: [oldOrder],
    result: {
      candidates: [{
        chapter: 1, chapterId: chapter.id, title: chapter.title,
        before, after, order: oldOrder, status: 'accepted', safety, prose,
        comparisons: locallyWinningComparisons(),
      }],
    },
  });
  assert.ok(oldRun.id);

  const currentOrder = {
    chapter: 1, action: 'tune', objective: '增加短桥受压后的即时处置和人物代价',
    evidence: ['第一段青石过沟时压弯了车板'], reason: '本次方案关注事故后果',
  };
  const currentRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned', workOrders: [currentOrder],
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: { diagnosis_fingerprint: 'fresh-diagnosis' },
  });

  let rewriteCalls = 0;
  const reusedEvents = [];
  let stoppedAt = '';
  await assert.rejects(() => executeRecommendationRecovery(book.id, currentRun.id, {
    // 模拟中断后的旧前端再次请求放宽复用；持久 fresh 策略必须优先。
    reusePriorCandidates: true,
    runTaskImpl: async ({ messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (prompt.includes('请完整重写《') || prompt.includes('请修订《')) {
        rewriteCalls++;
        stoppedAt = 'rewrite';
        throw new Error('TEST_STOP_AFTER_REWRITE');
      }
      stoppedAt = 'global';
      throw new Error('TEST_OLD_CANDIDATE_WAS_REUSED');
    },
    onEvent: event => {
      if (event.type === 'recovery_candidate_reused') reusedEvents.push(event);
    },
  }), /TEST_STOP_AFTER_REWRITE/);

  assert.equal(stoppedAt, 'rewrite');
  assert.equal(rewriteCalls, 1);
  assert.equal(reusedEvents.length, 0);
});

test('V0.100.7 整段复核失败的旧运行候选不得跨运行零调用复用', async () => {
  const book = store.books.create({ title: '整段否决候选隔离', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  const after = before
    .replace('雨脚越过东坡时', '号角越过东坡时')
    .replace('天亮前任何人不得拆换', '他亲自守到天亮，任何人不得拆换');
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  const order = {
    chapter: 1, action: 'tune', objective: '压缩测量过程并提前失踪车线索',
    evidence: ['七辆车里有一辆没有回签'], reason: '测量过程偏长',
  };
  const safety = validateChapterRewrite({ before, after, chapterIdx: 1, targetChars: 800, peerChapters: [] });
  const prose = validateRecoveryProseImprovement(before, after);
  const oldRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'failed', workOrders: [order],
    result: {
      diagnosis_fingerprint: 'same-diagnosis',
      globalReview: {
        verdict: 'fail', sustained_progression: false,
        evidence: ['号角越过东坡时'], reason: '单章变快但整段推进仍未成立', residual_risks: [],
      },
      candidates: [{
        chapter: 1, chapterId: chapter.id, title: chapter.title,
        before, after, order, status: 'accepted', safety, prose,
        comparisons: locallyWinningComparisons(),
      }],
    },
  });
  assert.ok(oldRun.id);

  const currentRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned', workOrders: [order],
    executionPolicy: { candidateReuse: 'exact_cross_run', rejectionHistory: 'compatible' },
    result: { diagnosis_fingerprint: 'same-diagnosis' },
  });
  let rewriteCalls = 0;
  const reusedEvents = [];
  await assert.rejects(() => executeRecommendationRecovery(book.id, currentRun.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') {
        rewriteCalls++;
        throw new Error('TEST_STOP_AFTER_REWRITE');
      }
      throw new Error('TEST_GLOBALLY_REJECTED_CANDIDATE_WAS_REUSED');
    },
    onEvent: event => {
      if (event.type === 'recovery_candidate_reused') reusedEvents.push(event);
    },
  }), /TEST_STOP_AFTER_REWRITE/);

  assert.equal(rewriteCalls, 1);
  assert.equal(reusedEvents.length, 0);
});

test('V0.100.7 整段复核失败把局部候选标为 global_rejected 并保留完整血缘', async () => {
  const book = store.books.create({ title: '候选血缘终态', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  const after = before
    .replace('雨脚越过东坡时', '号角越过东坡时')
    .replace('天亮前任何人不得拆换', '他亲自守到天亮，任何人不得拆换');
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const order = {
    chapter: 1, action: 'tune', objective: '压缩测量过程并提前失踪车线索',
    evidence: ['七辆车里有一辆没有回签'], reason: '测量过程偏长',
  };
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned', workOrders: [order],
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: { diagnosis_fingerprint: 'diagnosis-with-provenance' },
  });
  let compareRound = 0;
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') return { content: after, finishReason: 'stop' };
      if (task === 'opening_candidate_compare') {
        const comparison = locallyWinningComparisons()[compareRound++];
        return { content: JSON.stringify(comparison), finishReason: 'stop' };
      }
      return {
        content: JSON.stringify({
          verdict: 'fail', sustained_progression: false,
          evidence: ['号角越过东坡时'],
          reason: '单章改写尚未形成连续升级的整段推进', residual_risks: ['后续代价不足'],
        }),
        finishReason: 'stop',
      };
    },
  });

  assert.equal(result.globalReview.verdict, 'fail');
  const persisted = store.recommendationRecoveryRuns.get(run.id).result.candidates[0];
  assert.equal(persisted.provenance.sourceRunId, run.id);
  assert.equal(persisted.provenance.checkpointRunId, run.id);
  assert.equal(persisted.provenance.sourceDiagnosisFingerprint, 'diagnosis-with-provenance');
  assert.equal(persisted.provenance.sourceWorkOrderFingerprint, recoveryWorkOrderFingerprint(order));
  assert.equal(persisted.provenance.validationState, 'global_rejected');
});

test('V0.100.7 同一运行的 local_passed 候选仍可从检查点零调用恢复', async () => {
  const book = store.books.create({ title: '同运行断点保护', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  const after = before
    .replace('雨脚越过东坡时', '号角越过东坡时')
    .replace('天亮前任何人不得拆换', '他亲自守到天亮，任何人不得拆换');
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const order = {
    chapter: 1, action: 'tune', objective: '压缩测量过程并提前失踪车线索',
    evidence: ['七辆车里有一辆没有回签'], reason: '测量过程偏长',
  };
  const safety = validateChapterRewrite({ before, after, chapterIdx: 1, targetChars: 800, peerChapters: [] });
  const prose = validateRecoveryProseImprovement(before, after);
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'failed', workOrders: [order],
    executionPolicy: { candidateReuse: 'same_run', rejectionHistory: 'compatible' },
    result: {
      diagnosis_fingerprint: 'same-run-diagnosis',
      candidates: [{
        chapter: 1, chapterId: chapter.id, title: chapter.title,
        before, after, order, status: 'accepted', safety, prose,
        comparisons: locallyWinningComparisons(),
        provenance: normalizeCandidateProvenance({
          sourceRunId: 'placeholder', checkpointRunId: 'placeholder',
          sourceDiagnosisFingerprint: 'same-run-diagnosis',
          sourceWorkOrderFingerprint: recoveryWorkOrderFingerprint(order),
          sourceBeforeHash: createHash('sha256').update(before).digest('hex'),
          sourceNeighborFingerprint: 'same-run-checkpoint-neighbor',
          contractVersion: RECOVERY_CONTRACT_VERSION,
          validationState: 'local_passed',
        }),
      }],
    },
  });
  const stored = store.recommendationRecoveryRuns.get(run.id);
  stored.result.candidates[0].provenance.sourceRunId = run.id;
  stored.result.candidates[0].provenance.checkpointRunId = run.id;
  store.recommendationRecoveryRuns.update(run.id, { result: stored.result });

  let rewriteCalls = 0;
  const reusedEvents = [];
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') rewriteCalls++;
      throw new Error('TEST_STOP_AT_GLOBAL_REVIEW');
    },
    onEvent: event => {
      if (event.type === 'recovery_candidate_reused') reusedEvents.push(event);
    },
  }), /TEST_STOP_AT_GLOBAL_REVIEW/);

  assert.equal(rewriteCalls, 0);
  assert.equal(reusedEvents.length, 1);
});

test('V0.100.7 旧版无 provenance 候选即使已被复制进当前运行也必须隔离重生', async () => {
  // 用户现场数据里，第 8/14/15/16 章候选先被旧版跨运行复制到新运行；升级后如果只看
  // source.id === run.id，就会把历史污染误认成本运行检查点。无来源契约无法证明它由
  // 哪次诊断、哪份整体计划生成，必须 fail closed；工单可续，候选不可续。
  const book = store.books.create({ title: '旧候选迁移隔离', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  const after = before
    .replace('雨脚越过东坡时', '号角越过东坡时')
    .replace('天亮前任何人不得拆换', '他亲自守到天亮，任何人不得拆换');
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const order = {
    chapter: 1, action: 'tune', objective: '压缩测量过程并提前失踪车线索',
    evidence: ['七辆车里有一辆没有回签'], reason: '测量过程偏长',
  };
  const safety = validateChapterRewrite({ before, after, chapterIdx: 1, targetChars: 800, peerChapters: [] });
  const prose = validateRecoveryProseImprovement(before, after);
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'failed', workOrders: [order],
    executionPolicy: { candidateReuse: 'same_run', rejectionHistory: 'compatible' },
    result: {
      diagnosis_fingerprint: 'legacy-copied-into-current-run',
      candidates: [{
        chapter: 1, chapterId: chapter.id, title: chapter.title,
        before, after, order, status: 'accepted', safety, prose,
        comparisons: locallyWinningComparisons(),
        // 只有验证标签、没有任何来源字段：模拟不完整迁移/旧逻辑补默认值。
        provenance: { validationState: 'local_passed' },
      }],
    },
  });

  const dashboardRun = publicationDashboard(book.id).recoveryRuns.find(item => item.id === run.id);
  assert.equal(dashboardRun.candidateStats.localPassed, 0, '旧候选不能在驾驶舱冒充本运行局部通过');
  assert.equal(dashboardRun.candidateStats.legacyUntrusted, 1, '旧候选必须显示为来源不可信并隔离');

  let rewriteCalls = 0;
  const reusedEvents = [];
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') {
        rewriteCalls++;
        throw new Error('TEST_LEGACY_CANDIDATE_REGENERATED');
      }
      throw new Error('TEST_LEGACY_CANDIDATE_WAS_REUSED');
    },
    onEvent: event => {
      if (event.type === 'recovery_candidate_reused') reusedEvents.push(event);
    },
  }), /TEST_LEGACY_CANDIDATE_REGENERATED/);

  assert.equal(rewriteCalls, 1, '来源不可证的旧候选必须重新生成');
  assert.equal(reusedEvents.length, 0);
});

test('V0.100.7 同章同 action 但目标变化时不得继承旧工单的连败冻结', async () => {
  const book = store.books.create({ title: '第十七章冻结身份隔离', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡辨迹', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const oldOrder = {
    chapter: 1, action: 'tune', objective: '压缩站香和结尾抒情段',
    evidence: ['午后风从峡口灌进来'], reason: '过程描写拖慢推进',
  };
  for (let index = 0; index < 2; index++) {
    store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'failed', workOrders: [oldOrder],
      result: {
        diagnosis_fingerprint: `old-diagnosis-${index}`,
        candidates: [{
          chapter: 1, chapterId: chapter.id, title: chapter.title,
          before, after: '', order: oldOrder, status: 'rejected',
          rejection: { chapter: 1, code: 'RECOVERY_NO_CLEAR_IMPROVEMENT', reason: '旧目标下未胜出' },
          comparisons: [],
        }],
      },
    });
  }
  const newOrder = {
    chapter: 1, action: 'tune', objective: '增加一次具体辨迹失误及其即时后果',
    evidence: ['只记录发现位置'], reason: '缺少可验证的实战案例',
  };
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned', workOrders: [newOrder],
    executionPolicy: { candidateReuse: 'exact_cross_run', rejectionHistory: 'compatible' },
    result: { diagnosis_fingerprint: 'new-diagnosis' },
  });
  const frozenEvents = [];
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') throw new Error('TEST_NEW_WORK_ORDER_WAS_GENERATED');
      throw new Error('TEST_OLD_WORK_ORDER_WRONGLY_FROZE_NEW_PLAN');
    },
    onEvent: event => {
      if (event.type === 'recovery_chapter_frozen') frozenEvents.push(event);
    },
  }), /TEST_NEW_WORK_ORDER_WAS_GENERATED/);

  assert.equal(frozenEvents.length, 0);
});

test('V0.100.7 关键 rebuild 达到冻结阈值时先要求重新规划，不进入无法落盘的解冻死锁', async () => {
  const book = store.books.create({ title: '关键重构冻结重规划', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡断局', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const order = {
    chapter: 1, action: 'rebuild', objective: '把失踪车线索改造成不可逆的抓捕行动',
    evidence: ['七辆车里有一辆没有回签'], reason: '原章只有发现，没有行动升级',
  };
  for (let index = 0; index < 2; index++) {
    store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'failed', workOrders: [order],
      result: {
        diagnosis_fingerprint: `rebuild-failure-${index}`,
        candidates: [{
          chapter: 1, chapterId: chapter.id, title: chapter.title,
          before, after: '', order, status: 'rejected',
          rejection: { chapter: 1, code: 'RECOVERY_NO_CLEAR_IMPROVEMENT', reason: '关键重构仍未胜出' },
          comparisons: [],
        }],
      },
    });
  }
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned', workOrders: [order],
    result: { diagnosis_fingerprint: 'rebuild-current' },
  });
  let modelCalls = 0;
  const failedEvents = [];
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async () => {
      modelCalls++;
      throw new Error('TEST_REBUILD_FREEZE_MUST_BE_PREFLIGHTED');
    },
    onEvent: event => {
      if (event.type === 'recovery_failed') failedEvents.push(event);
    },
  }), error => error?.code === 'RECOVERY_REPLAN_REQUIRED');

  assert.equal(modelCalls, 0);
  const persisted = store.recommendationRecoveryRuns.get(run.id);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.rejected_chapters[0]?.code, 'RECOVERY_REPLAN_REQUIRED');
  assert.equal(failedEvents.at(-1)?.code, 'RECOVERY_REPLAN_REQUIRED');
});

test('V0.100.7 正文变化后旧工单在驾驶舱标 stale，执行入口也必须失败关闭', async () => {
  const book = store.books.create({ title: '过期工单双入口拦截', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  const scene = store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const diagnosisPayload = {
    quality_curve: [{
      chapter: 1, action: 'tune', score: 55,
      evidence: ['七辆车里有一辆没有回签'],
      effective_events: ['发现一辆车未回签'], filler_signals: ['测量过程偏长'],
      rebuild_objective: '压缩测量并提前触发封车行动',
 irreversible_change: '封存问题车轴', character_cost: '主角亲自守车',
      promise_delivery: '黑线与失踪车形成关联', ending_pull: '追查未回签车辆',
      reason: '有效发现出现太晚',
    }],
    segment_verdict: { deterioration_found: true, turn_chapter: 1, reason: '行动启动偏晚' },
  };
  const run = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 1,
    runTaskImpl: async () => ({ content: JSON.stringify(diagnosisPayload), finishReason: 'stop' }),
  });
  assert.match(run.result.diagnosis_fingerprint, /^[a-f0-9]{64}$/);

  store.scenes.update(scene.id, { content: `${before}\n\n天亮前，梁茂已经先一步拆走了车轴。` });
  const annotated = annotateRecoveryRunsResumability(book.id, publicationDashboard(book.id).recoveryRuns);
  const stale = annotated.find(item => item.id === run.id);
  assert.equal(stale.resumeKind, 'stale');
  assert.match(stale.resumeDetail, /正文或平台反馈已变化/);

  let modelCalls = 0;
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async () => {
      modelCalls++;
      throw new Error('TEST_STALE_PLAN_REACHED_MODEL');
    },
  }), error => error?.code === 'RECOVERY_PLAN_STALE');
  assert.equal(modelCalls, 0);
  assert.equal(store.snapshots.listAll(book.id).filter(item => item.source === 'recommendation_recovery').length, 0);
});

test('V0.100.7 超过五章的旧版工单缺少全范围 repair_plan 时只能重新诊断', async () => {
  const book = store.books.create({ title: '旧版整体工单隔离', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let index = 1; index <= 6; index++) {
    const chapter = store.chapters.create(book.id, volume.id, index, {
      title: `第${index}章`, status: 'done', wordCount: 800,
    });
    store.scenes.create(chapter.id, 1, {
      content: `${recoveryFixtureText()}\n\n本章范围锚点${index}。`, status: 'done', targetWords: 800,
    });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const legacyRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 6, status: 'failed',
    qualityCurve: Array.from({ length: 6 }, (_, index) => ({
      chapter: index + 1, score: 60, action: index === 5 ? 'rebuild' : 'keep',
    })),
    workOrders: [{
      chapter: 6, action: 'rebuild', objective: '让第六章发生实质转折',
      evidence: ['本章范围锚点6'], reason: '旧版逐章工单没有跨章因果计划',
    }],
    // 故意没有 result.repair_plan：模拟真实库里 V0.100.6 及更早的 1—34 章运行。
  });

  const annotated = annotateRecoveryRunsResumability(
    book.id,
    publicationDashboard(book.id).recoveryRuns,
  ).find(item => item.id === legacyRun.id);
  assert.equal(annotated.resumeKind, 'stale');
  assert.match(annotated.resumeDetail, /旧版全范围计划.*沿用逐章取证.*重做综合规划/);

  let modelCalls = 0;
  await assert.rejects(() => executeRecommendationRecovery(book.id, legacyRun.id, {
    runTaskImpl: async () => { modelCalls++; return { content: '' }; },
  }), error => error?.code === 'RECOVERY_PLAN_STALE');
  assert.equal(modelCalls, 0);
  assert.equal(store.snapshots.listAll(book.id).filter(item => item.source === 'recommendation_recovery').length, 0,
    '旧整体计划应在快照和模型调用前停止');
});

test('V0.100.7 驾驶舱必须透出全范围 repair_plan，否则工单永远无法直接执行', async () => {
  // 真实事故根因：publicationDashboard 为了不把候选正文送进前端，把 run.result 收窄成摘要，
  // 却把 repair_plan 一起裁掉了；annotateRecoveryRunsResumability 在生产链路里
  // （dashboard.recoveryRuns）因此永远看不到计划，永远判“缺少全范围计划→请重新诊断”。
  // 后果：界面永远不出现“直接执行工单”，每次恢复都要多烧一次综合调用。
  // 只测 store 行看不出这个缺陷，必须走 publicationDashboard → annotate 的生产链路。
  const book = store.books.create({ title: '驾驶舱计划透出', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let index = 1; index <= 6; index++) {
    const chapter = store.chapters.create(book.id, volume.id, index, {
      title: `第${index}章`, status: 'done', wordCount: 800,
    });
    store.scenes.create(chapter.id, 1, {
      content: `${recoveryFixtureText()}\n\n本章范围锚点${index}。`, status: 'done', targetWords: 800,
    });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const order = {
    chapter: 6, action: 'rebuild', objective: '让第六章发生实质转折',
    evidence: ['本章范围锚点6'], reason: '停滞区需要破局', plan_arc_id: 'arc-break',
  };
  const plannedRun = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 6, status: 'planned', workOrders: [order],
    qualityCurve: Array.from({ length: 6 }, (_, index) => ({
      chapter: index + 1, score: 60, action: index === 5 ? 'rebuild' : 'keep',
    })),
    result: {
      diagnosis_fingerprint: 'dashboard-projection-fingerprint',
      repair_plan: {
        arcs: [{
          id: 'arc-break', chapters: [6], problem: '调查循环没有累积后果',
          entry_state: '僵局仍在', exit_state: '诱饵迫使敌方暴露',
          causal_steps: [{ chapter: 6, required_change: '布下诱饵' }], protected_facts: ['身份未获铁证'],
        }],
        chapter_orders: [order],
      },
      repair_plan_contract_version: RECOVERY_PLAN_CONTRACT_VERSION,
    },
  });

  const annotated = annotateRecoveryRunsResumability(
    book.id,
    publicationDashboard(book.id).recoveryRuns,
  ).find(item => item.id === plannedRun.id);
  assert.equal(annotated.resumeKind, 'execute',
    '已经有全范围计划的运行必须在驾驶舱显示为可直接执行，不能被投影裁掉后误判为需重新诊断');
});

test('V0.100.7 可续性标注不得依赖调用方注入 candidateStats', async () => {
  // annotate 过去只读 run.candidateStats，而它由 publicationDashboard 注入；
  // 一旦调用方换成 store 原始行就会静默退化成全 0（驾驶舱统计假绿）。
  // 验证状态判定必须在领域层自算，不能靠投影层喂数据。
  const book = store.books.create({ title: '统计自算', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  store.scenes.create(chapter.id, 1, {
    content: recoveryFixtureText(), status: 'done', targetWords: 800,
  });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    workOrders: [{ chapter: 1, action: 'tune', objective: '压缩测量', evidence: ['七辆车'], reason: '偏长' }],
    result: {
      diagnosis_fingerprint: 'self-computed-stats',
      candidates: [
        { chapter: 1, status: 'accepted', provenance: { validationState: 'local_passed' } },
        { chapter: 1, status: 'accepted' },
      ],
    },
  });
  const rawRows = store.recommendationRecoveryRuns.list(book.id);
  assert.equal(rawRows[0].candidateStats, undefined, 'store 原始行本来就不带 candidateStats');
  const annotated = annotateRecoveryRunsResumability(book.id, rawRows).find(item => item.id === run.id);
  assert.equal(annotated.localPassedCandidates, 0, '空壳 validationState 不能算本运行局部通过');
  assert.equal(annotated.untrustedCandidates, 2, '空壳标签与无来源候选都必须被识别并隔离');
  assert.equal(annotated.resumeKind, 'execute');
});

test('V0.100.7 同一运行同一正文基准的执行重试复用恢复快照', async () => {
  const book = store.books.create({ title: '返工快照幂等', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const before = recoveryFixtureText();
  store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const order = {
    chapter: 1, action: 'tune', objective: '压缩测量并提前触发封车行动',
    evidence: ['七辆车里有一辆没有回签'], reason: '有效发现出现太晚',
  };
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned', workOrders: [order],
    result: { diagnosis_fingerprint: 'legacy-run-without-v1007-baseline-marker' },
  });
  const snapshotEvents = [];
  const executeAndStop = () => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') throw new Error('TEST_STOP_AFTER_SNAPSHOT');
      throw new Error('TEST_UNEXPECTED_MODEL_STAGE');
    },
    onEvent: event => {
      if (['recovery_snapshot_created', 'recovery_snapshot_reused'].includes(event.type)) snapshotEvents.push(event);
    },
  });

  await assert.rejects(executeAndStop, /TEST_STOP_AFTER_SNAPSHOT/);
  const firstSnapshotId = store.recommendationRecoveryRuns.get(run.id).snapshot_id;
  await assert.rejects(executeAndStop, /TEST_STOP_AFTER_SNAPSHOT/);
  const persisted = store.recommendationRecoveryRuns.get(run.id);
  assert.equal(persisted.snapshot_id, firstSnapshotId);
  assert.equal(store.snapshots.listAll(book.id).filter(item => item.source === 'recommendation_recovery').length, 1);
  assert.deepEqual(snapshotEvents.map(item => item.type), ['recovery_snapshot_created', 'recovery_snapshot_reused']);
});

test('V0.100.7 五章取证批次完成后由全范围 repair_plan 统一派生跨章工单', async () => {
  const book = store.books.create({ title: '全范围因果蓝图', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapterTexts = new Map();
  for (let idx = 1; idx <= 10; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `山道第${idx}日`, status: 'done', wordCount: 300,
    });
 const text = `第${idx}章主角核对第${idx}号木牌，确认山道第${idx}处哨点仍在原位。\n\n“第${idx}队照册回报。”梁茂把第${idx}页名单压在案上。\n\n入夜前，第${idx}处哨点传回一枚刻痕不同的木牌。`;
    chapterTexts.set(idx, text);
    store.scenes.create(chapter.id, 1, { content: text, status: 'done', targetWords: 300 });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const diagnosisPayload = indexes => ({
    quality_curve: indexes.map(idx => ({
      chapter: idx,
      action: idx <= 5 ? 'keep' : (idx === 8 ? 'rebuild' : 'tune'),
      score: idx <= 5 ? 82 : (idx === 8 ? 45 : 62),
      evidence: [`第${idx}处哨点传回一枚刻痕不同的木牌`],
      effective_events: [`第${idx}处发现异常木牌`],
      irreversible_change: idx <= 5 ? '哨点完成核验' : '异常木牌进入案卷',
 character_cost: idx <= 5 ? '' : '主角暂停原定运料安排',
      promise_delivery: idx <= 5 ? '完成当日核验' : '异常线索继续累积',
      filler_signals: idx <= 5 ? [] : ['逐章发现同类木牌但没有合并行动'],
      ending_pull: `第${idx}号木牌为何不同`,
      reason: idx <= 5 ? '事件闭合' : '异常重复出现但没有升级',
      rebuild_objective: idx <= 5 ? '' : `让第${idx}章承担追查链的第${idx - 5}步`,
    })),
    segment_verdict: {
      deterioration_found: indexes.some(idx => idx > 5),
      turn_chapter: indexes.some(idx => idx > 5) ? 6 : null,
      reason: indexes.some(idx => idx > 5) ? '第6章后异常只累积不行动' : '前段闭合',
    },
  });
  const repairPlan = {
    arcs: [{
      id: 'arc-wooden-token-trap',
      chapters: [6, 7, 8, 9, 10],
      problem: '异常木牌逐章重复，却没有触发合并调查与反制',
 entry_state: '主角只把各处异常分别记档',
 exit_state: '主角利用假木牌设伏，迫使内应暴露传递路径',
      causal_steps: [
        { chapter: 6, required_change: '合并五处木牌刻痕' },
        { chapter: 7, required_change: '锁定木牌替换发生在运料交接' },
        { chapter: 8, required_change: '主动投放一枚可追踪的假木牌' },
        { chapter: 9, required_change: '跟踪假木牌并承担一次误判代价' },
        { chapter: 10, required_change: '截住传递人但保留幕后身份悬念' },
      ],
      protected_facts: ['幕后主使尚无铁证', '山道运料不能长期停摆'],
    }],
    chapter_orders: [6, 7, 8, 9, 10].map(idx => ({
      chapter: idx,
      action: idx === 8 ? 'rebuild' : 'tune',
      objective: `执行木牌追查链第${idx - 5}步并产生可交接后果`,
      evidence: [`第${idx}处哨点传回一枚刻痕不同的木牌`],
      reason: '把重复异常改造成递进因果链',
      plan_arc_id: 'arc-wooden-token-trap',
      depends_on: idx === 6 ? [] : [idx - 1],
      must_handoff: idx === 10 ? '传递人被截住，幕后身份仍待追查' : `第${idx - 5}步结果必须成为下一章行动条件`,
    })),
  };
  let diagnosisCalls = 0;
  let synthesisCalls = 0;
  const run = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 10,
    runTaskImpl: async ({ messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (prompt.includes('推荐返工全范围综合规划')) {
        synthesisCalls++;
        return { content: JSON.stringify(repairPlan), finishReason: 'stop' };
      }
      diagnosisCalls++;
      return {
        content: JSON.stringify(diagnosisPayload(diagnosisCalls === 1 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10])),
        finishReason: 'stop',
      };
    },
  });

  assert.equal(diagnosisCalls, 2);
  assert.equal(synthesisCalls, 1);
  assert.deepEqual(run.result.repair_plan.arcs[0].chapters, [6, 7, 8, 9, 10]);
  assert.equal(run.work_orders.find(order => order.chapter === 8).plan_arc_id, 'arc-wooden-token-trap');
  assert.deepEqual(run.work_orders.find(order => order.chapter === 9).depends_on, [8]);

  // 全链路闭环：新诊断落库后，驾驶舱（会收窄 result 的投影层）必须仍能看到全范围计划，
  // 否则界面永远不会给出“直接执行工单”，用户每次恢复都被迫再烧一次综合调用。
  const annotated = annotateRecoveryRunsResumability(
    book.id,
    publicationDashboard(book.id).recoveryRuns,
  ).find(item => item.id === run.id);
  assert.equal(annotated.resumeKind, 'execute', '新诊断产生的全范围计划必须能被驾驶舱识别为可直接执行');
  assert.match(annotated.resumeDetail, /工单 5 章/);
  assert.equal(annotated.localPassedCandidates, 0);
});

test('V0.100.14 综合规划证据幻觉由本地编译器隔离，不重烧诊断或 synthesis', async () => {
  const book = store.books.create({ title: '综合规划断点恢复', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let idx = 1; idx <= 6; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `木牌${idx}`, status: 'done', wordCount: 200,
    });
    store.scenes.create(chapter.id, 1, {
 content: `主角收下第${idx}枚木牌。\n\n“第${idx}处刻痕不对。”梁茂把木牌放进证物袋。`,
      status: 'done', targetWords: 200,
    });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const payloadFor = indexes => ({
    quality_curve: indexes.map(idx => ({
      chapter: idx, action: idx === 3 ? 'rebuild' : 'tune', score: idx === 3 ? 45 : 60,
      evidence: [`第${idx}处刻痕不对`], effective_events: [`收到第${idx}枚异常木牌`],
      irreversible_change: '木牌进入证物袋', character_cost: '运料核验被迫暂停',
      promise_delivery: '异常刻痕得到实物证据', filler_signals: ['同类发现尚未合并'],
      ending_pull: `第${idx}枚木牌从何处替换`, reason: '证据重复但行动未升级',
      rebuild_objective: `让第${idx}章推进木牌反制链`,
    })),
    segment_verdict: { deterioration_found: true, turn_chapter: 1, reason: '异常线索连续空转' },
  });
  const validPlan = {
    arcs: [{
      id: 'arc-token-countermove', chapters: [1, 2, 3, 4, 5, 6],
      problem: '六枚木牌被分别记录，没有合并成反制行动',
 entry_state: '主角只掌握分散木牌', exit_state: '假木牌已投放并锁定传递路径',
      causal_steps: [1, 2, 3, 4, 5, 6].map(idx => ({ chapter: idx, required_change: `完成反制链第${idx}步` })),
      protected_facts: ['幕后主使尚未暴露'],
    }],
    chapter_orders: [1, 2, 3, 4, 5, 6].map(idx => ({
      chapter: idx, action: idx === 3 ? 'rebuild' : 'tune',
      objective: `完成木牌反制链第${idx}步`, evidence: [`第${idx}处刻痕不对`],
      reason: '把独立发现改成因果递进', plan_arc_id: 'arc-token-countermove',
      depends_on: idx === 1 ? [] : [idx - 1], must_handoff: `第${idx}步结果进入下一环`,
    })),
  };
  const invalidPlan = structuredClone(validPlan);
  invalidPlan.chapter_orders[2].evidence = ['正文中不存在的刻痕证据'];
  let diagnosisCalls = 0;
  let synthesisCalls = 0;
  let allowValidSynthesis = false;
  const runTaskImpl = async ({ messages }) => {
    const prompt = messages.at(-1)?.content || '';
    if (prompt.includes('推荐返工全范围综合规划')) {
      synthesisCalls++;
      return { content: JSON.stringify(allowValidSynthesis ? validPlan : invalidPlan), finishReason: 'stop' };
    }
    diagnosisCalls++;
    return {
      content: JSON.stringify(payloadFor(diagnosisCalls === 1 ? [1, 2, 3, 4, 5] : [6])),
      finishReason: 'stop',
    };
  };

  const planned = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl,
  });
  assert.equal(planned.status, 'planned');
  assert.equal(planned.quality_curve.length, 6);
  assert.equal(diagnosisCalls, 2);
  assert.equal(synthesisCalls, 1, '综合模型只调用一次，坏 evidence 由本地丢弃并回填真实取证');
  assert.deepEqual(planned.work_orders.find(order => order.chapter === 3).evidence, ['第3处刻痕不对']);

  allowValidSynthesis = true;
  const resumed = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl,
  });
  assert.equal(resumed.id, planned.id);
  assert.equal(resumed.status, 'planned');
  assert.equal(diagnosisCalls, 2, '已验证的两个诊断批次不得重跑');
  assert.equal(synthesisCalls, 1, '完整计划已经保存，恢复不得再跑全范围综合');
  assert.equal(resumed.result.repair_plan.chapter_orders.length, 6);
});

test('V0.100.7 相邻章顺序返工时后章读取前章已通过候选的交接尾部', async () => {
  const book = store.books.create({ title: '滚动候选上下文', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapterOne = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const chapterTwo = store.chapters.create(book.id, volume.id, 2, {
    title: '营门封车', status: 'done', wordCount: 800,
  });
  const beforeOne = `${recoveryFixtureText()}\n\n旧第1章交接锚点：问题车仍停在东坡，无人带回营门。`;
  const afterOne = beforeOne
    .replace('雨脚越过东坡时', '号角越过东坡时')
    .replace('旧第1章交接锚点：问题车仍停在东坡，无人带回营门。', '候选第1章独有交接锚点：梁茂已把问题车押回营门，车轴封条完好。');
  const beforeTwo = `${recoveryFixtureText()
 .replaceAll('主角', '赵成')
    .replaceAll('石九', '韩五')
    .replaceAll('梁茂', '周启')
    .replaceAll('何平', '孙毅')
    .replaceAll('东坡', '北门')
    .replaceAll('青石', '军粮')
    .replaceAll('车板', '门板')}\n\n第2章旧结尾：赵成只登记了守门人的姓名。`;
  store.scenes.create(chapterOne.id, 1, { content: beforeOne, status: 'done', targetWords: 800 });
  store.scenes.create(chapterTwo.id, 1, { content: beforeTwo, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const orders = [{
    chapter: 1, action: 'tune', objective: '把问题车押回营门并形成交接状态',
    evidence: ['七辆车里有一辆没有回签'], reason: '旧稿只发现未回签，没有完成交接',
  }, {
    chapter: 2, action: 'tune', objective: '承接已押回的问题车检查封条',
    evidence: ['七辆车里有一辆没有回签'], reason: '第二章必须接住前章行动结果',
    depends_on: [1], must_handoff: '封条异常进入下一章追查',
  }];
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned', workOrders: orders,
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: { diagnosis_fingerprint: 'rolling-context-legacy-fixture' },
  });
  let compareRound = 0;
  let chapterTwoPrompt = '';
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (task === 'revise' && prompt.includes('第1章《')) return { content: afterOne, finishReason: 'stop' };
      if (task === 'revise') {
        chapterTwoPrompt = prompt;
        throw new Error('TEST_STOP_AFTER_READING_ROLLING_CONTEXT');
      }
      if (task === 'opening_candidate_compare') {
        return { content: JSON.stringify(locallyWinningComparisons()[compareRound++]), finishReason: 'stop' };
      }
      throw new Error('TEST_UNEXPECTED_STAGE_BEFORE_CHAPTER_TWO');
    },
  }), /TEST_STOP_AFTER_READING_ROLLING_CONTEXT/);

  assert.match(chapterTwoPrompt, /候选第1章独有交接锚点/);
  assert.doesNotMatch(chapterTwoPrompt, /旧第1章交接锚点/);
});

test('V0.100.13 执行按 repair_plan 依赖排序，并只把本章局部职责送入重写提示', async () => {
  const book = store.books.create({ title: '蓝图驱动执行顺序', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let idx = 1; idx <= 2; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `木牌行动${idx}`, status: 'done', wordCount: 300,
    });
    store.scenes.create(chapter.id, 1, {
      content: `${recoveryFixtureText()}\n\n第${idx}章专属锚点：第${idx}枚木牌已经入袋。`,
      status: 'done', targetWords: 800,
    });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const arc = {
    id: 'arc-token-trap', chapters: [1, 2], problem: '发现异常却没有反制',
    entry_state: '两枚异常木牌彼此孤立', exit_state: '假木牌已投放并有人取走',
    causal_steps: [
      { chapter: 1, required_change: '合并刻痕并制作假木牌' },
      { chapter: 2, required_change: '投放假木牌并跟踪领取者' },
    ],
    protected_facts: ['幕后主使尚无铁证', '运料不能停摆'],
  };
  const orderOne = {
    chapter: 1, action: 'tune', objective: '制作可追踪假木牌',
    evidence: ['第1章专属锚点'], reason: '先建立反制前因',
    plan_arc_id: arc.id, depends_on: [], must_handoff: '假木牌已完成但尚未投放',
  };
  const orderTwo = {
    chapter: 2, action: 'rebuild', objective: '投放假木牌并跟踪领取者',
    evidence: ['第2章专属锚点'], reason: '承接第一章假木牌',
    plan_arc_id: arc.id, depends_on: [1], must_handoff: '领取者进入可跟踪路线',
  };
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned',
    workOrders: [orderTwo, orderOne],
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: {
      diagnosis_fingerprint: 'topological-order-legacy-fixture',
      repair_plan: { arcs: [arc], chapter_orders: [orderOne, orderTwo] },
    },
  });
  let firstPrompt = '';
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      if (task === 'revise') {
        firstPrompt = messages.at(-1)?.content || '';
        throw new Error('TEST_STOP_AT_FIRST_DEPENDENCY_ORDER');
      }
      throw new Error('TEST_UNEXPECTED_STAGE');
    },
  }), /TEST_STOP_AT_FIRST_DEPENDENCY_ORDER/);

  assert.match(firstPrompt, /第1章《木牌行动1》/);
  assert.match(firstPrompt, /arc-token-trap/);
  assert.match(firstPrompt, /合并刻痕并制作假木牌/);
  assert.match(firstPrompt, /假木牌已完成但尚未投放/);
  assert.match(firstPrompt, /不是新增故事事实|不得提前/);
  assert.doesNotMatch(firstPrompt, /两枚异常木牌彼此孤立/);
  assert.doesNotMatch(firstPrompt, /假木牌已投放并有人取走/);
  assert.doesNotMatch(firstPrompt, /幕后主使尚无铁证/);
});

test('V0.100.7 整段通过但仍有 tune 章未解决时结果必须明确为 partial', async () => {
  const book = store.books.create({ title: '部分完成结果口径', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapterOne = store.chapters.create(book.id, volume.id, 1, {
    title: '东坡旧沟', status: 'done', wordCount: 800,
  });
  const chapterTwo = store.chapters.create(book.id, volume.id, 2, {
    title: '北门旧册', status: 'done', wordCount: 800,
  });
  const beforeOne = recoveryFixtureText();
  const afterOne = beforeOne
    .replace('雨脚越过东坡时', '号角越过东坡时')
    .replace('天亮前任何人不得拆换', '他亲自守到天亮，任何人不得拆换');
  const beforeTwo = recoveryFixtureText()
 .replaceAll('主角', '赵成')
    .replaceAll('石九', '韩五')
    .replaceAll('梁茂', '周启')
    .replaceAll('何平', '孙毅')
    .replaceAll('东坡', '北门')
    .replaceAll('青石', '军粮');
  store.scenes.create(chapterOne.id, 1, { content: beforeOne, status: 'done', targetWords: 800 });
  store.scenes.create(chapterTwo.id, 1, { content: beforeTwo, status: 'done', targetWords: 800 });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const orders = [{
    chapter: 1, action: 'tune', objective: '提前触发封车行动',
    evidence: ['七辆车里有一辆没有回签'], reason: '有效行动太晚',
  }, {
    chapter: 2, action: 'tune', objective: '让守门人核验产生实际后果',
    evidence: ['七辆车里有一辆没有回签'], reason: '本章仍有空转',
  }];
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned', workOrders: orders,
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: { diagnosis_fingerprint: 'partial-result-legacy-fixture' },
  });
  let compareRound = 0;
  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, chapterId }) => {
      if (task === 'revise') {
        return { content: chapterId === chapterOne.id ? afterOne : beforeTwo, finishReason: 'stop' };
      }
      if (task === 'opening_candidate_compare') {
        return { content: JSON.stringify(locallyWinningComparisons()[compareRound++]), finishReason: 'stop' };
      }
      return {
        content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          evidence: ['号角越过东坡时'], reason: '已落盘候选与保留旧稿之间没有断裂', residual_risks: ['第2章仍需后续处理'],
        }),
        finishReason: 'stop',
      };
    },
    narrativeRevisionImpl: async () => ({ revisionId: 'revision-partial-test' }),
  });

  assert.equal(result.completion, 'partial');
  assert.deepEqual(result.unresolvedChapters, [2]);
  assert.equal(result.candidateStatsByValidation.applied, 1);
  assert.equal(result.candidateStatsByValidation.rejected, 1);
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'completed');
});

test('V0.100.8 全范围综合规划一次列全所有问题，不能只报第一条', () => {
 // 与实测同源的"打地鼠"缺陷：诊断与盲审已改成聚合报错（V0.100.6），综合规划却仍是
  // 遇到第一条即抛。19 章工单 + 多重约束下，一次只报一条意味着 3 次纠正必然耗尽，
  // 整批取证白烧。必须在一次反馈里列全，让唯一一次重答能整体修正。
  const chapters = [6, 7, 8].map(idx => ({
    idx, title: `第${idx}章`,
 text: `主角核对第${idx}号木牌，确认第${idx}处哨点仍在原位。\n\n“第${idx}队照册回报。”梁茂把名单压在案上。`,
  }));
  const qualityCurve = chapters.map((chapter, index) => ({
    chapter: chapter.idx,
    action: 'tune',
    score: 60,
    evidence: [`“第${chapter.idx}队照册回报。”`],
    reason: '证据重复但行动未升级',
    rebuild_objective: `推进第${chapter.idx}章反制`,
  }));
  const payload = {
    arcs: [
      {
        // 缺陷 1：入口与出口状态相同
        id: 'arc-a', chapters: [6, 7], problem: '重复',
        entry_state: '僵局仍在', exit_state: '僵局仍在',
        causal_steps: [{ chapter: 6, required_change: '合并刻痕' }],
        protected_facts: ['身份未获铁证'],
      },
      {
        // 缺陷 2：第 7 章已被 arc-a 占用（同章属于多条弧）
        id: 'arc-b', chapters: [7, 8], problem: '空转',
        entry_state: '仍在查', exit_state: '已锁定',
        causal_steps: [{ chapter: 8, required_change: '投放假木牌' }],
        protected_facts: [],
      },
    ],
    chapter_orders: [
      {
        chapter: 6, action: 'tune', objective: '合并刻痕',
        // 缺陷 3：幻觉引文，正文里不存在
        evidence: ['这段原文根本不存在于任何章节中'],
        reason: '首环', plan_arc_id: 'arc-a', depends_on: [], must_handoff: '刻痕已合并',
      },
      {
        chapter: 7, action: 'tune', objective: '锁定交接',
        evidence: ['“第7队照册回报。”'],
        reason: '中环', plan_arc_id: 'arc-b',
        // 缺陷 4：自依赖
        depends_on: [7], must_handoff: '交接点已锁定',
      },
      {
        chapter: 8, action: 'tune', objective: '投放假木牌',
        evidence: ['“第8队照册回报。”'],
        reason: '末环', plan_arc_id: 'arc-b', depends_on: [7],
        // 缺陷 5：must_handoff 为空
        must_handoff: '   ',
      },
    ],
  };

  let message = '';
  try {
    validateRecoverySynthesis(payload, chapters, qualityCurve);
    assert.fail('存在多处缺陷时必须失败关闭');
  } catch (error) {
    message = String(error.message || '');
  }
  // 一次反馈里必须同时出现五类问题，否则模型只能一次修一条。
  assert.match(message, /入口与出口状态不能相同/, '缺：弧入口出口相同');
  assert.match(message, /同时属于多个 repair_plan arc/, '缺：同章属于多条弧');
  assert.match(message, /不是该章已验证取证|无法在原文定位/, '缺：工单证据不实');
  assert.match(message, /depends_on.*自依赖|自依赖/, '缺：自依赖');
  assert.match(message, /must_handoff/, '缺：交接为空');
});

test('V0.100.9 工单另有字段错误时也必须同时检出跨章循环依赖', () => {
  // 综合规划只有一次带反馈纠正机会。若“证据错误”让该工单先被排除出依赖图，
  // 模型修完证据后第二轮才暴露环，就会把已经完成的全部取证批次白白作废。
  const chapters = [6, 7].map(idx => ({
    idx, title: `第${idx}章`,
 text: `主角核对第${idx}号木牌。\n\n“第${idx}队照册回报。”梁茂把名单压在案上。`,
  }));
  const qualityCurve = chapters.map(chapter => ({
    chapter: chapter.idx, action: 'tune', score: 60,
    evidence: [`“第${chapter.idx}队照册回报。”`],
    reason: '调查停滞', rebuild_objective: `推进第${chapter.idx}章反制`,
  }));
  const payload = {
    arcs: [{
      id: 'arc-cycle', chapters: [6, 7], problem: '相互等待',
      entry_state: '两章都未采取行动', exit_state: '形成单向因果推进',
      causal_steps: [
        { chapter: 6, required_change: '先投放假木牌' },
        { chapter: 7, required_change: '依据木牌追查' },
      ],
      protected_facts: ['木牌来源仍未公开'],
    }],
    chapter_orders: [
      {
        chapter: 6, action: 'tune', objective: '投放假木牌',
        evidence: ['正文里不存在的证据'], // 同时有字段错误
        reason: '建立前因', plan_arc_id: 'arc-cycle', depends_on: [7],
        must_handoff: '假木牌已进入视野',
      },
      {
        chapter: 7, action: 'tune', objective: '追查木牌',
        evidence: ['“第7队照册回报。”'],
        reason: '承接后果', plan_arc_id: 'arc-cycle', depends_on: [6],
        must_handoff: '追查指向下一节点',
      },
    ],
  };

  let message = '';
  try {
    validateRecoverySynthesis(payload, chapters, qualityCurve);
    assert.fail('字段错误与循环依赖必须共同失败关闭');
  } catch (error) {
    message = String(error.message || '');
  }
  assert.match(message, /不是该章已验证取证|无法在原文定位/, '必须报告字段错误');
  assert.match(message, /循环依赖/, '同一次反馈还必须报告依赖环');
});
