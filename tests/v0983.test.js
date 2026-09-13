// V0.98.3 神开局工艺（第一屏锚定）+ OpenCode Go 免费档（ox-alpha-free）
import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { createOpeningFixture, validContract } from './helpers/opening_fixture.js';

let book, volume, firstScene;

const promiseData = {
  premise_in_one_breath: '一个孩子在战乱中学会保护别人', primary_attraction_axis: '保护与成长', secondary_axes: [],
  protagonist_now: { lack: '弱小', immediate_need: '护住家人', agency_pattern: '观察后保护' },
  payoff_ladder: { near: ['有效选择'], middle: ['保护同伴'], long: ['守住山河'] },
  texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
  protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
};

beforeEach(async () => {
  ({ book, volume, firstScene } = createOpeningFixture(store));
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: promiseData });
});

const planFields = ({ kind, family, signature, content = '' }) => ({
  kind, strategy_family: family, entry_signature: signature,
 creative_hypothesis: `${family} 假设`, entry_time: '1241年', first_actor: '主角',
  immediate_problem: '北边反常', first_choice: '先护住弟弟', first_state_change: '一家人警觉',
  strongest_axis: 'question', transition_plan: '接回庙会', content,
});

test('V0.98.3 神开局工艺文本写审同源：候选写作/审校/压缩三处注入同一份纪律', async () => {
  const { COLD_OPEN_CRAFT_TEXT } = await import('../server/data/literary_techniques.js');
  assert.ok(COLD_OPEN_CRAFT_TEXT.includes('120 字内出现'), '工艺必须量化到字数');
  assert.ok(COLD_OPEN_CRAFT_TEXT.includes('前三句'), '工艺必须落到第一屏');
  assert.ok(COLD_OPEN_CRAFT_TEXT.includes('回切即钩子'), '回切钩子是楔子的收束工艺');

  const { openingContractEventContext, inferOpeningContractTarget } = await import('../server/engine/planning/opening_intervention.js');
  const { openingCandidateInstruction, openingCandidateAuditInstruction, openingCandidateLengthRepairInstruction } = await import('../server/engine/prompts.js');
  const contractEvent = openingContractEventContext(book.id, inferOpeningContractTarget(book.id));
  const strategy = { kind: 'chapter1_cold_open', strategy_family: 'future_result_present_question' };

  const write = openingCandidateInstruction({ book, strategy, contractEvent, budget: { preferred: [300, 800], hardMax: 1000 } });
  assert.ok(write.includes('神开局工艺'), '写作指令注入工艺');
  assert.ok(write.includes('第一屏 120 字内'), '契约块声明第一屏锚定要求（注入即可检）');

  const audit = openingCandidateAuditInstruction({ book, candidate: { kind: 'chapter1_cold_open' }, contractEvent });
  assert.ok(audit.includes('神开局工艺'), '审校与写作同源拿到同一工艺');

  const repair = openingCandidateLengthRepairInstruction({
    strategy, content: '超限正文', contractEvent, budget: { preferred: [300, 800], hardMax: 1000 },
  });
  assert.ok(repair.includes('神开局工艺'), '压缩不得丢工艺与锚定信号');
});

test('V0.98.3 事件信号迟到第一屏之后 → high 问题禁止采用（第一屏生死线）', async () => {
  const { composeOpeningCandidates, selectOpeningAsset } = await import('../server/engine/planning/opening_intervention.js');
  const late = `${'他在城头上来回走动，逐一检查垛口与礌石的绳结，又吩咐身边人加固门板。'.repeat(8)}开庆元年，钓鱼城的砲声忽然沉了下去。\n\n十八年前，淳祐元年。`;
  const candidates = [{
    ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content: late }),
    contract: validContract(volume.id),
  }];
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } });
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.ok(audit.issues.some(item => item.code === 'cold_open_first_screen_unanchored' && item.severity === 'high'),
    '信号词在 120 字之后才出现=开场在铺气氛，必须判废');
  assert.ok(!audit.issues.some(item => item.code === 'cold_open_target_ungrounded'),
    '信号在场只是迟到，不重复判未锚定');
  assert.throws(() => selectOpeningAsset(book.id, cold.asset_id), error => error?.code === 'OPENING_AUDIT_BLOCKED');
});

test('V0.98.3 OpenCode Go 免费档预设：模型映射、参数与协议正确', async () => {
  const { PROVIDER_PRESETS, resolveModelName, resolveRoute } = await import('../server/config.js');
  const preset = PROVIDER_PRESETS.opencode_go_free;
  assert.equal(preset.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(preset.models.flash, 'ox-alpha-free');
  assert.equal(preset.models.pro, 'ox-alpha-free');
  assert.equal(preset.deepseekParams, false, '免费档不发 DeepSeek 专属参数');
  assert.equal(preset.protocol, 'chat');

  const g = { provider: 'opencode_go_free', writingModel: 'flash', routes: {} };
  assert.equal(resolveModelName('write', 'deepseek-v4-pro', g), 'ox-alpha-free', '正文任务映射到免费档');
  assert.equal(resolveModelName('audit', 'deepseek-v4-flash', g), 'ox-alpha-free', '默认名经预设映射，自定义名原样保留');
  assert.equal(resolveModelName('audit', 'glm-5', g), 'glm-5');
});

test('V0.98.3 ox-alpha-free 计价为 0，成本页不得虚高估算', async () => {
  const { getPrice, computeCost } = await import('../server/llm/cost.js');
  assert.deepEqual(getPrice('ox-alpha-free'), { hit: 0, miss: 0, output: 0, label: 'Ox Alpha Free（OpenCode Go 限时免费）' });
  assert.equal(computeCost('ox-alpha-free', 100000, 200000, 50000).cost, 0);
});
