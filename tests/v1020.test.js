// V0.102.0：卷缝编译器——上一卷实际出口、停滞弧、有界兑付队列、短中钩超期老化。
// 依据 docs/卷缝与长线压力调研报告.md。不把全量台账灌进卷纲/章纲。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const store = await import('../server/db/store.js');
const {
  compileVolumeSeam,
  validateVolumeSeam,
  compileChapterHorizon,
  formatVolumeSeamText,
  formatChapterHorizonText,
  hooksDueToAge,
} = await import('../server/engine/horizon.js');
const { buildVolumeSeam, buildChapterHorizon } = await import('../server/engine/horizon.js');
const { volumeOutlineInstruction, chapterOutlineInstruction } = await import('../server/engine/prompts.js');
const { settleHookLedger } = await import('../server/engine/pleasure.js');

function seedHistoryBook() {
  return store.books.create({ title: '卷缝测试', genre: '历史' });
}

test('V0.102 短中钩超期无推进必须老化，长线仍转伏笔；有推进的不杀', () => {
  const shortDue = { desc: '明日比试', kind: 'short', dueChapter: 4, plantedChapter: 2, status: 'open' };
  const mediumDue = { desc: '账册对上', kind: 'medium', dueChapter: 8, plantedChapter: 5, status: 'open' };
  const longDue = { desc: '身世之谜', kind: 'long', dueChapter: 10, plantedChapter: 2, status: 'open' };
  const longProgress = { desc: '魔器来历', kind: 'long', dueChapter: 10, plantedChapter: 2, status: 'open', lastProgressChapter: 28 };
  const aged = hooksDueToAge([shortDue, mediumDue, longDue, longProgress], 30);
  assert.ok(aged.some(h => h.desc === '明日比试'), '短线超期必须进老化队列');
  assert.ok(aged.some(h => h.desc === '账册对上'), '中线超期必须进老化队列');
  assert.ok(aged.some(h => h.desc === '身世之谜'), '长线超期仍老化');
  assert.ok(!aged.some(h => h.desc === '魔器来历'), '有推进的长线不老化');
});

test('V0.102 settleHookLedger 短线超期 expire 且不转伏笔', () => {
  const b = seedHistoryBook();
  store.pleasureHooks.create(b.id, { desc: '明日比试', kind: 'short', type: '危机钩', plantedChapter: 2, dueChapter: 4, status: 'open', intensity: 3 });
  store.pleasureHooks.create(b.id, { desc: '身世之谜待解', kind: 'long', type: '悬念钩', plantedChapter: 2, dueChapter: 10, status: 'open', intensity: 4 });
  const r = settleHookLedger(b.id, 30);
  assert.ok(r.abandoned >= 2, `短线+长线都应老化，actual=${r.abandoned}`);
  const short = store.pleasureHooks.list(b.id).find(h => h.desc === '明日比试');
  assert.equal(short.status, 'expired');
  assert.ok(!store.foreshadows.list(b.id).some(f => f.desc.includes('明日比试')), '短线老化不得转伏笔');
  assert.ok(store.foreshadows.list(b.id).some(f => f.desc.includes('身世之谜')), '长线老化仍转伏笔');
});

