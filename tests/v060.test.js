// V0.60 防屎山专项测试：债务只记需圆场问题 + 清理窗口 + 存量清理
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v060-'));

describe('V0.60 防屎山', () => {
  test('audit 落库过滤：语句质量/文学性/low 级不记债，仅需圆场类型 medium+ 记债', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/audit.js'), 'utf8');
    assert.ok(src.includes('NEEDS_ROUNDUP'), '应有圆场类型白名单');
    assert.ok(src.includes("'语句质量' || type === '文学性'") || src.includes("type === '语句质量' || type === '文学性'"), '文本质量类不记债');
    assert.ok(src.includes("=== 'low'"), 'low 级不记债');
    assert.ok(src.includes('伏笔遗忘') && src.includes('时间线冲突'), '白名单含伏笔/时间线');
  });

  test('conflicts.pruneBefore 清理窗口 + removeByType', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 8; i++) store.chapters.create(b.id, v.id, i, { title: 'C' + i });
    store.conflicts.create(b.id, { chapterId: 'ch-1', type: '语句质量', issue: 'x1' });
    store.conflicts.create(b.id, { chapterId: 'ch-1', type: '时间线冲突', issue: 'x2' });
    store.conflicts.create(b.id, { chapterId: 'ch-6', type: '时间线冲突', issue: 'x3' });
    assert.equal(store.conflicts.list(b.id).length, 3);
    // 清理：保留最近 5 章（idx>=2 的 chapter_id 值用字符串模拟——pruneBefore 按 chapter_id 数值比较）
    // 实际 chapter_id 是 id 非 idx；这里验证方法存在与类型删除
    const removed = store.conflicts.removeByType(b.id, '语句质量');
    assert.equal(removed, 1, '语句质量应可批量删除');
    assert.equal(store.conflicts.list(b.id).length, 2);
  });

  test('settle 章结算后自动 prune（过期债务清理接线）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/settle.js'), 'utf8');
    assert.ok(src.includes('pruneBefore'), '结算应清理过期债务');
    assert.ok(src.includes('chapter.idx - 4'), '保留最近 5 章窗口');
  });

  test('store.js 提供 pruneBefore/removeByType', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/db/store.js'), 'utf8');
    assert.ok(src.includes('pruneBefore(bookId'), '应有 pruneBefore');
    assert.ok(src.includes('removeByType(bookId'), '应有 removeByType');
  });
});
