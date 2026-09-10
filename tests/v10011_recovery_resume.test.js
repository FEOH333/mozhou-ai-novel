// V0.100.11：返工首批失败、执行失败与综合规划中断都必须保留可选择的恢复入口。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const {
  annotateRecoveryRunsResumability,
  diagnoseRecommendationRecovery,
  executeRecommendationRecovery,
} = await import('../server/engine/recommendation_recovery.js');
const { RECOVERY_PLAN_CONTRACT_VERSION } = await import('../server/engine/recovery_contract.js');
const { publicationDashboard } = await import('../server/engine/publication_feedback.js');

function createRecoveryBook(title, chapterCount) {
  const book = store.books.create({ title, genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapters = [];
  for (let idx = 1; idx <= chapterCount; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `章${idx}`, status: 'done', wordCount: 200,
    });
    store.scenes.create(chapter.id, 1, {
 content: `第${idx}章真实锚点落在军报上。\n\n主角核过第${idx}枚木牌，命人封存待查。`,
      status: 'done', targetWords: 200,
    });
    chapters.push(chapter);
  }
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', publishedChapterCount: 0,
  });
  return { book, chapters };
}

function diagnosisPayload(indexes, { rebuild = [] } = {}) {
  const rebuildSet = new Set(rebuild);
  return {
    quality_curve: indexes.map(idx => ({
      chapter: idx,
      score: rebuildSet.has(idx) ? 48 : 82,
      action: rebuildSet.has(idx) ? 'rebuild' : 'keep',
      evidence: [`第${idx}章真实锚点`],
      effective_events: rebuildSet.has(idx) ? ['木牌线索被封存'] : ['军报完成核验'],
      irreversible_change: rebuildSet.has(idx) ? '木牌进入封存链' : '',
      character_cost: rebuildSet.has(idx) ? '调查人手被占用' : '',
      promise_delivery: rebuildSet.has(idx) ? '异常线索形成行动后果' : '',
      filler_signals: rebuildSet.has(idx) ? ['行动仍需升级'] : [],
      ending_pull: rebuildSet.has(idx) ? '木牌来源待追查' : '',
      reason: rebuildSet.has(idx) ? '发现线索但反制尚未形成' : '本章行动与后果完整',
      rebuild_objective: rebuildSet.has(idx) ? `让第${idx}章建立可追踪的木牌反制` : '',
    })),
    segment_verdict: {
      deterioration_found: rebuildSet.size > 0,
      turn_chapter: rebuildSet.size ? [...rebuildSet][0] : null,
      reason: rebuildSet.size ? '本段出现调查停滞' : '本段保持实质推进',
    },
  };
}

function synthesisPayload() {
  return {
    arcs: [{
      id: 'arc-token-trace', chapters: [6], problem: '木牌发现后没有形成反制',
      entry_state: '木牌只被封存', exit_state: '木牌成为可追踪诱饵',
      causal_steps: [{ chapter: 6, required_change: '给木牌做暗记并放回领取点' }],
      protected_facts: ['幕后主使尚无铁证'],
    }],
    chapter_orders: [{
      chapter: 6, action: 'rebuild', objective: '给木牌做暗记并放回领取点',
      evidence: ['第6章真实锚点'], reason: '把静态发现升级成主动反制',
      plan_arc_id: 'arc-token-trace', depends_on: [], must_handoff: '领取木牌的人进入可跟踪路线',
    }],
  };
}

test('V0.100.11 第一批调用失败也保存零批次检查点，并可从同一运行重新开始', async () => {
  const { book } = createRecoveryBook('首批失败恢复', 1);
  let shouldFail = true;
  let calls = 0;
  const runTaskImpl = async () => {
    calls++;
    if (shouldFail) throw new Error('TEST_FIRST_BATCH_NETWORK_FAILURE');
    return { content: JSON.stringify(diagnosisPayload([1])), finishReason: 'stop' };
  };

  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 1, runTaskImpl,
  }), /TEST_FIRST_BATCH_NETWORK_FAILURE/);
  const failed = store.recommendationRecoveryRuns.list(book.id)[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.result.diagnosis_fingerprint, /^[a-f0-9]{64}$/,
    '模型首批返回前就要持久化诊断输入版本，不能等首批成功后才写');
  assert.equal(failed.result.completed_batches, 0);
  assert.deepEqual(failed.result.segment_verdicts, []);

  const marked = annotateRecoveryRunsResumability(
    book.id, publicationDashboard(book.id).recoveryRuns,
  ).find(item => item.id === failed.id);
  assert.equal(marked.resumeKind, 'diagnose');
  assert.match(marked.resumeDetail, /第 1 章重新开始|尚无已验证批次/);

  shouldFail = false;
  const resumed = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 1, resumeRunId: failed.id, runTaskImpl,
  });
  assert.equal(resumed.id, failed.id, '首批失败后继续应复用同一运行，而不是制造另一条失败记录');
  assert.equal(resumed.status, 'planned');
  assert.equal(calls, 2);
});

