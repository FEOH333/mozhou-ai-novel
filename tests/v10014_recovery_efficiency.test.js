// V0.100.14：推荐返工必须先做关键章、单章有界止损，并用局部场景窗口避免整章洗稿。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const recovery = await import('../server/engine/recommendation_recovery.js');
const { RECOVERY_PLAN_CONTRACT_VERSION } = await import('../server/engine/recovery_contract.js');

function fixtureText(prefix = '东坡') {
  return [
 `雨脚越过${prefix}时，主角先把木尺压进泥里，再叫何平记下土色和水痕。`,
    '石九从下方递来麻绳，绳结沾着细沙，众人因此停下第一辆石车。',
    '梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
 '主角没有急着定案，只让两名军汉分别量坡高和沟深，把数字写在同一张纸上。',
    '“山道还没通，谁也不许催车。”梁茂按住铜锣，负责运料的人只得停在湿土外。',
 '主角把空车推上小路，让众人亲眼看见左轮陷进软泥，争论这才停住。',
    '他们拆下两块车板铺在沟口，又用旧绳把第一块青石分成两段起运。',
    '第一段青石过沟时压弯了车板，梁茂立即挥手停下后车，没有人继续冒险。',
 '主角改写运料顺序，先送木料和铁钉，再让工匠在坡下补一座短桥。',
    '何平在草根旁找到一截黑线，线头打着营中不用的双扣，众人都收住了声音。',
 '“只记位置，不下定论。”主角把黑线装进纸袋，不准先把它说成敌探留下的证据。',
    '梁茂带两人封住东坡入口，石九则回营核对昨夜经过这里的车队和更次。',
    '晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟，没有再压坏车板。',
    '更鼓响过一遍，石九从营门跑回来，说昨夜登记的七辆车里有一辆没有回签。',
 '主角合上册页，命梁茂封存那辆车的车轴，天亮前任何人不得拆换。',
  ].join('\n\n');
}

function createBook(title, chapterCount, { sceneFactory = null } = {}) {
  const book = store.books.create({ title, genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let idx = 1; idx <= chapterCount; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `章${idx}`, status: 'done', wordCount: 1000,
    });
    const scenes = sceneFactory ? sceneFactory(idx) : [fixtureText(`东坡${idx}`)];
    scenes.forEach((content, sceneIndex) => store.scenes.create(chapter.id, sceneIndex + 1, {
      content, status: 'done', targetWords: Math.max(300, Math.ceil(content.length / 2)),
    }));
  }
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', publishedChapterCount: 0,
  });
  return book;
}

function curveRow(chapter, action = 'tune', evidence = `第${chapter}章真实锚点`) {
  return {
    chapter, score: action === 'keep' ? 86 : 55, action, evidence: [evidence],
    effective_events: ['旧稿已有处置动作'], irreversible_change: '处置进入下一环',
    character_cost: '占用调查人手', promise_delivery: '线索进入行动链',
    filler_signals: action === 'keep' ? [] : ['重复复核'], ending_pull: '来源仍待核验',
    reason: action === 'keep' ? '行动完整' : '旧稿已有处置反复复核，后果兑现太迟',
    rebuild_objective: action === 'keep' ? '' : '压缩重复复核，让旧稿已有处置当场形成后果',
    prior: chapter < 7 ? 'suspected_baseline' : 'high_risk',
  };
}

function diagnosisPayload(indexes) {
  return {
    quality_curve: indexes.map(chapter => curveRow(chapter, chapter === 1 || chapter === 6 ? 'tune' : 'keep')),
    segment_verdict: {
      deterioration_found: indexes.some(chapter => chapter === 1 || chapter === 6),
      turn_chapter: indexes.includes(1) ? 1 : indexes.includes(6) ? 6 : null,
      reason: '已有行动反复复核，后果兑现太迟',
    },
  };
}

function arcFor(order, id = `arc-${order.chapter}`) {
  return {
    id, chapters: [order.chapter], problem: '旧稿已有行动没有及时兑现结果',
    entry_state: '处置尚未形成交接', exit_state: '处置已经形成可承接结果',
    causal_steps: [{ chapter: order.chapter, required_change: order.objective }],
    protected_facts: ['幕后身份尚无铁证'],
  };
}

function createPlannedRun(book, rows, orders, arcs = orders.map(order => arcFor(order, order.plan_arc_id))) {
  return store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1,
    endChapter: Math.max(...rows.map(row => row.chapter)),
    status: 'planned',
    qualityCurve: rows,
    workOrders: orders,
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
    result: {
      diagnosis_fingerprint: `legacy-${book.id}`,
      repair_plan: { arcs, chapter_orders: orders },
      repair_plan_contract_version: RECOVERY_PLAN_CONTRACT_VERSION,
    },
  });
}

