import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import {
  createOpeningFixture, coldOpenCandidate, prologueCandidate, validContract, validDiagnosis, sha256,
} from './helpers/opening_fixture.js';

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

test('V0.98 opening asset 状态机与 active reader layer 唯一', () => {
  const a = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  assert.equal(a.status, 'candidate');
  assert.throws(() => store.openingAssets.transition(a.id, 'applied'), /非法状态转换/);
  store.openingAssets.transition(a.id, 'audited');
  store.openingAssets.transition(a.id, 'selected');
  assert.equal(store.openingAssets.active(book.id).id, a.id);

  const b = store.openingAssets.create(book.id, prologueCandidate(volume.id));
  store.openingAssets.transition(b.id, 'audited');
  assert.throws(() => store.openingAssets.transition(b.id, 'selected'), /已有启用的读者前置层/);
  assert.equal(store.openingAssets.get(b.id).status, 'audited', '冲突失败不得半写状态');
});

test('V0.98 opening asset 更新使用字段白名单并在 store 边界统一 JSON', () => {
  const asset = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  const updated = store.openingAssets.update(asset.id, {
    title: '新标题', content: '新候选正文',
    contract: { promise_key: 'opening:test' },
    audit: [{ severity: 'low', reason: '可读' }],
    rank: { stable: false }, creativeHypothesis: '从人物选择切入',
  });
  assert.equal(updated.title, '新标题');
  assert.deepEqual(JSON.parse(updated.contract_json), { promise_key: 'opening:test' });
  assert.deepEqual(JSON.parse(updated.audit_json), [{ severity: 'low', reason: '可读' }]);
  assert.deepEqual(JSON.parse(updated.rank_json), { stable: false });
  assert.equal(updated.creative_hypothesis, '从人物选择切入');
  assert.throws(() => store.openingAssets.update(asset.id, { book_id: '别的书' }), /不允许更新字段/);
  assert.equal(store.openingAssets.get(asset.id).book_id, book.id);
});

test('V0.98.12 opening asset 删除权限：未应用可删、applied 禁删、作品删除不留孤儿', () => {
  // V0.98.12 用户需求：过往生成的旧方案可清理——audited/selected/candidate/rejected/retired 都可删
  const candidate = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  store.openingAssets.transition(candidate.id, 'audited');
  assert.equal(store.openingAssets.remove(candidate.id).changes, 1, 'V0.98.12：audited（未应用）旧方案必须可删除');
  const protectedAsset = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  store.openingAssets.transition(protectedAsset.id, 'audited');
  store.openingAssets.transition(protectedAsset.id, 'selected');
  store.openingAssets.transition(protectedAsset.id, 'applied');
  assert.equal(store.openingAssets.remove(protectedAsset.id).changes, 0, 'applied 资产仍禁止直接删除（防发布视图丢失）');
  const retired = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  store.openingAssets.transition(retired.id, 'retired');
  assert.equal(store.openingAssets.remove(retired.id).changes, 1);
  const remaining = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  store.books.remove(book.id);
  assert.equal(store.openingAssets.get(remaining.id), undefined);
});

test('V0.98 快照恢复 opening assets；老快照缺段时保留后来创建的资产', () => {
  const asset = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  store.openingAssets.update(asset.id, { title: '快照标题' });
  const snapshot = store.snapshotBook(book.id);
  assert.equal(snapshot.opening_assets.length, 1);
  store.openingAssets.update(asset.id, { title: '后来标题' });
  store.restoreSnapshot(book.id, snapshot);
  assert.equal(store.openingAssets.get(asset.id).title, '快照标题');

  const old = store.snapshotBook(book.id);
  delete old.opening_assets;
  const later = store.openingAssets.create(book.id, prologueCandidate(volume.id));
  assert.doesNotThrow(() => store.restoreSnapshot(book.id, old));
  assert.ok(store.openingAssets.get(later.id), '旧快照不能误删后来创建的资产');
});

test('V0.98 快照 opening_assets 校验枚举、归属和 active 唯一性并 fail closed', () => {
  const asset = store.openingAssets.create(book.id, coldOpenCandidate(volume.id));
  const valid = store.snapshotBook(book.id);
  const invalidStatus = structuredClone(valid);
  invalidStatus.opening_assets[0].status = 'mystery';
  assert.throws(() => store.restoreSnapshot(book.id, invalidStatus), error => error?.code === 'INVALID_SNAPSHOT');
  const wrongBook = structuredClone(valid);
  wrongBook.opening_assets[0].book_id = 'bk-other';
  assert.throws(() => store.restoreSnapshot(book.id, wrongBook), error => error?.code === 'INVALID_SNAPSHOT');
  const duplicateActive = structuredClone(valid);
  duplicateActive.opening_assets[0].status = 'selected';
  duplicateActive.opening_assets.push({
    ...duplicateActive.opening_assets[0], id: `${asset.id}-two`, kind: 'standalone_prologue', placement: 'before_chapter1',
  });
  assert.throws(() => store.restoreSnapshot(book.id, duplicateActive), error => error?.code === 'INVALID_SNAPSHOT');
  assert.equal(store.openingAssets.get(asset.id).status, 'candidate', '坏快照不得改动当前资产');
});

