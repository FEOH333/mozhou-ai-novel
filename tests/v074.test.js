// V0.74 选择章节导出测试：chapterIds 过滤 + chapterList 返回 + 前端勾选 UI
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v074-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));

describe('V0.74 选择章节导出', () => {
  test('①后端 export 支持 chapterIds 过滤 + 返回 chapterList', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const exporter = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/export.js'), 'utf8');
    assert.ok(idx.includes("searchParams.get('chapterIds')"), '应支持 chapterIds 参数');
    assert.ok(exporter.includes('chapterList'), '应返回章节清单');
    assert.ok(exporter.includes('selected.has(chapter.id)'), '应按 id 过滤');
  });

  test('②导出组装：选中章节才输出（模拟后端过滤逻辑）', () => {
    const b = store.books.create({ title: '选择书', genre: '玄幻' });
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', status: 'outlined' });
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '一', status: 'done' });
    const c2 = store.chapters.create(b.id, v1.id, 2, { title: '二', status: 'done' });
    const c3 = store.chapters.create(b.id, v1.id, 3, { title: '三', status: 'done' });
    store.scenes.create(c1.id, 1, { content: '正文一', status: 'done' });
    store.scenes.create(c2.id, 1, { content: '正文二', status: 'done' });
    store.scenes.create(c3.id, 1, { content: '正文三', status: 'done' });
    // 模拟路由组装逻辑
    const chapters = store.chapters.list(b.id);
    const fullTexts = new Map(chapters.map(c => [c.id, (store.chapters.fullText(c.id) || '').trim()]));
    const selected = new Set([c1.id, c3.id]);
    const wanted = chapters.filter(c => selected.has(c.id));
    const parts = ['《选择书》', ''];
    for (const ch of wanted) {
      const text = fullTexts.get(ch.id);
      if (!text) continue;
      parts.push(`第${ch.idx}章 ${ch.title || ''}`, '', text, '');
    }
    const text = parts.join('\n');
    assert.ok(text.includes('第1章 一') && text.includes('正文一'), '含选中章 1');
    assert.ok(text.includes('第3章 三') && text.includes('正文三'), '含选中章 3');
    assert.ok(!text.includes('第2章 二') && !text.includes('正文二'), '未选中章 2 不导出');
  });

  test('③前端弹窗含章节勾选（全选/清空/勾选刷新）', () => {
    const lib = fs.readFileSync(path.join(ROOT, 'web/js/views/library.js'), 'utf8');
    assert.ok(lib.includes('选择章节'), '应有章节选择区');
    assert.ok(lib.includes('type: \'checkbox\''), '应使用复选框');
    assert.ok(lib.includes("chapterIds="), '勾选变化应带 chapterIds 重新请求');
    assert.ok(lib.includes('refreshText'), '应有刷新函数');
    assert.ok(lib.includes('全选') && lib.includes('清空'), '应有全选/清空按钮');
  });
});
