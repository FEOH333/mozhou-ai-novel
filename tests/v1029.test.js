// V0.102.9：章结算两轮取证仍错必须确定性投影降级，不得把已写五场卡成 quality_blocked。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { settleChapter } from '../server/engine/pipeline/settle.js';

function makeChapter() {
  const book = store.books.create({ title: '结算降级书', genre: '玄幻' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });
  store.scenes.create(chapter.id, 1, { content: '李尘来到青云城，决定寻找图谱。', status: 'done' });
  return { book, chapter };
}

test('V0.102.9 结算重答仍错则确定性投影降级放行，幻觉引文不得入账', async () => {
  const { book, chapter } = makeChapter();
  process.env.NOVEL_SETTLE_FAULT = '2';
  const events = [];
  try {
    const settled = await settleChapter(book.id, chapter.id, { onEvent: event => events.push(event) });
    assert.ok(settled.summary, '降级后结算必须成功');
    assert.match(String(settled.summary), /第一章|青云城|图谱/);
  } finally {
    delete process.env.NOVEL_SETTLE_FAULT;
  }
  assert.equal(events.filter(event => event.type === 'settlement_retry').length, 1, '只准重答一次');
  assert.equal(events.filter(event => event.type === 'settlement_degraded').length, 1, '第二次失败必须降级事件');
  assert.equal(store.chapters.get(chapter.id).status, 'settled');
  assert.equal(store.characters.list(book.id).some(c => c.name === '林晚'), false, '幻觉人物不得入角色库');
  const facts = store.facts.list(book.id);
  assert.equal(facts.some(f => /林晚|玉佩/.test(`${f.subject}${f.object}`)), false, '幻觉事实不得入账');
});

test('V0.102.9 注入的残缺结算仍失败关闭', async () => {
  const { book, chapter } = makeChapter();
  await assert.rejects(
    settleChapter(book.id, chapter.id, {
      data: { facts: [], character_updates: [], timeline: [], foreshadow_actions: [] },
    }),
    error => error?.code === 'SETTLEMENT_INVALID',
  );
  assert.notEqual(store.chapters.get(chapter.id).status, 'settled');
});