test('V0.100.14 全范围综合只调用模型一次，缺工单与危险字段由本地编译器收口', async () => {
  const book = createBook('综合一次止损', 6, {
 sceneFactory: idx => [`第${idx}章真实锚点落在军报上。主角核过第${idx}枚木牌，命人封存待查。`],
  });
  let synthesisCalls = 0;
  const run = await recovery.diagnoseRecommendationRecovery(book.id, {
    startChapter: 1,
    endChapter: 6,
    runTaskImpl: async ({ messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (prompt.includes('推荐失败返工总诊断')) {
        const indexes = [1, 2, 3, 4, 5, 6].filter(idx => prompt.includes(`第${idx}章真实锚点`));
        return { content: JSON.stringify(diagnosisPayload(indexes)), finishReason: 'stop' };
      }
      if (prompt.includes('推荐返工全范围综合规划')) {
        synthesisCalls++;
        if (synthesisCalls > 1) throw new Error('SYNTHESIS_MUST_NOT_RETRY');
        return {
          content: JSON.stringify({
            arcs: [{
              id: 'arc-partial', chapters: [1], problem: '缺乏突发危机',
              entry_state: '众人正在复核', exit_state: '微型事故迫使众人警觉',
              causal_steps: [{ chapter: 1, required_change: '通过微型事故制造紧张感' }],
              protected_facts: ['幕后身份尚无铁证'],
            }],
            chapter_orders: [{
              chapter: 1, action: 'tune', objective: '压缩重复复核', evidence: ['第1章真实锚点'],
              reason: '需通过微型事故证明记录价值', plan_arc_id: 'arc-partial',
              depends_on: [], must_handoff: '事故发生后众人更加警觉',
            }],
          }),
          finishReason: 'stop',
        };
      }
      throw new Error(`UNEXPECTED_TASK:${prompt.slice(0, 80)}`);
    },
  });

  assert.equal(run.status, 'planned');
  assert.equal(synthesisCalls, 1, '格式/覆盖缺陷不得再烧第二次综合规划');
  assert.deepEqual(run.work_orders.map(order => order.chapter), [1, 6]);
  for (const order of run.work_orders.filter(item => item.action === 'tune')) {
    const arc = run.result.repair_plan.arcs.find(item => item.id === order.plan_arc_id);
    const localDuty = arc?.causal_steps?.find(step => step.chapter === order.chapter)?.required_change || '';
    assert.doesNotMatch(`${order.objective}\n${order.reason}\n${order.must_handoff}\n${localDuty}`,
      /微型事故|潜在威胁|突发危机/);
  }
});

test('V0.100.14 已保存计划在执行前本地净化，绝不为危险 tune 字段重跑综合', async () => {
  const book = createBook('执行本地净化', 1);
  const order = {
    chapter: 1, action: 'tune', objective: '压缩重复复核', evidence: ['七辆车里有一辆没有回签'],
    reason: '需通过微型事故证明记录价值', plan_arc_id: 'arc-unsafe', depends_on: [],
    must_handoff: '事故发生后众人更加警觉',
  };
  const arc = arcFor(order, 'arc-unsafe');
  arc.causal_steps[0].required_change = '借助潜在威胁强化紧迫感';
  const legacyCurveRow = curveRow(1, 'tune', '七辆车里有一辆没有回签');
  delete legacyCurveRow.evidence; // 旧检查点常只在 work_orders 保存证据，不能因此重跑综合蓝图。
  const run = createPlannedRun(book, [legacyCurveRow], [order], [arc]);
  let prompt = '';

  await assert.rejects(() => recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      assert.equal(task, 'revise');
      prompt = messages.at(-1)?.content || '';
      throw new Error('STOP_AFTER_PROMPT');
    },
  }), /STOP_AFTER_PROMPT/);

  assert.match(prompt, /压缩重复复核/);
  assert.doesNotMatch(prompt, /微型事故|潜在威胁|事故发生后/,
    '旧计划里的危险字段必须本地净化后再进入作者模型');
});

