// V0.103.1：质量门带码、partial 续跑、结算写 features、细纲期六轴口径、写审同源。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../server/db/store.js';
import {
  compileDiversityContract, diversityContractIssues, diversityFeatures, diversityRegression,
} from '../server/engine/chapter_diversity.js';
import { narrativePatternFeatures } from '../server/engine/narrative_patterns.js';
import { evaluateOutlineQuestions, chapterOutlineQualityIssues } from '../server/engine/outline.js';
import { reviseInstruction } from '../server/engine/prompts.js';
import { chapterFailurePolicy } from '../server/engine/pilot.js';
import { settleChapter } from '../server/engine/settle.js';
import { shouldImmediateReplanWipe } from '../server/engine/pipeline.js';
import { stampOpeningTimelineProseFix } from '../server/engine/historical_guardrails.js';
import { schedulerCheck } from '../server/engine/pleasure.js';
import { transitionChapterStatus } from '../server/engine/chapter_status.js';

function scenes(beats, extra = {}) {
  return beats.map((beat, i) => ({
 id: `s${i + 1}`, pov: extra.pov || '主角', location: extra.location || '北崖',
    scene_type: extra.types?.[i] || extra.scene_type || 'suspense',
    pacing: extra.pacings?.[i] || '推进',
    beat, target_words: extra.target_words || 1700,
  }));
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

test('V0.103.1 质量门 hard 与字数门均归 OUTLINE_GUARD_FAILED / quality_blocked', () => {
  const outlineSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/outline.js'), 'utf8');
  const gateThrow = outlineSrc.slice(
    outlineSrc.indexOf('细纲质量门未通过'),
    outlineSrc.indexOf('细纲质量门未通过') + 280,
  );
  assert.match(gateThrow, /OUTLINE_GUARD_FAILED/, '质量门 hard 必须带码，否则 pilot 打成 planned 停机');

  const quality = chapterFailurePolicy('OUTLINE_GUARD_FAILED', { hasDraftContent: false });
  assert.equal(quality.qualityStop, true);
  assert.equal(quality.status, 'quality_blocked');

  const length = chapterFailurePolicy('CHAPTER_LENGTH_BLOCKED', { hasDraftContent: true });
  assert.equal(length.qualityStop, true);
  assert.equal(length.status, 'quality_blocked');

  const unknown = chapterFailurePolicy(undefined, { hasDraftContent: false });
  assert.equal(unknown.status, 'planned');
});

test('V0.103.1 partial 再启动走 autoFixBlocked，不在 while 头直接 need_human', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/engine/pilot.js'), 'utf8');
  const autoFix = src.slice(src.indexOf('async function autoFixBlocked'), src.indexOf('export function qualityAutoRetryLimit'));
  assert.match(autoFix, /quality_blocked['"]?\s*(?:,|\s*\|\||\s*\))/, 'autoFixBlocked 必须扫 quality_blocked');
  assert.match(
    autoFix,
    /status === ['"]partial['"]|['"]partial['"]\s*\]|includes\(['"]partial['"]\)/,
    'autoFixBlocked 必须把 partial 与 quality_blocked 一样送进 runChapterFlow',
  );
});

test('V0.103.1 settleChapter 写入 narrative_patterns features', async () => {
  const book = store.books.create({ title: '结算多样性书', genre: '玄幻' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });
  store.chapters.update(chapter.id, {
    outline: {
      title: '第一章',
      goal: '审讯旧敌逼问玉佩来历',
      conflict: '旧敌拒供',
      counterforce: '旧敌咬死不说',
      scenes: [{ id: 's1', beat: '审讯旧敌逼问来历。', pov: '林晚' }],
    },
  });
  store.scenes.create(chapter.id, 1, { content: '林晚审讯旧敌，逼问玉佩来历。', status: 'done' });
  transitionChapterStatus(book.id, chapter.id, 'drafted', { reason: '正文已写' });
  await settleChapter(book.id, chapter.id, {
    data: {
      facts: [{ subject: '林晚', predicate: '审讯', object: '旧敌' }],
      character_updates: [{ name: '林晚', changes: ['位置=青云城'] }],
      character_emotional: [{ name: '林晚', mood: '警惕', relation_delta: '与旧敌决裂' }],
      timeline: ['林晚审讯旧敌'],
      foreshadow_actions: [],
      new_entities: [],
      summary: '林晚审讯旧敌逼问玉佩。',
      rolling_update: '林晚审讯旧敌。',
    },
  });
  const rows = store.narrativePatterns.list(book.id, { beforeChapter: 2, limit: 5 });
  assert.ok(rows.length >= 1, '结算必须写入 narrative_patterns');
  assert.equal(rows[0].chapter_idx, 1);
  assert.equal(rows[0].features?.event_class, 'interrogation');
  assert.ok(rows[0].features?.initiative);
});

test('V0.103.1 细纲期六轴用 outline-only，不被上章正文轴误杀', () => {
  const dailyOutline = {
    title: '邻里闲话',
    goal: '市井买米吃饭歇息，邻里闲话',
    conflict: '米价与余粮',
    dramatic_question: '今晚还能否买到米？',
    counterforce: '米店缺货',
    turn: '邻里匀出半升',
    irreversible_change: '欠下一升人情',
    choice_cost: '把口粮垫出去',
    reader_gain: '邻里关系变近',
    reader_pull: '还米的日子未到',
    scenes: scenes(['市井买米。', '邻里闲话歇息。', '把米背回家。'], { scene_type: 'daily' }),
  };
  const last = {
    ...feat({
      initiative: 'choose_and_pay',
      counterforce: 'human_opponent',
      resolution: 'irreversible_action',
      artifact: 'map',
      ending: 'task_or_clock',
      event_class: 'daily',
    }),
    outline_axes: diversityFeatures({ outline: dailyOutline, text: '' }),
  };
  const candidate = {
    title: '酒馆余波',
    goal: '主角登场并遭遇冲突',
    conflict: '旧敌寻仇',
    dramatic_question: '林晚是否愿意为了守住酒馆正面反抗旧敌？',
    counterforce: '旧敌带人堵门并砸毁酒坛，逼他当众低头',
    turn: '林晚发现旧敌真正寻找的是他腰间玉佩',
    irreversible_change: '酒馆被砸，林晚与旧敌公开决裂，玉佩秘密暴露',
    choice_cost: '林晚选择迎战，失去继续隐姓埋名的退路',
    reader_gain: '林晚第一次主动反抗',
    reader_pull: '林晚必须先查清玉佩来历',
    scenes: scenes(['林晚在城门遇到旧敌。', '旧敌砸毁酒坛。', '公开决裂。']),
  };
  const issues = diversityContractIssues(candidate, compileDiversityContract([last]));
  assert.equal(
    issues.filter(i => i.code === 'OUTLINE_AXIS_ISOMORPHIC').length, 0,
    `上章细纲是日常，不得被正文里的选择/旧敌/决裂轴误杀：${JSON.stringify(issues)}`,
  );
});

test('V0.105 主簿查账是朝堂人对人，不得因未写「大人」判成无阻力', () => {
  const feat44 = narrativePatternFeatures({
    outline: {
      counterforce: '户部主簿带着严苛算学程序试图证明私设刑堂',
      conflict: '战时专断军权与朝廷主簿查账之间的冲突',
    },
  });
  assert.equal(feat44.counterforce, 'authority',
    '主簿/查账必须算 authority，不能因为没写「大人」就弱成无阻力');

  const lastTwo = [
    feat({ event_class: 'council', counterforce: 'authority' }),
    feat({ event_class: 'battle', counterforce: 'weak_counterforce' }),
  ];
  const contract = compileDiversityContract(lastTwo);
  const isolated = {
    title: '北崖孤灯',
    goal: '查出谁动过工册',
    conflict: '内部有人要毁记录',
    dramatic_question: '要不要当场上报',
    counterforce: '内部信任危机',
    turn: '抓住烧册的杂役',
    irreversible_change: '手里握住内部名单',
    choice_cost: '决定暂不上报以免打草惊蛇',
    reader_gain: '知道账册被人动过',
    reader_pull: '泸州方向还有消息',
    scenes: scenes(['暗桩被触动。', '抓住烧册杂役。', '决定是否上报。']),
  };
  assert.equal(
    diversityContractIssues(isolated, contract).filter(i => i.code === 'OUTLINE_OPPONENT_WINDOW_MISSING').length,
    0,
    '上章已是主簿查账，不得再逼本章必须补人对人',
  );
});

test('V0.103.1 authority 算人对人；三日时限分类为 clock', () => {
  assert.equal(narrativePatternFeatures({
    outline: { counterforce: '三日时限与巷口封路', conflict: '天亮前必须追上' },
  }).counterforce, 'clock');

  const bothAuthority = compileDiversityContract([
    feat({ event_class: 'council', counterforce: 'authority' }),
    feat({ event_class: 'report_ledger', counterforce: 'authority' }),
  ]);
  const travel = {
    title: '山道避雨',
    goal: '沿山道赶路避开暴雨',
    conflict: '暴雨与山体松动',
    dramatic_question: '今晚能否赶到岩棚？',
    counterforce: '暴雨和山体坍塌',
    turn: '路人分出蓑衣',
    irreversible_change: '与路人同行并承诺过岗',
    choice_cost: '把干粮分掉一半',
    reader_gain: '暴雨夜里多了一个同行的人',
    reader_pull: '过岗之后还能不能再见面',
    scenes: scenes(['沿山道赶路。', '山体松动。', '岩棚过夜。'], { scene_type: 'daily' }),
  };
  const missing = diversityContractIssues(travel, bothAuthority);
  assert.equal(
    missing.filter(i => i.code === 'OUTLINE_OPPONENT_WINDOW_MISSING').length, 0,
    `朝堂大人两章不得判成无人：${JSON.stringify(missing)}`,
  );

  const blocked = diversityContractIssues({
    title: '再审',
    goal: '把余孽再审一遍逼问秘法',
    conflict: '余孽拒供',
    dramatic_question: '秘法从谁嘴里出来？',
    counterforce: '余孽咬死不说',
    turn: '用刑也问不出',
    irreversible_change: '把拒供记入宗门册',
    choice_cost: '结下死仇',
    reader_gain: '仍无秘法',
    reader_pull: '余孽还有后手',
    scenes: scenes(['再审余孽逼问秘法。', '用刑仍无口供。', '把拒供记入宗门册。']),
  }, bothAuthority);
  assert.ok(blocked.some(i => i.hard && i.code === 'OUTLINE_OPPONENT_WINDOW_BLOCKED'), JSON.stringify(blocked));
});

test('V0.103.1 字符串 ending_hook 不是 none；事件类 hard 文案与闸一致', () => {
  const typed = diversityFeatures({ outline: { ending_hook: '危机钩' } });
  assert.notEqual(typed.hook_type, 'none');
  const desc = diversityFeatures({ outline: { ending_hook: '旧敌撂下狠话，说玉佩主人终将找上门来' } });
  assert.notEqual(desc.hook_type, 'none');

  const issues = diversityContractIssues({
    goal: '继续审讯逼问同党',
    conflict: '同党拒供',
    dramatic_question: '同党名字从谁嘴里出来？',
    counterforce: '灰袍人拒不招供',
    turn: '问不出',
    irreversible_change: '把拒供记下',
    choice_cost: '结仇',
    reader_gain: '仍无名单',
    reader_pull: '还有后手',
    scenes: scenes(['审讯继续。', '逼问同党名字。', '把名单记下。']),
  }, compileDiversityContract([feat({ event_class: 'interrogation' })]));
  const repeated = issues.find(i => i.code === 'OUTLINE_EVENT_CLASS_REPEATED');
  assert.ok(repeated, JSON.stringify(issues));
  assert.doesNotMatch(repeated.issue, /或至少同时改/);
});

test('V0.103.1 五问 q4 含无但 reader_pull 具体则过；非历史同样生效', () => {
  const hist = evaluateOutlineQuestions({
    q4_ending_hook: '无新钩',
    q6_emotional_change: '邻里关系变近',
    reader_value: { type: '信息', gain: '得到米价' },
    pass: false,
  }, { isHistory: true, readerPull: '还米的日子未到' });
  assert.equal(hist.pass, true, hist.failReason);

  const xuanhuan = evaluateOutlineQuestions({
    q4_ending_hook: '无',
    pass: false,
  }, { platform: '通用', isHistory: false, readerPull: '上游还有第二批火种' });
  assert.equal(xuanhuan.pass, true, xuanhuan.failReason);
});

test('V0.103.1 修订开篇饱和允许换起手；普通套话仍禁止改开篇', () => {
  const opener = reviseInstruction({
    bookTitle: '测', chapterTitle: '一',
    scene: { beat: '开场', target_words: 1000, content: '北崖的风像刀子。' },
    issues: [{
      severity: 'medium', type: '语句质量',
      issue: '章首结构「place_wind_knife」与上一章相同',
      quote: '北崖的风像刀子',
      fix: '换起手结构，不得复用近章已占用的开篇族',
    }],
  });
  assert.match(opener, /换起手|允许改开篇|必须换起手/);
  assert.doesNotMatch(opener, /不得改开篇结构/);

  const cliche = reviseInstruction({
    bookTitle: '测', chapterTitle: '一',
    scene: { beat: '开场', target_words: 1000, content: '他似乎看见了。' },
    issues: [{
      severity: 'medium', type: '语句质量',
      issue: '套话「似乎」',
      quote: '似乎',
      fix: '删掉似乎',
    }],
  });
  assert.match(cliche, /不得改开篇结构/);
});

test('V0.103.1 diversityRegression 只判第 1 场开篇与末场收束', () => {
  const contract = compileDiversityContract([feat({ opener_family: 'place_wind_knife', ending: 'distant_signal' })]);
 const before = '他推开门走进棚里。主角按住灰袍人。';
 const after = '北崖的风像刀子。主角按住灰袍人。';
  const mid = diversityRegression(before, after, contract, {
    issues: [{ type: '语句质量', issue: '似乎' }],
    sceneIdx: 2,
    isLastScene: false,
  });
  assert.equal(mid.reject, false, '中场第一句不得当章首开篇回归');

  const first = diversityRegression(before, after, contract, {
    issues: [{ type: '语句质量', issue: '似乎' }],
    sceneIdx: 1,
    isLastScene: false,
  });
  assert.equal(first.reject, true);
});

test('V0.103.1 快感调度不再点名 3 级危机钩；细纲合同只编译一次', () => {
  const book = store.books.create({ title: '调度书', genre: '玄幻' });
  const vol = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let i = 1; i <= 3; i++) {
    const ch = store.chapters.create(book.id, vol.id, i, { title: `第${i}章` });
    store.chapterHealth.add({ bookId: book.id, chapterId: ch.id, idx: i, verdict: 'ok' });
    const h = store.chapterHealth.getByChapter(ch.id);
    store.chapterHealth.update(h.id, { notes: JSON.stringify({ emotion: { type: '平淡', intensity: 4 }, hook: { present: false, intensity: 0 } }) });
  }
  const rules = schedulerCheck(book.id, 4).join('\n');
  assert.doesNotMatch(rules, /3级以上钩子（危机\/悬念\/反转\/挑衅\/倒计时）/);
  if (/最近3章/.test(rules) && /钩/.test(rules)) {
    assert.match(rules, /reader_pull|已有因果|余力/);
  }

  const outlineSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/outline.js'), 'utf8');
  const fn = outlineSrc.slice(
    outlineSrc.indexOf('export async function generateChapterOutline'),
    outlineSrc.indexOf('export async function fiveQuestionsCheck'),
  );
  const compiles = fn.split('compileBookDiversityContract').length - 1;
  assert.equal(compiles, 1, `generateChapterOutline 应只编译一次多样性合同，实际 ${compiles}`);
});