const planFields = ({ kind, family, signature, content = '' }) => ({
  kind, strategy_family: family, entry_signature: signature,
 creative_hypothesis: `${family} 能更早显出人物选择`, entry_time: '1241年', first_actor: '主角',
  immediate_problem: '北边出现反常迹象', first_choice: '先护住弟弟', first_state_change: '一家人开始警觉',
  strongest_axis: 'bond', transition_plan: '沿暗红天色自然接回庙会', content,
});

function repairCandidates() {
  const source = store.scenes.get(firstScene.id).content;
 const coldOpen = `开庆元年，钓鱼城头的风卷过残旗。${'主角先护住身后的人，再望向城下未解的危局。'.repeat(10)}\n\n十八年前，淳祐元年的庙会锣声正响。`;
  return [
    {
 ...planFields({ kind: 'head_rewrite', family: 'chronological_choice', signature: '1241|主角|护弟|警觉', content: '主角先把弟弟拉到身后。' }),
      anchor_scene_id: firstScene.id, anchor_start: 0, anchor_end: source.length,
      source_excerpt: source, source_hash: sha256(source),
    },
    {
      ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content: coldOpen }),
      contract: validContract(volume.id),
    },
  ];
}

test('V0.98 候选软预算允许合理偏离，一个强吸引轴不被平均分淘汰', async () => {
  const { candidateBudget, validateCandidateLength, coldReadJudgment, candidateCanWin } = await import('../server/engine/planning/opening_intervention.js');
  assert.deepEqual(candidateBudget('chapter1_cold_open'), { preferred: [300, 800], hardMax: 1000, soft: true });
  assert.equal(validateCandidateLength('chapter1_cold_open', '字'.repeat(850)).severity, 'note');
  assert.equal(validateCandidateLength('chapter1_cold_open', '字'.repeat(1001)).severity, 'error');
  const judgment = coldReadJudgment({ strongest_axis: { kind: 'bond', strength: 4 },
    scores: { causal_motion: 2, novelty: 2 }, hard_failures: [] });
  assert.equal(candidateCanWin(judgment), true);
});

test('V0.98 编排器生成进入逻辑不同的存量候选，并自动把原稿纳入比较', async () => {
  const { composeOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const events = [];
  const result = await composeOpeningCandidates(book.id, {
    mode: 'repair', data: { candidates: repairCandidates() }, onEvent: event => events.push(event),
  });
  assert.ok(result.candidates.some(item => item.kind === 'baseline'));
  assert.ok(result.candidates.some(item => item.kind === 'chapter1_cold_open'));
  assert.equal(new Set(result.candidates.map(item => item.entry_signature)).size, result.candidates.length);
  assert.ok(result.candidates.every(item => item.creative_hypothesis));
  assert.equal(store.openingAssets.list(book.id).length, 2, '原稿不重复落 opening_assets，两个补丁候选应落库');
  assert.deepEqual(events.filter(event => event.step === 'auditing').map(event => event.detail), [
    '审校候选 1/2：chronological_choice',
    '审校候选 2/2：future_result_present_question',
  ]);
});

test('V0.98 有稳定卷事件键时自动校正读者契约，未落地契约禁止选择', async () => {
  const { composeOpeningCandidates, selectOpeningAsset } = await import('../server/engine/planning/opening_intervention.js');
  const candidates = repairCandidates();
  candidates[1].contract = {};
  const result = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } });
  const cold = result.candidates.find(item => item.kind === 'chapter1_cold_open');
  const contract = JSON.parse(store.openingAssets.get(cold.asset_id).contract_json);
  assert.equal(contract.target_volume_id, volume.id);
  assert.equal(contract.target_year, 1259);
  assert.equal(contract.target_event_key, 'historical:1259:diaoyucheng-mongke-death');

  const invalid = store.openingAssets.create(book.id, coldOpenCandidate(volume.id, { contract_json: '{}' }));
  store.openingAssets.transition(invalid.id, 'audited');
  assert.throws(() => selectOpeningAsset(book.id, invalid.id), error => error?.code === 'OPENING_CONTRACT_INVALID');
});

