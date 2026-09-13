// V0.100.15：返工候选三处写审同源收口——①rebuild/tune 工单戏剧化处方在编译器净化；
// ②候选生成指令注入 redlines 单一真源词表与反处方纪律；③盲审位置公平与打分纪律。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const recovery = await import('../server/engine/recovery/recommendation_recovery.js');
const prompts = await import('../server/engine/prompts.js');
const { AI_TASTE_FULL, EXTREME_CLICHES, STRICT_MOTIFS, REDLINES } = await import('../server/data/redlines.js');
const { RECOVERY_PLAN_CONTRACT_VERSION, RECOVERY_WINDOW_LENGTH_RATIOS } = await import('../server/engine/recovery/recovery_contract.js');
const { runLocalRules } = await import('../server/engine/quality/rules.js');

function fixtureText(prefix = '东坡') {
  return [
 `雨脚越过${prefix}时，主角先把木尺压进泥里，再叫何平记下土色和水痕。`,
    '梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
 '主角没有急着定案，只让两名军汉分别量坡高和沟深，把数字写在同一张纸上。',
    '“山道还没通，谁也不许催车。”梁茂按住铜锣，负责运料的人只得停在湿土外。',
    '晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟，没有再压坏车板。',
  ].join('\n\n');
}

function createBook(title, chapterCount = 1) {
  const book = store.books.create({ title, genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let idx = 1; idx <= chapterCount; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `章${idx}`, status: 'done', wordCount: 1000,
    });
    store.scenes.create(chapter.id, 1, {
      content: fixtureText(`东坡${idx}`), status: 'done', targetWords: 600,
    });
  }
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', publishedChapterCount: 0,
  });
  return book;
}

test('V0.100.15 编译器净化 rebuild 工单的戏剧化处方（实测 ch27 冷笑陷阱败因）', () => {
  const book = createBook('处方净化');
  const chapter = store.chapters.list(book.id)[0];
  const chapters = [{ ...chapter, text: store.chapters.fullText(chapter.id) }];
  const curve = [{
    chapter: 1, score: 55, action: 'rebuild', evidence: ['梁茂沿旧沟走了一遍'],
    effective_events: ['发现桩位异动'], irreversible_change: '桩位异动待核',
    character_cost: '占用人手', promise_delivery: '线索进入行动链',
    filler_signals: ['记录上报无后果'], ending_pull: '异动未核',
    reason: '记录上报未形成结果', rebuild_objective: '让桩位异动产生可核验的结果',
    prior: 'high_risk',
  }];
  const compiled = recovery.compileRecoveryPlan({
    arcs: [{
      id: 'arc-27', chapters: [1], problem: '记录上报无后果',
      entry_state: '桩位异动未核', exit_state: '异动已产生结果',
      causal_steps: [{ chapter: 1, required_change: '主动设置验证陷阱，体现战术主动性' }],
      protected_facts: ['幕后身份尚无铁证'],
    }],
    chapter_orders: [{
      chapter: 1, action: 'rebuild',
 objective: '将主角对桩位被动的反应从“记录上报”改为“主动设置验证陷阱”，体现战术主动性',
      evidence: ['梁茂沿旧沟走了一遍'], reason: '反应被动',
      plan_arc_id: 'arc-27', depends_on: [], must_handoff: '陷阱已布下',
    }],
  }, chapters, curve);

  const order = compiled.chapter_orders[0];
  // V0.100.11：存档保留诊断 objective（执行失败不覆盖修复计划）；治毒在注入侧。
  assert.match(order.objective, /陷阱|施压|博弈/, '存档保留诊断原文（V0.100.11 契约）');
  const arc = compiled.arcs.find(item => item.id === 'arc-27');
  const step = arc.causal_steps.find(item => item.chapter === 1);
  assert.doesNotMatch(step.required_change, /陷阱/, 'causal_step 同步净化（编译层仍治毒）');

  // 注入侧必须中性化（作者模型收到局势目标而非处方）。
  const instruction = prompts.recommendationRecoveryRewriteInstruction({
    bookTitle: '测试书', chapter: { idx: 1, title: '夜哨' }, chapterText: fixtureText(),
    workOrder: {
      chapter: 1, action: 'rebuild',
 objective: '将主角对桩位被动的反应从“记录上报”改为“主动设置验证陷阱”，体现战术主动性',
      evidence: ['梁茂沿旧沟走了一遍'], reason: '反应被动',
      plan_arc_id: 'arc-27', depends_on: [], must_handoff: '陷阱已布下',
    },
    targetChars: 800,
  });
  assert.doesNotMatch(instruction, /设置验证陷阱|陷阱，体现/, '注入作者模型的 rebuild 目标必须中性化');
  assert.match(instruction, /可核验的实质变化/, '中性化后的局势目标必须注入');
});

