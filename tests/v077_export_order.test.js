// V0.77 导出安全：损坏的卷归属不能打乱全书章节顺序
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBookExport } from '../server/engine/export.js';

test('导出始终按章节全局 idx 排序，即使卷归属交叉或为空', () => {
  const volumes = [
    { id: 'v6', idx: 6, title: '第六卷' },
    { id: 'v7', idx: 7, title: '第七卷' },
  ];
  const chapters = [
    { id: 'c72', idx: 72, title: '七十二', volume_id: 'v6' },
    { id: 'c1', idx: 1, title: '开篇', volume_id: null },
    { id: 'c66', idx: 66, title: '六十六', volume_id: 'v7' },
    { id: 'c103', idx: 103, title: '一百零三', volume_id: 'v6' },
  ];
  const fullTexts = new Map(chapters.map(ch => [ch.id, `正文${ch.idx}`]));
  const result = buildBookExport({ book: { title: '卷序测试' }, volumes, chapters, fullTexts });

  const positions = [1, 66, 72, 103].map(idx => result.text.indexOf(`第${idx}章`));
  assert.ok(positions.every(pos => pos >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '章节必须保持 1→66→72→103');
  assert.deepEqual(result.chapterList.map(ch => ch.idx), [1, 66, 72, 103]);
});

test('选择导出仍按 idx，空正文跳过且不会重复章节', () => {
  const chapters = [
    { id: 'c3', idx: 3, title: '三', volume_id: null },
    { id: 'c2', idx: 2, title: '二', volume_id: null },
    { id: 'c1', idx: 1, title: '一', volume_id: null },
  ];
  const result = buildBookExport({
    book: { title: '选择测试' },
    volumes: [],
    chapters,
    fullTexts: new Map([['c1', '正文一'], ['c2', ''], ['c3', '正文三']]),
    selected: new Set(['c3', 'c1']),
  });
  assert.ok(result.text.indexOf('第1章') < result.text.indexOf('第3章'));
  assert.equal(result.chapters, 2);
  assert.equal((result.text.match(/第1章/g) || []).length, 1);
  assert.ok(!result.text.includes('第2章'));
});