test('V0.100.14 无依赖关键重构先于边缘微调，首个重构失败立即停止整批', async () => {
  const book = createBook('关键重构优先', 2);
  const tune = {
    chapter: 1, action: 'tune', objective: '压缩重复对话', evidence: ['七辆车里有一辆没有回签'],
    reason: '边缘节奏问题', plan_arc_id: 'arc-tune', depends_on: [], must_handoff: '保留旧稿事实边界',
  };
  const rebuild = {
    chapter: 2, action: 'rebuild', objective: '把被动记录改成旧稿证据支撑的主动验证',
    evidence: ['七辆车里有一辆没有回签'], reason: '关键调查链停滞',
    plan_arc_id: 'arc-rebuild', depends_on: [], must_handoff: '验证动作形成明确结果',
  };
  const run = createPlannedRun(book, [
    curveRow(1, 'tune', '七辆车里有一辆没有回签'),
    curveRow(2, 'rebuild', '七辆车里有一辆没有回签'),
  ], [tune, rebuild], [
    arcFor(tune, 'arc-tune'), arcFor(rebuild, 'arc-rebuild'),
  ]);
  const revisePrompts = [];
  const result = await recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      if (task !== 'revise') throw new Error(`UNEXPECTED_PAID_STAGE:${task}`);
      revisePrompts.push(messages.at(-1)?.content || '');
      return { content: '风压住空城，众人沉默不语。'.repeat(180), finishReason: 'stop' };
    },
  });

  // V0.100.15：rebuild 工具闸失败重生成一次（有界）后仍失败即终局；edge tune 不再被生成。
  assert.equal(revisePrompts.length, 2, '关键重构工具闸失败后仅重生成一次，第二次失败即终局');
  assert.match(revisePrompts[0], /第2章《章2》/);
  assert.equal(result.completion, 'failed');
  assert.equal(result.rejected[0]?.chapter, 2);
});

test('V0.100.14 A/B 换位分裂直接保留旧稿，不再重生候选或补救二扫', async () => {
  const book = createBook('换位分裂止损', 1);
  const chapter = store.chapters.list(book.id)[0];
  const before = store.chapters.fullText(chapter.id);
  const after = before
    .replace('雨脚越过东坡1时', '号角越过东坡1时')
    .replace('第一段青石过沟时压弯了车板，梁茂立即挥手停下后车，没有人继续冒险。',
      '“停后车。”第一段青石过沟时压弯了车板，梁茂立即挥手，没有人继续冒险。')
 .replace('天亮前任何人不得拆换', '主角亲自守到天亮，任何人不得拆换');
  const proseGate = recovery.validateRecoveryProseImprovement(before, after);
  assert.equal(proseGate.ok, true, `测试候选必须先过本地文风闸：${JSON.stringify(proseGate)}`);
  const order = {
    chapter: 1, action: 'tune', objective: '让旧稿已有封车行动更早产生后果',
    evidence: ['七辆车里有一辆没有回签'], reason: '结果兑现偏迟',
    plan_arc_id: 'arc-split', depends_on: [], must_handoff: '封车行动形成可承接结果',
  };
  const run = createPlannedRun(book, [curveRow(1, 'tune', '七辆车里有一辆没有回签')], [order], [arcFor(order, 'arc-split')]);
  let reviseCalls = 0;
  let compareCalls = 0;
  const result = await recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') {
        reviseCalls++;
        return { content: after, finishReason: 'stop' };
      }
      if (task === 'opening_candidate_compare') {
        compareCalls++;
        const odd = compareCalls % 2 === 1;
        return {
          content: JSON.stringify({
            winner: 'B', margin: 12,
            scores: {
              A: { progression: 80, consequence: 80, character: 80, pull: 80 },
              // V0.100.15：镜像分裂的 tune 只有候选两轮都过绝对质量线才可接受；
              // 本用例候选（B 位）character 55 有短板，必须仍保旧稿。
              B: { progression: 82, consequence: 82, character: 55, pull: 82 },
            },
            evidence: odd
              ? { A: ['雨脚越过东坡1时'], B: ['号角越过东坡1时'] }
              : { A: ['号角越过东坡1时'], B: ['雨脚越过东坡1时'] },
            reason: '始终偏好 B 位置，无法证明哪一版更好',
          }),
          finishReason: 'stop',
        };
      }
      throw new Error(`UNEXPECTED_STAGE:${task}`);
    },
  });

  assert.equal(result.completion, 'failed');
  assert.equal(reviseCalls, 1, '盲审分裂后不得再生成第二、第三份整章候选');
  assert.equal(compareCalls, 2, '两次换位已经足够识别位置偏差，不得再开决胜轮或二扫');
});