test('V0.100.15 编译器同样净化 tune 诊断行与“迫使式”处方', () => {
  const book = createBook('tune 处方净化');
  const chapter = store.chapters.list(book.id)[0];
  const chapters = [{ ...chapter, text: store.chapters.fullText(chapter.id) }];
  const curve = [{
    chapter: 1, score: 55, action: 'tune', evidence: ['梁茂沿旧沟走了一遍'],
    effective_events: [], irreversible_change: '', character_cost: '',
    promise_delivery: '', filler_signals: ['重复复核'], ending_pull: '',
    reason: '复核重复', rebuild_objective: '利用陷阱反馈对降将进行心理施压，迫使他做出激进掩饰',
    prior: 'high_risk',
  }];
  const compiled = recovery.compileRecoveryPlan({ chapter_orders: [] }, chapters, curve);
  assert.doesNotMatch(compiled.chapter_orders[0].objective, /施压|迫使/,
 '诊断行的戏剧化处方（实测 ch28 实证措辞）不得进入 tune 工单');
});

test('V0.100.15 软性扩写处方同样净化（实测 ch23-24/ch27 二轮实证）', () => {
  const book = createBook('软性扩写净化');
  const chapter = store.chapters.list(book.id)[0];
  const chapters = [{ ...chapter, text: store.chapters.fullText(chapter.id) }];
  const curve = [{
    chapter: 1, score: 55, action: 'tune', evidence: ['梁茂沿旧沟走了一遍'],
    effective_events: [], irreversible_change: '', character_cost: '',
    promise_delivery: '', filler_signals: ['罗列疑点'], ending_pull: '',
    reason: '疑点罗列', rebuild_objective: '通过传话主动推动对降将的监控升级，让秦月带来更具冲击力的新证据',
    prior: 'high_risk',
  }];
  const compiled = recovery.compileRecoveryPlan({ chapter_orders: [] }, chapters, curve);
  assert.match(compiled.chapter_orders[0].objective, /压缩重复内容/,
    '“推动监控升级/带来新证据”式软性扩写必须退回压缩兜底');

  // tune 生成纪律：删与并优先，保留人物标志性工作动作。
  const instruction = prompts.recommendationRecoveryRewriteInstruction({
    bookTitle: '测试书', chapter: { idx: 23, title: '账影重重' }, chapterText: fixtureText(),
    workOrder: {
      chapter: 23, action: 'tune', objective: '压缩整理过程',
      evidence: ['梁茂沿旧沟走了一遍'], reason: '疑点罗列', plan_arc_id: 'arc-1',
      depends_on: [], must_handoff: '结果交接',
    },
  });
  assert.match(instruction, /默认动作是删与并/, 'tune 纪律必须以删并为默认动作');
 assert.match(instruction, /压缩不删过渡/, '压缩不得删除场景过渡（实测 ch27 灰烟收工实证）');
  assert.match(instruction, /标志性工作方式与习惯动作/, '必须保护人物标志性工作动作');
  assert.match(instruction, /绝不新增行动、证据、险情/, '扩写语义必须翻译成压缩执行');
});

test('V0.100.15 候选指令注入 redlines 单一真源词表与反处方纪律（写审同源）', () => {
  const instruction = prompts.recommendationRecoveryRewriteInstruction({
    bookTitle: '测试书', chapter: { idx: 1, title: '夜哨' }, chapterText: fixtureText(),
    workOrder: {
      chapter: 1, action: 'rebuild', objective: '让局势产生可核验变化',
      evidence: ['梁茂沿旧沟走了一遍'], reason: '后果太迟', plan_arc_id: 'arc-1',
      depends_on: [], must_handoff: '结果交接',
    },
    targetChars: 800,
  });
  // 注入必可检：指令中的词表样本与阈值来自 redlines 同一常量，不是第二份抄写。
  for (const word of ['仿佛', '顿了顿', '指腹']) {
    assert.ok(AI_TASTE_FULL.includes('仿佛') || word !== '仿佛');
    assert.match(instruction, new RegExp(word), `候选指令应注入检测词表样本「${word}」`);
  }
  assert.match(instruction, new RegExp(EXTREME_CLICHES.slice(0, 3).join('|')), '极端套话子集必须注入');
  assert.match(instruction, /指节|喉结/, '特征母题词表必须注入');
  assert.match(instruction, new RegExp(`同词出现 ${REDLINES.clicheDetectMedium} 次`), '阈值数字来自 REDLINES 单一真源');
 // 反处方与窗口衔接纪律（实测 ch27 OOC / ch12 结尾削弱两处败因）。
  assert.match(instruction, /问题陈述，不是情节处方/, '候选指令必须声明工单目标不是情节处方');
  assert.match(instruction, /窗口结尾必须与窗口后文自然衔接/, '候选指令必须守住窗口拼回边界');
 // 篇幅上限写审同源（实测 ch27 实证：3422 字候选撞 1.9× 上限被拒，指令却从未声明天花板）。
  const ceiling = Math.ceil(fixtureText().replace(/\s+/g, '').length * RECOVERY_WINDOW_LENGTH_RATIOS.rebuildMax);
  assert.match(instruction, new RegExp(`不得高于 ${ceiling} 字`), '候选指令必须注入与本地闸同源的篇幅上限');
});

