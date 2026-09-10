// V0.100.13：返工纠错必须携带真实上版，综合计划不得靠随机事故提质，旧计划只重做综合规划。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const recovery = await import('../server/engine/recommendation_recovery.js');
const contract = await import('../server/engine/recovery_contract.js');

function createSixChapterBook(title) {
  const book = store.books.create({ title, genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let idx = 1; idx <= 6; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `章${idx}`, status: 'done', wordCount: 200,
    });
    store.scenes.create(chapter.id, 1, {
 content: `第${idx}章真实锚点落在军报上。\n\n主角核过第${idx}枚木牌，命人封存待查。`,
      status: 'done', targetWords: 200,
    });
  }
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', publishedChapterCount: 0,
  });
  return book;
}

function diagnosisPayload(indexes) {
  return {
    quality_curve: indexes.map((chapter) => {
      const needsRepair = chapter === 1 || chapter === 6;
      return {
        chapter,
        score: needsRepair ? 58 : 86,
        action: needsRepair ? 'tune' : 'keep',
        evidence: [`第${chapter}章真实锚点`],
        effective_events: ['木牌完成核验'],
        irreversible_change: needsRepair ? '木牌进入封存链' : '',
        character_cost: needsRepair ? '调查人手被占用' : '',
        promise_delivery: needsRepair ? '异常线索进入行动链' : '',
        filler_signals: needsRepair ? ['复核过程重复'] : [],
        ending_pull: needsRepair ? '木牌来源仍待核验' : '',
        reason: needsRepair ? '重复复核挤占了行动篇幅' : '行动与后果完整',
        rebuild_objective: needsRepair ? `压缩第${chapter}章重复复核，让既有木牌处置形成后果` : '',
      };
    }),
    segment_verdict: {
      deterioration_found: indexes.some(chapter => chapter === 1 || chapter === 6),
      turn_chapter: indexes.includes(1) ? 1 : indexes.includes(6) ? 6 : null,
      reason: '重复复核拖慢了既有行动链',
    },
  };
}

function synthesisPayload({ missingLast = false, marker = '' } = {}) {
  const chapters = [1, 6];
  const orders = chapters.map((chapter) => ({
    chapter,
    action: 'tune',
    objective: `压缩第${chapter}章重复复核，让旧稿已有的木牌处置当场产生后果`,
    evidence: [`第${chapter}章真实锚点`],
    reason: '从既有处置动作中兑现结果，不另造事故',
    plan_arc_id: 'arc-token-ledger',
    depends_on: chapter === 6 ? [1] : [],
    must_handoff: chapter === 1 ? '木牌进入可追踪的封存链' : '木牌来源核验形成明确下一步',
  }));
  return {
    arcs: [{
      id: 'arc-token-ledger',
      chapters,
      problem: marker || '既有木牌处置反复复核却没有兑现后果',
      entry_state: '木牌刚被发现',
      exit_state: '木牌进入可追踪的核验链',
      causal_steps: chapters.map(chapter => ({
        chapter, required_change: `让第${chapter}章已有处置动作产生可交接结果`,
      })),
      protected_facts: ['幕后身份尚无铁证'],
    }],
    chapter_orders: missingLast ? orders.slice(0, 1) : orders,
  };
}

test('V0.100.14 综合规划缺工单时本地补齐，不再调用格式修复模型', async () => {
  const book = createSixChapterBook('结构化纠错保留上版');
  const synthesisPrompts = [];
  const synthesisTasks = [];
  let synthesisCalls = 0;
  const runTaskImpl = async ({ task, messages }) => {
    const prompt = messages.at(-1)?.content || '';
    if (prompt.includes('推荐失败返工总诊断')) {
      const indexes = [1, 2, 3, 4, 5, 6].filter(idx => prompt.includes(`第${idx}章真实锚点`));
      return { content: JSON.stringify(diagnosisPayload(indexes)), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工全范围综合规划')) {
      synthesisCalls++;
      synthesisPrompts.push(prompt);
      synthesisTasks.push(task);
      return {
        content: JSON.stringify(synthesisCalls === 1
          ? synthesisPayload({ missingLast: true, marker: 'CORRECTION_SOURCE_MARKER' })
          : synthesisPayload()),
        finishReason: 'stop',
      };
    }
    throw new Error(`TEST_UNEXPECTED_TASK: ${prompt.slice(0, 80)}`);
  };

  const run = await recovery.diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl,
  });

  assert.equal(run.status, 'planned');
  assert.equal(synthesisPrompts.length, 1, '缺工单不得再烧格式修复模型');
  assert.deepEqual(synthesisTasks, ['mid_story_review']);
  assert.deepEqual(run.work_orders.map(order => order.chapter), [1, 6],
    '缺失工单必须由本地编译器从已验证曲线补齐');
});