test('V0.100.14 作者模型只收到证据命中的场景窗口，不再整章洗稿', async () => {
  const book = createBook('场景窗口重写', 1, {
    sceneFactory: () => [
      `SCENE_ONE_FULL_ONLY_MARKER\n${'甲'.repeat(900)}\n第一幕收束`,
 `第二幕真实证据落在木牌上。\n${'乙'.repeat(500)}\n主角把木牌封进袋中。`,
      `第三幕开场\n${'丙'.repeat(900)}\nSCENE_THREE_FULL_ONLY_MARKER`,
    ],
  });
  const order = {
    chapter: 1, action: 'tune', objective: '压缩第二幕复核，让封存动作产生结果',
    evidence: ['第二幕真实证据', '第三幕开场'], reason: '第二幕局部空转',
    plan_arc_id: 'arc-window', depends_on: [], must_handoff: '木牌封存状态明确',
  };
  const row = curveRow(1, 'tune', '第二幕真实证据');
  row.evidence = [...order.evidence];
  const run = createPlannedRun(book, [row], [order], [arcFor(order, 'arc-window')]);
  let prompt = '';

  await assert.rejects(() => recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      assert.equal(task, 'revise');
      prompt = messages.at(-1)?.content || '';
      throw new Error('STOP_AFTER_WINDOW_PROMPT');
    },
  }), /STOP_AFTER_WINDOW_PROMPT/);

  assert.match(prompt, /待替换场景窗口|只输出.*窗口/);
  assert.match(prompt, /第二幕真实证据/);
  assert.doesNotMatch(prompt, /SCENE_ONE_FULL_ONLY_MARKER/);
  assert.doesNotMatch(prompt, /SCENE_THREE_FULL_ONLY_MARKER/);
  assert.doesNotMatch(prompt, /【旧稿全文】/);
});

test('V0.100.14 返工候选指令必须注入本地文风闸检测的模板句红线（写审同源）', async () => {
  const book = createBook('写审同源注入', 1, {
    sceneFactory: () => [
 '第一幕：营中清点。\n主角核对竹签与账册，把它们按序收好。',
 '第二幕：夜巡记录。\n主角把三处塌方记进册页，标注水流方向。',
 '第三幕：封册。\n主角合上册页，命人守住营门。',
    ],
  });
  const order = {
    chapter: 1, action: 'tune', objective: '压缩复核，让封存动作产生结果',
    evidence: ['第二幕：夜巡记录'], reason: '第二幕局部空转',
    plan_arc_id: 'arc-guard', depends_on: [], must_handoff: '册页封存状态明确',
  };
  const row = curveRow(1, 'tune', '第二幕：夜巡记录');
  row.evidence = [order.evidence[0]];
  const run = createPlannedRun(book, [row], [order], [arcFor(order, 'arc-guard')]);
  let prompt = '';

  await assert.rejects(() => recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      assert.equal(task, 'revise');
      prompt = messages.at(-1)?.content || '';
      throw new Error('STOP_AFTER_GUARD_PROMPT');
    },
  }), /STOP_AFTER_GUARD_PROMPT/);

  // 写入侧必须声明本地闸会判废的形态，flash 模型才能提前避开
  assert.match(prompt, /不是X|抽象对比/, '候选指令应注入「不是X而是Y」禁令');
  assert.match(prompt, /N年前X|成长总结/, '候选指令应注入「N年前X如今Y」禁令');
  assert.match(prompt, /动作母题|指腹|蹲下/, '候选指令应注入动作母题红线');
});

test('V0.100.14 窗口文风闸不得套用章级对话占比与章末零钩规则', async () => {
  const { runLocalRules } = await import('../server/engine/rules.js');
  const narrativeWindow = [
 '主角沿北坡旧壕走了一遍，把三处塌方按深浅记进册页。',
    '他在第二处塌方前蹲下，用木尺量了滑土的坡度，又抓了一把湿土搓开。',
    '土里混着细碎的木屑，颜色比山中腐木新得多。',
    '册页合上时，北坡的风把火把压得低了一截。',
    '他把这处坡段标作待查，没有写下任何推断。',
    '回程的路上，他反复回看那把搓开的湿土。',
  ].join('\n\n');

  const chapterIssues = runLocalRules(narrativeWindow);
  assert.ok(
    chapterIssues.some(issue => /对话占比/.test(issue.issue)),
    `章级口径应报对话占比，实测：${JSON.stringify(chapterIssues.map(issue => issue.issue))}`,
  );
  const windowIssues = runLocalRules(narrativeWindow, { scope: 'window', endsAtChapterEnd: false });
  assert.equal(windowIssues.filter(issue => /对话占比/.test(issue.issue)).length, 0,
    '场景窗口无法满足章级对话占比，窗口闸套用该规则会把所有低对话窗口判成死局');

  const staticEnding = `${narrativeWindow}\n\n远处坡脊的灰烟慢慢涨开，像一明一灭的灰。`;
  assert.ok(runLocalRules(staticEnding).some(issue => /零钩/.test(issue.issue)), '章级口径应报章末零钩');
  assert.equal(
    runLocalRules(staticEnding, { scope: 'window', endsAtChapterEnd: false })
      .filter(issue => /零钩/.test(issue.issue)).length,
    0, '窗口结束不是章末，不得要求钩子');
  assert.ok(
    runLocalRules(staticEnding, { scope: 'window', endsAtChapterEnd: true })
      .some(issue => /零钩/.test(issue.issue)),
    '窗口一直覆盖到章末时，章末零钩仍须判');

  const gate = recovery.validateRecoveryProseImprovement(narrativeWindow, narrativeWindow.replace('待查', '待复核'), {
    scope: 'window', endsAtChapterEnd: false,
  });
  assert.equal(gate.ok, true, `干净低对话窗口必须能过闸：${JSON.stringify(gate)}`);
});