test('V0.100.15 盲审指令带位置公平与打分纪律（抗位置偏差）', () => {
  const instruction = prompts.recommendationRecoveryCompareInstruction({
    chapter: { idx: 12, title: '夜哨' }, candidateA: '甲稿'.repeat(50), candidateB: '乙稿'.repeat(50), round: 1,
  });
  assert.match(instruction, /呈现顺序由轮次随机决定/, '必须声明位置与质量无关');
  assert.match(instruction, /综合分差不足 5 分时必须判 tie/, '必须先独立打分再裁决，近同判 tie');
  assert.match(instruction, /先给 A、B 各自独立打分/, '必须先独立打分后比较');
});

test('V0.100.15 位置镜像分裂的 tune 候选可接受，rebuild 与真败选仍拒', () => {
 // 实测 ch23 run4 实证形态：两轮 A 位同分（340/280），内容效应为零，位置锚定主导。
  const mirrored = [
    { winner: 'A', margin: 12, scores: { A: { progression: 85, consequence: 80, character: 90, pull: 85 }, B: { progression: 75, consequence: 70, character: 65, pull: 70 } } },
    { winner: 'A', margin: 12, scores: { A: { progression: 85, consequence: 80, character: 90, pull: 85 }, B: { progression: 75, consequence: 70, character: 65, pull: 70 } } },
  ];
  assert.ok(recovery.comparisonsAcceptCandidate(mirrored, { action: 'tune' }),
    '镜像分裂 + 候选两轮均过绝对质量线（70/85）的 tune 应接受');
  assert.ok(!recovery.comparisonsAcceptCandidate(mirrored, { action: 'rebuild' }),
    'rebuild 关键重构仍必须两轮方向性全胜');
  assert.ok(!recovery.comparisonsAcceptCandidate(mirrored),
    '未声明 action 时保持保守（默认不接受）');

  // 候选一轮有短板（character 55 < 60）时不得借镜像放行。
  const weakMirrored = [
    { winner: 'A', margin: 12, scores: { A: { progression: 85, consequence: 80, character: 90, pull: 85 }, B: { progression: 75, consequence: 70, character: 55, pull: 70 } } },
    { winner: 'A', margin: 12, scores: { A: { progression: 85, consequence: 80, character: 90, pull: 85 }, B: { progression: 75, consequence: 70, character: 55, pull: 70 } } },
  ];
  assert.ok(!recovery.comparisonsAcceptCandidate(weakMirrored, { action: 'tune' }),
    '候选绝对质量不过线的镜像分裂必须拒绝');

  // 真败选（两轮旧稿胜且分差不等的大差距）不得误判为镜像。
  const genuineLoss = [
    { winner: 'A', margin: 35, scores: { A: { progression: 85, consequence: 90, character: 92, pull: 88 }, B: { progression: 60, consequence: 40, character: 55, pull: 50 } } },
    { winner: 'B', margin: 25, scores: { A: { progression: 60, consequence: 40, character: 55, pull: 50 }, B: { progression: 85, consequence: 90, character: 92, pull: 88 } } },
  ];
  assert.ok(!recovery.comparisonsAcceptCandidate(genuineLoss, { action: 'tune' }),
 '大分差真败选（实测 ch27 形态）不得放行');

  // 两轮全胜路径回归不变。
  const clearWin = [
    { winner: 'B', margin: 15, scores: { A: { progression: 70, consequence: 65, character: 75, pull: 60 }, B: { progression: 85, consequence: 80, character: 90, pull: 85 } } },
    { winner: 'A', margin: 12, scores: { A: { progression: 85, consequence: 80, character: 90, pull: 85 }, B: { progression: 70, consequence: 65, character: 75, pull: 60 } } },
  ];
  assert.ok(recovery.comparisonsAcceptCandidate(clearWin, { action: 'rebuild' }));
});

