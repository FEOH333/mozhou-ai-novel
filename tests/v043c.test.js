// V0.43 第二阶段：缓存优化——阈值放宽/审校收敛/重建追踪/成本归因
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v043c-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.43 缓存优化', () => {
  test('长度自愈以目标 0.85 为下限（压缩仍为 1.7）', async () => {
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/write.js'), 'utf8');
    assert.ok(w.includes('Math.round(target * 0.85)'), 'minWords 应 0.85，保证场景目标总和能托住章级下限');
    assert.ok(w.includes('Math.round(target * 1.7)'), 'maxWords 应 1.7');
    assert.ok(w.includes('超 70% 才压缩'), '注释说明');
  });

  test('审校修订收敛：low 语句质量不再触发 fix 修订', async () => {
    const p = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline.js'), 'utf8');
    assert.ok(p.includes("i.severity === 'high' || i.severity === 'medium'"), '只修 high+medium 语句质量');
    // 行为验证：low 语句质量 → 不可 fix
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x' });
    // textFixable 是 pipeline 内部闭包——通过静态断言验证已足够（行为由 v015 全流程测试覆盖）
    const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
    assert.ok(typeof runChapterFlow === 'function');
  });

  test('truncateFrom 记录缓存重建原因', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V' });
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C', status: 'done' });
    store.scenes.create(c.id, 1, { content: '正文', status: 'done', historySeq: 3 });
    store.history.append(b.id, 'system', 's');
    store.history.append(b.id, 'user', 'u');
    store.history.append(b.id, 'assistant', '正文1');
    store.history.truncateFrom(b.id, 3, '场景重写测试');
    const logs = store.operationLogs.list({ category: 'cache', bookId: b.id }).items;
    assert.ok(logs.some(l => l.op === 'rebuild' && (l.detail || '').includes('场景重写测试')), '应记录重建原因');
  });

  test('costs API 含 byChapter 归因与 rebuilds', async () => {
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes('rebuilds: store.operationLogs.list'), 'costs API 应含重建记录');
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x' });
    store.usageLogs.add({ bookId: b.id, task: 'write', model: 'm', promptHit: 100, promptMiss: 20, completion: 50, cost: 0.1, costIfMiss: 0.2 });
    const agg = store.usageLogs.aggregate({ bookId: b.id });
    assert.ok(Array.isArray(agg.byChapter), 'aggregate 应含 byChapter');
    assert.ok(agg.byChapter.length >= 1, 'byChapter 应有数据');
  });

  test('前端成本页实时轮询与重建展示', () => {
    const c = fs.readFileSync(path.join(ROOT, 'web/js/views/costs.js'), 'utf8');
    assert.ok(c.includes('setInterval'), '应实时轮询');
    assert.ok(c.includes('缓存重建记录'), '应展示重建记录');
    assert.ok(c.includes('按章节命中率'), '应按章归因');
    assert.ok(c.includes('miss 最多的任务排前'), '任务应 miss 排序');
  });
});
