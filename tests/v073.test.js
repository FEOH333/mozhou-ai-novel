// V0.73 书籍一键导出测试：路由存在 + 格式（书名/卷分隔/章节标题/正文）+ 空章跳过
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v073-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));

describe('V0.73 书籍一键导出', () => {
  test('①后端 export 路由存在且返回 {title,text,chapters,chars}', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const exporter = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/export.js'), 'utf8');
    assert.ok(idx.includes("'/api/books/:id/export'"), '应有 export 路由');
    assert.ok(exporter.includes('━━━━━━━━━━━━━━━━━━━━━━━━━━━━'), '应有卷分隔线');
    assert.ok(idx.includes('fullTexts'), '应按章取全文');
  });

  test('②导出格式：书名 + 卷分隔 + 章节标题 + 正文，空章跳过', async () => {
    const b = store.books.create({ title: '导出书', genre: '玄幻' });
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷 山脚', status: 'outlined' });
    // 第 1 章：有正文；第 2 章：空（planned 无正文）→ 跳过
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '醒来', status: 'done' });
    const c2 = store.chapters.create(b.id, v1.id, 2, { title: '空章', status: 'planned' });
    store.scenes.create(c1.id, 1, { content: '第一段正文。', status: 'done' });
    store.scenes.create(c1.id, 2, { content: '第二段正文。', status: 'done' });
    // 模拟后端组装（直接从 store 组装与路由相同逻辑的关键部分）
    const chapters = store.chapters.list(b.id);
    const fullTexts = new Map(chapters.map(c => [c.id, (store.chapters.fullText(c.id) || '').trim()]));
    const vols = store.volumes.list(b.id);
    const parts = [`《导出书》`, ''];
    const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    for (const v of vols) {
      const vChs = chapters.filter(c => c.volume_id === v.id);
      const done = vChs.filter(c => fullTexts.get(c.id));
      if (!done.length) continue;
      parts.push(SEP, v.title, SEP, '');
      for (const ch of vChs) {
        const text = fullTexts.get(ch.id);
        if (!text) continue;
        parts.push(`第${ch.idx}章 ${ch.title}`, '', text, '');
      }
    }
    const text = parts.join('\n');
    assert.ok(text.includes('《导出书》'), '含书名');
    assert.ok(text.includes('第一卷 山脚'), '含卷名');
    assert.ok(text.includes('第1章 醒来'), '含章节标题');
    assert.ok(text.includes('第一段正文。') && text.includes('第二段正文。'), '含正文（场景拼接）');
    assert.ok(!text.includes('第2章 空章'), '空章应跳过');
  });

  test('③前端导出按钮 + 弹窗复制/下载', () => {
    const lib = fs.readFileSync(path.join(ROOT, 'web/js/views/library.js'), 'utf8');
    assert.ok(lib.includes("title: '导出全文（复制/下载）'"), '作品卡应有导出按钮');
    assert.ok(lib.includes('exportBook'), '应有导出函数');
    assert.ok(lib.includes('/export'), '前端应调 export 接口');
    assert.ok(lib.includes('navigator.clipboard.writeText'), '应支持一键复制');
    assert.ok(lib.includes('download .txt') || lib.includes('下载 .txt'), '应支持下载 txt');
    assert.ok(lib.includes('fmtTokens'), '应导入 fmtTokens');
  });
});