test('V0.100.15 rebuild 镜像分裂降级保留旧稿，其余整改继续落盘（实测 ch30 实证）', async () => {
  const book = createBook('镜像降级', 2);
  const ch1 = store.chapters.list(book.id).find(item => item.idx === 1);
  const ch2 = store.chapters.list(book.id).find(item => item.idx === 2);
  const orders = [
    { chapter: 1, action: 'rebuild', objective: '让旧稿因果推进产生实质变化', evidence: ['梁茂沿旧沟走了一遍'],
      reason: '因果断裂', plan_arc_id: 'arc-x', depends_on: [], must_handoff: '结果交接' },
    { chapter: 2, action: 'tune', objective: '压缩重复对话', evidence: ['梁茂沿旧沟走了一遍'],
      reason: '对话重复', plan_arc_id: 'arc-y', depends_on: [1], must_handoff: '保留事实边界' },
  ];
  const curve = [
    { chapter: 1, score: 50, action: 'rebuild', evidence: ['梁茂沿旧沟走了一遍'], reason: 'r', rebuild_objective: '让因果推进', prior: 'high_risk' },
    { chapter: 2, score: 55, action: 'tune', evidence: ['梁茂沿旧沟走了一遍'], reason: 'r', rebuild_objective: '压缩', prior: 'high_risk' },
  ];
  const arcs = [
    { id: 'arc-x', chapters: [1], problem: 'p', entry_state: 'e', exit_state: 'x', causal_steps: [{ chapter: 1, required_change: 'c' }], protected_facts: ['f'] },
    { id: 'arc-y', chapters: [2], problem: 'p', entry_state: 'e', exit_state: 'x', causal_steps: [{ chapter: 2, required_change: 'c' }], protected_facts: ['f'] },
  ];
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned',
    qualityCurve: curve, workOrders: orders,
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: { diagnosis_fingerprint: `legacy-${book.id}`, repair_plan: { arcs, chapter_orders: orders } },
  });
  let ch2Generated = 0;
  let ch1CompareRound = 0;
  const result = await recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (task === 'revise') {
        if (prompt.includes('第2章')) {
          ch2Generated++;
          return { content: store.chapters.fullText(ch2.id).replace('雨脚越过东坡2时', '号角越过东坡2时'), finishReason: 'stop' };
        }
        return { content: store.chapters.fullText(ch1.id).replace('雨脚越过东坡1时', '号角越过东坡1时'), finishReason: 'stop' };
      }
      if (task === 'opening_candidate_compare') {
        if (prompt.includes('第2章')) {
          const candInA = prompt.indexOf('号角越过东坡2') > prompt.indexOf('【候选 A】') && prompt.indexOf('号角越过东坡2') < prompt.indexOf('【候选 B】');
          return { content: JSON.stringify(candInA
            ? { winner: 'A', margin: 15, scores: { A: { progression: 85, consequence: 80, character: 88, pull: 82 }, B: { progression: 70, consequence: 65, character: 75, pull: 70 } }, evidence: { A: ['号角越过东坡2时'], B: ['雨脚越过东坡2'] }, reason: '新稿胜' }
            : { winner: 'B', margin: 15, scores: { A: { progression: 70, consequence: 65, character: 75, pull: 70 }, B: { progression: 85, consequence: 80, character: 88, pull: 82 } }, evidence: { A: ['雨脚越过东坡2'], B: ['号角越过东坡2时'] }, reason: '新稿胜' }), finishReason: 'stop' };
        }
        // rebuild 候选镜像分裂：两轮同位置 winner、分差相同、候选两轮绝对质量过线；
        // 引文按轮次引各自 B 位文本（第1轮 B=候选，第2轮 B=旧稿）。
        ch1CompareRound++;
        const second = ch1CompareRound === 2;
        return { content: JSON.stringify({ winner: 'A', margin: 12, scores: { A: { progression: 85, consequence: 80, character: 90, pull: 85 }, B: { progression: 75, consequence: 70, character: 65, pull: 70 } }, evidence: { A: ['梁茂沿旧沟走了一遍'], B: [second ? '雨脚越过东坡1时' : '号角越过东坡1时'] }, reason: '位置锚定主导，两版整体相当，A 位连贯性略好' }), finishReason: 'stop' };
      }
      if (task === 'mid_story_review') {
        return { content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          evidence: ['梁茂沿旧沟走了一遍'], reason: '整体因果推进成立',
          residual_risks: [],
          ...(prompt.includes('跨段') ? { segment_consistency: true } : {}),
        }), finishReason: 'stop' };
      }
      throw new Error(`UNEXPECTED_STAGE:${task}`);
    },
    narrativeRevisionImpl: async (_bookId, { rewrites }) => ({ revisionId: 'revision-mirror-keep-test' }),
  });
  assert.ok(ch2Generated >= 1, '镜像降级的 rebuild 不得阻断依赖后章');
  assert.notEqual(result.completion, 'failed', '镜像降级后整批必须继续落盘');
  // V0.100.15 镜像降级 = 候选放行参与整段复核（局部无退化由复核裁决），rebuild 也落盘。
  assert.ok(result.applied.some(item => Number(item.chapter) === 1), '镜像分裂且候选过线的 rebuild 必须放行落盘');
  assert.ok(result.applied.some(item => Number(item.chapter) === 2), 'tune 章照常落盘');
});

