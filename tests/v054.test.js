// V0.54 章细纲生成失败修复测试：thinking disabled 防截断 + 校验放宽 + 结构降级放行
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v054-'));

describe('V0.54 章细纲生成失败修复', () => {
  test('chapter_outline：thinking enabled + maxTokens 充足（V0.55：质量优先——先思考再写，预算调高防推理吃光正文）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/config.js'), 'utf8');
    const line = src.split('\n').find(l => l.includes('chapter_outline'));
    assert.ok(line, '应有 chapter_outline 路由');
    assert.ok(line.includes("thinking: 'enabled'"), 'chapter_outline 应 thinking enabled（质量优先）');
    assert.ok(line.includes("reasoningEffort: 'high'"), 'chapter_outline 应 effort high（V0.95.2）');
    // maxTokens 足够：thinking 预算 4096 封顶，正文 JSON 至少剩 7000+（细纲 scenes/pace/character_beat 复杂也不截断）
    const m = line.match(/maxTokens: (\d+)/);
    assert.ok(m && parseInt(m[1]) >= 12000, `maxTokens 应 >=12000（正文余量充足），实际 ${m && m[1]}`);
  });

  test('validateChapterOutline 放宽：checkpoints 允许为空', async () => {
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/outline.js')));
    // 直接测生成流程：mock 细纲若无 checkpoints 也能落库
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x', platform: '通用' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'planned' });
    // 直接构造无 checkpoints 的细纲验证校验逻辑（通过生成流程 mock 验证）
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/outline.js'), 'utf8');
    assert.ok(src.includes('checkpoints 允许为空'), '校验注释应体现放宽');
    assert.ok(!src.includes('!Array.isArray(o.checkpoints)'), '不应再强制 checkpoints 非空');
  });

  test('结构不合法降级：解析出 scenes 即补默认 checkpoints 放行', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/outline.js'), 'utf8');
    assert.ok(src.includes('补默认 checkpoints 放行'), '应有降级放行逻辑');
    assert.ok(src.includes('outline.checkpoints ='), '应补默认 checkpoints');
  });

  test('mock 冒烟：缺 checkpoints 的细纲也能完成生成（五问通过路径）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/outline.js')));
    const b = store.books.create({ title: 'T2', genre: '玄幻', blurb: 'x', platform: '通用' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g', status: 'outlined' });
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'planned' });
    const o = await outline.generateChapterOutline(b.id, c.id);
    assert.ok(o && o.scenes && o.scenes.length > 0, '细纲应生成成功');
    assert.equal(store.chapters.get(c.id).status, 'outlined', '应落库 outlined');
  });
});