test('V0.98 契约目标由通用史实语义锚推导，不依赖具体书名', async () => {
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const { inferOpeningContractTarget } = await import('../server/engine/planning/opening_intervention.js');
  const otherBook = store.books.create({
    title: '蜀地守城录', genre: '历史', platform: '番茄', blurb: '一个孩子最终走上山城。',
  });
  store.volumes.create(otherBook.id, 1, {
    title: '故园卷', outline: { year: 1241, event_keys: ['story:1241:hometown-fall'] },
  });
  const futureVolume = store.volumes.create(otherBook.id, 5, {
    title: '山城卷',
    outline: { start_year: 1259, end_year: 1260, historical_anchor: '1259年钓鱼城之战与蒙哥之死' },
  });
  await buildStoryPromiseProfile(otherBook.id, { data: promiseData });

  const target = inferOpeningContractTarget(otherBook.id);
  assert.equal(target.target_volume_id, futureVolume.id, '后期主承诺不得被第一卷局部事件抢走');
  assert.equal(target.target_year, 1259);
  assert.equal(target.target_event_key, 'historical:1259:diaoyucheng-mongke-death');
});

test('V0.98 契约推导跳过只提前引用事件的卷，继续寻找事件真实发生卷', async () => {
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const { inferOpeningContractTarget } = await import('../server/engine/planning/opening_intervention.js');
  const anchoredBook = store.books.create({
    title: '山城年代记', genre: '历史', platform: '番茄', blurb: '先预告未来事件，数卷后才真正发生。',
  });
  store.volumes.create(anchoredBook.id, 1, { title: '故园', outline: { year: 1241 } });
  const foreshadowVolume = store.volumes.create(anchoredBook.id, 4, {
    title: '风雨将至', outline: { title: '风雨将至' },
  });
  store.chapters.create(anchoredBook.id, foreshadowVolume.id, 18, {
    title: '遥望城头',
    outline: { year: 1256, event_keys: ['historical:1259:diaoyucheng-mongke-death'] },
  });
  const occurrenceVolume = store.volumes.create(anchoredBook.id, 5, {
    title: '城头决战',
    outline: { start_year: 1259, end_year: 1260, historical_anchor: '1259年钓鱼城之战与蒙哥之死' },
  });
  await buildStoryPromiseProfile(anchoredBook.id, { data: promiseData });

  const target = inferOpeningContractTarget(anchoredBook.id);
  assert.equal(target.target_volume_id, occurrenceVolume.id);
  assert.equal(target.target_year, 1259);
  assert.equal(target.target_event_key, 'historical:1259:diaoyucheng-mongke-death');
});

test('V0.98 事件键与其真实年份成对推导，不把卷起始年误绑为兑现年', async () => {
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const { inferOpeningContractTarget } = await import('../server/engine/planning/opening_intervention.js');
  const rangeBook = store.books.create({ title: '跨年卷测试', genre: '历史', platform: '番茄', blurb: '跨年事件。' });
  store.volumes.create(rangeBook.id, 1, { title: '开篇', outline: { year: 1241 } });
  const rangeVolume = store.volumes.create(rangeBook.id, 2, {
    title: '多年卷', outline: { start_year: 1254, end_year: 1260 },
  });
  store.chapters.create(rangeBook.id, rangeVolume.id, 20, {
    title: '城头', outline: { year: 1259, event_keys: ['historical:1259:diaoyucheng-mongke-death'] },
  });
  await buildStoryPromiseProfile(rangeBook.id, { data: promiseData });

  const target = inferOpeningContractTarget(rangeBook.id);
  assert.equal(target.target_year, 1259);
  assert.equal(target.target_volume_id, rangeVolume.id);
});

test('V0.98 未来冷开场未在正文中定位回第一章时不得胜选或应用', async () => {
  const {
    composeOpeningCandidates, compareOpeningCandidates,
    selectOpeningAsset, applySelectedOpeningAsset,
  } = await import('../server/engine/planning/opening_intervention.js');
  const candidates = repairCandidates();
 candidates[1].content = `开庆元年，主角想起1241年早已远去。${'他按住身边人的肩，望向城下。'.repeat(14)}`;
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } });
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const stored = store.openingAssets.get(cold.asset_id);
  const audit = JSON.parse(stored.audit_json);
  assert.ok(audit.issues.some(item => item.code === 'cold_open_return_unlocated' && item.severity === 'high'));

  const rounds = [1, 2].map(() => ({
    winner_id: cold.candidate_id, reason: '表面上疑问最强',
    judgments: Object.fromEntries(composed.candidates.map(item => [item.candidate_id, {
      strongest_axis: { kind: 'question', strength: 4 }, hard_failures: [], issues: [],
    }])),
  }));
  const compared = await compareOpeningCandidates(book.id,
    composed.candidates.filter(item => item.asset_id).map(item => item.asset_id), { data: rounds });
  assert.equal(compared.status, 'no_stable_winner');
  assert.throws(() => selectOpeningAsset(book.id, cold.asset_id), error => error?.code === 'OPENING_AUDIT_BLOCKED');

  // 兼容旧库：即使历史版本已经把问题资产标成 selected，落盘前也必须再次 fail closed。
  store.openingAssets.transition(cold.asset_id, 'selected');
  const rejected = applySelectedOpeningAsset(book.id, cold.asset_id);
  assert.equal(rejected.code, 'OPENING_AUDIT_BLOCKED');
  assert.equal(store.openingAssets.get(cold.asset_id).status, 'selected');
});

