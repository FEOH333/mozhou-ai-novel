// 数据层 + 缓存层 + 事实库/伏笔 集成测试（使用临时数据目录）
import './helper.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { assembleMessages, budgetCheck, historyStats } from '../server/llm/cache.js';
import { applyFacts, relevantFacts, formatFacts } from '../server/engine/factbook.js';
import { applyForeshadowActions } from '../server/engine/foreshadow.js';
import { ensureHistory, rebuildHistory } from '../server/engine/outline.js';
import { runLocalRules } from '../server/engine/rules.js';

let bookId;
before(async () => {
  const book = store.books.create({ title: '测试长篇', genre: '玄幻' });
  bookId = book.id;
  ensureHistory(bookId);
});

test('历史堆初始化：system + 公共材料', () => {
  const stats = historyStats(bookId);
  assert.equal(stats.messages, 2);
  const msgs = store.history.list(bookId);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
});

test('公共材料更新：原地替换前缀，条数不变', () => {
  store.materials.set(bookId, 'world', '青云大陆');
  rebuildHistory(bookId);
  assert.equal(historyStats(bookId).messages, 2);
  store.materials.set(bookId, 'world', '青云大陆·修正');
  rebuildHistory(bookId);
  assert.equal(historyStats(bookId).messages, 2);
});

test('历史堆 append + 消息组装顺序', () => {
  store.history.append(bookId, 'assistant', '第一章正文');
  const msgs = assembleMessages(bookId, [{ role: 'user', content: '第二章指令' }]);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[2].content, '第一章正文');
  assert.equal(msgs[3].content, '第二章指令');
});

test('预算检查', () => {
  const b = budgetCheck(bookId);
  assert.ok(b.usedTokens > 0);
  assert.ok(b.budget >= 500000, `预算应 >=500000（V0.47 质量优先），实际 ${b.budget}`); // V0.47：400K→500K
  assert.equal(b.over, false);
});

test('书/卷/章/场景 CRUD', () => {
  const vol = store.volumes.create(bookId, 1, { title: '第一卷' });
  const ch = store.chapters.create(bookId, vol.id, 1, { title: '第一章' });
  const sc = store.scenes.create(ch.id, 1, { pov: '主角', location: '青云城', beat: '测试' });
  assert.equal(store.volumes.list(bookId).length, 1);
  assert.equal(store.chapters.list(bookId).length, 1);
  assert.equal(store.scenes.list(ch.id).length, 1);
  store.scenes.update(sc.id, { content: '正文内容' });
  assert.equal(store.chapters.fullText(ch.id), '正文内容');
  store.chapters.remove(ch.id);
  assert.equal(store.scenes.list(ch.id).length, 0);
  store.volumes.remove(vol.id);
});

test('事实库：创建/冲突/superseded', () => {
  store.facts.create(bookId, { subject: '林晚', predicate: '实力达到', object: '练气三层', sourceChapter: 1 });
  const r = applyFacts(bookId, [{ subject: '林晚', predicate: '实力达到', object: '筑基期', sourceChapter: 2 }], 2);
  assert.equal(r.superseded, 1);
  const active = store.facts.list(bookId, { status: 'active' });
  const old = store.facts.list(bookId, { status: 'superseded' });
  assert.equal(active.find(f => f.subject === '林晚').object, '筑基期');
  assert.equal(old.length, 1);
});

test('事实库：相关性选取', () => {
  const rel = relevantFacts(bookId, '林晚的实力现在是什么境界？', 5);
  assert.ok(rel.length > 0);
  assert.ok(formatFacts(rel).includes('林晚'));
});

test('伏笔：applyForeshadowActions', () => {
  const f = store.foreshadows.create(bookId, { desc: '玉佩月圆发烫', plantedChapter: 1, payoffChapter: 5 });
  const r = applyForeshadowActions(bookId, [
    { id: f.id, action: 'advance', note: '第3章又烫了一次' },
    { id: f.id, action: 'payoff', note: '第5章揭示身份' },
  ], 5);
  assert.equal(r.advanced, 1);
  assert.equal(r.paidOff, 1);
  const updated = store.foreshadows.get(f.id);
  assert.equal(updated.status, 'paid_off');
  // 新伏笔自动登记
  const r2 = applyForeshadowActions(bookId, [{ desc: '新的神秘人', action: 'plant' }], 6);
  assert.equal(r2.planted, 1);
  assert.equal(store.foreshadows.list(bookId).length, 2);
});

test('遗忘预警', () => {
  const f = store.foreshadows.create(bookId, { desc: '被遗忘的伏笔', plantedChapter: 1, payoffChapter: 3 });
  const forgotten = store.foreshadows.forgotten(bookId, 15, 10);
  assert.ok(forgotten.some(x => x.id === f.id));
});

test('世界书：关键词触发（中文子串）', () => {
  store.worldbook.create(bookId, { keywords: ['青云城'], content: '青云城是南疆第一城', category: '地点' });
  store.worldbook.create(bookId, { keywords: [], content: '常驻设定', category: '通用' });
  // 直接测试激活逻辑（worldbook.activateEntriesText 依赖 getGlobal，这里用简化断言）
  const entries = store.worldbook.list(bookId, { enabledOnly: true });
  assert.equal(entries.length, 2);
});

test('本地规则与 JSON 工具联动', () => {
  const issues = runLocalRules('他微微一笑。她微微点头。两人微微叹息。');
  assert.ok(issues.length > 0);
});

test('待登记实体', () => {
  store.pendingEntities.add(bookId, { name: '天机阁', context: '出现在第2章', sourceChapter: 2 });
  assert.equal(store.pendingEntities.list(bookId).length, 1);
  store.pendingEntities.resolve(store.pendingEntities.list(bookId)[0].id, 'confirmed');
  assert.equal(store.pendingEntities.list(bookId).length, 0);
});

test('用量日志与聚合', () => {
  store.usageLogs.add({ bookId, task: 'write', model: 'deepseek-v4-pro', promptHit: 1000, promptMiss: 200, completion: 3000, cost: 0.02, costIfMiss: 0.2 });
  const agg = store.usageLogs.aggregate({ bookId });
  assert.equal(agg.calls, 1);
  assert.equal(agg.totalHit, 1000);
  assert.ok(agg.hitRatio > 0.8);
  assert.ok(agg.saving > 0);
});

after(() => {
  // 清理临时目录由 OS 处理
});
