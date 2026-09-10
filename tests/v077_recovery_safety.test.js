import './pipeline-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as store from '../server/db/store.js';
import { replanFrom } from '../server/engine/recovery.js';

function addSceneWithHistory(bookId, chapter, content, status = 'done') {
  const scene = store.scenes.create(chapter.id, 1, {
    pov: '主角', location: '测试地', beat: '测试节拍', content, targetWords: 500, status,
  });
  const historySeq = store.history.append(bookId, 'assistant', content);
  store.scenes.update(scene.id, { historySeq });
  return store.scenes.get(scene.id);
}

test('恢复重规划只清理未结算的未来章，绝不删除已结算正文或派生投影', async () => {
  const book = store.books.create({ title: '恢复安全边界', genre: '玄幻' });
  const settled = store.chapters.create(book.id, null, 1, { title: '已结算章', status: 'done' });
  const settledText = '第一章已经成为既定历史，不能被恢复规划抹掉。';
  addSceneWithHistory(book.id, settled, settledText);
  store.summaries.set(settled.id, book.id, '第一章摘要');
  store.facts.create(book.id, { subject: '主角', predicate: '经历', object: '第一章事件', sourceChapter: 1 });
  store.timeline.add(book.id, { chapterId: settled.id, event: '第一章事件发生' });
  store.chapterSettlements.set(book.id, settled.id, {
    contentHash: createHash('sha256').update(settledText).digest('hex'),
    result: { summary: '第一章摘要' },
  });

  const future = store.chapters.create(book.id, null, 2, { title: '待重规划章', status: 'quality_blocked' });
  const staleFutureText = '这是应该被清理的失败草稿。';
  addSceneWithHistory(book.id, future, staleFutureText, 'revised');

  const result = await replanFrom(book.id, 1);

  assert.equal(store.chapters.fullText(settled.id), settledText);
  assert.equal(store.chapters.get(settled.id).status, 'done');
  assert.equal(store.summaries.get(settled.id).summary, '第一章摘要');
  assert.ok(store.chapterSettlements.get(settled.id));
  assert.ok(store.facts.list(book.id).some(row => row.source_chapter === 1));
  assert.ok(store.timeline.list(book.id).some(row => row.chapter_id === settled.id));
  assert.equal(store.chapters.fullText(future.id), '');
  assert.equal(result.skippedSettled, 1);
});

test('若待清理历史之后还有受保护的定稿历史，重规划失败关闭且不改正文', async () => {
  const book = store.books.create({ title: '交错历史安全', genre: '玄幻' });
  const retry = store.chapters.create(book.id, null, 1, { title: '待重试', status: 'partial' });
  addSceneWithHistory(book.id, retry, '待重试草稿。', 'partial');
  const done = store.chapters.create(book.id, null, 2, { title: '后续定稿', status: 'done' });
  const doneText = '后续章节已经定稿。';
  addSceneWithHistory(book.id, done, doneText);
  store.chapterSettlements.set(book.id, done.id, {
    contentHash: createHash('sha256').update(doneText).digest('hex'), result: { summary: '定稿' },
  });

  await assert.rejects(() => replanFrom(book.id, 1), error => error?.code === 'REPLAN_HISTORY_CONFLICT');
  assert.equal(store.chapters.fullText(retry.id), '待重试草稿。');
  assert.equal(store.chapters.fullText(done.id), doneText);
});
