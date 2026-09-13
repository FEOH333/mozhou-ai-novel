// V0.103.0：章级多样性合同——近窗换轴，禁止同构考卷把合格章收束成一种安全写法。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyEventClass, compileDiversityContract, diversityContractIssues,
  diversityFeatures, diversityRegression, openerStructureTemplate,
} from '../server/engine/quality/chapter_diversity.js';
import { chapterOutlineQualityIssues, healOutlineWordTargets } from '../server/engine/planning/outline.js';
import {
  chapterOutlineInstruction, writeSceneInstruction, reviseInstruction,
  attractionRevisionNote, auditInstruction,
} from '../server/engine/prompts.js';
import { CONTINUITY_CRAFT_TEXT, techniqueInjection } from '../server/data/literary_techniques.js';
import { detectChapterOpenerTic, detectOpenerStructureSaturation } from '../server/engine/quality/rules.js';
import { shouldImmediateReplanWipe } from '../server/engine/pipeline/pipeline.js';
import { stampOpeningTimelineProseFix } from '../server/engine/longform/historical_guardrails.js';

function scenes(beats, extra = {}) {
  return beats.map((beat, i) => ({
 id: `s${i + 1}`, pov: extra.pov || '主角', location: extra.location || '北崖',
    scene_type: extra.types?.[i] || extra.scene_type || 'suspense',
    pacing: extra.pacings?.[i] || '推进',
    beat, target_words: extra.target_words || 1700,
  }));
}

function outline(overrides = {}) {
  return {
    title: '墙基验工',
    pace: 'advance',
    goal: '沿墙基验工并抓住渗水的人',
    conflict: '工期与证据不可兼得',
    dramatic_question: '今晚能不能把灰袍人按住？',
    counterforce: '灰袍人带着同伴反扑',
    turn: '验工线对上暗门',
    irreversible_change: '抓获灰袍人并得知地道',
    choice_cost: '暂不上报，承担知情不报',
    reader_gain: '得到地道与三日窗口',
    reader_pull: '三日后爆破尚未发生',
    ending_hook: null,
    scenes: scenes([
 '主角沿墙基勘线，核对应验工记号。',
 '陈七反对越权，主角仍决定设伏。',
      '灰袍人入网，局面从验工变成对峙。',
    ]),
    ...overrides,
  };
}

function feat(partial = {}) {
  return {
    opening: 'situation_open',
    initiative: 'observe',
    counterforce: 'human_opponent',
    resolution: 'record',
    artifact: 'ledger',
    ending: 'distant_signal',
    event_class: 'inspection',
    scene_mix: 'suspense',
    pace: 'advance',
    hook_type: 'none',
 pov_name: '主角',
    opener_family: 'place_wind_knife',
    ...partial,
  };
}

test('V0.103.0 事件类黄金样例：验工/审讯/禀报/追逃/日常互不误伤', () => {
  assert.equal(classifyEventClass({ goal: '沿墙基验工勘线，核账渗水点' }), 'inspection');
  assert.equal(classifyEventClass({ goal: '审讯灰袍人，逼问地道与爆破' }), 'interrogation');
  assert.equal(classifyEventClass({ goal: '向陈七禀报人数，记入工册' }), 'report_ledger');
  assert.equal(classifyEventClass({ goal: '沿干沟追截携带火药的人手' }), 'pursuit');
  assert.equal(classifyEventClass({ goal: '市井买米吃饭歇息，邻里闲话' }), 'daily');
  assert.notEqual(classifyEventClass({ goal: '沿墙基验工勘线' }), 'interrogation');
  assert.notEqual(classifyEventClass({ goal: '审讯灰袍人逼问地道' }), 'inspection');
});

