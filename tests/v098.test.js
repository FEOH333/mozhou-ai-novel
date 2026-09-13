// V0.90 修复：书级大纲 volumes 对象形式容错（真实模型偶发输出 {"1":{...},"2":{...}}，
// 此前仅卷纲 chapters 有对象→数组容错、书纲缺 → "书级大纲解析失败"卡死一键创作）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v098-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.90 书级大纲解析容错', () => {
  test('①volumes 对象形式（{1:{...}}）→ 自动转数组，书纲生成成功且建卷', async () => {
    process.env.NOVEL_BOOK_OUTLINE_OBJ = '1'; // 模拟模型输出 volumes 对象形式 + 无 idx
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateBookOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '未命名', genre: '玄幻', blurb: '废柴剑子逆袭' });
    const outline = await generateBookOutline(b.id, {});
    assert.ok(outline, '书纲生成成功');
    assert.ok(Array.isArray(outline.volumes), 'volumes 已转数组');
    assert.ok(outline.volumes.length >= 1, '有卷');
    assert.ok(store.materials.get(b.id, 'outline')?.content, 'outline 材料已落库');
    const vols = store.volumes.list(b.id);
    assert.equal(vols.length, outline.volumes.length, '卷已创建');
    // idx 兜底：对象形式无 idx → 按数组序 1..N
    assert.deepEqual(vols.map(v => v.idx), vols.map((_, i) => i + 1), '卷 idx 按数组序兜底');
    delete process.env.NOVEL_BOOK_OUTLINE_OBJ;
  });

  test('②数组形式（正常）不受影响，卷 idx 用模型值', async () => {
    delete process.env.NOVEL_BOOK_OUTLINE_OBJ;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateBookOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '未命名', genre: '玄幻', blurb: 'x' });
    const outline = await generateBookOutline(b.id, {});
    assert.ok(Array.isArray(outline.volumes), '正常数组形式');
    assert.ok(outline.volumes[0].idx === 1, '正常 idx 保留');
  });

  test('③真实失败语义保留：volumes 缺失/非对象仍报明确错误（不静默吞掉）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes("!Array.isArray(volumes) || !volumes.length"), '校验仍要求有效 volumes');
    // V0.93.9：错误消息追加自动重试次数说明（前缀语义不变）
    assert.ok(src.includes('书级大纲解析失败，请重试'), '明确报错保留');
  });
});
