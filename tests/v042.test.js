// V0.42：叙述视角（人称）——建书字段/指令注入/审校人称检查/视角切换
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 必须在任何 server 模块加载前设置（store.js 在模块加载时读取 NOVEL_DATA_DIR）
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v042-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();

describe('V0.42 叙述视角（人称）', () => {
  test('建书 perspective 落库 + 默认第三人称', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b1 = store.books.create({ title: '第一人称书', genre: '都市', blurb: 'x', perspective: 'first' });
    const b2 = store.books.create({ title: '第三人称书', genre: '玄幻', blurb: 'x' });
    assert.equal(b1.perspective, 'first');
    assert.equal(b2.perspective, 'third', '默认第三人称');
    // update 支持视角变更
    const b3 = store.books.update(b1.id, { perspective: 'third' });
    assert.equal(b3.perspective, 'third');
  });

  test('perspectiveText 指令注入：第一/第三人称措辞', async () => {
    const { perspectiveText, writeSceneInstruction, chapterOutlineInstruction, auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const pt = perspectiveText('first', '林晚');
    assert.ok(pt.includes('第一人称') && pt.includes('林晚') && pt.includes('不得出现第三人称'), '第一人称描述');
    const pt3 = perspectiveText('third');
    assert.ok(pt3.includes('第三人称') && pt3.includes('不得出现第一人称'), '第三人称描述');
    // writeSceneInstruction：first → 强约束"我"
    const w1 = writeSceneInstruction({ bookTitle: 'T', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', beat: 'b', target_words: 1000 }, scenesBefore: [], prevTail: '', perspective: 'first' });
    assert.ok(w1.includes('全程用"我"叙述'), '正文指令应强约束第一人称');
    assert.ok(!w1.includes('不得出现第一人称'), 'first 不出现第三人称约束');
    const w2 = writeSceneInstruction({ bookTitle: 'T', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', beat: 'b', target_words: 1000 }, scenesBefore: [], prevTail: '', perspective: 'third' });
    assert.ok(w2.includes('不得出现第一人称"我"'), '第三人称应禁止"我"');
    // chapterOutlineInstruction：first → POV 必须主角
    const co = chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1, perspective: 'first' });
    assert.ok(co.includes('【叙述视角】'), '细纲应注入视角');
    assert.ok(co.includes('POV 必须全程是主角'), '第一人称细纲 POV 约束');
    // auditInstruction：人称漂移检查
    const ai = auditInstruction({ bookTitle: 'T', chapterTitle: 'C', chapterText: 'x', perspective: 'first' });
    assert.ok(ai.includes('第一人称（主角视角）'), '审校应知本书视角');
    const ai3 = auditInstruction({ bookTitle: 'T', chapterTitle: 'C', chapterText: 'x' });
    assert.ok(ai3.includes('第三人称'), '默认审校第三人称');
  });

  test('buildSystemPrompt 含叙述视角行', async () => {
    const { buildSystemPrompt } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s1 = buildSystemPrompt({ title: 'T', genre: '玄幻', perspective: 'first' });
    assert.ok(s1.includes('叙述视角：第一人称（主角视角）'), 'system 应声明第一人称');
    const s2 = buildSystemPrompt({ title: 'T', genre: '玄幻' });
    assert.ok(s2.includes('叙述视角：第三人称'), 'system 应声明第三人称');
  });

  test('写正文/审校接线传 perspective + API 视角切换', async () => {
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    const a = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/audit.js'), 'utf8');
    const o = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const lib = fs.readFileSync(path.join(ROOT, 'web/js/views/library.js'), 'utf8');
    const ol = fs.readFileSync(path.join(ROOT, 'web/js/views/outline.js'), 'utf8');
    assert.ok(w.includes("perspective: book.perspective"), 'write.js 应传视角');
    assert.ok(a.includes("perspective: book.perspective"), 'audit.js 应传视角');
    assert.ok(o.includes("perspective: book.perspective"), 'outline.js 细纲应传视角');
    assert.ok(idx.includes('/api/books/:id/perspective'), '应有视角切换 API');
    assert.ok(idx.includes('rebuildHistory'), '视角切换应重建历史堆');
    assert.ok(lib.includes('perspSelect'), '建书表单应有视角下拉');
    assert.ok(lib.includes('第一人称'), '建书表单含第一人称选项');
    assert.ok(ol.includes('叙述视角'), '大纲页应有视角切换');
  });
});
