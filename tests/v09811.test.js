// V0.98.11 比较结果可读提示：同模型两轮同胜者 = single_model_advisory（仅供参考、可手动采用），
// 不再让「流程成功但保守不采用」被误读为「没有效果/失败」。
import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { createOpeningFixture, validContract } from './helpers/opening_fixture.js';

const promiseData = {
  premise_in_one_breath: '一个孩子在战乱中学会保护别人', primary_attraction_axis: '保护与成长', secondary_axes: [],
  protagonist_now: { lack: '弱小', immediate_need: '护住家人', agency_pattern: '观察后保护' },
  payoff_ladder: { near: ['有效选择'], middle: ['保护同伴'], long: ['守住山河'] },
  texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
  protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
};

let book, volume, firstScene;
beforeEach(async () => {
  ({ book, volume, firstScene } = createOpeningFixture(store));
  const { buildStoryPromiseProfile } = await import('../server/engine/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: promiseData });
});

const planFields = ({ kind, family, signature, content = '' }) => ({
  kind, strategy_family: family, entry_signature: signature,
 creative_hypothesis: `${family} 假设`, entry_time: '1241年', first_actor: '主角',
  immediate_problem: '北边反常', first_choice: '先护住弟弟', first_state_change: '一家人警觉',
  strongest_axis: 'question', transition_plan: '接回庙会', content,
});

test('V0.98.11 同模型两轮同胜者：status=single_model_advisory 且 message 引导手动采用', async () => {
  const { composeOpeningCandidates, compareOpeningCandidates } = await import('../server/engine/opening_intervention.js');
 const content = '开庆元年七月，钓鱼城北崖，砲石压进膛口。主角拽开传令兵，自己探身看江面。\n\n十八年前，淳祐元年的秋天，他九岁。';
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: [{
    ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content }),
    contract: validContract(volume.id),
  }] } });
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const assetIds = composed.candidates.filter(item => item.asset_id).map(item => item.asset_id);
  const ids = composed.candidates.map(item => item.candidate_id);
  const rounds = [1, 2].map(() => ({
    winner_id: cold.candidate_id, reason: '未来场面与回切落差清楚',
    judgments: Object.fromEntries(ids.map(id => [id, {
      strongest_axis: { kind: 'question', strength: 4 }, hard_failures: [], issues: [],
    }])),
  }));
  const result = await compareOpeningCandidates(book.id, assetIds, { data: rounds });
  assert.equal(result.status, 'single_model_advisory', '生成与裁判同模型 → 不自动应用');
  assert.equal(result.auto_safe, false);
  assert.ok(result.message, '比较结果必须带可读提示');
  assert.ok(result.message.includes('两轮均被选为胜者'), '必须明说两轮都胜出');
  assert.ok(result.message.includes('手动「采用此方案」'), '必须引导作者手动采用');
});