test('V0.105 截获降书草稿不是禀报账册；正式降元献图可接在截获章后', () => {
  const interceptOutline = {
    title: '泸州惊变',
 goal: '主角截获刘整降蒙底稿，面对上报必反、隐瞒同罪的死局',
    conflict: '与户部主事搜查对峙',
    dramatic_question: '前线该不该把密信交出去？',
    scenes: [
 { beat: '主角截获伪装渔民的信使，搜出油布包里的降书草稿。' },
 { beat: '文书吏建议烧毁或上报；主角把密信塞进炭盆夹层，与主事对峙。' },
    ],
  };
  assert.equal(classifyEventClass(interceptOutline), 'intercept',
    '截获密信/降书草稿不得被「烧毁或上报」误判成禀报账册');
  assert.equal(classifyEventClass({ goal: '向陈七禀报人数，记入工册' }), 'report_ledger');

  const defectionOutline = {
    title: '降书无泪',
    goal: '刘整正式降元，献出泸州地图与攻宋之策',
    conflict: '北崖只能眼看侧翼失守',
    dramatic_question: '降城火光起来时还能不能保住合州？',
    counterforce: '刘整已把泸州交给蒙古',
    turn: '城头看见泸州方向火光',
    irreversible_change: '侧翼失守已成事实，两人封存这段耻辱记录',
    scenes: [
 { beat: '刘整正式降元，献出泸州地图。主角在城头看见火光冲天。炭盆夹层里还压着密信。' },
      { beat: '文书吏账本显示降前有情报被拒；两人把耻辱记录封存。' },
    ],
  };
  assert.equal(classifyEventClass(defectionOutline), 'defection',
    '目标已写正式降元时，场景残留密信不得盖过降城事件核');
  const last = feat({
    event_class: 'intercept',
    initiative: 'report_or_obey',
    counterforce: 'authority',
    resolution: 'record',
    artifact: 'ledger',
  });
  const issues = diversityContractIssues(defectionOutline, compileDiversityContract([last]));
  assert.equal(issues.filter(i => i.code === 'OUTLINE_EVENT_CLASS_REPEATED').length, 0,
    '截获章之后的正式降城不得因「降书」二字被当成同一事件类');
  assert.equal(issues.filter(i => i.hard).length, 0, JSON.stringify(issues));

  const interceptAxes = feat({
    event_class: 'intercept',
    initiative: 'choose_and_pay',
    counterforce: 'authority',
    resolution: 'irreversible_action',
    artifact: 'letter_order',
  });
  const afterIntercept = {
    ...interceptAxes,
    outline_axes: interceptAxes,
  };
  const threeAxisSame = diversityContractIssues({
    title: '降书无泪',
 goal: '刘整正式降元，献出泸州地图；主角选择把耻辱记下',
    conflict: '户部主事仍要搜查',
    dramatic_question: '降城火光起来时还能不能保住合州？',
    counterforce: '户部主事带着朝命搜查北崖',
    turn: '城头看见泸州方向火光',
    irreversible_change: '侧翼失守已成事实，两人公开这段耻辱',
    choice_cost: '决定不再隐瞒',
    scenes: [
 { beat: '刘整正式降元，献出泸州地图。主角选择站上城头。' },
      { beat: '户部主事要搜查；火光里两人公开失守的事实。' },
    ],
  }, compileDiversityContract([afterIntercept]));
  assert.equal(threeAxisSame.filter(i => i.code === 'OUTLINE_EVENT_CLASS_REPEATED').length, 0);
  assert.equal(threeAxisSame.filter(i => i.hard && i.code === 'OUTLINE_AXIS_ISOMORPHIC').length, 0,
    `换事件类后三轴相同不得误杀正式降城：${JSON.stringify(threeAxisSame)}`);
  const fourSame = diversityContractIssues({
    title: '降书无泪',
 goal: '刘整正式降元，献出泸州地图；主角选择把降书留下',
    conflict: '户部主事带着朝命搜查',
    dramatic_question: '要不要把降书交出去？',
    counterforce: '户部主事带着朝命搜查北崖',
    turn: '他决定公开失守的事实',
    irreversible_change: '两人公开这段耻辱，降书仍压在炭盆',
    choice_cost: '选择不再隐瞒',
    scenes: [
 { beat: '刘整正式降元。主角选择把降书留下。' },
      { beat: '户部主事要搜查；两人公开失守。' },
    ],
  }, compileDiversityContract([afterIntercept]));
  assert.equal(fourSame.filter(i => i.hard).length, 0,
    `换事件类后四词同轴也不得废降城细纲：${JSON.stringify(fourSame)}`);
});

