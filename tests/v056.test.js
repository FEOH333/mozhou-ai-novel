// V0.56 细纲提速测试：thinking 预算 2048 封顶 + 细纲输出精炼要求
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v056-'));

describe('V0.58 细纲质量优先（回滚 V0.56 降质提速）', () => {
  test('client.js thinking budget 恢复 4096（时间换质量，不牺牲推理深度）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/llm/client.js'), 'utf8');
    assert.ok(src.includes('Math.min(4096,'), 'thinking budget 应恢复 4096');
    assert.ok(!src.includes('Math.min(2048,'), '不应再 2048');
  });

  test('细纲指令要求具体详实（beat 100-150 字为正文提供依据，不再限 2500 tokens）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(src.includes('细纲要具体详实'), '应要求详实细纲');
    assert.ok(src.includes('100-150 字'), 'beat 应 100-150 字');
    assert.ok(!src.includes('输出要精炼'), '不应再要求精炼');
    assert.ok(!src.includes('2500 tokens'), '不应再限 2500 tokens');
  });

  test('mock 冒烟：细纲生成仍正常（详实要求不影响结构）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/outline.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x', platform: '通用' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g', status: 'outlined' });
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'planned' });
    const o = await outline.generateChapterOutline(b.id, c.id);
    assert.ok(o && o.scenes && o.scenes.length > 0, '细纲应生成成功');
  });
});
