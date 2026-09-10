// V0.77 长篇事实记忆回归：最近事实方向、稳定排序、入口去重与归档语义
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-facts-'));
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const { relevantFacts, applyFacts, archiveOldFacts } = await import('../server/engine/factbook.js');

describe('V0.77 长篇事实记忆', () => {
  test('无关键词命中时返回最新事实，而不是最老事实', () => {
    const book = store.books.create({ title: '事实时序', genre: '玄幻' });
    for (let i = 1; i <= 12; i++) {
      store.facts.create(book.id, {
        subject: `角色${i}`,
        predicate: '状态',
        object: `阶段${i}`,
        sourceChapter: i,
      });
    }

    const selected = relevantFacts(book.id, '完全无关的查询词', 3);
    assert.deepEqual(selected.map(f => f.source_chapter), [12, 11, 10]);
  });

  test('facts.recent 对相同时间戳仍以最后写入优先', () => {
    const book = store.books.create({ title: '稳定排序', genre: '玄幻' });
    for (let i = 1; i <= 5; i++) {
      store.facts.create(book.id, {
        subject: `同刻${i}`,
        predicate: '序号',
        object: String(i),
        sourceChapter: i,
      });
    }

    assert.equal(typeof store.facts.recent, 'function', 'store 应提供语义明确的 recent API');
    assert.deepEqual(
      store.facts.recent(book.id, { status: 'active', limit: 3 }).map(f => f.source_chapter),
      [5, 4, 3],
    );
  });

  test('同义谓词与同对象在入口即去重', () => {
    const book = store.books.create({ title: '事实入口去重', genre: '玄幻' });
    const first = applyFacts(book.id, [{ subject: '李尘', predicate: '获得', object: '图谱' }], 1);
    const duplicate = applyFacts(book.id, [{ subject: '李尘', predicate: '得到', object: '图谱' }], 2);

    assert.equal(first.created, 1);
    assert.equal(duplicate.created, 0);
    assert.equal(duplicate.skipped, 1);
    assert.equal(store.facts.list(book.id, { status: 'active' }).length, 1);
  });

  test('容量归档使用 archived 状态，不伪装成事实冲突', () => {
    const book = store.books.create({ title: '事实归档语义', genre: '玄幻' });
    for (let i = 1; i <= 5; i++) {
      store.facts.create(book.id, {
        subject: '人物', predicate: `经历${i}`, object: `事件${i}`, sourceChapter: i,
      });
    }

    assert.equal(archiveOldFacts(book.id, { cap: 3 }), 2);
    assert.equal(store.facts.list(book.id, { status: 'active' }).length, 3);
    const archived = store.facts.list(book.id, { status: 'archived' });
    assert.equal(archived.length, 2);
    assert.ok(archived.every(f => !(f.note || '').includes('undefined')));
  });
});
