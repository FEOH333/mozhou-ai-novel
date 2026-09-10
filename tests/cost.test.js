import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, isPeakHour, PRICES } from '../server/llm/cost.js';

test('定价表存在 flash/pro', () => {
  assert.ok(PRICES['deepseek-v4-flash']);
  assert.ok(PRICES['deepseek-v4-pro']);
  // 命中价远低于未命中价（缓存是核心杠杆）
  assert.ok(PRICES['deepseek-v4-flash'].hit < PRICES['deepseek-v4-flash'].miss);
});

test('computeCost: 全命中比全未命中便宜', () => {
  const hit = computeCost('deepseek-v4-flash', 100000, 0, 3000, Date.parse('2026-08-01T20:00:00'));
  const miss = computeCost('deepseek-v4-flash', 0, 100000, 3000, Date.parse('2026-08-01T20:00:00'));
  assert.ok(hit.cost < miss.cost, `${hit.cost} < ${miss.cost}`);
  assert.ok(miss.saving === 0);
});

test('computeCost: 峰谷翻倍', () => {
  const peak = Date.parse('2026-08-01T10:00:00'); // 10:00 高峰
  const off = Date.parse('2026-08-01T20:00:00');  // 20:00 平价
  const a = computeCost('deepseek-v4-flash', 0, 1000, 1000, peak);
  const b = computeCost('deepseek-v4-flash', 0, 1000, 1000, off);
  assert.ok(Math.abs(a.cost - b.cost * 2) < 1e-6);
  assert.equal(a.peak, true);
  assert.equal(b.peak, false);
});

test('computeCost: 阿里云 qwen 无峰谷价差（peak 不标不得误翻倍）', () => {
  const peak = Date.parse('2026-08-01T10:00:00');
  const off = Date.parse('2026-08-01T20:00:00');
  const a = computeCost('qwen3.8-flash', 4000, 1000, 1000, peak);
  const b = computeCost('qwen3.8-flash', 4000, 1000, 1000, off);
  assert.equal(a.cost, b.cost, 'qwen 计价与时段无关');
  assert.equal(a.peak, false);
  // 命中价生效：4000 命中 × 0.04 + 1000 未命中 × 0.2 + 1000 输出 × 0.8（每百万）= 0.00116 → 4 位舍入 0.0012
  assert.equal(b.cost, 0.0012);
});

test('isPeakHour: 边界', () => {
  assert.equal(isPeakHour(Date.parse('2026-08-01T09:00:00')), true);
  assert.equal(isPeakHour(Date.parse('2026-08-01T11:59:00')), true);
  assert.equal(isPeakHour(Date.parse('2026-08-01T12:00:00')), false);
  assert.equal(isPeakHour(Date.parse('2026-08-01T14:00:00')), true);
  assert.equal(isPeakHour(Date.parse('2026-08-01T18:00:00')), false);
});
