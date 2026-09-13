// V0.90 修复：设定生成自动重试（对齐 V0.85 卷纲容错）——模型偶发输出缺 worldview 的坏 JSON 时
// 此前一次性"设定解析失败，请重试"，需手动；现自动重试 ≤3 次（注入上次失败提示）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v101-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.90 设定生成自动重试', () => {
  test('①坏 JSON（缺 worldview）自动重试成功，world 材料落库', async () => {
    process.env.NOVEL_SETTINGS_FAULT = '1'; // mock 前两次返回缺 worldview 的坏 JSON
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateBookSettings } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/settings.js')));
 const b = store.books.create({ title: '示例历史长篇', genre: '历史', blurb: '蜀中孤儿', platform: '番茄' });
    store.materials.set(b.id, 'contract', '【书契约】目标读者：历史爱好者。承诺：前3章立住人物。');
    const r = await generateBookSettings(b.id, {});
    assert.ok(r.ok, '设定生成成功（自动重试）');
    assert.ok(store.materials.get(b.id, 'world')?.content, 'world 材料已落库');
    assert.ok(store.materials.get(b.id, 'world').content.includes('青云大陆'), '重试后拿到完整世界观');
    delete process.env.NOVEL_SETTINGS_FAULT;
  });

  test('②正常路径不受影响（一次成功）', async () => {
    delete process.env.NOVEL_SETTINGS_FAULT;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateBookSettings } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/settings.js')));
    const b = store.books.create({ title: '玄幻书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '【书契约】目标读者：爽文读者。');
    const r = await generateBookSettings(b.id, {});
    assert.ok(r.ok, '正常一次成功');
    assert.ok(store.materials.get(b.id, 'world')?.content, 'world 落库');
  });

  test('③重试逻辑接线：settings.js 含自动重试与失败提示注入', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/settings.js'), 'utf8');
    assert.ok(src.includes('V0.90 自动重试'), '自动重试标注');
    assert.ok(src.includes('for (let attempt = 0; attempt < 3 && !out; attempt++)'), '≤3 次循环');
    assert.ok(src.includes('缺少 worldview 字段'), '失败原因注入');
    assert.ok(src.includes('已自动重试 3 次'), '仍失败时明确报错');
  });
});