test('V0.100.14 低对话章节的场景窗口候选能走完返工并落盘', async () => {
  const narrativeWindow = [
 '主角沿北坡旧壕走了一遍，把三处塌方按深浅记进册页。',
    '他在第二处塌方前蹲下，用木尺量了滑土的坡度，又抓了一把湿土搓开。',
    '土里混着细碎的木屑，颜色比山中腐木新得多。',
    '册页合上时，北坡的风把火把压得低了一截。',
    '他把这处坡段标作待查，没有写下任何推断。',
    '回程的路上，他反复回看那把搓开的湿土。',
  ].join('\n\n');
  const book = createBook('低对话窗口落盘', 1, {
    sceneFactory: () => [
      `第一幕：营中清点。\n${'甲'.repeat(600)}`,
      narrativeWindow,
      `第三幕：夜里封册。\n${'丙'.repeat(600)}`,
    ],
  });
  const order = {
    chapter: 1, action: 'tune', objective: '压缩第二幕复核，让塌方记录产生后果',
    evidence: ['土里混着细碎的木屑'], reason: '第二幕局部空转',
    plan_arc_id: 'arc-low-dialogue', depends_on: [], must_handoff: '坡段标记进入核查链',
  };
  const row = curveRow(1, 'tune', '土里混着细碎的木屑');
  row.evidence = [order.evidence[0]];
  const run = createPlannedRun(book, [row], [order], [arcFor(order, 'arc-low-dialogue')]);
  const afterWindow = narrativeWindow.replace('他把这处坡段标作待查，没有写下任何推断。',
    '他把这处坡段标作待查，另册记下木屑的新旧，留待下次巡山对验。');
  const comparisons = [
    { winner: 'B', margin: 12,
      scores: { A: { progression: 80, consequence: 80, character: 80, pull: 80 }, B: { progression: 84, consequence: 84, character: 84, pull: 84 } },
      evidence: { A: ['标作待查，没有写下任何推断'], B: ['留待下次巡山对验'] }, reason: '候选让记录有了后续指向' },
    { winner: 'A', margin: 12,
      scores: { A: { progression: 84, consequence: 84, character: 84, pull: 84 }, B: { progression: 80, consequence: 80, character: 80, pull: 80 } },
      evidence: { A: ['留待下次巡山对验'], B: ['标作待查，没有写下任何推断'] }, reason: '候选让记录有了后续指向' },
  ];
  let compareRound = 0;
  let committedRewrites = null;

  const result = await recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') return { content: afterWindow, finishReason: 'stop' };
      if (task === 'opening_candidate_compare') {
        return { content: JSON.stringify(comparisons[compareRound++]), finishReason: 'stop' };
      }
      return {
        content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          evidence: ['留待下次巡山对验'], reason: '窗口替换未伤接口', residual_risks: [],
        }),
        finishReason: 'stop',
      };
    },
    narrativeRevisionImpl: async (_bookId, { rewrites }) => {
      committedRewrites = rewrites instanceof Map ? rewrites : new Map(Object.entries(rewrites || {}));
      return { revisionId: 'revision-window-dialogue-test' };
    },
  });

  assert.deepEqual(result.applied.map(item => item.chapter), [1],
    `低对话窗口候选必须能落盘，而不是被章级规则闸死：${JSON.stringify(result.rejected)}`);
  const committed = String(committedRewrites?.get(store.chapters.list(book.id)[0].id) || '');
  assert.match(committed, /留待下次巡山对验/, '原子提交的正文必须包含窗口替换结果');
  assert.match(committed, /第一幕：营中清点/, '窗口外旧稿必须原样拼回');
});
