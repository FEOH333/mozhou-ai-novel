// V0.98.8 瞬时坏响应自愈：空输出（finish=stop 无思考）路由层降档重试 + 候选 JSON 解析失败静默重试
// 实证（ox-alpha-free）：用户报「方案生成失败：开篇正文候选无法解析」——同请求复现两轮成功，
// 属免费档瞬时坏响应（空正文/无 JSON 散文，finish=stop）；此前这类形态不触发任何重试直接失败。
import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { createOpeningFixture } from './helpers/opening_fixture.js';

const promiseData = {
  premise_in_one_breath: '一个孩子在战乱中学会保护别人', primary_attraction_axis: '保护与成长', secondary_axes: [],
  protagonist_now: { lack: '弱小', immediate_need: '护住家人', agency_pattern: '观察后保护' },
  payoff_ladder: { near: ['有效选择'], middle: ['保护同伴'], long: ['守住山河'] },
  texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
  protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
};

let book;
beforeEach(async () => {
  ({ book } = createOpeningFixture(store));
  const { buildStoryPromiseProfile } = await import('../server/engine/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: promiseData });
});

test('V0.98.8 瞬时空响应（finish=stop、无思考）→ 路由层降档重试拿回正文', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  process.env.NOVEL_EMPTY_ONCE = '1';
  const { runTask } = await import('../server/llm/router.js');
  const result = await runTask({ task: 'summarize', messages: [{ role: 'user', content: '写一段摘要。' }] });
  assert.ok((result.content || '').trim().length > 0, '首次空响应后必须重试拿到正文');
  process.env.NOVEL_EMPTY_ONCE = '';
});

test('V0.98.8 候选 JSON 解析失败静默重试：首次纯散文 → 第二次正常 → compose 成功落库', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  process.env.NOVEL_PROSE_ONCE = '1';
  const { composeOpeningCandidates } = await import('../server/engine/opening_intervention.js');
  const events = [];
  const result = await composeOpeningCandidates(book.id, { mode: 'repair', onEvent: event => events.push(event) });
  const cold = result.candidates.find(item => item.kind === 'chapter1_cold_open');
  assert.ok(cold?.asset_id, '重试后楔子候选应正常生成并落库');
  assert.ok(events.some(event => event.step === 'drafting' && event.detail.includes('解析失败')), '重试应对界面可见');
  process.env.NOVEL_PROSE_ONCE = '';
});