test('V0.102 卷缝编译：出口事实、停滞弧、无回收章伏笔进入有界队列', () => {
  const seam = compileVolumeSeam({
    previousVolumeIdx: 4,
    previousVolumeTitle: '风雨欲来',
    previousTurn: '就任东崖防区指挥',
    lastChapter: {
      idx: 34, title: '狼烟', year: 1258,
 summary: '假料签传递链被截获，钱六收押。行在塘报确认北虏大汗自率大军入蜀。主角回到前哨防区值夜。',
      tail: '他登上垛口，接过巡签。对岸石岭方向黑沉沉的。',
      goal: '验证假料签传递链并等到交接发生再收网',
    },
 previousSummaries: ['主角向主将汇报新线', '前哨防区值夜'],
    staleArcs: [
      { name: '女配感情线', last_active_chapter: 17, opened_chapter: 17 },
      { name: '权相权谋线', last_active_chapter: 17, opened_chapter: 17 },
    ],
    overdueHooks: [{ desc: '母亲银簪', kind: 'medium', due_chapter: 10 }],
    plantedForeshadows: [
 { desc: '主角随身保存亡弟旧物', planted_chapter: 5, payoff_chapter: null, status: 'planted' },
      { desc: '明日升帐军议', planted_chapter: 32, payoff_chapter: null, status: 'planted' },
    ],
    previousSignatures: [
      'situation_open>observe>authority>record>ledger>distant_signal',
      'situation_open>observe>human_opponent>record>map>distant_signal',
      'situation_open>report_or_obey>authority>soft_resolution>ledger>task_or_clock',
      'situation_open>observe>authority>record>ledger>distant_signal',
    ],
  });
  assert.equal(seam.previousVolumeIdx, 4);
  assert.ok(seam.exitFacts.some(f => /北虏大汗|前哨防区|钱六|假料/.test(f)), `出口事实应咬住正文：${seam.exitFacts.join(',')}`);
  assert.equal(seam.unpaidTurn, '就任东崖防区指挥');
  assert.equal(seam.staleArcs.length, 2);
  assert.ok(seam.payoffQueue.length <= 6);
  assert.ok(seam.payoffQueue.some(item => /旧物|升帐|银簪/.test(item.desc)));
  assert.equal(seam.microLoop, true);
  const text = formatVolumeSeamText(seam);
  assert.match(text, /狼烟/);
  assert.match(text, /女配/);
  assert.doesNotMatch(text, /指节发麻|旁观震惊/);
});

test('V0.102 卷缝校验：首章脱离实际出口则拒；不推进停滞弧则拒；微循环再写一卷则拒', () => {
  const seam = compileVolumeSeam({
    previousVolumeIdx: 4,
    previousTurn: '就任东崖防区指挥',
 lastChapter: { idx: 34, title: '狼烟', summary: '北虏大汗入蜀，主角前哨防区值夜，钱六已收押。', tail: '前哨防区垛口', goal: '收网' },
    previousSummaries: ['前哨防区值夜'],
    staleArcs: [{ name: '女配感情线', last_active_chapter: 17, opened_chapter: 17 }],
    overdueHooks: [],
    plantedForeshadows: [{ desc: '明日升帐军议', planted_chapter: 32, payoff_chapter: null }],
    previousSignatures: Array.from({ length: 4 }, () => 'situation_open>observe>authority>record>ledger>distant_signal'),
  });

  const disconnected = validateVolumeSeam({
    stage_turn: '围城开始',
    arcs_advanced: ['山河守护主线'],
    hooks_paid: [],
    chapters: [
 { idx: 1, beat: '主角在集市买糖人，与陌生货郎闲聊物价', goal: '过一个安稳的早晨' },
      { idx: 2, beat: '继续观察脚印并记入工册' },
      { idx: 3, beat: '复核竹管焦痕' },
    ],
  }, seam);
  assert.equal(disconnected.ok, false);
  assert.ok(disconnected.issues.some(i => i.code === 'SEAM_EXIT_IGNORED'));

  const noStale = validateVolumeSeam({
    stage_turn: '北虏大汗围城',
    arcs_advanced: ['山河守护主线'],
    hooks_paid: ['明日升帐军议'],
    chapters: [
 { idx: 1, beat: '主将升帐，主角汇报钱六案与北虏大汗入蜀军报，前哨防区防段落定', goal: '临战部署' },
      { idx: 2, beat: '飞砲测距，击退夜袭' },
      { idx: 3, beat: '地道攻防，汪德臣殒命' },
    ],
  }, seam);
  assert.equal(noStale.ok, false);
  assert.ok(noStale.issues.some(i => i.code === 'STALE_ARC_IGNORED'));

  const loop = validateVolumeSeam({
    stage_turn: '继续看桩',
    arcs_advanced: ['女配感情线'],
    hooks_paid: ['明日升帐军议'],
    chapters: [
 { idx: 1, beat: '主角观察前哨防区脚印并记入工册，等候主将复核', goal: '把痕迹写入账册' },
      { idx: 2, beat: '继续观察竹管并请示大人验证' },
      { idx: 3, beat: '把路线标记在图上交陈七保管' },
    ],
  }, seam);
  assert.equal(loop.ok, false);
  assert.ok(loop.issues.some(i => i.code === 'VOLUME_MICRO_LOOP'));

  const ok = validateVolumeSeam({
    stage_turn: '钓鱼城开打，前哨防区从值夜转为守城',
    arcs_advanced: ['女配感情线', '山河守护主线'],
    hooks_paid: ['明日升帐军议'],
    chapters: [
 { idx: 1, beat: '主将升帐部署，主角带着钱六案与北虏大汗军报请领前哨防区守段，女配到伤科备药', goal: '临战交接' },
 { idx: 2, beat: '飞砲砸前哨防区，主角测距校正，阿蛮抬伤员' },
 { idx: 3, beat: '夜袭地道，主角选择灌水还是塌方，代价是一段墙基' },
    ],
  }, seam);
  assert.equal(ok.ok, true, ok.issues.map(i => i.code + i.message).join(';'));
});

