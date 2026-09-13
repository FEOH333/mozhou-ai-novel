// V0.35：写前五问自检 3 轮不过卡死全书 → ①第 2 次起按 fail_reason 修订细纲 ②仍不过则降级放行继续写作
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

describe('V0.35 五问自检不阻断成书', () => {
  test('修订注入：第 2 次尝试的指令包含上次未通过原因', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes('lastFailReason'), '应记录上次未通过原因');
    assert.ok(src.includes('【上一版未通过写前自检】'), '指令应注入未通过原因');
    assert.ok(src.includes('请保留章节结构与核心设计'), '应要求按原因修订而非重写');
  });

  test('降级放行：3 轮仍不过则复用最后一次合法细纲继续（不抛错）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes('lastGoodOutline'), '应记录最后一次合法细纲');
    assert.ok(src.includes('已降级放行继续写作'), '应有降级放行提示');
    assert.ok(src.includes('startsWith(\'套路自检\')'), '仅套路自检失败才降级（结构不合法仍报错）');
  });

  test('mock 全流程：五问通过 → 细纲正常返回并落库（回归）', async () => {
    process.env.NOVEL_MOCK_LLM = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v035-'));
    process.env.NOVEL_DATA_DIR = tmp;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '测试书', genre: '玄幻', platform: '番茄', blurb: 'x' });
    await outline.generateBookOutline(b.id, { volumeCount: 2 });
    const vols = store.volumes.list(b.id);
    await outline.generateVolumeOutline(b.id, vols[0].id, { chapterCount: 2 });
    const chs = store.chapters.list(b.id);
    const events = [];
    const o = await outline.generateChapterOutline(b.id, chs[0].id, { onEvent: (ev) => events.push(ev.message) });
    assert.ok(o?.scenes?.length > 0, '细纲应正常生成');
    assert.ok(events.some(m => m.includes('五问自检通过')), '应提示五问通过');
    const saved = store.chapters.outline(chs[0].id);
    assert.ok(saved?.scenes?.length > 0, '细纲应落库');
    delete process.env.NOVEL_MOCK_LLM;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
