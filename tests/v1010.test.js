// V0.101.0：自动创作质量内核——章级红线按场景余量分配、角色语音卡、
// 低谷调度、题材偏好槽。依据 docs/人声低谷与写时配额调研报告.md。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const store = await import('../server/db/store.js');
const { resolveCraftProfile, evidenceCertaintyThreshold } = await import('../server/engine/quality/craft_profile.js');
const {
  countMotifHits,
  sceneMotifCap,
  buildCraftQuotaText,
} = await import('../server/engine/quality/craft_quota.js');
const { characterCardsText } = await import('../server/engine/narrative/characters.js');
const { detectSpeechForbidHits, detectEvidenceCertaintyStack } = await import('../server/engine/quality/rules.js');
const { schedulerCheck } = await import('../server/engine/quality/pleasure.js');
const { writeSceneInstruction, rosterTidyInstruction, auditInstruction } = await import('../server/engine/prompts.js');
const { VALLEY_FRAGMENT_TEXT } = await import('../server/data/literary_techniques.js');

test('V0.101 历史题材预设为严格物证/权限，玄幻为高回报且物证关闭', () => {
  const history = resolveCraftProfile({ genre: '历史' });
  assert.equal(history.evidenceBound, 'strict');
  assert.equal(history.permissionBound, 'strict');
  assert.equal(history.rewardIntensity, 'medium');
  assert.equal(history.valleyCadence, 4);
  assert.equal(history.isHistory, true);

  const xuanhuan = resolveCraftProfile({ genre: '玄幻' });
  assert.equal(xuanhuan.evidenceBound, 'off');
  assert.equal(xuanhuan.permissionBound, 'loose');
  assert.equal(xuanhuan.rewardIntensity, 'high');
  assert.equal(xuanhuan.isHistory, false);
  assert.equal(evidenceCertaintyThreshold(xuanhuan), 99);
  assert.ok(evidenceCertaintyThreshold(history) < 3);
});

test('V0.101 settings.craftProfile 只接受合法枚举，非法键不得覆盖预设', () => {
  const profile = resolveCraftProfile({ genre: '历史' }, {
    craftProfile: { evidenceBound: 'off', valleyCadence: 99, unknownSlot: 'x', rewardIntensity: 'high' },
  });
  assert.equal(profile.evidenceBound, 'off');
  assert.equal(profile.rewardIntensity, 'high');
  assert.equal(profile.valleyCadence, 4, '越界 cadence 必须忽略');
  assert.equal(profile.unknownSlot, undefined);
});

test('V0.101 母题余量：前场景已用满则本场景配额为 0', () => {
  const squat = ['蹲下', '蹲在', '蹲回', '蹲身', '蹲到', '蹲住', '蹲了'];
  const prior = '他蹲在墙根。又蹲下看土。';
  assert.equal(countMotifHits(prior, squat), 2);
  assert.equal(sceneMotifCap(2, 2, 3), 0, '章上限 2、已用 2、还剩 3 场 → 本场 0');
  assert.equal(sceneMotifCap(0, 2, 1), 2, '末场吃完剩余');
  assert.equal(sceneMotifCap(0, 2, 4), 1, '未用满时非末场至少可写 1 次并给后场留余量');
});

test('V0.101 配额指令必须点名已用满的动作族，且不含库存正例句', () => {
 const text = buildCraftQuotaText('他蹲在沟边，又蹲下探手。主角顿了顿，再顿了顿。', 3);
  assert.match(text, /蹲/);
  assert.match(text, /禁止|不得|最多 0/);
  assert.match(text, /顿了顿/);
  assert.doesNotMatch(text, /指节发麻|旁观震惊|握紧了拳/);
});

test('V0.101 角色卡注入说话/禁腔，性格仍只来自 personality', () => {
  const book = store.books.create({ title: '语音卡测试', genre: '历史' });
  store.characters.create(book.id, {
    name: '梁茂', personality: '务实，不爱总结',
    speech: '短句，只报尺寸与工序', speechForbid: '这意味着|从某种意义上',
  });
  const cards = characterCardsText(book.id, { names: ['梁茂'] });
  assert.match(cards, /说话：短句，只报尺寸与工序/);
  assert.match(cards, /禁腔：这意味着/);
  assert.match(cards, /性格：务实/);
  assert.doesNotMatch(cards, /card\.traits/);
});

test('V0.101 禁腔出现在该角色对白才报，旁人说同样的话不误伤', () => {
  const chars = [
    { name: '梁茂', speech_forbid: '这意味着' },
    { name: '阿蛮', speech_forbid: '' },
  ];
  const hit = detectSpeechForbidHits('梁茂说：“这意味着北坡要改槽。”', chars);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'medium');
  const miss = detectSpeechForbidHits('阿蛮说：“这意味着北坡要改槽。”', chars);
  assert.equal(miss.length, 0);
});

