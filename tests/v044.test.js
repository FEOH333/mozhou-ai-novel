// V0.44 长篇化：完本判定引擎 + 自动续卷（书纲长篇规划/续卷/存量兼容）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
// V0.44 测试隔离：必须在 import store 前设置（store 模块加载时读环境变量）
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v044-'));

describe('V0.44 完本判定与自动续卷', () => {
  test('localEndingCheck：伏笔未回收→强制续卷；字数不足→续卷；达标→交 AI；超上限→停', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const cont = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));
    const b = store.books.create({ title: '判定书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'done' });
    store.scenes.create(c.id, 1, { content: 'x'.repeat(3000), status: 'done' });
    // 无伏笔但字数不足
    let r = cont.localEndingCheck(b.id, { minChars: 10000 });
    assert.equal(r.done, true, '字数不足应直接下结论');
    assert.equal(r.shouldContinue, true, '字数不足应续卷');
    assert.ok(r.reason.includes('万字'), '原因应含字数');
    // 加伏笔 → 伏笔优先
    store.foreshadows.create(b.id, { desc: '玉佩血线纹的秘密', status: 'planted', importance: 'high' });
    r = cont.localEndingCheck(b.id, { minChars: 10000 });
    assert.equal(r.shouldContinue, true, '有伏笔应续卷');
    assert.ok(r.reason.includes('伏笔'), '原因应含伏笔');
    // 伏笔回收 + 字数达标 → 交 AI
    store.foreshadows.update(store.foreshadows.list(b.id)[0].id, { status: 'paid' });
    for (let i = 0; i < 4; i++) store.scenes.create(c.id, i + 2, { content: 'y'.repeat(3000), status: 'done' });
    r = cont.localEndingCheck(b.id, { minChars: 10000 });
    assert.equal(r.done, false, '本地规则通过应交 AI 评估');
    // 章数超上限 → 停
    for (let i = 0; i < 8; i++) store.chapters.create(b.id, v.id, i + 2, { title: 'C' + (i + 2), status: 'done' });
    r = cont.localEndingCheck(b.id, { minChars: 10000, maxChapters: 9 });
    assert.equal(r.shouldContinue, false, '超上限应停止');
  });

  test('shouldContinueBook：本地规则优先；AI 评估 mock 未完本→续卷/完本→停', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const cont = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));
    const b = store.books.create({ title: '评估书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'done' });
    store.scenes.create(c.id, 1, { content: 'z'.repeat(3000), status: 'done' });
    store.materials.set(b.id, 'contract', '【书契约】核心卖点：主角逆袭登顶');
    // 伏笔未回收 → 本地规则直接续卷（不调 AI）
    store.foreshadows.create(b.id, { desc: '主线大反派来历', status: 'planted' });
    let r = await cont.shouldContinueBook(b.id, { minChars: 10000 });
    assert.equal(r.shouldContinue, true, '有伏笔必续卷');
    assert.ok(!r.ai, '本地规则下结论不应调 AI');
    // 回收伏笔 + 补足字数到阈值以上 → 调 AI（mock 默认未完本 → 续卷）
    store.foreshadows.update(store.foreshadows.list(b.id)[0].id, { status: 'paid' });
    for (let i = 0; i < 4; i++) store.scenes.create(c.id, i + 2, { content: 'w'.repeat(3000), status: 'done' });
    r = await cont.shouldContinueBook(b.id, { minChars: 10000 });
    assert.equal(r.shouldContinue, true, 'AI 判定未完本应续卷');
    assert.ok(r.ai, '应调用 AI 评估');
    assert.ok(r.reason.length > 0, '应有原因');
  });

  test('aiEndingCheck：输入含契约/伏笔/规模，mock 完本关键词→finished', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const cont = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));
    const b = store.books.create({ title: '完本书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'done' });
    store.scenes.create(c.id, 1, { content: 'a'.repeat(2000), status: 'done' });
    store.materials.set(b.id, 'contract', '【书契约】主角已达成核心目标，故事收束');
    const r = await cont.aiEndingCheck(b.id, {});
    assert.equal(typeof r.finished, 'boolean', 'finished 应为布尔');
    assert.equal(r.finished, true, 'mock 含已达成核心目标应判定完本');
  });

  test('书纲指令长篇化：无 3-6 卷限制，含长篇连载定位', async () => {
    const { bookOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s = bookOutlineInstruction({ genre: '玄幻', blurb: 'x' });
    assert.ok(!s.includes('3-6 卷'), '不应再有 3-6 卷限制');
    assert.ok(s.includes('10-30 卷'), '应规划 10-30 卷');
    assert.ok(s.includes('80-300 万字'), '应指明百万字规模');
    assert.ok(s.includes('后续卷写概要'), '后续卷应为概要');
  });
});
