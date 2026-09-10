// V0.98.2 远期高能楔子 grounded generation：契约目标前置注入 + 确定性未来性防线
import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { createOpeningFixture, validContract, sha256 } from './helpers/opening_fixture.js';

let book, volume, firstScene;

const promiseData = {
  premise_in_one_breath: '一个孩子在战乱中学会保护别人', primary_attraction_axis: '保护与成长', secondary_axes: [],
  protagonist_now: { lack: '弱小', immediate_need: '护住家人', agency_pattern: '观察后保护' },
  payoff_ladder: { near: ['有效选择'], middle: ['保护同伴'], long: ['守住山河'] },
  texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
  protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
};

const healthyDiagnosis = { rubric: { promise_alignment: { score: 4 } }, recommendation: { kind: 'baseline' }, strategies: [] };
const weakDiagnosis = { rubric: { promise_alignment: { score: 2 } }, recommendation: { kind: 'baseline' }, strategies: [] };

beforeEach(async () => {
  ({ book, volume, firstScene } = createOpeningFixture(store));
  const { buildStoryPromiseProfile } = await import('../server/engine/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: promiseData });
});

const planFields = ({ kind, family, signature, content = '' }) => ({
  kind, strategy_family: family, entry_signature: signature,
 creative_hypothesis: `${family} 假设`, entry_time: '1241年', first_actor: '主角',
  immediate_problem: '北边反常', first_choice: '先护住弟弟', first_state_change: '一家人警觉',
  strongest_axis: 'bond', transition_plan: '接回庙会', content,
});

test('V0.98.2 契约目标在场时远期楔子是默认核心策略；顺叙强化只在弱开篇时救济', async () => {
  const { planOpeningStrategies, inferOpeningContractTarget } = await import('../server/engine/opening_intervention.js');
  const target = inferOpeningContractTarget(book.id);
  assert.ok(target, 'fixture 卷纲带 1259 稳定事件键，应解析出契约目标');

  const healthy = planOpeningStrategies(promiseData, healthyDiagnosis, {
    hasPublishedText: true, contractTarget: target,
  });
  assert.ok(healthy.some(item => item.kind === 'chapter1_cold_open'), '健康开篇也必须拿到远期楔子');
  assert.equal(healthy.some(item => item.kind === 'head_rewrite'), false, '顺叙强化不得冒充楔子核心');
  const cold = healthy.find(item => item.kind === 'chapter1_cold_open');
  for (const field of ['kind', 'strategy_family', 'entry_signature', 'creative_hypothesis', 'entry_time',
    'first_actor', 'immediate_problem', 'first_choice', 'first_state_change', 'strongest_axis', 'transition_plan']) {
    assert.ok(String(cold[field] || '').trim(), `确定性蓝图字段 ${field} 必须完整，可直接进入候选写作`);
  }
  assert.ok(cold.entry_time.includes('1259'), '楔子进入时间必须是目标事件现场');

  const weak = planOpeningStrategies(promiseData, weakDiagnosis, {
    hasPublishedText: true, contractTarget: target,
  });
  assert.ok(weak.some(item => item.kind === 'head_rewrite'), '弱开篇诊断才追加顺叙救济');
  assert.equal(planOpeningStrategies(promiseData, healthyDiagnosis, { hasPublishedText: true })
    .some(item => item.kind === 'chapter1_cold_open'), false, '无契约目标时不得生成无锚楔子');
});

test('V0.98.2 契约事件上下文携带目标卷材料与第一章年份差', async () => {
  const { openingContractEventContext, inferOpeningContractTarget } = await import('../server/engine/opening_intervention.js');
  const context = openingContractEventContext(book.id, inferOpeningContractTarget(book.id));
  assert.equal(context.volume_title, '城头卷');
  assert.equal(context.opening_year, 1241);
  assert.equal(context.year_delta, 18);
  assert.deepEqual(context.event_signals, ['钓鱼', '蒙哥']);
  assert.equal(context.target_event_key, 'historical:1259:diaoyucheng-mongke-death');
});

test('V0.98.2 候选写作与审校指令同源注入远期事件契约（生成前 grounding，不是事后附加）', async () => {
  const { openingContractEventContext, inferOpeningContractTarget } = await import('../server/engine/opening_intervention.js');
  const { openingCandidateInstruction, openingCandidateAuditInstruction } = await import('../server/engine/prompts.js');
  const contractEvent = openingContractEventContext(book.id, inferOpeningContractTarget(book.id));
  const strategy = { kind: 'chapter1_cold_open', strategy_family: 'future_result_present_question' };

  const write = openingCandidateInstruction({ book, strategy, contractEvent, budget: { preferred: [200, 700], hardMax: 1000 } });
  assert.ok(write.includes('远期事件契约'), '写作指令必须携带契约块');
  assert.ok(write.includes('historical:1259:diaoyucheng-mongke-death'));
  assert.ok(write.includes('目标年份：1259'));
  assert.ok(write.includes('钓鱼、蒙哥'), '事件信号词必须显式给出（注入即可检）');
  assert.ok(write.includes('18年前') || write.includes('十八年前'), '回切年差必须量化给出');
  assert.ok(write.includes('禁止复用第一章'), '不得把第一章内容搬到前面冒充楔子');

  const audit = openingCandidateAuditInstruction({ book, candidate: { kind: 'chapter1_cold_open' }, contractEvent });
  assert.ok(audit.includes('远期事件契约'), '审校与写作必须同源拿到同一契约');
  assert.ok(audit.includes('1259'));

  const repair = (await import('../server/engine/prompts.js')).openingCandidateLengthRepairInstruction({
    strategy, content: '超限正文', contractEvent, budget: { preferred: [200, 700], hardMax: 1000 },
  });
  assert.ok(repair.includes('远期事件契约'), '压缩时不得丢锚定信号');
});

test('V0.98.2 前置层无目标事件信号 → high 问题禁止采用（本作事故回归）', async () => {
  const { composeOpeningCandidates, selectOpeningAsset } = await import('../server/engine/opening_intervention.js');
  const source = store.scenes.get(firstScene.id).content;
  const nightSceneRewrite = `后半夜的风从东南边吹过来，带着铁锈和灰烬的气味。${'他扒住墙头往外探，那点暗红一动不动。'.repeat(20)}\n\n一切都要从那个庙会的秋天说起。`;
  const candidates = [
 { ...planFields({ kind: 'head_rewrite', family: 'chronological_choice', signature: '1241|主角|护弟|警觉', content: '主角先把弟弟拉到身后。' }),
      anchor_scene_id: firstScene.id, anchor_start: 0, anchor_end: source.length,
      source_excerpt: source, source_hash: sha256(source) },
    { ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content: nightSceneRewrite }),
      contract: validContract(volume.id) },
  ];
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } });
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.ok(audit.issues.some(item => item.code === 'cold_open_target_ungrounded' && item.severity === 'high'),
    '第一章夜戏重写没有任何 1259 事件信号，必须本地判废');
  assert.throws(() => selectOpeningAsset(book.id, cold.asset_id), error => error?.code === 'OPENING_AUDIT_BLOCKED');
});