test('V0.101 连续兑现章触发低谷约束；不足窗口不催', () => {
  const book = store.books.create({ title: '低谷调度', genre: '历史' });
  for (let idx = 1; idx <= 4; idx++) {
    const ch = store.chapters.create(book.id, null, idx, { title: `第${idx}章`, status: 'done' });
    store.chapterHealth.add({
      bookId: book.id, chapterId: ch.id, idx, verdict: 'ok',
      notes: JSON.stringify({ payoff_count: 2, emotion: { intensity: 6 } }),
    });
  }
  const due = schedulerCheck(book.id, 5);
  assert.ok(due.some(rule => /低谷|代价/.test(rule)), `应派低谷：${due.join(' | ')}`);
  const afterComplete = schedulerCheck(book.id, 4);
  assert.ok(afterComplete.some(rule => /低谷|代价/.test(rule)), '成章后按刚完成章号调度，也必须派给下一章');

  const short = store.books.create({ title: '低谷不足窗', genre: '玄幻' });
  const ch = store.chapters.create(short.id, null, 1, { title: '一', status: 'done' });
  store.chapterHealth.add({
    bookId: short.id, chapterId: ch.id, idx: 1, verdict: 'ok',
    notes: JSON.stringify({ payoff_count: 1, emotion: { intensity: 6 } }),
  });
  const early = schedulerCheck(short.id, 2);
  assert.ok(!early.some(rule => /低谷|代价章/.test(rule)));
});

test('V0.101 物证过顺阈值随 evidenceBound 收紧；关闭则零报', () => {
  const src = '靴印严丝合缝对上他的鞋。苔痕分毫不差指着北槽。';
  const strict = detectEvidenceCertaintyStack(src, { threshold: 2 });
  assert.equal(strict[0]?.severity, 'medium');
  const off = detectEvidenceCertaintyStack(src, { threshold: 99 });
  assert.equal(off.length, 0);
});

test('V0.101 写作指令在低谷约束命中时注入碎片纪律，未命中不加', () => {
  const base = {
    bookTitle: 'X', chapterIdx: 5, chapterTitle: 'C',
    scene: { id: 's1', pov: 'A', location: 'L', beat: '被驳回的请示', target_words: 1000, scene_type: 'daily' },
    scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '',
    recentSummaries: [], timelineEvents: [], futureChapters: [],
    foreshadowsText: '', factsText: '', worldbookText: '', styleRules: '',
  };
  const withValley = writeSceneInstruction({
    ...base,
    constraints: '【快感节奏】连续4章都有回报，本章必须是低谷/代价章',
    valleyText: VALLEY_FRAGMENT_TEXT,
  });
  assert.match(withValley, /低谷|代价|物象/);
  const without = writeSceneInstruction({ ...base, constraints: '（无）' });
  assert.doesNotMatch(without, /独立故事碎片/);
});

test('V0.101 roster 补全指令含说话字段；审校指令能接收人物卡', () => {
  const tidy = rosterTidyInstruction({ bookTitle: 'T', castText: '', listText: '- 梁茂（已有：性格=空）' });
  assert.match(tidy, /speech/);
  const audit = auditInstruction({
    bookTitle: 'T', chapterTitle: 'C', chapterText: '梁茂把尺收回来。',
    factsText: '', foreshadowsText: '', characterStates: '', contract: '',
    cardText: '【角色人物卡】\n- 梁茂：说话：短句',
  });
  assert.match(audit, /说话：短句/);
});

test('V0.101 非历史题材不因语音卡空字段阻断；空禁腔零误报', () => {
  const book = store.books.create({ title: '玄幻零影响', genre: '玄幻' });
  store.characters.create(book.id, { name: '林晚', personality: '隐忍' });
  const cards = characterCardsText(book.id, { names: ['林晚'] });
  assert.match(cards, /林晚/);
  assert.doesNotMatch(cards, /说话：/);
  assert.equal(detectSpeechForbidHits('林晚说：“先走。”', [{ name: '林晚', speech_forbid: '' }]).length, 0);
});

test('V0.101 质量内核仍在树中（精确版本号由 v025/当前版断言）', () => {
  assert.ok(fs.existsSync(path.join(process.cwd(), 'server/engine/quality/craft_quota.js')));
  assert.ok(fs.existsSync(path.join(process.cwd(), 'server/engine/quality/craft_profile.js')));
});

test('V0.101 语音卡与题材偏好有前端观察入口，不是引擎内部黑盒', () => {
  const idx = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
  const roster = fs.readFileSync(path.join(process.cwd(), 'web/js/views/roster.js'), 'utf8');
  const workshop = fs.readFileSync(path.join(process.cwd(), 'web/js/views/workshop.js'), 'utf8');
  assert.match(idx, /speechForbid/);
  assert.match(idx, /craftProfile/);
  assert.match(roster, /speechForbid/);
  assert.match(workshop, /craftProfile/);
});
