// V0.102.2：自动自愈补强——过期 hash 只要旧投影仍能逐字定位则复用；
// 取证/规划校准两轮仍错时落地确定性投影与规划，不得把全书停死。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const store = await import('../server/db/store.js');
const {
  assertNarrativeStateReady,
  ensureNarrativeStateReady,
  prepareAndCommitNarrativeRevision,
} = await import('../server/engine/narrative_state.js');

const sha256 = value => createHash('sha256').update(String(value || '')).digest('hex');
const ANCHOR = '主角烧掉退路文书';

function completedChapter(bookId, idx, text, volumeId = null) {
  const chapter = store.chapters.create(bookId, volumeId, idx, {
    title: `第${idx}章`, status: 'done', wordCount: text.length,
  });
  store.scenes.create(chapter.id, 1, { content: text, status: 'done' });
  store.summaries.set(chapter.id, bookId, `第${idx}章摘要`);
  store.chapterSettlements.set(bookId, chapter.id, {
    contentHash: sha256(text), result: { summary: `第${idx}章摘要` },
  });
  return chapter;
}

function strictProjection(text) {
  assert.ok(text.includes(ANCHOR));
  return {
 summary: '主角烧掉退路文书，带十人进入山道。',
 rolling_update: '主角烧掉退路文书并进入山道。',
    outline_actual: {
      goal: '烧掉退路文书并突围',
      conflict: '退路与抢先突围不可兼得',
 dramatic_question: '主角敢不敢亲手断掉退路？',
      counterforce: '同伴反对且追兵逼近',
      turn: '斥候已经看见文书',
      irreversible_change: '文书被烧，十人进入陌生山道',
      choice_cost: '失去原路撤回的可能',
      reader_gain: '突围路线与责任升级',
      reader_pull: '山道尽头出现宋军旗号',
      evidence: ANCHOR,
 scenes: [{ id: 's1', beat: '主角烧掉文书，带队进入山道', evidence: ANCHOR }],
    },
 facts: [{ subject: '主角', predicate: '烧掉', object: '退路文书', evidence: ANCHOR }],
 character_updates: [{ name: '主角', changes: ['位置=山道'], evidence: ANCHOR }],
    character_notes: [],
    character_emotional: [],
 timeline: [{ event: '主角烧掉退路文书并带队突围', evidence: ANCHOR }],
    foreshadow_actions: [],
    memory_entries: [],
    new_entities: [],
  };
}

test('V0.102.2 自动自愈规划校准两轮仍错时落地确定性规划，不把全书停死', async () => {
  const book = store.books.create({ title: '规划降级测试' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷', goal: '突围' });
  const text = `${ANCHOR}，带十个人当夜冲出营门。`.repeat(40);
  completedChapter(book.id, 1, text, volume.id);
  store.chapters.create(book.id, volume.id, 2, { title: '山口', status: 'planned' });
  const events = [];
  let planCalls = 0;
  await ensureNarrativeStateReady(book.id, {
    projectionImpl: async ({ text: current }) => strictProjection(current),
    planImpl: async () => {
      planCalls += 1;
      const error = new Error('书级实际状态证据无法在第1章当前正文定位：幻觉引文');
      error.code = 'PLAN_RECONCILE_INVALID';
      throw error;
    },
    reindex: false,
    onEvent: event => events.push(event),
  });
  assert.equal(planCalls, 2, '规划校准仍只准重答一次，然后降级而非第三次调用');
  assert.doesNotThrow(() => assertNarrativeStateReady(book.id));
  assert.ok(events.some(event => event.type === 'narrative_plan_degraded'));
  const current = store.narrativeRevisions.current(book.id);
  assert.ok(current);
  const plan = current.manifest?.plan_reconciliation;
  assert.equal(plan.book_state?.actual_through_chapter, 1);
  assert.equal(plan.next_chapters?.[0]?.chapter, 2);
 assert.match(String(plan.book_state.evidence[0].quote), /主角烧掉退路文书|带十个人当夜冲出营门/);
});

test('V0.102.2 显式重建接口规划失败仍 fail-closed，不得默认降级', async () => {
  const book = store.books.create({ title: '规划显式失败测试' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷', goal: '突围' });
  completedChapter(book.id, 1, `${ANCHOR}，带十个人当夜冲出营门。`.repeat(40), volume.id);
  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    projectionImpl: async ({ text }) => strictProjection(text),
    planImpl: async () => {
      const error = new Error('幻觉引文');
      error.code = 'PLAN_RECONCILE_INVALID';
      throw error;
    },
    reindex: false,
  }), /幻觉引文|无法定位|PLAN_RECONCILE/);
  assert.ok(!store.narrativeRevisions.current(book.id));
});

test('V0.102.2 写章入口把规划降级开关传给同版重建', () => {
  const src = fs.readFileSync('server/engine/narrative_state.js', 'utf8');
  assert.match(src, /allowDegradedPlan:\s*true/);
  assert.match(src, /deterministicPlanReconciliation/);
  assert.match(src, /narrative_plan_degraded/);
});
