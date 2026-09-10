// V0.77 章节健康状态回归：同章幂等、note 落库、漂移窗口按章节去重
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-health-'));
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const { recordChapterHealth, detectDrift } = await import('../server/engine/recovery.js');

test('同一章节的健康记录应更新原行并保存 note', () => {
  const book = store.books.create({ title: '健康幂等', genre: '玄幻' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });

  recordChapterHealth(book.id, chapter.id, {
    verdict: 'error', failed: true, wordCount: 100, note: '首次失败',
  });
  recordChapterHealth(book.id, chapter.id, {
    verdict: 'accept', failed: false, wordCount: 900, note: '重试成功',
  });

  const rows = store.chapterHealth.list(book.id).filter(h => h.chapter_id === chapter.id);
  assert.equal(rows.length, 1, '一个章节只应有一条当前健康状态');
  assert.equal(rows[0].verdict, 'accept');
  assert.equal(rows[0].failed, 0);
  assert.equal(rows[0].word_count, 900);
  assert.equal(rows[0].notes, '重试成功');
});

test('同一失败章节被重复记录不能伪造“连续多章失败”', () => {
  const book = store.books.create({ title: '漂移去重', genre: '玄幻' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });

  for (let i = 0; i < 3; i++) {
    recordChapterHealth(book.id, chapter.id, { verdict: 'error', failed: true });
  }

  assert.equal(store.chapterHealth.recent(book.id, 4).length, 1);
  assert.equal(detectDrift(book.id).trigger, false);
});
