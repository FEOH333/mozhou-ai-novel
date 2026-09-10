// V0.69 成本统计与图表测试：byDay 聚合 / 前端图表组件 / 防 NaN
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v069-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));

describe('V0.69 成本统计与图表', () => {
  test('①aggregate 返回 byDay（按天聚合：日期/费用/命中率数据）', () => {
    const b = store.books.create({ title: '成本书', genre: '玄幻' });
    // 造两天数据（ts 不同天）
    const day1 = new Date('2026-08-01T12:00:00Z').getTime();
    const day2 = new Date('2026-08-02T12:00:00Z').getTime();
    store.usageLogs.add({ bookId: b.id, task: 'write', model: 'm', promptHit: 1000, promptMiss: 0, completion: 100, cost: 1, durationMs: 1000 });
    // 第二条记录（同一天）
    store.usageLogs.add({ bookId: b.id, task: 'audit', model: 'm', promptHit: 500, promptMiss: 500, completion: 50, cost: 0.5, durationMs: 500 });
    const agg = store.usageLogs.aggregate({ bookId: b.id });
    assert.ok(Array.isArray(agg.byDay), '应有 byDay');
    assert.ok(agg.byDay.length >= 1, 'byDay 非空');
    assert.ok('day' in agg.byDay[0] && 'cost' in agg.byDay[0], 'byDay 字段齐全');
    assert.ok(agg.byDay[0].hit >= 0 && agg.byDay[0].miss >= 0, 'byDay 命中统计存在');
  });

  test('②前端成本页含图表组件（trendChart/taskBarChart）与容错', () => {
    const cs = fs.readFileSync(path.join(ROOT, 'web/js/views/costs.js'), 'utf8');
    assert.ok(cs.includes('function trendChart'), '应有按天趋势图');
    assert.ok(cs.includes('function taskBarChart'), '应有任务条形图');
    assert.ok(cs.includes('function safePct'), '应有防 NaN 格式化');
    assert.ok(cs.includes('数据加载失败'), '轮询应有容错提示');
    assert.ok(cs.includes('aggregate.byDay'), '应消费 byDay 数据');
  });

  test('③ui.js 支持 SVG 元素与 innerHTML（图表渲染前提）', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'web/js/ui.js'), 'utf8');
    assert.ok(ui.includes('createElementNS'), 'SVG 用 createElementNS');
    assert.ok(ui.includes("k === 'innerHTML'"), '支持 innerHTML');
    assert.ok(ui.includes('polyline'), 'SVG 标签清单含 polyline');
  });
});