test('V0.100.13 tune 工单不得靠新增意外、险情或突发威胁冒充提质', () => {
 const chapters = [{ idx: 1, text: '第1章真实锚点落在军报上。主角命人封存待查。' }];
  const qualityCurve = diagnosisPayload([1]).quality_curve;
  const unsafe = {
    arcs: [{
      id: 'arc-random-accident', chapters: [1], problem: '场面偏平',
      entry_state: '众人正在核验', exit_state: '众人完成核验',
      causal_steps: [{ chapter: 1, required_change: '增加一个微小意外或冲突来提升紧张感' }],
      protected_facts: ['幕后身份尚无铁证'],
    }],
    chapter_orders: [{
      chapter: 1, action: 'tune', objective: '增加一个微小意外或潜在威胁暗示',
      evidence: ['第1章真实锚点'], reason: '制造戏剧张力', plan_arc_id: 'arc-random-accident',
      depends_on: [], must_handoff: '意外发生后众人更加警觉',
    }],
  };

  assert.throws(
    () => recovery.validateRecoverySynthesis(unsafe, chapters, qualityCurve),
    /不得靠新增.*意外|随机事故|旧稿已有的行动/,
  );
});

test('V0.100.13 文风纠错与盲审败选重写都以真实候选为底稿，不再逐字段落锁死', () => {
  assert.equal(typeof recovery.buildRecoveryRewriteCorrection, 'function');
  assert.equal(typeof recovery.buildRecoveryRegenFeedback, 'function');
 const candidate = 'CANDIDATE_REVISION_BASE：主角把旧木牌压在军报上，当场改了封存次序。';
  const correction = recovery.buildRecoveryRewriteCorrection({
    prose: {
      beforeBlocking: 0, afterBlocking: 1,
      issues: [{ severity: 'medium', type: '语句质量', issue: '出现模板比喻', quote: '时间仿佛凝固' }],
    },
    rejectedCandidateText: candidate,
    oldChars: 3000,
  });
  assert.match(correction, /CANDIDATE_REVISION_BASE/);
  assert.match(correction, /实际修订底稿|上一版候选全文/);
  assert.doesNotMatch(correction, /未命中段落.*逐字原样保留/);

  const regen = recovery.buildRecoveryRegenFeedback([{
    winner: 'A', margin: 12,
    scores: {
      A: { progression: 82, consequence: 80, character: 84, pull: 78 },
      B: { progression: 70, consequence: 60, character: 68, pull: 72 },
    },
    reason: '候选把紧张感写成了无因果的突发事故',
  }], candidate);
  assert.match(regen, /CANDIDATE_REVISION_BASE/);
  assert.match(regen, /允许重写.*完整.*场景|改动范围由.*败因/);
  assert.match(regen, /不得.*随机事故|不得.*突发事故/);
  assert.doesNotMatch(regen, /定点修补|其余段落逐字保留/);
});

test('V0.100.13 旧版全范围计划只重做综合规划，七批逐章取证不重跑', async () => {
  const book = createSixChapterBook('旧计划仅重做综合');
  let diagnosisCalls = 0;
  let synthesisCalls = 0;
  const firstTask = async ({ messages }) => {
    const prompt = messages.at(-1)?.content || '';
    if (prompt.includes('推荐失败返工总诊断')) {
      diagnosisCalls++;
      const indexes = [1, 2, 3, 4, 5, 6].filter(idx => prompt.includes(`第${idx}章真实锚点`));
      return { content: JSON.stringify(diagnosisPayload(indexes)), finishReason: 'stop' };
    }
    if (prompt.includes('推荐返工全范围综合规划')) {
      synthesisCalls++;
      return { content: JSON.stringify(synthesisPayload()), finishReason: 'stop' };
    }
    throw new Error('TEST_UNEXPECTED_FIRST_STAGE');
  };
  const first = await recovery.diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, runTaskImpl: firstTask,
  });
  const legacyResult = { ...first.result };
  delete legacyResult.repair_plan_contract_version;
  store.recommendationRecoveryRuns.update(first.id, {
    status: 'planned', result: legacyResult,
  });

  let resumedDiagnosisCalls = 0;
  let resumedSynthesisCalls = 0;
  const resumed = await recovery.diagnoseRecommendationRecovery(book.id, {
    startChapter: 1,
    endChapter: 6,
    resumeRunId: first.id,
    runTaskImpl: async ({ messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (prompt.includes('推荐失败返工总诊断')) resumedDiagnosisCalls++;
      if (prompt.includes('推荐返工全范围综合规划')) {
        resumedSynthesisCalls++;
        return { content: JSON.stringify(synthesisPayload()), finishReason: 'stop' };
      }
      throw new Error('旧计划恢复不应重跑逐章取证');
    },
  });

  assert.equal(diagnosisCalls, 2);
  assert.equal(synthesisCalls, 1);
  assert.equal(resumedDiagnosisCalls, 0, '完整逐章曲线必须从检查点复用');
  assert.equal(resumedSynthesisCalls, 1, '只重新组织一次全范围因果计划');
  assert.equal(resumed.result.repair_plan_contract_version, contract.RECOVERY_PLAN_CONTRACT_VERSION);
});
