// V0.43 第四阶段：长度灵活化 + 快感按情节阶段
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v043e-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.43 长度灵活化与快感阶段感知', () => {
  test('lengthProfileOf：题材默认 + settings 覆盖', async () => {
    const { lengthProfileOf } = await import(pathToFileURL(path.join(ROOT, 'server/engine/outline.js')));
    assert.equal(lengthProfileOf({ genre: '玄幻' }), 3500);
    assert.equal(lengthProfileOf({ genre: '悬疑' }), 2800);
    assert.equal(lengthProfileOf({ genre: '都市' }), 3000);
    assert.equal(lengthProfileOf({ genre: '未知题材' }), 3200, '未知题材兜底 3200');
    assert.equal(lengthProfileOf({ genre: '玄幻', settings_json: JSON.stringify({ lengthProfile: 5000 }) }), 5000, 'settings 覆盖');
  });

  test('lengthRequirementText：字数→场景数/单场景字数联动', async () => {
    const { lengthRequirementText } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const t1 = lengthRequirementText(2500);
    assert.ok(t1.includes('2500 字') && t1.includes('2-3 个'), '紧凑');
    const t3 = lengthRequirementText(3500);
    assert.ok(t3.includes('3-4 个'), '标准');
    const t5 = lengthRequirementText(5000);
    assert.ok(t5.includes('4-5 个') && t5.includes('1000-1400'), '丰满');
    const t6 = lengthRequirementText(8000);
    assert.ok(t6.includes('5-6 个'), '超长');
  });

  test('细纲指令按 chapterLength 注入长度要求', async () => {
    const { chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const co = chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1, chapterLength: 5000 });
    assert.ok(co.includes('本章目标 5000 字'), '应注入目标字数');
    assert.ok(co.includes('4-5 个'), '应注入场景数');
  });

  test('快感上下文含卷内阶段（铺垫/推进/收束）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { buildPleasureContext } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V', status: 'outlined' });
    for (let i = 1; i <= 10; i++) store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
    const c1 = buildPleasureContext(b.id, 2);
    assert.ok(c1.includes('铺垫期'), '第 2/10 章应为铺垫期');
    const c5 = buildPleasureContext(b.id, 5);
    assert.ok(c5.includes('推进期'), '第 5/10 章应为推进期');
    const c9 = buildPleasureContext(b.id, 9);
    assert.ok(c9.includes('收束期'), '第 9/10 章应为收束期');
    assert.ok(c1.includes('卷内阶段'), '应标注卷内阶段');
  });

  test('前端大纲页长度配置入口', () => {
    const o = fs.readFileSync(path.join(ROOT, 'web/js/views/outline.js'), 'utf8');
    assert.ok(o.includes('每章字数'), '应有字数配置');
    assert.ok(o.includes('lengthProfile'), '应写 settings.lengthProfile');
    assert.ok(o.includes('紧凑 2500'), '应有紧凑档');
    assert.ok(o.includes('丰满 5000'), '应有丰满档');
  });
});