test('V0.105 场景字数差 100 本地补到硬下限，不重掷细纲', () => {
  const outline = {
    scenes: [
      { beat: '一', target_words: 1100 },
      { beat: '二', target_words: 1100 },
      { beat: '三', target_words: 1100 },
      { beat: '四', target_words: 1100 },
    ],
  };
  assert.equal(healOutlineWordTargets(outline, 5000), true);
  const sum = outline.scenes.reduce((acc, s) => acc + s.target_words, 0);
  assert.ok(sum >= 4500, `补后总和 ${sum}`);
  assert.equal(chapterOutlineQualityIssues(outline, { chapterLength: 5000 })
    .filter(i => /硬下限/.test(i.issue)).length, 0);
  const ok = { scenes: [{ beat: '一', target_words: 1200 }, { beat: '二', target_words: 1200 }, { beat: '三', target_words: 1200 }, { beat: '四', target_words: 1200 }] };
  assert.equal(healOutlineWordTargets(ok, 5000), false);
});

test('V0.103.0 空窗不注入，占用项不含库存正例', () => {
  const empty = compileDiversityContract([]);
  assert.equal(empty.text, '');
  assert.equal(empty.last, null);
  const one = compileDiversityContract([feat({ event_class: 'interrogation', opener_family: 'place_wind_knife' })]);
  assert.match(one.text, /近窗换轴/);
  assert.match(one.text, /interrogation/);
  assert.doesNotMatch(one.text, /号角吹了第三遍/);
  assert.doesNotMatch(one.text, /请写成/);
});

test('V0.103.0 上章审讯再审讯 hard；换事件类且换两轴则过', () => {
  const contract = compileDiversityContract([feat({
    event_class: 'interrogation',
    initiative: 'observe',
    resolution: 'record',
    counterforce: 'human_opponent',
  })]);
  const again = diversityContractIssues(outline({
    goal: '继续审讯灰袍人逼问同党',
    conflict: '口供真假难辨',
    counterforce: '灰袍人拒不招供',
    irreversible_change: '把口供记入工册',
    scenes: scenes(['继续审讯灰袍人逼问地道。', '陈七来看口供。', '把人名记入工册。']),
  }), contract);
  assert.ok(again.some(i => i.hard && i.code === 'OUTLINE_EVENT_CLASS_REPEATED'), JSON.stringify(again));

  const swapped = diversityContractIssues(outline({
    title: '干沟截火',
    goal: '沿干沟追截携带火药的人手',
    conflict: '追截会暴露暗门',
    dramatic_question: '要不要在爆破前截住火种？',
    counterforce: '三日时限和山洪',
    turn: '火药已抬进干沟',
    irreversible_change: '截获火药并改道放水',
    choice_cost: '放弃隐蔽，干沟暴露',
    reader_gain: '火药被截，窗口改写',
    reader_pull: '上游还有第二批火种',
    scenes: scenes([
 '主角沿干沟追截抬火药的人。',
      '山洪将至，他选择改道放水。',
      '火药被截，干沟暴露给对岸。',
    ], { scene_type: 'fight' }),
  }), contract);
  assert.equal(swapped.filter(i => i.hard).length, 0, JSON.stringify(swapped));
  assert.equal(classifyEventClass({ goal: '沿干沟追截携带火药的人手' }), 'pursuit');
});

test('V0.103.0 近 5 章三次验工，第四次验工 hard', () => {
  const recent = [
    feat({ event_class: 'inspection' }),
    feat({ event_class: 'inspection' }),
    feat({ event_class: 'daily' }),
    feat({ event_class: 'inspection' }),
    feat({ event_class: 'pursuit' }),
  ];
  const contract = compileDiversityContract(recent);
  const issues = diversityContractIssues(outline({
    goal: '再沿墙基验工勘线',
    scenes: scenes(['再次验工勘线。', '核账渗水。', '把缺口记下来。']),
  }), contract);
  assert.ok(issues.some(i => i.hard && i.code === 'OUTLINE_EVENT_CLASS_SATURATED'), JSON.stringify(issues));
});

test('V0.103.0 对手戏是窗约束：近两章都是人对人则禁审讯主事件；近两章都不是则必须人对人', () => {
  const bothHuman = compileDiversityContract([
    feat({ event_class: 'interrogation', counterforce: 'human_opponent' }),
    feat({ event_class: 'inspection', counterforce: 'human_opponent' }),
  ]);
  const blocked = diversityContractIssues(outline({
    goal: '把灰袍人再审一遍逼问同党',
    counterforce: '灰袍人的同伙',
    scenes: scenes(['再审灰袍人。', '同伙来劫。', '把口供记下。']),
  }), bothHuman);
  assert.ok(blocked.some(i => i.hard && i.code === 'OUTLINE_OPPONENT_WINDOW_BLOCKED'), JSON.stringify(blocked));

  const bothClock = compileDiversityContract([
    feat({ event_class: 'travel', counterforce: 'clock' }),
    feat({ event_class: 'inspection', counterforce: 'environment' }),
  ]);
  const missing = diversityContractIssues(outline({
    goal: '沿山道赶路避开暴雨',
    counterforce: '暴雨和山体坍塌',
    scenes: scenes(['赶路避雨。', '山体松动。', '找到岩棚过夜。']),
  }), bothClock);
  assert.ok(missing.some(i => i.hard && i.code === 'OUTLINE_OPPONENT_WINDOW_MISSING'), JSON.stringify(missing));
});

