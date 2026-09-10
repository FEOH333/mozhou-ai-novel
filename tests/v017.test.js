// V0.17 快感引擎测试：期待账本/弧线管理/节奏检查/快感审计/快感计划
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v017-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '1';

let store, pleasure, pipeline;
let bookId, chapterId;

before(async () => {
  store = await import('../server/db/store.js');
  pleasure = await import('../server/engine/pleasure.js');
  pipeline = await import('../server/engine/pipeline.js');
  bookId = store.books.create({ title: '快感测试', genre: '玄幻' }).id;
  const ch = store.chapters.create(bookId, null, 1, { title: '第一章' });
  chapterId = ch.id;
  store.scenes.create(chapterId, 1, { pov: '林晚', location: '青云城', beat: '冲突爆发', targetWords: 800, status: 'planned' });
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 句柄占用时忽略 */ } });

test('V0.17: 细纲输出登记期待账本（new_hooks/ending_hook）', () => {
  const outline = {
    new_hooks: ['玉佩在月圆夜发烫之谜', { desc: '苏晚的真实身份', kind: 'long', type: '身份伏笔' }],
    ending_hook: { desc: '城门上那道黑影是谁？', type: '悬念钩', intensity: 4 },
    scenes: [],
  };
  const reg = pleasure.registerHooksFromOutline(bookId, outline, 1);
  assert.equal(reg.length, 3);
  const hooks = store.pleasureHooks.list(bookId);
  assert.equal(hooks.length, 3);
  const short = hooks.find(h => h.desc.includes('黑影'));
  assert.equal(short.kind, 'short');
  assert.equal(short.due_chapter, 2);
  const long = hooks.find(h => h.desc.includes('身份'));
  assert.equal(long.kind, 'long');
  assert.equal(long.due_chapter, 16);
  // 幂等：重复登记不产生重复
  pleasure.registerHooksFromOutline(bookId, outline, 1);
  assert.equal(store.pleasureHooks.list(bookId).length, 3);
});

test('V0.17: 快感审计——情绪落健康快照、兑现标记 paid、问题转约束', async () => {
  // 先清空既有 hooks 避免干扰
  for (const h of store.pleasureHooks.list(bookId)) store.pleasureHooks.remove(h.id);
  const hook = store.pleasureHooks.create(bookId, { desc: '林晚在城门当众打碎旧敌的门牙', kind: 'short', type: '打脸期待', plantedChapter: 1, dueChapter: 2, intensity: 3 });
  const r = await pleasure.auditPleasure(bookId, chapterId, 1);
  assert.equal(r.ok, true);
  // 兑现标记
  const paid = store.pleasureHooks.get(hook.id);
  assert.equal(paid.status, 'paid');
  assert.ok(paid.note.includes('兑现'));
  // 情绪落 chapter_health
  const health = store.chapterHealth.getByChapter(chapterId);
  const notes = JSON.parse(health.notes);
  assert.equal(notes.emotion.type, '燃');
  assert.equal(notes.emotion.intensity, 8);
  assert.equal(notes.hook.type, '悬念钩');
});

test('V0.17: 弧线管理——open/stale（8章无进展提醒回填）', () => {
  store.storyArcs.create(bookId, { name: '玉佩之谜', type: '主线', openedChapter: 1 });
  store.storyArcs.create(bookId, { name: '宗门恩怨', type: '暗线', openedChapter: 1, lastActiveChapter: 2 });
  const arcs = store.storyArcs.open(bookId);
  assert.equal(arcs.length, 2);
  // 第 12 章时，宗门恩怨已 10 章无进展 → stale
  const stale = store.storyArcs.stale(bookId, 12, 8);
  assert.ok(stale.some(a => a.name === '宗门恩怨'));
  // 状态流转：closing → closed
  const arc = store.storyArcs.update(arcs[0].id, { status: 'closing' });
  assert.equal(arc.status, 'closing');
  store.storyArcs.update(arcs[0].id, { status: 'closed' });
  assert.equal(store.storyArcs.open(bookId).length, 1);
});

test('V0.17: 本地节奏检查——连续高强度/无钩子/弧线不足/超期期待', () => {
  // 构造 3 章高强度情绪（第1章也补上，保证滑窗满 3）
  const c1h = store.chapterHealth.getByChapter(chapterId);
  if (!c1h) store.chapterHealth.add({ bookId, chapterId, idx: 1, verdict: 'ok' });
  const h1 = store.chapterHealth.getByChapter(chapterId);
  store.chapterHealth.update(h1.id, { notes: JSON.stringify({ emotion: { type: '紧张', intensity: 8 }, hook: { present: true, intensity: 3 } }) });
  const c2 = store.chapters.create(bookId, null, 2, { title: '二' });
  const c3 = store.chapters.create(bookId, null, 3, { title: '三' });
  for (const [cid, intensity, hasHook] of [[c2.id, 8, true], [c3.id, 8, true]]) {
    store.chapterHealth.add({ bookId, chapterId: cid, idx: cid === c2.id ? 2 : 3, verdict: 'ok' });
    const h = store.chapterHealth.getByChapter(cid);
    store.chapterHealth.update(h.id, { notes: JSON.stringify({ emotion: { type: '紧张', intensity }, hook: hasHook ? { present: true, intensity: 3 } : null }) });
  }
  const rules = pleasure.schedulerCheck(bookId, 3);
  assert.ok(rules.some(r => r.includes('连续3章高强度')), '连续高强度应触发规则');
  // 超期期待
  store.pleasureHooks.create(bookId, { desc: '超期未兑现的期待', kind: 'short', type: '悬念钩', plantedChapter: 1, dueChapter: 2, status: 'open' });
  const rules2 = pleasure.schedulerCheck(bookId, 10);
  assert.ok(rules2.some(r => r.includes('超期')), '超期期待应触发规则');
});

test('V0.17: 快感计划——pilot 骨架阶段落 settings_json', async () => {
  const r = await pleasure.planBookPleasure(bookId);
  assert.equal(r.ok, true);
  const settings = JSON.parse(store.books.get(bookId).settings_json);
  assert.ok(settings.pleasurePlan.reward_rhythm.small.includes('每1-3章'));
  assert.ok(settings.pleasurePlan.emotion_rotation.length >= 1);
  assert.ok(settings.pleasurePlan.protagonist_recipe.ordinary_anchors.length >= 1);
  // 上下文注入包含快感计划
  const ctx = pleasure.buildPleasureContext(bookId, 4);
  assert.ok(ctx.includes('快感计划'));
});

test('V0.17: 完整写一章自动包含快感审计（情绪/钩子落库）', async () => {
  const book = store.books.create({ title: '快感管线测试', genre: '都市' });
  const ch = store.chapters.create(book.id, null, 1, { title: '第一章' });
  store.scenes.create(ch.id, 1, { pov: '陈默', location: '夜市', beat: '冲突', targetWords: 800, status: 'planned' });
  const r = await pipeline.runChapterFlow(book.id, ch.id, { onEvent: () => {}, autoConfirm: true });
  assert.equal(r.status, 'done');
  // 快感审计落库：chapter_health 有情绪标签
  const health = store.chapterHealth.getByChapter(ch.id);
  const notes = JSON.parse(health.notes || '{}');
  assert.ok(notes.emotion, '应有情绪标签');
  // 快感约束（节奏规则）已写入
  const cons = store.constraints.list(book.id);
  assert.ok(cons.some(c => c.source === 'pleasure' || c.content.includes('快感')), '应有快感约束反哺');
});