test('V0.100.15 tune 前章败选不阻断后章依赖（旧稿不变=依赖输入稳定）', async () => {
  const book = createBook('依赖不阻断', 2);
  const ch1 = store.chapters.list(book.id).find(item => item.idx === 1);
  const ch2 = store.chapters.list(book.id).find(item => item.idx === 2);
  const text1 = store.chapters.fullText(ch1.id);
  const after1 = text1.replace('雨脚越过东坡1时', '号角越过东坡1时');
  const orders = [
    { chapter: 1, action: 'tune', objective: '压缩重复复核', evidence: ['梁茂沿旧沟走了一遍'],
      reason: '复核重复', plan_arc_id: 'arc-a', depends_on: [], must_handoff: '保留事实边界' },
    { chapter: 2, action: 'tune', objective: '压缩重复对话', evidence: ['梁茂沿旧沟走了一遍'],
      reason: '对话重复', plan_arc_id: 'arc-b', depends_on: [1], must_handoff: '保留事实边界' },
  ];
  const curve = [1, 2].map(idx => ({
    chapter: idx, score: 55, action: 'tune', evidence: ['梁茂沿旧沟走了一遍'],
    effective_events: [], irreversible_change: '', character_cost: '',
    promise_delivery: '', filler_signals: ['重复'], ending_pull: '',
    reason: '重复', rebuild_objective: '压缩重复内容', prior: 'high_risk',
  }));
  const arcs = [
    { id: 'arc-a', chapters: [1], problem: '重复', entry_state: '未处理', exit_state: '已处理',
      causal_steps: [{ chapter: 1, required_change: '压缩' }], protected_facts: ['身份不变'] },
    { id: 'arc-b', chapters: [2], problem: '重复', entry_state: '未处理', exit_state: '已处理',
      causal_steps: [{ chapter: 2, required_change: '压缩' }], protected_facts: ['身份不变'] },
  ];
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned',
    qualityCurve: curve, workOrders: orders,
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: { diagnosis_fingerprint: `legacy-${book.id}`, repair_plan: { arcs, chapter_orders: orders } },
  });
  let ch2Generated = 0;
  const result = await recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (task === 'revise') {
        if (prompt.includes('第2章')) {
          ch2Generated++;
          return { content: store.chapters.fullText(ch2.id).replace('雨脚越过东坡2时', '号角越过东坡2时'), finishReason: 'stop' };
        }
        return { content: after1, finishReason: 'stop' };
      }
      if (task === 'opening_candidate_compare') {
        // 第1章候选两轮真败选（旧稿不同位置胜）；第2章候选按轮位全胜。
        if (prompt.includes('第2章')) {
          const odd = !!(prompt.indexOf('号角越过东坡2') >= 0 && prompt.indexOf('雨脚越过东坡2') >= 0 && prompt.indexOf('号角越过东坡2') < prompt.indexOf('雨脚越过东坡2'));
          return { content: JSON.stringify(odd
            ? { winner: 'B', margin: 15, scores: { A: { progression: 70, consequence: 65, character: 75, pull: 70 }, B: { progression: 85, consequence: 80, character: 88, pull: 82 } }, evidence: { A: ['雨脚越过东坡2'], B: ['号角越过东坡2时'] }, reason: '新稿胜' }
            : { winner: 'A', margin: 15, scores: { A: { progression: 85, consequence: 80, character: 88, pull: 82 }, B: { progression: 70, consequence: 65, character: 75, pull: 70 } }, evidence: { A: ['号角越过东坡2时'], B: ['雨脚越过东坡2'] }, reason: '新稿胜' }), finishReason: 'stop' };
        }
        return { content: JSON.stringify({ winner: 'A', margin: 15, scores: { A: { progression: 85, consequence: 80, character: 88, pull: 82 }, B: { progression: 70, consequence: 65, character: 75, pull: 70 } }, evidence: { A: ['梁茂沿旧沟走了一遍'], B: ['号角越过东坡1时'] }, reason: '旧稿胜' }), finishReason: 'stop' };
      }
      if (task === 'mid_story_review') {
        return { content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          evidence: ['梁茂沿旧沟走了一遍'], reason: '整体因果推进成立',
          residual_risks: [],
          ...(prompt.includes('跨段') ? { segment_consistency: true } : {}),
        }), finishReason: 'stop' };
      }
      throw new Error(`UNEXPECTED_STAGE:${task}`);
    },
    narrativeRevisionImpl: async (_bookId, { rewrites }) => ({ revisionId: 'revision-dep-test' }),
  });
  assert.ok(ch2Generated >= 1, 'tune 前章败选后，后章必须照常生成（旧稿输入未变化）');
  const depGap = (result.rejected || []).some(item => Number(item.chapter) === 2 && item.code === 'RECOVERY_DEPENDENCY_GAP');
  assert.ok(!depGap, '后章不得再因 tune 前章败选被判依赖断裂');
});