test('V0.98.2 前置层复用第一章正文（章内重排冒充未来楔子）→ high 问题禁止采用', async () => {
  const { composeOpeningCandidates, selectOpeningAsset } = await import('../server/engine/opening_intervention.js');
 const chapterText = '天边压着一线暗红。主角把弟弟往上颠了颠。庙会的锣声隔着田埂传过来，糖油味混着香火味。母亲在灶房里喊他们回家吃饭，父亲蹲在门槛上磨那把短猎刀。';
  store.scenes.update(firstScene.id, { content: chapterText.repeat(4) });
  const echo = `1259年，钓鱼城头。${chapterText.repeat(6)}\n\n十八年前，淳祐元年的庙会锣声正响。`;
  const candidates = [{
    ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content: echo }),
    contract: validContract(volume.id),
  }];
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } });
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.ok(audit.issues.some(item => item.code === 'cold_open_reuses_chapter1' && item.severity === 'high'),
    '与第一章正文高度同质必须判废：这是章内优化，不是楔子');
  assert.throws(() => selectOpeningAsset(book.id, cold.asset_id), error => error?.code === 'OPENING_AUDIT_BLOCKED');
});

test('V0.98.2 无契约目标且开篇健康 → 零模型调用早退，不生成无锚候选', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  const { buildStoryPromiseProfile } = await import('../server/engine/story_promise.js');
  const plainBook = store.books.create({ title: '无锚书', genre: '都市', platform: '番茄', blurb: '普通故事' });
  const plainVolume = store.volumes.create(plainBook.id, 1, { title: '第一卷' });
  const plainChapter = store.chapters.create(plainBook.id, plainVolume.id, 1, { title: '一', status: 'done' });
  store.scenes.create(plainChapter.id, 1, { content: '普通正文，没有远期事件锚点。', status: 'done' });
  await buildStoryPromiseProfile(plainBook.id, { data: promiseData });

  const { composeOpeningCandidates } = await import('../server/engine/opening_intervention.js');
  const events = [];
  const result = await composeOpeningCandidates(plainBook.id, { mode: 'repair', onEvent: event => events.push(event) });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_grounded_contract_target');
  assert.equal(result.candidates.length, 1, '只有原稿基线');
  assert.equal(result.candidates[0].kind, 'baseline');
  assert.equal(store.openingAssets.list(plainBook.id).length, 0, '不得落任何无锚候选');
  assert.ok(events.every(event => event.step !== 'drafting'), '没有可写候选时不得进入写作阶段');
});

test('V0.98.2 存量修复允许「原稿 + 单楔子」精简批次，仍拒绝同族重复', async () => {
  const { composeOpeningCandidates } = await import('../server/engine/opening_intervention.js');
  const single = [{
    ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望',
 content: `开庆元年，钓鱼城头的炮石砸进城下军阵。${'主角先按住身边人的肩，望向尚未回答的危局。'.repeat(12)}\n\n十八年前，淳祐元年的庙会锣声正响。` }),
    contract: validContract(volume.id),
  }];
  const result = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: single } });
  assert.equal(result.candidates.length, 2, '原稿 + 单楔子即构成有效比较批次');
  const audit = JSON.parse(store.openingAssets.get(result.candidates.find(item => item.kind === 'chapter1_cold_open').asset_id).audit_json);
  assert.equal(audit.issues.some(item => item.severity === 'high'), false, '锚定+回切齐全的楔子干净通过');

  const duplicated = [
    single[0],
    { ...single[0], entry_signature: '1259|另一个签名|但同族|重复' },
  ];
  await assert.rejects(
    composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: duplicated } }),
    error => error?.code === 'OPENING_CANDIDATE_DIVERSITY',
  );
});
