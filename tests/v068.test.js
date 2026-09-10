// V0.68 事实库整理机制测试：同义词归一/上限归档/定期整理
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v068-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const { normalizePredicate, tidyFacts, archiveOldFacts, applyFacts } = await import(pathToFileURL(path.join(ROOT, 'server/engine/factbook.js')));

describe('V0.68 事实库整理', () => {
  test('①谓词同义词归一（获得/得到/拿到→获得；对X说→告诉）', () => {
    assert.equal(normalizePredicate('得到'), '获得');
    assert.equal(normalizePredicate('拿到'), '获得');
    assert.equal(normalizePredicate('对李尘说'), '告诉');
    assert.equal(normalizePredicate('知晓'), '得知');
    assert.equal(normalizePredicate('自定义谓词'), '自定义谓词');
  });

  test('②applyFacts 同义词去重（同 subject+归一谓词+同 object 不重复建）', () => {
    const b = store.books.create({ title: '事实书', genre: '玄幻' });
    const r1 = applyFacts(b.id, [{ subject: '李尘', predicate: '获得', object: '图谱' }], 1);
    const r2 = applyFacts(b.id, [{ subject: '李尘', predicate: '得到', object: '图谱' }], 2);
    assert.equal(r1.created, 1, '第一次创建');
    assert.equal(r2.created, 0, '同义谓词且同对象应在入口直接去重');
    assert.equal(r2.skipped, 1, '重复事实应计入 skipped');
    const before = store.facts.list(b.id, { status: 'active' }).length;
    const t = tidyFacts(b.id);
    const after = store.facts.list(b.id, { status: 'active' }).length;
    assert.equal(before, 1);
    assert.equal(after, 1);
    assert.equal(t.merged, 0, '入口已去重时不应留给定期整理兜底');
  });

  test('③archiveOldFacts 上限归档（cap 生效，归档后不注入）', () => {
    const b = store.books.create({ title: '归档书', genre: '玄幻' });
    for (let i = 0; i < 25; i++) {
      store.facts.create(b.id, { subject: 'S', predicate: 'P' + i, object: 'O' + i });
    }
    const n = archiveOldFacts(b.id, { cap: 20 });
    assert.equal(n, 5, '应归档 5 条（25-20）');
    assert.equal(store.facts.list(b.id, { status: 'active' }).length, 20);
  });

  test('④pilot 每 5 章调 tidyFacts（定期整理接线）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pilot.js'), 'utf8');
    assert.ok(src.includes('tidyFacts(bookId)'), 'pilot 应调用 tidyFacts');
    assert.ok(src.includes('已整理事实库'), '应有整理事件');
  });
});
