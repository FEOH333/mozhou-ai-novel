// V0.95.0 工程五：台账治理——钩子老化 / 伏笔-钩子兑现联动 / 全局债清理
// 背景：审计实证①pleasure_hooks 永不清理（settleHookLedger 恒 abandoned:0，300 章后 open 钩数百条
// 残留，靠注入限流掩盖）；②双台账失步（V0.93.8：ch21 名册钩正文已兑现但台账 open——结算判 payoff
// 后快感审计不联动）；③conflicts 全局债（chapter_id=null）永久残留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import * as store from '../server/db/store.js';
import { settleHookLedger } from '../server/engine/quality/pleasure.js';
import { applyForeshadowActions } from '../server/engine/narrative/foreshadow.js';

function seedBook() {
  return store.books.create({ title: '台账测试书', genre: '玄幻' });
}

test('V0.95 钩子老化：长线钩超期 >15 章且无推进 → expired 并转 foreshadows；V0.102 短线同样老化但不转伏笔', () => {
  const b = seedBook();
  // 长线钩：第 2 章埋，计划第 10 章兑现，现在第 30 章（超期 20 章），从未推进
  store.pleasureHooks.create(b.id, { desc: '身世之谜待解', kind: 'long', type: '悬念钩', plantedChapter: 2, dueChapter: 10, status: 'open', intensity: 4 });
  // 短线钩：同样超期（V0.102 起老化，不转伏笔——否则短钩堆成第二份坑）
  store.pleasureHooks.create(b.id, { desc: '明日比试', kind: 'short', type: '危机钩', plantedChapter: 2, dueChapter: 4, status: 'open', intensity: 3 });
  // 有推进的长线钩（不老化——分期确认过）
  store.pleasureHooks.create(b.id, { desc: '魔器来历', kind: 'long', type: '悬念钩', plantedChapter: 2, dueChapter: 17, status: 'open', intensity: 4, lastProgressChapter: 25 });

  const r = settleHookLedger(b.id, 30);
  assert.ok(r.abandoned >= 2, `短线+长线无推进钩必须老化（实际 abandoned=${r.abandoned}）`);
  const open = store.pleasureHooks.list(b.id).filter(h => h.status === 'open' || h.status === 'progressing');
  assert.ok(!open.some(h => h.desc === '身世之谜待解'), '无推进长线钩已 expired');
  assert.ok(!open.some(h => h.desc === '明日比试'), '短线超期同样老化');
  assert.equal(store.pleasureHooks.list(b.id).find(h => h.desc === '明日比试').status, 'expired');
  assert.ok(!store.foreshadows.list(b.id).some(f => f.desc.includes('明日比试')), '短线老化不转伏笔');
  assert.ok(open.some(h => h.desc === '魔器来历'), '有推进的长线钩不老化');
  // 主线锚点转 foreshadows（回收责任由伏笔台账承接）
  assert.ok(store.foreshadows.list(b.id).some(f => f.desc.includes('身世之谜')), '老化的长线钩转 foreshadows 主线锚点');
});

test('V0.95 伏笔-钩子兑现联动：结算判定 payoff 时同步标 paid（消灭双台账失步主源）', () => {
  const b = seedBook();
  store.foreshadows.create(b.id, { desc: '黑衣人身份揭晓', type: '剧情伏笔', plantedChapter: 3, payoffChapter: 12, importance: 'high', status: 'planted' });
  store.pleasureHooks.create(b.id, { desc: '黑衣人身份揭晓（第12章兑现）', kind: 'medium', type: '悬念钩', plantedChapter: 3, dueChapter: 12, status: 'open', intensity: 4 });
  // 结算模型判定 payoff（最权威的兑现信号）
  applyForeshadowActions(b.id, [{ desc: '黑衣人身份揭晓', action: 'payoff', note: '第12章揭晓' }], 12);
  assert.equal(store.foreshadows.list(b.id).find(f => f.desc.includes('黑衣人')).status, 'paid_off');
  const hook = store.pleasureHooks.list(b.id).find(h => h.desc.includes('黑衣人'));
  assert.equal(hook.status, 'paid', '结算 payoff 时快感钩子同步标 paid（此前只有快感审计发现才标）');
});

test('V0.95 全局债清理：chapter_id=null 的 open 债超 20 条时删最老（防 conflicts 表堆满）', () => {
  const b = seedBook();
  for (let i = 1; i <= 25; i++) {
    store.conflicts.create(b.id, { type: '设定冲突', quote: '', issue: `全局债务${String(i).padStart(2, '0')}` });
  }
  assert.equal(store.conflicts.list(b.id).length, 25);
  store.conflicts.pruneBefore(b.id, 30);
  const after = store.conflicts.list(b.id);
  assert.equal(after.length, 20, '全局债保留上限 20 条');
  assert.ok(!after.some(c => c.issue === '全局债务01'), '最老的全局债被清');
  assert.ok(after.some(c => c.issue === '全局债务25'), '最新的全局债保留');
});
