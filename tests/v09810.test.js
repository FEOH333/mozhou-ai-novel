// V0.98.10 审校证据治理与诊断同源：坏引文/缺根因的单条隔离，不废整份审校
// 实证（ox-alpha-free）：候选生成已通，审校模型的 high/medium 意见引文与候选正文存在
// 空白差异或缺失 → 逐字 includes 误判 → 整份 OPENING_CANDIDATE_AUDIT_INVALID。
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
  const { buildStoryPromiseProfile } = await import('../server/engine/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: promiseData });
});

const planFields = ({ kind, family, signature, content = '' }) => ({
  kind, strategy_family: family, entry_signature: signature,
 creative_hypothesis: `${family} 假设`, entry_time: '1241年', first_actor: '主角',
  immediate_problem: '北边反常', first_choice: '先护住弟弟', first_state_change: '一家人警觉',
  strongest_axis: 'question', transition_plan: '接回庙会', content,
});

test('V0.98.10 审校引文空白差异被本地重定位，意见保留', async () => {
  const { composeOpeningCandidates } = await import('../server/engine/opening_intervention.js');
 const content = '开庆元年七月，钓鱼城北崖，第二拨砲石已经压进膛口。\n\n主角拽开传令兵，自己探身去看江面。\n\n十八年前，淳祐元年的秋天，他九岁。';
  const candidates = [{
    ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content }),
    contract: validContract(volume.id),
    audit: {
      hard_failures: [],
      issues: [
        // 模型把两段之间的双换行写成了单空格——逐字必挂，重定位应救回
 { severity: 'medium', quote: '压进膛口。 主角拽开传令兵', cause: '节奏过密', smallest_fix: '拆成两拍' },
        // 引文完全不存在 → 隔离，不废整份
        { severity: 'high', quote: '候选里根本不存在的一句幻觉引文', cause: '幻觉', smallest_fix: '删' },
        // high 但缺根因/改法 → 隔离
 { severity: 'high', quote: '主角拽开传令兵', cause: '', smallest_fix: '' },
      ],
      strongest_axis: { kind: 'question', strength: 4 },
    },
  }];
  const result = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } });
  const cold = result.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.equal(audit.issues.length, 1, '重定位成功的意见保留');
 assert.equal(audit.issues[0].quote, '压进膛口。\n\n主角拽开传令兵', '引文映射回原文真实切片（含换行）');
  assert.equal(audit.isolated_issues.length, 2, '幻觉引文与缺根因意见被隔离而非废整份');
  assert.deepEqual(audit.isolated_issues.map(item => item.code), ['quote_unlocatable', 'quote_unlocatable']);
});

test('V0.98.10 hard_failure 引文不可定位同样隔离；无最强轴仍整份 fail-closed', async () => {
  const { composeOpeningCandidates } = await import('../server/engine/opening_intervention.js');
  const content = '开庆元年七月，钓鱼城北崖，砲石压进膛口。\n\n十八年前，淳祐元年。';
  const candidates = [{
    ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content }),
    contract: validContract(volume.id),
    audit: {
      hard_failures: [{ code: 'fact_error', quote: '不存在的引文', reason: '幻觉硬伤' }],
      issues: [],
      strongest_axis: { kind: 'bond', strength: 3 },
    },
  }];
  const result = await composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates } });
  const cold = result.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.equal(audit.hard_failures.length, 0, '不可定位硬伤引文被隔离');
  assert.equal(audit.isolated_issues.length, 1);

  const noAxis = structuredClone(candidates);
  noAxis[0].audit.strongest_axis = { kind: '', strength: 5 };
  await assert.rejects(
    composeOpeningCandidates(book.id, { mode: 'repair', data: { candidates: noAxis } }),
    error => error?.code === 'OPENING_CANDIDATE_AUDIT_INVALID',
  );
});