test('V0.100.11 升级前无指纹的零进度失败记录可安全重启，但不冒充已完成批次', async () => {
  const { book } = createRecoveryBook('旧零进度恢复', 1);
  const legacy = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'failed',
    result: { failure_code: 'RECOMMENDATION_RECOVERY_INVALID' },
    error: '第一批证据校验失败',
  });
  const marked = annotateRecoveryRunsResumability(
    book.id, publicationDashboard(book.id).recoveryRuns,
  ).find(item => item.id === legacy.id);
  assert.equal(marked.resumeKind, 'diagnose');
  assert.match(marked.resumeDetail, /尚无已验证批次/);

  const resumed = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 1, resumeRunId: legacy.id,
    runTaskImpl: async () => ({ content: JSON.stringify(diagnosisPayload([1])), finishReason: 'stop' }),
  });
  assert.equal(resumed.id, legacy.id);
  assert.match(resumed.result.diagnosis_fingerprint, /^[a-f0-9]{64}$/,
    '零进度没有旧结论可复用，可在明确继续时绑定当前输入指纹');
});

test('V0.100.11 执行失败不得覆盖全范围修复计划，仍应显示直接执行', async () => {
  const { book } = createRecoveryBook('执行失败保留计划', 6);
  const repairPlan = synthesisPayload();
  const workOrders = repairPlan.chapter_orders;
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 6, status: 'planned',
    qualityCurve: diagnosisPayload([1, 2, 3, 4, 5, 6], { rebuild: [6] }).quality_curve,
    workOrders,
    result: {
      diagnosis_fingerprint: 'legacy-plan-fixture',
      completed_through: 6, completed_batches: 2,
      segment_verdicts: [{}, {}], repair_plan: repairPlan,
      repair_plan_contract_version: RECOVERY_PLAN_CONTRACT_VERSION,
    },
  });

  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') throw new Error('TEST_EXECUTION_INTERRUPTED');
      throw new Error(`TEST_UNEXPECTED_TASK_${task}`);
    },
  }), /TEST_EXECUTION_INTERRUPTED/);

  const failed = store.recommendationRecoveryRuns.get(run.id);
  assert.equal(failed.result.repair_plan.chapter_orders.length, repairPlan.chapter_orders.length,
    '执行前本地规范化可以补元数据，但不得丢失全范围工单');
  assert.deepEqual(
    failed.result.repair_plan.chapter_orders.map(({ chapter, action, objective, evidence }) => ({ chapter, action, objective, evidence })),
    repairPlan.chapter_orders.map(({ chapter, action, objective, evidence }) => ({ chapter, action, objective, evidence })),
    '本地规范化不得改写诊断阶段已经确定的重构职责与证据',
  );
  assert.equal(failed.result.repair_plan_contract_version, RECOVERY_PLAN_CONTRACT_VERSION);
  const marked = annotateRecoveryRunsResumability(
    book.id, publicationDashboard(book.id).recoveryRuns,
  ).find(item => item.id === run.id);
  assert.equal(marked.resumeKind, 'execute');
});

test('V0.100.14 综合模型中断由本地编译器一次收口，不重跑逐章取证或整份蓝图', async () => {
  const { book } = createRecoveryBook('旧综合计划恢复', 6);
  let synthesisAttempts = 0;
  let diagnosisCalls = 0;
  const runTaskImpl = async ({ messages }) => {
    const prompt = messages.at(-1)?.content || '';
    if (prompt.includes('推荐失败返工总诊断')) {
      diagnosisCalls++;
      const indexes = [1, 2, 3, 4, 5, 6].filter(idx => prompt.includes(`第${idx}章真实锚点`));
      return {
        content: JSON.stringify(diagnosisPayload(indexes, { rebuild: indexes.includes(6) ? [6] : [] })),
        finishReason: 'stop',
      };
    }
    if (prompt.includes('推荐返工全范围综合规划')) {
      synthesisAttempts++;
      if (synthesisAttempts === 1) throw new Error('TEST_SYNTHESIS_INTERRUPTED');
      return { content: JSON.stringify(synthesisPayload()), finishReason: 'stop' };
    }
    throw new Error('TEST_UNEXPECTED_RECOVERY_STAGE');
  };

  const recovered = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl,
  });
  assert.equal(recovered.status, 'planned');
  assert.equal(recovered.quality_curve.length, 6);
  assert.equal(diagnosisCalls, 2, '两个逐章取证批次各调用一次，不得因综合失败重跑');
  assert.equal(synthesisAttempts, 1, '综合规划只准尝试一次，连接失败后直接本地编译');
  assert.equal(recovered.work_orders.length, 1);
  assert.ok(recovered.result.repair_plan, '本地编译必须补出可直接执行的完整计划');
});