test('V0.98.2 mock 存量修复：确定性蓝图只生成远期楔子，健康开篇不做章内重写', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  const { composeOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const events = [];
  const result = await composeOpeningCandidates(book.id, { mode: 'repair', onEvent: event => events.push(event) });
  assert.equal(result.candidates.length, 2, '原稿 + 一个远期高能楔子');
  assert.ok(result.candidates.some(item => item.kind === 'baseline'));
  const cold = result.candidates.find(item => item.kind === 'chapter1_cold_open');
  assert.ok(cold, '有契约目标时远期楔子是默认核心策略');
  assert.equal(result.candidates.some(item => item.kind === 'head_rewrite'), false, '健康开篇不得生成顺叙强化');
  assert.ok(events.some(event => event.step === 'planning' && event.detail.includes('确定性蓝图')));
  assert.ok(cold.content.includes('1259'), 'mock 候选必须锚定目标年份');
  assert.ok(JSON.parse(store.openingAssets.get(cold.asset_id).audit_json).issues
    .every(issue => issue.severity !== 'high'), '锚定+回切齐全的楔子不带 high 问题');
  assert.ok(store.openingAssets.list(book.id).every(item => item.status === 'audited'));
});

test('V0.98 模型候选超过硬上限时自动收敛，不能整批报错并丢弃其他方案', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  const settings = store.books.settings(book.id);
  settings.openingIntervention = {
    ...(settings.openingIntervention || {}),
    candidateBudgets: {
      head_rewrite: { preferred: [60, 80], hardMax: 100, soft: true },
    },
  };
  store.books.update(book.id, { settings });
  const { composeOpeningCandidates, validateCandidateLength } = await import('../server/engine/planning/opening_intervention.js');
  const events = [];
  const headPlan = {
    kind: 'head_rewrite', strategy_family: 'chronological_choice',
    entry_signature: 'present|hero|choice|change', creative_hypothesis: '弱开篇顺叙救济',
    entry_time: '第一章原时空', first_actor: '主角', immediate_problem: '眼前反常',
    first_choice: '先护住身边人', first_state_change: '人物开始主动应对', strongest_axis: 'character',
    transition_plan: '接回第二场景',
  };

  const result = await composeOpeningCandidates(book.id, {
    mode: 'repair', strategyPlans: [headPlan], onEvent: event => events.push(event),
  });
  const head = result.candidates.find(item => item.kind === 'head_rewrite');
  assert.ok(head, '超限顺叙强化应完成收敛并留在比较批次中');
  assert.equal(validateCandidateLength('head_rewrite', head.content,
    settings.openingIntervention.candidateBudgets).ok, true);
  assert.ok(events.some(event => event.step === 'conforming_length'), '超限后应向界面报告长度收敛阶段');
  const stored = store.openingAssets.get(head.asset_id);
  const rank = JSON.parse(stored.rank_json);
  assert.equal(rank.length_recovery?.method, 'local_boundary_guard', '模型两轮仍失控时必须有确定性安全闸');
  const audit = JSON.parse(stored.audit_json);
  assert.ok(audit.issues.some(issue => issue.code === 'opening_length_local_fallback' && issue.severity === 'high'),
    '确定性裁剪只保证流程安全，未经人工或模型重写不得自动采用');
});

test('V0.98 无效契约目标在调用模型前失败，不能先花费生成候选再报确定性错误', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  const { composeOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const settings = store.books.settings(book.id);
  settings.openingIntervention = {
    contractTarget: {
      promise_key: 'opening:invalid-target', target_event_key: 'historical:1259:diaoyucheng-mongke-death',
      target_year: 1258, target_volume_id: volume.id,
    },
  };
  store.books.update(book.id, { settings });
  const events = [];

  await assert.rejects(
    composeOpeningCandidates(book.id, { mode: 'repair', onEvent: event => events.push(event) }),
    error => error?.code === 'OPENING_CONTRACT_TARGET_INVALID',
  );
  assert.deepEqual(events, [], '本地契约校验必须先于 planning/drafting 等模型阶段');
});

test('V0.98 重复 entry_signature fail closed，不把同义改写五连落库', async () => {
  const { composeOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const candidates = repairCandidates();
  candidates[1].entry_signature = candidates[0].entry_signature;
  await assert.rejects(
    composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } }),
    error => error?.code === 'OPENING_CANDIDATE_DUPLICATE',
  );
  assert.equal(store.openingAssets.list(book.id).length, 0, '整批验证完成前不得部分落库');
});

