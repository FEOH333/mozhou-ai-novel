// V0.93 事实簿：事件事实可并存，只有单值状态允许覆盖
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v117-factbook-'));

const store = await import('../server/db/store.js');
const factbook = await import('../server/engine/factbook.js');

describe('V0.93 事实簿覆盖语义', () => {
  test('发现不再被归一为获得', () => {
    assert.equal(factbook.normalizePredicate('发现'), '发现');
    assert.equal(factbook.normalizePredicate('找到'), '找到');
    assert.equal(factbook.normalizePredicate('得到'), '获得');
  });

  test('同一人物的获得、发现和多次发现都是可并存事件', () => {
    const book = store.books.create({ title: '事件事实测试', genre: '历史' });
    factbook.applyFacts(book.id, [
 { subject: '主角', predicate: '获得', object: '学习弓箭的资格' },
    ], 7);
    factbook.applyFacts(book.id, [
 { subject: '主角', predicate: '发现', object: '料道坡面裂缝' },
 { subject: '主角', predicate: '发现', object: '北坡渗水' },
    ], 13);

    const active = store.facts.list(book.id, { status: 'active' });
    assert.equal(active.length, 3);
    assert.deepEqual(new Set(active.map(row => row.object)), new Set([
      '学习弓箭的资格', '料道坡面裂缝', '北坡渗水',
    ]));
    assert.equal(store.facts.list(book.id, { status: 'superseded' }).length, 0);
  });

  test('年龄、位置和身份等单值状态仍覆盖旧值', () => {
    const book = store.books.create({ title: '状态事实测试', genre: '历史' });
    factbook.applyFacts(book.id, [
 { subject: '主角', predicate: '位置', object: '重庆府流民营' },
 { subject: '主角', predicate: '年龄', object: '九岁' },
    ], 1);
    const result = factbook.applyFacts(book.id, [
 { subject: '主角', predicate: '位置', object: '钓鱼山料场' },
 { subject: '主角', predicate: '年龄', object: '十二岁' },
    ], 10);

    assert.equal(result.superseded, 2);
    const active = store.facts.list(book.id, { status: 'active' });
    assert.deepEqual(new Set(active.map(row => row.object)), new Set(['钓鱼山料场', '十二岁']));
  });
});