test('V0.103.1 细纲质量门仍拦事件类连用；软事实矛盾不清场', () => {
  const hist = chapterOutlineQualityIssues({
    title: '再审',
    goal: '继续审讯逼问同党',
    conflict: '同党拒供',
    dramatic_question: '同党名字从谁嘴里出来？',
    counterforce: '灰袍人拒不招供',
    turn: '问不出',
    irreversible_change: '把拒供记下',
    choice_cost: '结仇',
    reader_gain: '仍无名单',
    reader_pull: '还有后手',
    scenes: scenes(['审讯继续。', '逼问同党名字。', '把名单记下。']),
  }, {
    chapterLength: 5000,
    diversityContract: compileDiversityContract([feat({ event_class: 'interrogation' })]),
    strictDramaticContract: true,
  });
  assert.ok(hist.some(i => i.hard && i.code === 'OUTLINE_EVENT_CLASS_REPEATED'));

  const space = stampOpeningTimelineProseFix([{
    type: '事实矛盾', severity: 'high',
 quote: '主角缩进墙基后的阴影',
    issue: '场景逻辑与空间连续性严重冲突',
    fix: '补位移',
  }]);
  assert.equal(shouldImmediateReplanWipe({ verdict: 'fix', issues: space }, { hasDraft: true, reviseRound: 0 }), false);
});