test('V0.100.15 rebuild 工具闸失败重生成一次，盲审败选仍终局', async () => {
  const book = createBook('工具闸重掷', 1);
  const ch1 = store.chapters.list(book.id)[0];
  const order = {
    chapter: 1, action: 'rebuild', objective: '让旧稿因果推进产生实质变化', evidence: ['梁茂沿旧沟走了一遍'],
    reason: '因果断裂', plan_arc_id: 'arc-t', depends_on: [], must_handoff: '结果交接',
  };
  const curve = [{ chapter: 1, score: 50, action: 'rebuild', evidence: ['梁茂沿旧沟走了一遍'], reason: 'r', rebuild_objective: '重构', prior: 'high_risk' }];
  const arcs = [{ id: 'arc-t', chapters: [1], problem: 'p', entry_state: 'e', exit_state: 'x', causal_steps: [{ chapter: 1, required_change: 'c' }], protected_facts: ['f'] }];
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    qualityCurve: curve, workOrders: [order],
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: { diagnosis_fingerprint: `legacy-${book.id}`, repair_plan: { arcs, chapter_orders: [order] } },
  });
  let reviseCalls = 0;
  const result = await recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (task === 'revise') {
        reviseCalls++;
        // 第一次缩水（TOO_SHORT），第二次合格。
        if (reviseCalls === 1) return { content: '太短。', finishReason: 'stop' };
        return { content: store.chapters.fullText(ch1.id).replace('雨脚越过东坡1时', '号角越过东坡1时，梁茂沿旧沟走了一遍'), finishReason: 'stop' };
      }
      if (task === 'opening_candidate_compare') {
        const candInA = prompt.indexOf('号角越过东坡1') > prompt.indexOf('【候选 A】') && prompt.indexOf('号角越过东坡1') < prompt.indexOf('【候选 B】');
        return { content: JSON.stringify(candInA
          ? { winner: 'A', margin: 15, scores: { A: { progression: 85, consequence: 80, character: 88, pull: 82 }, B: { progression: 70, consequence: 65, character: 75, pull: 70 } }, evidence: { A: ['号角越过东坡1时'], B: ['雨脚越过东坡1时'] }, reason: '新稿胜' }
          : { winner: 'B', margin: 15, scores: { A: { progression: 70, consequence: 65, character: 75, pull: 70 }, B: { progression: 85, consequence: 80, character: 88, pull: 82 } }, evidence: { A: ['雨脚越过东坡1时'], B: ['号角越过东坡1时'] }, reason: '新稿胜' }), finishReason: 'stop' };
      }
      if (task === 'mid_story_review') {
        return { content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          evidence: ['梁茂沿旧沟走了一遍'], reason: '因果推进成立',
          residual_risks: [],
          ...(prompt.includes('跨段') ? { segment_consistency: true } : {}),
        }), finishReason: 'stop' };
      }
      throw new Error(`UNEXPECTED_STAGE:${task}`);
    },
    narrativeRevisionImpl: async () => ({ revisionId: 'revision-tool-retry-test' }),
  });
  assert.equal(reviseCalls, 2, 'rebuild 工具闸失败必须重生成一次');
  assert.notEqual(result.completion, 'failed', '第二次合格后整批必须继续');
});

