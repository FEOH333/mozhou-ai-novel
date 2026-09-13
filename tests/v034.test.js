// V0.34：大纲生成 "Cannot read properties of undefined (reading 'title')" 根因修复
// ①前端 sse() 恒返回 undefined → 调用方 r.title 必崩 → 改为返回 done 数据/error reject/中断报错
// ②后端生成函数 store.books.get 无判空 → book.title TypeError → 全部补齐"作品不存在"判空
// ③后端 SSE 中途出错发 error 事件（此前静默断开）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

describe('V0.34 大纲生成 TypeError 根因修复', () => {
  test('前端 sse() 返回 done 数据/error reject/中断报错（不再恒返回 undefined）', () => {
    const api = fs.readFileSync(path.join(ROOT, 'web/js/api.js'), 'utf8');
    assert.ok(api.includes('let doneData = null'), 'sse() 应记录 done 数据');
    assert.ok(api.includes("else if (event === 'error') errorMsg ="), 'sse() 应捕获 error 事件');
    assert.ok(api.includes('if (doneData) return doneData;'), 'sse() 应返回 done 数据');
    assert.ok(api.includes("throw new Error('生成中断：未收到完成信号，请重试')"), '中断应明确报错');
    assert.ok(api.includes('if (errorMsg) throw new Error(errorMsg)'), 'error 事件应 reject');
  });

  test('后端 SSE 出错发 error 事件（asyncWrap + sseStart 标记）', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes('res._sse = true'), 'sseStart 应标记 SSE');
    assert.ok(idx.includes("event: error"), 'asyncWrap 应发送 error 事件');
  });

  test('卷大纲/细纲/五问/评分门：作品不存在时抛"作品不存在"而非 TypeError', async () => {
    process.env.NOVEL_MOCK_LLM = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v034-'));
    process.env.NOVEL_DATA_DIR = tmp;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const idea = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/idea.js')));
    const audit = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/audit.js')));
    // 书不存在 → 各入口抛明确业务错误（"卷不存在/章节不存在/作品不存在"），而不是 TypeError 崩溃
    await assert.rejects(() => outline.generateVolumeOutline('bk-none', 'vol-none', {}), /不存在/);
    await assert.rejects(() => outline.generateChapterOutline('bk-none', 'ch-none'), /不存在/);
    await assert.rejects(() => outline.fiveQuestionsCheck('bk-none', 'ch-none', { scenes: [] }), /不存在/);
    await assert.rejects(() => idea.scoreContract('bk-none'), /不存在/);
    await assert.rejects(() => audit.coverageCheck('bk-none', 'ch-none'), /不存在/);
    // 正常路径不受影响（建书→书纲→卷大纲 mock 全流程）
    const b = store.books.create({ title: '测试书', genre: '玄幻', blurb: 'x' });
    const out = await outline.generateBookOutline(b.id, { volumeCount: 2 });
    assert.ok(out.volumes?.length > 0, '书纲应正常生成');
    const vols = store.volumes.list(b.id);
    const vo = await outline.generateVolumeOutline(b.id, vols[0].id, { chapterCount: 3 });
    assert.ok(vo.chapters?.length > 0, '卷大纲应正常生成');
    // 清理环境（Windows 下 sqlite 句柄未释放可能 EPERM，忽略即可——临时目录由系统回收）
    delete process.env.NOVEL_MOCK_LLM;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