test('V0.102 章级长线简报最多四条兑付，不把九十条钩子写进指令', () => {
  const hooks = Array.from({ length: 90 }, (_, i) => ({ desc: `过期钩${i}`, kind: 'medium', due_chapter: i + 1 }));
  const brief = compileChapterHorizon({
    chapterIdx: 35,
    exitLine: '第34章《狼烟》：北虏大汗入蜀，前哨防区值夜',
    staleArcs: [{ name: '女配感情线', last_active_chapter: 17 }],
    duePayoffs: hooks,
  });
  assert.ok(brief.payoffs.length <= 4);
  const text = formatChapterHorizonText(brief);
  assert.ok(text.length < 900, `简报过长：${text.length}`);
  assert.match(text, /女配|狼烟|北虏大汗|前哨防区/);
  assert.doesNotMatch(text, /过期钩89/);
});

test('V0.102 卷纲/章纲指令能接收卷缝与长线简报；无缝时不加独立故事碎片', () => {
  const vol = volumeOutlineInstruction({
    bookTitle: 'T', volumeIdx: 5, volumeTitle: '钓鱼城头', bookOutline: '纲', chapterCount: 8,
    seamText: '【卷缝】上卷出口：第34章《狼烟》北虏大汗入蜀。停滞弧：女配感情线。',
  });
  assert.match(vol, /卷缝/);
  assert.match(vol, /狼烟/);
  const ch = chapterOutlineInstruction({
    bookTitle: 'T', chapterIdx: 35, volumeGoal: '守城',
    recentSummaries: [], rollingSummary: '', activeForeshadows: [],
    horizonText: '【本章长线简报】承接前哨防区值夜；推进女配感情线。',
  });
  assert.match(ch, /长线简报|前哨防区/);
  const bare = volumeOutlineInstruction({
    bookTitle: 'X', volumeIdx: 1, volumeTitle: '开篇', bookOutline: '纲', chapterCount: 6,
  });
  assert.doesNotMatch(bare, /【卷缝】/);
});

test('V0.102 无前卷的新书：store 编译缝为空，校验通过（非长篇零影响）', () => {
  const b = store.books.create({ title: '玄幻开书', genre: '玄幻' });
  const v = store.volumes.create(b.id, 1, { title: '第一卷', status: 'planned' });
  const seam = buildVolumeSeam(b.id, 1);
  assert.equal(seam.previousVolumeIdx, 0);
  assert.equal(validateVolumeSeam({ stage_turn: '拜师', arcs_advanced: [], hooks_paid: [], chapters: [{ idx: 1, beat: '少年入门' }] }, seam).ok, true);
  const horizon = buildChapterHorizon(b.id, 1);
  assert.ok(formatChapterHorizonText(horizon).length < 400 || !horizon.payoffs?.length);
  void v;
});

test('V0.102 卷缝编译器文件仍在树中（版本号由 v025 单源断言）', () => {
  assert.ok(fs.existsSync(path.join(process.cwd(), 'server/engine/horizon.js')));
});