test('V0.100.15 rebuild 连败史回流诊断指令并参与指纹（flash 重构打不过人工精修旧稿的感知通道）', async () => {
  const book = createBook('连败回流', 1);
  const order = {
    chapter: 1, action: 'rebuild', objective: '让旧稿因果推进产生实质变化', evidence: ['梁茂沿旧沟走了一遍'],
    reason: '因果断裂', plan_arc_id: 'arc-l', depends_on: [], must_handoff: '结果交接',
  };
  const curve = [{ chapter: 1, score: 50, action: 'rebuild', evidence: ['梁茂沿旧沟走了一遍'], reason: 'r', rebuild_objective: '重构', prior: 'high_risk' }];
  const arcs = [{ id: 'arc-l', chapters: [1], problem: 'p', entry_state: 'e', exit_state: 'x', causal_steps: [{ chapter: 1, required_change: 'c' }], protected_facts: ['f'] }];
  // 第一轮执行：rebuild 质量性败选 ×2（写入历史审计）。
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'planned',
      qualityCurve: curve, workOrders: [order],
      executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
      result: { diagnosis_fingerprint: `legacy-${book.id}-${attempt}`, repair_plan: { arcs, chapter_orders: [order] } },
    });
    await recovery.executeRecommendationRecovery(book.id, run.id, {
      runTaskImpl: async ({ task }) => {
 if (task === 'revise') return { content: '主角量过坡高，把木尺压进泥里，再叫何平记下土色和水痕。梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。主角没有急着定案，只让两名军汉分别量坡高和沟深，把数字写在同一张纸上。“山道还没通，谁也不许催车。”梁茂按住铜锣，负责运料的人只得停在湿土外。晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟。', finishReason: 'stop' };
 return { content: JSON.stringify({ winner: 'A', margin: 25, scores: { A: { progression: 85, consequence: 90, character: 88, pull: 85 }, B: { progression: 60, consequence: 40, character: 55, pull: 50 } }, evidence: { A: ['梁茂沿旧沟走了一遍'], B: ['主角量过坡高'] }, reason: '旧稿胜' }), finishReason: 'stop' };
      },
    }).catch(() => {});
  }
  // 连败史生成与指令注入。
  const backflow = recovery.repeatedRebuildLossContext(book.id);
  assert.match(backflow, /第1章.*rebuild|第1章（.*）章/s, '两轮 rebuild 质量败选必须回流');
  assert.match(backflow, /慎再给这些章开 rebuild/);
  const instruction = prompts.recommendationRecoveryDiagnosisInstruction({
    bookTitle: '测试书', chapters: [{ idx: 1, title: 'x', text: '正文' }], repeatedRebuildLosses: backflow,
  });
  assert.match(instruction, /执行史回流/, '诊断指令必须注入连败史');
  const synthesis = prompts.recommendationRecoverySynthesisInstruction({
    bookTitle: '测试书', qualityCurve: [], segmentVerdicts: [], repeatedRebuildLosses: backflow,
  });
  assert.match(synthesis, /执行史回流/, '综合指令必须注入连败史');
});