test('V0.98 同一策略族只改签名仍不算结构多样，候选硬伤必须有可核对引文', async () => {
  const { composeOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const sameFamily = repairCandidates();
  sameFamily[1].strategy_family = sameFamily[0].strategy_family;
  await assert.rejects(
    composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: sameFamily } }),
    error => error?.code === 'OPENING_CANDIDATE_DIVERSITY',
  );
  const badAudit = repairCandidates();
  badAudit[0].audit = {
    hard_failures: [{ code: 'invented', quote: '候选里不存在的句子', reason: '事实发明' }],
    issues: [], strongest_axis: { kind: 'character', strength: 3 },
  };
  // V0.98.10 治理与诊断同源：不可定位引文的硬伤意见被隔离（isolated_issues）而非报废整份审校；
  // 隔离的硬伤不再作为可采信证据参与阻断——但其记录保留在 audit 里供作者查看。
  const isolatedRun = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: badAudit } });
  const isolatedHead = isolatedRun.candidates.find(item => item.kind === 'head_rewrite');
  const isolatedAudit = JSON.parse(store.openingAssets.get(isolatedHead.asset_id).audit_json);
  assert.equal(isolatedAudit.hard_failures.length, 0, '幻觉引文硬伤不得作为可采信硬伤保留');
  assert.equal(isolatedAudit.isolated_issues.length, 1, '隔离记录保留可观测');
});

test('V0.98 新书在第一章落笔前至少得到三种进入逻辑，临时候选不污染 asset 表', async () => {
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const { composeOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const newBook = store.books.create({ title: '新书', genre: '历史', platform: '番茄', blurb: '新书简介' });
  await buildStoryPromiseProfile(newBook.id, { data: promiseData });
  const candidates = [
    planFields({ kind: 'chapter1_draft', family: 'chronological_choice', signature: 'now|hero|choice|change', content: '顺叙正文' }),
    planFields({ kind: 'chapter1_draft', family: 'in_medias_res', signature: 'danger|hero|escape|change', content: '困局正文' }),
    planFields({ kind: 'chapter1_draft', family: 'relationship_choice', signature: 'home|family|protect|change', content: '关系正文' }),
  ];
  const result = await composeOpeningCandidates(newBook.id, { mode: 'create', data: { candidates } });
  assert.ok(result.candidates.length >= 3);
  assert.equal(result.candidates.some(item => item.kind === 'baseline'), false);
  assert.ok(new Set(result.candidates.map(item => item.strategy_family)).size >= 3);
  assert.equal(store.openingAssets.list(newBook.id).length, 0);
});

test('V0.98 独立楔子默认不进入策略；兼容性未实测时即使请求也拒绝', async () => {
  const {
    planOpeningStrategies, composeOpeningCandidates, platformFrontMatterCompatibility,
  } = await import('../server/engine/planning/opening_intervention.js');
  assert.equal(platformFrontMatterCompatibility({ frontMatter: 'verified' }).verified, false,
    '只写一个 verified 字符串不能冒充真实平台实测');
  const verified = {
    frontMatter: 'verified', checkedAt: Date.now(), checks: {
      authorEditorAccepted: true, reviewPassed: true, readerDirectoryOrderCorrect: true,
      previousNextNavigationCorrect: true, chapterDataAttributionVisible: true,
      reorderAfterPublishTested: true,
    },
  };
  assert.equal(platformFrontMatterCompatibility(verified).verified, true);
  assert.equal(planOpeningStrategies(promiseData, null, { hasPublishedText: true }).some(item => item.kind === 'standalone_prologue'), false);
  assert.equal(planOpeningStrategies(promiseData, {
    recommendation: { kind: 'standalone_prologue' }, strategies: [],
  }, {
    hasPublishedText: true, allowStandalonePrologue: true, platformCompatibility: verified,
  }).some(item => item.kind === 'standalone_prologue'), true);
  const prologue = {
    ...planFields({ kind: 'standalone_prologue', family: 'future_scene', signature: 'future|army|question|cut', content: '楔子正文'.repeat(100) }),
    contract: validContract(volume.id),
  };
  await assert.rejects(
    composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: [...repairCandidates(), prologue] }, allowStandalonePrologue: true }),
    error => error?.code === 'OPENING_FRONT_MATTER_UNVERIFIED',
  );
});

test('V0.98 匿名比较：同模型只能 advisory；不同裁判且两轮同胜者才允许 auto_safe', async () => {
  const { composeOpeningCandidates, compareOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: repairCandidates() } });
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const assetIds = composed.candidates.filter(item => item.asset_id).map(item => item.asset_id);
  const rounds = [1, 2].map(() => ({
    winner_id: cold.candidate_id, reason: '亲情轴与长期疑问同时清楚',
    judgments: Object.fromEntries(composed.candidates.map(item => [item.candidate_id, {
      strongest_axis: { kind: item.kind === 'chapter1_cold_open' ? 'bond' : 'causal', strength: item.kind === 'chapter1_cold_open' ? 4 : 3 },
      hard_failures: [], attention_drop: [], artificial_or_ai_feel: [],
    }])),
  }));
  const events = [];
  const advisory = await compareOpeningCandidates(book.id, assetIds, {
    data: rounds, onEvent: event => events.push(event),
  });
  assert.equal(advisory.status, 'single_model_advisory');
  assert.equal(advisory.auto_safe, false);
  assert.deepEqual(events.filter(event => event.step === 'comparing').map(event => event.detail), [
    '匿名比较第 1/2 轮', '匿名比较第 2/2 轮',
  ]);

  const settings = store.books.settings(book.id);
  settings.openingIntervention = { judgeModel: 'independent-opening-judge' };
  store.books.update(book.id, { settings });
  const stable = await compareOpeningCandidates(book.id, assetIds, { data: rounds });
  assert.equal(stable.status, 'stable_winner');
  assert.equal(stable.winner.candidate_id, cold.candidate_id);
  assert.equal(stable.auto_safe, true);
});