test('V0.103.0 弱默认六轴（react/soft_resolution）互撞不构成同构 hard', () => {
  const contract = compileDiversityContract([feat({
    opening: 'unknown_open',
    initiative: 'react',
    counterforce: 'weak_counterforce',
    resolution: 'soft_resolution',
    artifact: 'none',
    ending: 'aftermath_pull',
    event_class: 'other',
  })]);
  const issues = diversityContractIssues(outline({
    title: '邻里闲话',
    goal: '市井买米吃饭歇息，邻里闲话',
    conflict: '米价与余粮',
    dramatic_question: '今晚还能否买到米？',
    counterforce: '米店缺货',
    turn: '邻里匀出半升',
    irreversible_change: '欠下一升人情',
    choice_cost: '把明日口粮先垫出去',
    reader_gain: '邻里关系变近',
    reader_pull: '还米的日子未到',
    pace: 'daily',
    scenes: scenes(['市井买米。', '邻里闲话歇息。', '把米背回家。'], { scene_type: 'daily' }),
  }), contract);
  assert.equal(issues.filter(i => i.code === 'OUTLINE_AXIS_ISOMORPHIC').length, 0, JSON.stringify(issues));
  assert.equal(issues.filter(i => i.hard && i.code === 'OUTLINE_EVENT_CLASS_REPEATED').length, 0);
});

test('V0.103.0 ending_hook 为 null 且 reader_pull 具体，多样性闸不杀', () => {
  const contract = compileDiversityContract([feat({
    event_class: 'inspection',
    hook_type: 'distant_signal',
    initiative: 'observe',
    resolution: 'record',
  })]);
  const issues = diversityContractIssues(outline({
    title: '干沟截火',
    goal: '沿干沟追截火药',
    counterforce: '三日时限',
    turn: '火药进沟',
    irreversible_change: '截获火药',
    choice_cost: '干沟暴露',
    reader_gain: '火药被截',
    reader_pull: '上游还有第二批火种，不必另塞烟火钩',
    ending_hook: null,
    scenes: scenes(['追截火药。', '选择改道。', '干沟暴露。'], { scene_type: 'fight' }),
  }), contract);
  assert.equal(issues.filter(i => i.hard).length, 0, JSON.stringify(issues));
});

test('V0.103.0 细纲质量门消费合同：再审讯 hard；非历史题材同样生效', () => {
  const contract = compileDiversityContract([feat({ event_class: 'interrogation' })]);
  const hist = chapterOutlineQualityIssues(outline({
    goal: '继续审讯逼问同党',
    scenes: scenes(['审讯继续。', '逼问同党名字。', '把名单记下。']),
  }), { chapterLength: 5000, diversityContract: contract, strictDramaticContract: true });
  assert.ok(hist.some(i => i.hard && i.code === 'OUTLINE_EVENT_CLASS_REPEATED'));

  const xuanhuan = chapterOutlineQualityIssues(outline({
    title: '再审余孽',
    goal: '把余孽再审一遍逼问秘法',
    dramatic_question: '秘法从谁嘴里出来？',
    counterforce: '余孽咬死不说',
    turn: '用刑也问不出',
    irreversible_change: '把拒供记入宗门册',
    choice_cost: '结下死仇',
    reader_gain: '仍无秘法',
    reader_pull: '余孽还有后手',
    scenes: scenes(['再审余孽逼问秘法。', '用刑仍无口供。', '把拒供记入宗门册。']),
  }), { chapterLength: 5000, diversityContract: contract, strictDramaticContract: true });
  assert.ok(xuanhuan.some(i => i.hard && i.code === 'OUTLINE_EVENT_CLASS_REPEATED'));
});

