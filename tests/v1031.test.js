// V0.102.11：quality_blocked 自动修复成功后必须能进入 settled。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { transitionChapterStatus } from '../server/engine/chapter_status.js';
import { settleChapter } from '../server/engine/settle.js';

function makeChapter() {
  const book = store.books.create({ title: '卡章结算书', genre: '玄幻' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });
  store.scenes.create(chapter.id, 1, { content: '李尘来到青云城，决定寻找图谱。', status: 'done' });
  return { book, chapter };
}

test('V0.102.11 quality_blocked 可迁入 settled，完成态仍不得降为 drafted', () => {
  const { book, chapter } = makeChapter();
  transitionChapterStatus(book.id, chapter.id, 'drafted', { reason: '正文已写' });
  transitionChapterStatus(book.id, chapter.id, 'quality_blocked', { reason: '质量门' });
  transitionChapterStatus(book.id, chapter.id, 'settled', { reason: '自动修复后结算' });
  assert.equal(store.chapters.get(chapter.id).status, 'settled');
  assert.throws(
    () => transitionChapterStatus(book.id, chapter.id, 'drafted', { reason: '测试' }),
    /迁移被拒/,
  );
});

test('V0.102.11 卡章自动修复路径：quality_blocked 章可完成结算', async () => {
  const { book, chapter } = makeChapter();
  transitionChapterStatus(book.id, chapter.id, 'drafted', { reason: '正文已写' });
  transitionChapterStatus(book.id, chapter.id, 'quality_blocked', { reason: '质量门' });
  await settleChapter(book.id, chapter.id, {
    data: {
      facts: [{ subject: '李尘', predicate: '位于', object: '青云城' }],
      character_updates: [{ name: '李尘', changes: ['位置=青云城'] }],
      character_emotional: [{ name: '李尘', mood: '警惕', relation_delta: '与守卫互相戒备' }],
      timeline: ['李尘进入青云城'],
      foreshadow_actions: [],
      new_entities: [],
      summary: '李尘进入青云城寻找图谱。',
      rolling_update: '李尘抵达青云城。',
    },
  });
  assert.equal(store.chapters.get(chapter.id).status, 'settled');
});