test('V0.98 两轮胜者不一致时保留原稿，不用平均分强行选稿', async () => {
  const { composeOpeningCandidates, compareOpeningCandidates } = await import('../server/engine/planning/opening_intervention.js');
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: repairCandidates() } });
  const assetIds = composed.candidates.filter(item => item.asset_id).map(item => item.asset_id);
  const ids = composed.candidates.map(item => item.candidate_id);
  const makeRound = winner_id => ({ winner_id, reason: '各有明显强轴', judgments: Object.fromEntries(ids.map(id => [id, {
    strongest_axis: { kind: 'bond', strength: 4 }, hard_failures: [],
  }])) });
  const result = await compareOpeningCandidates(book.id, assetIds, { data: [makeRound(ids[0]), makeRound(ids[1])] });
  assert.equal(result.status, 'no_stable_winner');
  assert.equal(result.auto_safe, false);
  assert.equal(store.openingAssets.active(book.id), undefined);
});

test('V0.98 场景片段应用必须同时命中源哈希和原文范围', async () => {
  const { applyValidatedScenePatch } = await import('../server/engine/quality/polish.js');
  const before = store.scenes.get(firstScene.id).content;
  const patch = {
    sceneId: firstScene.id, start: 0, end: 8, expected: before.slice(0, 8),
    sourceHash: sha256(before), replacement: '新的八字开头',
  };
  const applied = applyValidatedScenePatch(book.id, patch);
  assert.equal(applied.ok, true, applied.message);
  assert.equal(applyValidatedScenePatch(book.id, patch).code, 'OPENING_PATCH_STALE');
});

test('V0.98 错字符范围 fail closed，正文逐字保持不变', async () => {
  const { applyValidatedScenePatch } = await import('../server/engine/quality/polish.js');
  const before = store.scenes.get(firstScene.id).content;
  const result = applyValidatedScenePatch(book.id, {
    sceneId: firstScene.id, start: 0, end: 8, expected: '并非这里',
    sourceHash: sha256(before), replacement: '不应落库',
  });
  assert.equal(result.code, 'OPENING_PATCH_ANCHOR_MISMATCH');
  assert.equal(store.scenes.get(firstScene.id).content, before);
});

test('V0.98 应用顺叙资产先快照并原子转 applied；源场景变化时整批拒绝', async () => {
  const { composeOpeningCandidates, applySelectedOpeningAsset } = await import('../server/engine/planning/opening_intervention.js');
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: repairCandidates() } });
  const head = composed.candidates.find(item => item.kind === 'head_rewrite');
  store.openingAssets.transition(head.asset_id, 'selected');
  const before = store.scenes.get(firstScene.id).content;
  const result = applySelectedOpeningAsset(book.id, head.asset_id);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.requiresStateRebuild, true, '改写第一章正文后必须先重建同版派生状态');
  assert.equal(store.openingAssets.get(head.asset_id).status, 'applied');
  assert.notEqual(store.scenes.get(firstScene.id).content, before);
  assert.ok(store.snapshots.listAll(book.id).some(item => item.source === 'opening-intervention'));

  const secondBook = store.books.create({ title: '陈旧补丁书', genre: '历史', platform: '番茄', blurb: 'x' });
  const secondVolume = store.volumes.create(secondBook.id, 1, { title: '第一卷' });
  const secondChapter = store.chapters.create(secondBook.id, secondVolume.id, 1, { title: '一', status: 'done' });
  const secondScene = store.scenes.create(secondChapter.id, 1, { content: '原始场景正文足够长，可以安全验证精确范围。', status: 'done' });
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  await buildStoryPromiseProfile(secondBook.id, { data: promiseData });
  const raw = [
    { ...planFields({ kind: 'head_rewrite', family: 'chronological_choice', signature: 'a|b|c|d', content: '新的顺叙正文足够长，可以安全验证。' }),
      anchor_scene_id: secondScene.id, anchor_start: 0, anchor_end: secondScene.content.length,
      source_excerpt: secondScene.content, source_hash: sha256(secondScene.content) },
    { ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: 'e|f|g|h', content: '字'.repeat(300) }), contract: validContract(secondVolume.id) },
  ];
  const second = await composeOpeningCandidates(secondBook.id, { mode: 'repair', data: { candidates: raw } });
  const stale = second.candidates.find(item => item.kind === 'head_rewrite');
  store.openingAssets.transition(stale.asset_id, 'selected');
  store.scenes.update(secondScene.id, { content: '外部已经改过的场景正文。' });
  const rejected = applySelectedOpeningAsset(secondBook.id, stale.asset_id);
  assert.equal(rejected.code, 'OPENING_PATCH_STALE');
  assert.equal(store.openingAssets.get(stale.asset_id).status, 'selected');
  assert.equal(store.scenes.get(secondScene.id).content, '外部已经改过的场景正文。');
});