test('V0.103.0 连续 {处所}的风+刀子 开篇饱和；对话/动作起手不命中', () => {
 assert.equal(openerStructureTemplate('北崖的风像刀子。主角把绳结打完。'), 'place_wind_knife');
  assert.equal(openerStructureTemplate('南坡的风是钝刀子，吹得眼疼。'), 'place_wind_knife');
  const prev = [
    { idx: 35, text: '北崖的风像刀子，刮得旗绳直响。' },
    { idx: 36, text: '墙根的风是钝刀子，吹得眼眶发干。' },
  ];
  const hit = detectOpenerStructureSaturation('西沟的风像刀子，贴着石缝进来。', prev);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'medium');
  assert.equal(hit[0].type, '语句质量');
  assert.doesNotMatch(hit[0].fix || '', /号角吹了第三遍/);
 assert.equal(detectOpenerStructureSaturation('「谁在沟里？」主角把火压灭。', prev).length, 0);
 assert.equal(detectOpenerStructureSaturation('主角一把拽住抬火药的人，膝盖磕进泥里。', prev).length, 0);
});

test('V0.103.0 修订只删套话却把开篇改成近章同族则拒收', () => {
  const contract = compileDiversityContract([feat({ opener_family: 'place_wind_knife', ending: 'distant_signal' })]);
 const before = '主角把绳结打完。灰袍人似乎还在沟里。三日窗口没有关上。';
 const after = '北崖的风像刀子。主角把绳结打完。灰袍人还在沟里。三日窗口没有关上。';
  const issues = [{ type: '语句质量', severity: 'medium', issue: '「似乎」同词超限', quote: '似乎', fix: '删掉似乎' }];
  const rejected = diversityRegression(before, after, contract, { issues });
  assert.equal(rejected.reject, true);

 const kept = diversityRegression(before, '主角把绳结打完。灰袍人还在沟里。三日窗口没有关上。', contract, { issues });
  assert.equal(kept.reject, false);
});

test('V0.103.0 纪律文本与技法注入不再灌库存正例；简报压成机制句', () => {
  assert.doesNotMatch(CONTINUITY_CRAFT_TEXT, /号角吹了第三遍/);
  const twoPrev = [
    { idx: 1, text: '天没亮，雾贴着壕沟。' },
    { idx: 2, text: '天未亮，露水打湿旗绳。' },
  ];
  const tic = detectChapterOpenerTic('天还没亮透，雾又起来了。', twoPrev);
  assert.ok(tic.length);
  assert.doesNotMatch(tic[0].fix || '', /号角吹了第三遍/);
  assert.doesNotMatch(techniqueInjection('emotion'), /例：/);

  const write = writeSceneInstruction({
    bookTitle: '多样性测试', chapterIdx: 37, chapterTitle: '干沟',
    goal: '追截火药', conflict: '暴露与截火不可兼得',
 scene: { id: 's1', pov: '主角', location: '干沟', scene_type: 'fight', target_words: 1250, beat: '主角必须决定是否改道放水。' },
    scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [],
    timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '',
    constraints: '', styleRules: '', isHistory: false, sceneType: 'fight',
    diversityText: compileDiversityContract([feat({ event_class: 'interrogation' })]).text,
  });
  assert.match(write, /近窗换轴/);
  assert.match(write, /决定|选择/);
  assert.doesNotMatch(write, /号角吹了第三遍/);
});

test('V0.103.0 细纲指令不再每章复读「连续三章必须对手戏」；有合同则注入占用轴', () => {
  const bare = chapterOutlineInstruction({
    bookTitle: '多样性测试', chapterIdx: 2, volumeGoal: '推进',
    recentSummaries: [], rollingSummary: '', activeForeshadows: [],
  });
  assert.doesNotMatch(bare, /连续 3 章内必须/);
  const filled = chapterOutlineInstruction({
    bookTitle: '多样性测试', chapterIdx: 37, volumeGoal: '推进',
    recentSummaries: [], rollingSummary: '', activeForeshadows: [],
    diversityText: compileDiversityContract([feat({ event_class: 'interrogation' })]).text,
  });
  assert.match(filled, /近窗换轴/);
  assert.match(filled, /interrogation/);
});