test('V0.100.15 rebuild 连败 ≥2 轮编译层硬性降级为 tune（不再烧钱重写）', async () => {
  const book = createBook('连败硬降级', 1);
  const order = {
    chapter: 1, action: 'rebuild', objective: '按已验证证据重构本章因果推进', evidence: ['梁茂沿旧沟走了一遍'],
    reason: '因果断裂', plan_arc_id: 'arc-h', depends_on: [], must_handoff: '结果交接',
  };
  const curve = [{ chapter: 1, score: 50, action: 'rebuild', evidence: ['梁茂沿旧沟走了一遍'], reason: 'r', rebuild_objective: '重构', prior: 'high_risk' }];
  const arcs = [{ id: 'arc-h', chapters: [1], problem: 'p', entry_state: 'e', exit_state: 'x', causal_steps: [{ chapter: 1, required_change: 'c' }], protected_facts: ['f'] }];
  // 先造 2 轮 rebuild 质量性败选审计。
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = store.recommendationRecoveryRuns.create(book.id, {
      startChapter: 1, endChapter: 1, status: 'planned',
      qualityCurve: curve, workOrders: [order],
      executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
      result: { diagnosis_fingerprint: `legacy-${book.id}-${attempt}`, repair_plan: { arcs, chapter_orders: [order] } },
    });
    await recovery.executeRecommendationRecovery(book.id, run.id, {
      runTaskImpl: async ({ task }) => {
 if (task === 'revise') return { content: '主角量过坡高，把木尺压进泥里，再叫何平记下土色和水痕。梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。主角没有急着定案，只让两名军汉分别量坡高和沟深，把数字写在同一张纸上。“山道还没通，谁也不许催车。”梁茂按住铜锣，负责运料的人只得停在湿土外。晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟。', finishReason: 'stop' };
 return { content: JSON.stringify({ winner: 'A', margin: 25, scores: { A: { progression: 85, consequence: 90, character: 88, pull: 85 }, B: { progression: 60, consequence: 40, character: 55, pull: 50 } }, evidence: { A: ['梁茂沿旧沟走了一遍'], B: ['主角量过坡高'] }, reason: '旧稿胜' }), finishReason: 'stop' };
      },
    }).catch(() => {});
  }
  // 编译新计划：ch1 应被硬性降级为 tune 压缩。
  const chapter = store.chapters.list(book.id)[0];
  const chapters = [{ ...chapter, text: store.chapters.fullText(chapter.id) }];
  const compiled = recovery.compileRecoveryPlan({ chapter_orders: [{ chapter: 1, action: 'rebuild', evidence: ['梁茂沿旧沟走了一遍'], reason: 'r' }] }, chapters, curve, { bookId: book.id });
  assert.equal(compiled.chapter_orders[0].action, 'tune', '连败 ≥2 轮的 rebuild 必须本地降级');
  assert.match(compiled.chapter_orders[0].objective, /压缩重复描写|压缩收敛/, '降级目标是压缩收敛');
});

test('V0.100.15 诊断指令带 action 升级门槛，不得为主动性给人物开越权处方', () => {
  const instruction = prompts.recommendationRecoveryDiagnosisInstruction({
    bookTitle: '测试书', chapters: [{ idx: 1, title: '夜哨', text: '正文'.repeat(20) }],
    suspectedTurnChapter: 7,
  });
  assert.match(instruction, /action 升级门槛/, '诊断指令必须声明 tune/rebuild 的升级边界');
  assert.match(instruction, /不是病，不得为“主动性\/戏剧性”给人物开越权处方/, '符合人物弧光的克制写法不得被误诊');
});

test('V0.100.15 EXTREME_CLICHES 迁移后检测行为不变（出现即 medium）', () => {
  const issues = runLocalRules(`众所周知，这一夜过去了。${'正文正文正文。'.repeat(3)}`, { scope: 'window' });
  const extreme = issues.find(issue => issue.issue.includes('众所周知'));
  assert.ok(extreme, '极端套话出现 1 次仍必须报');
  assert.equal(extreme.severity, 'medium');
});

test('V0.100.15 已保存旧计划执行前本地净化戏剧化处方（零模型重跑）', async () => {
  const book = createBook('旧计划净化', 1);
  const order = {
    chapter: 1, action: 'rebuild',
 objective: '将主角对桩位被动的反应从“记录上报”改为“主动设置验证陷阱”，体现战术主动性',
    evidence: ['梁茂沿旧沟走了一遍'], reason: '反应被动',
    plan_arc_id: 'arc-legacy', depends_on: [], must_handoff: '陷阱已布下',
  };
  const arc = {
    id: 'arc-legacy', chapters: [1], problem: '记录上报无后果',
    entry_state: '异动未核', exit_state: '异动有结果',
    causal_steps: [{ chapter: 1, required_change: '主动设置验证陷阱' }],
    protected_facts: ['幕后身份尚无铁证'],
  };
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 1, status: 'planned',
    qualityCurve: [{
      chapter: 1, score: 55, action: 'rebuild', evidence: ['梁茂沿旧沟走了一遍'],
      reason: '记录上报未形成结果', rebuild_objective: '让桩位异动产生可核验的结果',
      prior: 'high_risk',
    }],
    workOrders: [order],
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: {
      diagnosis_fingerprint: `legacy-${book.id}`,
      repair_plan: { arcs: [arc], chapter_orders: [order] },
      repair_plan_contract_version: RECOVERY_PLAN_CONTRACT_VERSION,
    },
  });
  let prompt = '';
  await assert.rejects(() => recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ messages }) => {
      prompt = messages.at(-1)?.content || '';
      throw new Error('STOP_AFTER_PROMPT');
    },
  }), /STOP_AFTER_PROMPT/);
  assert.doesNotMatch(prompt, /设置验证陷阱|陷阱，体现/, '旧计划执行前必须本地净化处方措辞');
  assert.match(prompt, /可核验/, '净化后作者模型收到的是局势目标');
});