test('V0.98 内嵌楔子应用只激活读者层，不写入第一章场景', async () => {
  const { composeOpeningCandidates, applySelectedOpeningAsset, composeOpeningAsset } = await import('../server/engine/planning/opening_intervention.js');
  const composed = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: repairCandidates() } });
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  store.openingAssets.transition(cold.asset_id, 'selected');
  const before = store.chapters.fullText(firstScene.chapter_id);
  const result = applySelectedOpeningAsset(book.id, cold.asset_id);
  assert.equal(result.ok, true);
  assert.equal(store.chapters.fullText(firstScene.chapter_id), before, '前置正文不得落进场景');
  const active = store.openingAssets.active(book.id);
  assert.equal(active.status, 'applied');
  const reader = composeOpeningAsset(active, before);
  assert.match(reader.firstChapterText, new RegExp(`^${active.content.slice(0, 20)}`));
  assert.match(reader.firstChapterText, /天边压着一线暗红/);
});

function activateColdOpen({ content, contract = validContract(volume.id) } = {}) {
  const asset = store.openingAssets.create(book.id, coldOpenCandidate(volume.id, {
    content: content || '城下风声骤紧。', contract_json: JSON.stringify(contract),
  }));
  store.openingAssets.transition(asset.id, 'audited');
  store.openingAssets.transition(asset.id, 'selected');
  store.openingAssets.transition(asset.id, 'applied');
  return store.openingAssets.get(asset.id);
}

test('V0.98 前置正文完全隔离，三个写审提示只得到同一份结构化读者契约', async () => {
  const secretSentence = '九斿白旗在城下一寸寸折断，而且城头没有一个人回望';
  activateColdOpen({ content: secretSentence });
  store.chapters.create(book.id, volume.id, 2, {
    title: '军报', status: 'planned', outline: { year: 1242, event_keys: [] },
  });

  const { openingReaderContractText } = await import('../server/engine/planning/opening_intervention.js');
  const { chapterOutlineInstruction, writeSceneInstruction, auditInstruction } = await import('../server/engine/prompts.js');
  const contractText = openingReaderContractText(book.id, 2);
  const messages = [
    chapterOutlineInstruction({ bookTitle: book.title, chapterIdx: 2, openingContractText: contractText }),
    writeSceneInstruction({
      bookTitle: book.title, chapterIdx: 2, chapterTitle: '军报',
 scene: { id: 's1', pov: '主角', location: '家中', beat: '听见军报', target_words: 900 },
      scenesBefore: [], sceneAfter: null, openingContractText: contractText,
    }),
    auditInstruction({
 bookTitle: book.title, chapterTitle: '军报', chapterText: '主角听见了军报。',
      openingContractText: contractText,
    }),
  ];
  const joined = JSON.stringify(messages);
  assert.equal(joined.includes(secretSentence), false);
  assert.equal(joined.includes(secretSentence.slice(0, 20)), false);
  assert.match(joined, /读者已知/);
  assert.match(joined, /不得让人物预知/);
  assert.match(joined, /historical:1259:diaoyucheng-mongke-death/);
  assert.match(joined, /不得复写前置正文/);
  assert.equal(store.history.list(book.id).some(row => row.content.includes(secretSentence.slice(0, 20))), false);
  assert.equal(store.facts.list(book.id).some(row => JSON.stringify(row).includes(secretSentence.slice(0, 20))), false);
  assert.equal(store.timeline.list(book.id).some(row => JSON.stringify(row).includes(secretSentence.slice(0, 20))), false);
  assert.equal(store.rollingSummaries.get(book.id).includes(secretSentence.slice(0, 20)), false);
  assert.equal(store.vectors.list(book.id).some(row => row.chunk.includes(secretSentence.slice(0, 20))), false);
});

