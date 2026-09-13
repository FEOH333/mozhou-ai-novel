// V0.77 章节结算回归：严格输出、事务原子性、同正文幂等
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-settle-'));
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const { settleChapter } = await import('../server/engine/pipeline/settle.js');

function makeChapter(title = '结算测试') {
  const book = store.books.create({ title, genre: '玄幻' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });
  store.scenes.create(chapter.id, 1, { content: '李尘来到青云城，决定寻找图谱。', status: 'done' });
  return { book, chapter };
}

const validData = () => ({
  facts: [{ subject: '李尘', predicate: '位于', object: '青云城' }],
  character_updates: [{ name: '李尘', changes: ['位置=青云城'] }],
  character_emotional: [{ name: '李尘', mood: '警惕', relation_delta: '与守卫互相戒备' }],
  timeline: ['李尘进入青云城'],
  foreshadow_actions: [],
  new_entities: [],
  summary: '李尘进入青云城寻找图谱。',
  rolling_update: '李尘抵达青云城。',
});

test('结算输出缺少摘要时 fail-closed，章节不得完成', async () => {
  const { book, chapter } = makeChapter('严格结算');
  await assert.rejects(
    settleChapter(book.id, chapter.id, {
      data: { facts: [], character_updates: [], timeline: [], foreshadow_actions: [] },
    }),
    error => error?.code === 'SETTLEMENT_INVALID',
  );
  assert.notEqual(store.chapters.get(chapter.id).status, 'settled');
  assert.equal(store.summaries.get(chapter.id), undefined);
});

test('同一正文重复结算只应用一次派生投影', async () => {
  const { book, chapter } = makeChapter('幂等结算');
  const first = await settleChapter(book.id, chapter.id, { data: validData() });
  const second = await settleChapter(book.id, chapter.id, { data: validData() });

  assert.equal(first.summary, '李尘进入青云城寻找图谱。');
  assert.equal(second.reused, true, '第二次应复用同一正文的结算指纹');
  assert.equal(store.facts.list(book.id, { status: 'active' }).length, 1);
  assert.equal(store.timeline.list(book.id).filter(t => t.event === '李尘进入青云城').length, 1);
  assert.equal((store.rollingSummaries.get(book.id).match(/李尘抵达青云城/g) || []).length, 1);
  const character = store.characters.list(book.id).find(c => c.name === '李尘');
  assert.equal((character.relation.match(/与守卫互相戒备/g) || []).length, 1);
  assert.ok(store.chapterSettlements.get(chapter.id));
});

test('结算应用中途异常时事实、时间线、摘要和状态全部回滚', async () => {
  const { book, chapter } = makeChapter('原子结算');
  const broken = validData();
  broken.character_emotional = [{ name: '李尘', mood: '警惕', relation_delta: 123 }];

  await assert.rejects(settleChapter(book.id, chapter.id, { data: broken }));

  assert.equal(store.facts.list(book.id).length, 0);
  assert.equal(store.timeline.list(book.id).length, 0);
  assert.equal(store.summaries.get(chapter.id), undefined);
  assert.equal(store.rollingSummaries.get(book.id), '');
  assert.notEqual(store.chapters.get(chapter.id).status, 'settled');
  assert.equal(store.chapterSettlements.get(chapter.id), undefined);
});

test('store.transaction 抛错时回滚全部同步写入', () => {
  const { book } = makeChapter('事务帮助器');
  assert.throws(() => store.transaction(() => {
    store.facts.create(book.id, { subject: '临时', predicate: '状态', object: '不应存在' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.facts.list(book.id).length, 0);
});

test('V0.100.1 结算证据定位失败带反馈重答一次后收敛（与重建投影同权）', async () => {
  const { book, chapter } = makeChapter('结算反馈重答');
  process.env.NOVEL_SETTLE_FAULT = '1'; // mock 首次返回正文外幻觉证据，收到纠正反馈后返回正常
  const events = [];
  try {
    const settled = await settleChapter(book.id, chapter.id, {
      onEvent: event => events.push(event),
    });
    assert.ok(settled.summary, '重答收敛后结算必须成功');
  } finally {
    delete process.env.NOVEL_SETTLE_FAULT;
  }
  const retries = events.filter(event => event.type === 'settlement_retry');
  assert.equal(retries.length, 1, '证据判废必须退回模型重答恰好一次');
  assert.match(String(retries[0].reason), /逐字定位/, '反馈必须带原始本地校验错误');
});

test('V0.102.9 结算重答仍错则确定性投影降级，只准重答一次', async () => {
  const { book, chapter } = makeChapter('结算二次失败');
  process.env.NOVEL_SETTLE_FAULT = '2'; // mock 恒返回幻觉证据（含纠正反馈后仍坏）
  const events = [];
  try {
    const settled = await settleChapter(book.id, chapter.id, { onEvent: event => events.push(event) });
    assert.ok(settled.summary, '降级后结算必须成功');
  } finally {
    delete process.env.NOVEL_SETTLE_FAULT;
  }
  assert.equal(events.filter(event => event.type === 'settlement_retry').length, 1, '只准重答一次，不无界重试烧费');
  assert.equal(events.filter(event => event.type === 'settlement_degraded').length, 1, '第二次失败必须降级放行');
  assert.equal(store.chapters.get(chapter.id).status, 'settled');
});
