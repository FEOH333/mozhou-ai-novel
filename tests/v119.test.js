// V0.93 恢复状态收口：成功后不遗留失败健康记录与陈旧冲突
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v119-recovery-'));

const store = await import('../server/db/store.js');
const { replanFrom } = await import('../server/engine/recovery/recovery.js');

describe('V0.93 恢复后的陈旧状态核销', () => {
  test('场景补写完成后自动关闭生成失败与已被正文修掉的引用冲突', () => {
    const book = store.books.create({ title: '恢复冲突测试', genre: '历史' });
    const chapter = store.chapters.create(book.id, null, 15, { title: '迟了半声', status: 'done' });
 store.scenes.create(chapter.id, 1, { content: '老兵甲核过记录，主角只负责复诵。', status: 'done' });
    const stream = store.conflicts.create(book.id, {
      chapterId: chapter.id, type: '生成失败', issue: 'STREAM_INCOMPLETE', quote: '',
    });
    const typo = store.conflicts.create(book.id, {
      chapterId: chapter.id, type: '角色矛盾', issue: '人物名错误', quote: '樊老六',
    });
    const stillPresent = store.conflicts.create(book.id, {
 chapterId: chapter.id, type: '设定冲突', issue: '仍需处理', quote: '老兵甲',
    });

    assert.equal(typeof store.conflicts.resolveRecoveredChapter, 'function');
    const count = store.conflicts.resolveRecoveredChapter(chapter.id, store.chapters.fullText(chapter.id));
    assert.equal(count, 2);
    assert.notEqual(store.conflicts.list(book.id).find(row => row.id === stream.id).resolution, 'open');
    assert.notEqual(store.conflicts.list(book.id).find(row => row.id === typo.id).resolution, 'open');
    assert.equal(store.conflicts.list(book.id).find(row => row.id === stillPresent.id).resolution, 'open');
  });

  test('未来章重规划会清除该章旧健康失败并核销恢复型冲突', async () => {
    const book = store.books.create({ title: '重规划状态测试', genre: '玄幻' });
    const chapter = store.chapters.create(book.id, null, 1, { title: '待规划', status: 'quality_blocked' });
    store.chapterHealth.upsert({
      bookId: book.id, chapterId: chapter.id, idx: 1,
      verdict: 'error', failed: true, notes: '上一次细纲失败',
    });
    const conflict = store.conflicts.create(book.id, {
      chapterId: chapter.id, type: '生成失败', issue: '章细纲返回空', quote: '',
    });

    await replanFrom(book.id, 1);

    assert.equal(store.chapterHealth.getByChapter(chapter.id), null);
    assert.notEqual(store.conflicts.list(book.id).find(row => row.id === conflict.id).resolution, 'open');
    assert.ok(store.chapters.outline(chapter.id)?.scenes?.length > 0);
  });
});