test('V0.98 读者契约只在真实目标卷年份和事件键同时命中且审校通过后兑现', async () => {
  const contract = validContract(volume.id);
  const asset = activateColdOpen({ content: '未来城头的一段秘密正文，不得进入故事记忆。', contract });
  store.volumes.update(volume.id, {
    outline: { year: 1259, event_keys: [contract.target_event_key] },
  });
  const target = store.chapters.create(book.id, volume.id, 18, {
    title: '城头', status: 'done',
    outline: { year: 1259, event_keys: [contract.target_event_key] },
  });
  const wrongYear = store.chapters.create(book.id, volume.id, 17, {
    title: '城前', status: 'done',
    outline: { year: 1258, event_keys: [contract.target_event_key] },
  });

  const { fulfillOpeningReaderContract } = await import('../server/engine/planning/opening_intervention.js');
  assert.equal(fulfillOpeningReaderContract(book.id, wrongYear.id, { auditPassed: true }).fulfilled, false);
  assert.equal(fulfillOpeningReaderContract(book.id, target.id, { auditPassed: false }).fulfilled, false);
  const fulfilled = fulfillOpeningReaderContract(book.id, target.id, { auditPassed: true });
  assert.equal(fulfilled.fulfilled, true);
  assert.equal(fulfilled.chapterIdx, 18);
  const saved = JSON.parse(store.openingAssets.get(asset.id).contract_json);
  assert.equal(saved.status, 'fulfilled');
  assert.equal(saved.fulfilled_chapter, 18);
  assert.equal(saved.promise_key, contract.promise_key);
  const repeated = fulfillOpeningReaderContract(book.id, target.id, { auditPassed: true });
  assert.equal(repeated.idempotent, true);
  assert.equal(store.foreshadows.list(book.id).some(row => Number(row.planted_chapter) === 0), false);
});

test('V0.98 新书跨模型稳定胜者成为真实第一章草稿，仍留给正常审校结算', async () => {
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const {
    composeOpeningCandidates, compareDraftOpeningCandidates, applyNewBookOpeningCandidate,
  } = await import('../server/engine/planning/opening_intervention.js');
  const newBook = store.books.create({ title: '待写新书', genre: '历史', platform: '番茄', blurb: '孩子守住故乡' });
  const newVolume = store.volumes.create(newBook.id, 1, { title: '第一卷' });
  const newChapter = store.chapters.create(newBook.id, newVolume.id, 1, { title: '风起', status: 'planned' });
  await buildStoryPromiseProfile(newBook.id, { data: promiseData });
  const settings = store.books.settings(newBook.id);
  settings.openingIntervention = { judgeModel: 'independent-opening-judge' };
  store.books.update(newBook.id, { settings });
  const candidates = [
    planFields({ kind: 'chapter1_draft', family: 'chronological_choice', signature: 'now|hero|choice|change', content: '顺叙开篇正文。'.repeat(180) }),
    planFields({ kind: 'chapter1_draft', family: 'in_medias_res', signature: 'danger|hero|escape|change', content: '困局开篇正文。'.repeat(180) }),
    planFields({ kind: 'chapter1_draft', family: 'relationship_choice', signature: 'home|family|protect|change', content: '关系开篇正文。'.repeat(180) }),
  ];
  const composed = await composeOpeningCandidates(newBook.id, { mode: 'create', data: { candidates } });
  const winner = composed.candidates[1];
  const rounds = [1, 2].map(() => ({
    winner_id: winner.candidate_id, reason: '人物的保护选择最清楚',
    judgments: Object.fromEntries(composed.candidates.map(candidate => [candidate.candidate_id, {
      strongest_axis: { kind: candidate.candidate_id === winner.candidate_id ? 'bond' : 'situation', strength: candidate.candidate_id === winner.candidate_id ? 4 : 3 },
      hard_failures: [], issues: [],
    }])),
  }));
  const compared = await compareDraftOpeningCandidates(newBook.id, composed.candidates, { data: rounds });
  assert.equal(compared.status, 'stable_winner');
  assert.equal(compared.auto_safe, true);
  const applied = applyNewBookOpeningCandidate(newBook.id, compared.winner);
  assert.equal(applied.ok, true, applied.message);
  assert.equal(store.chapters.fullText(newChapter.id), winner.content);
  assert.equal(store.chapters.get(newChapter.id).status, 'drafted');
  assert.equal(store.openingAssets.list(newBook.id).length, 0, '正常第一章方案不应伪装成读者前置资产');
  assert.ok(store.snapshots.listAll(newBook.id).some(item => item.source === 'opening-intervention'));
});

test('V0.98 开篇检查点坏 JSON 显式 unreviewed 但不抛错、不阻断后续章', async () => {
  const { maybeReviewOpening } = await import('../server/engine/planning/opening_intervention.js');
  const events = [];
  const failed = await maybeReviewOpening(book.id, 1, { data: {}, onEvent: event => events.push(event) });
  assert.equal(failed.ok, false);
  assert.equal(failed.unreviewed, true);
  assert.ok(events.some(event => event.step === 'unreviewed'));
  assert.deepEqual(store.books.settings(book.id).openingIntervention?.reviewedCheckpoints || [], []);
  const passed = await maybeReviewOpening(book.id, 1, { data: validDiagnosis });
  assert.equal(passed.ok, true);
  assert.ok(store.books.settings(book.id).openingIntervention.reviewedCheckpoints.includes('chapter:1'));
});