test('V0.103.0 修订指令最小改动；吸引力补强禁补远方钩', () => {
  const text = reviseInstruction({
    bookTitle: '多样性测试', chapterTitle: '干沟',
 scene: { beat: '追截', pov: '主角', location: '干沟', target_words: 1000, content: '原文似乎还在。' },
    issues: [{ severity: 'medium', type: '语句质量', issue: '似乎超限', quote: '似乎', fix: '删掉' }],
  });
  assert.match(text, /只修复列出的问题|其余.*不变|不得改开篇结构/);
  const note = attractionRevisionNote({ isHistory: true, rewardMode: '信息' });
  assert.match(note, /本章已有因果|自然产生的余力/);
  assert.doesNotMatch(note, /必须.*章末钩子/);
  assert.match(note, /不得硬塞陌生人|不要.*烟柱|不得.*烟柱/);
  const audit = auditInstruction({
    bookTitle: '多样性测试', chapterTitle: '干沟', chapterText: '正文',
    diversityText: compileDiversityContract([feat({ event_class: 'interrogation' })]).text,
  });
  assert.match(audit, /近窗换轴/);
});

test('V0.103.0 多样性失败不是立刻清场；软事实矛盾合同不回退', () => {
  const space = stampOpeningTimelineProseFix([{
    type: '事实矛盾', severity: 'high',
 quote: '主角缩进墙基后的阴影',
    issue: '场景逻辑与空间连续性严重冲突',
    fix: '补位移',
  }]);
  assert.equal(shouldImmediateReplanWipe({ verdict: 'fix', issues: space }, { hasDraft: true, reviseRound: 0 }), false);
  assert.equal(shouldImmediateReplanWipe({
    verdict: 'fix',
    issues: [{ type: '事实编造', severity: 'high', quote: '老幺', issue: '未登记', fix: '改回' }],
  }, { hasDraft: true, reviseRound: 2 }), true);
});

test('V0.103.0 结算写入完整 features；管线接线不含书名开关', () => {
  const features = diversityFeatures({
    outline: outline({ goal: '审讯灰袍人逼问地道' }),
 text: '北崖的风像刀子。主角按住灰袍人，逼问地道。',
  });
  assert.equal(features.event_class, 'interrogation');
  assert.equal(features.opener_family, 'place_wind_knife');
  assert.ok(features.initiative);
  const root = process.cwd();
  const outlineSrc = fs.readFileSync(path.join(root, 'server/engine/planning/outline.js'), 'utf8');
  const writeSrc = fs.readFileSync(path.join(root, 'server/engine/pipeline/write.js'), 'utf8');
  const auditSrc = fs.readFileSync(path.join(root, 'server/engine/pipeline/audit.js'), 'utf8');
  const pipelineSrc = fs.readFileSync(path.join(root, 'server/engine/pipeline/pipeline.js'), 'utf8');
  const settleSrc = fs.readFileSync(path.join(root, 'server/engine/pipeline/settle.js'), 'utf8');
  const nsSrc = fs.readFileSync(path.join(root, 'server/engine/narrative/narrative_state.js'), 'utf8');
  assert.match(outlineSrc, /diversityContract|compileDiversityContract|loadRecentDiversityFeatures/);
  assert.match(writeSrc, /diversityText/);
  assert.match(auditSrc, /diversityRegression|diversityText/);
  assert.match(pipelineSrc, /settleChapter/);
  assert.match(settleSrc, /recordChapterDiversityFeatures/);
  assert.match(nsSrc, /recordChapterDiversityFeatures/);
  assert.doesNotMatch(pipelineSrc, /narrativePatterns\.upsert/);
 assert.doesNotMatch(outlineSrc + writeSrc, /示例历史长篇/);
});

test('V0.103.0 mock 细纲按章换轴，相邻章多样性闸不 hard', async () => {
  const { chatCompletion } = await import('../server/llm/client.js');
  const parse = async (idx) => JSON.parse((await chatCompletion({
    model: 'm',
    messages: [{ role: 'user', content: `请为《测》第${idx}章生成细纲` }],
    jsonMode: true,
  })).content);
  const o1 = await parse(1);
  const o2 = await parse(2);
  const last = diversityFeatures({
    outline: o1,
    text: '雨下到第1遍更鼓还没停。她推开门，看见他站在巷口。',
  });
  const issues = diversityContractIssues(o2, compileDiversityContract([last]));
  assert.equal(issues.filter(i => i.hard).length, 0, JSON.stringify(issues));
  assert.notEqual(classifyEventClass(o1), classifyEventClass(o2));
});
