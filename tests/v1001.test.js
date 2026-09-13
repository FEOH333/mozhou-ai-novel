// V0.100.1：① OpenRouter 服务商预设（stealth/ox-alpha 限时免费档，冒烟三件 2026-08-24 实测全过）；
// ② 影子投影证据分段对齐——模型把被“说话人标签/省略号”隔开的两段真实原句拼成一条 evidence
// （实测 ch1 实证：正文「“……若真到那一步，”是父亲的声音，“你带两个孩子先走，我断后。”」
//    模型引「若真到那一步，你带两个孩子先走，我断后。」被判废，重建第 1 章即停），
//    分段全命中且有序则确定性放行；幻觉引文、乱序拼接、无强锚点碎片仍判废（fail-closed 不降级）。
// 补：全短段拼接（实测 ch2 实证：「“翻青林坳，”父亲说，“走大路，别回头。”」全为 3-4 字段）
//    须段总长 ≥8 且跨度贴段长才放行，远距离碰巧按序出现的碎片仍判废。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1001-'));
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_NO_OPEN = '1';

const { PROVIDER_PRESETS, resolveModelName, capReasoningEffort, pickTestModel } = await import('../server/config.js');
const { getPrice } = await import('../server/llm/cost.js');
const { validateNarrativeProjection } = await import('../server/engine/narrative/narrative_state.js');

// ---- OpenRouter 预设 ----

test('openrouter 预设存在且映射 stealth/ox-alpha', () => {
  const preset = PROVIDER_PRESETS.openrouter;
  assert.ok(preset, 'PROVIDER_PRESETS 应有 openrouter');
  assert.equal(preset.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(preset.models.flash, 'stealth/ox-alpha');
  assert.equal(preset.models.pro, 'stealth/ox-alpha');
  assert.equal(preset.deepseekParams, false, 'OpenAI 兼容端点不发 DeepSeek 专属参数');
  assert.equal(preset.protocol, 'chat');
  assert.equal(preset.preferStream, true, '免费档默认走流式避开非流式不稳定队列');
  assert.ok(preset.maxTokensFloor >= 16000, '免费档大 max_tokens 可用，抬高结构化任务输出下限');
});

test('openrouter 下任务模型解析为 stealth/ox-alpha 且无 effort 封顶', () => {
  const g = { provider: 'openrouter', routes: {}, writingModel: 'flash' };
  assert.equal(resolveModelName('write', 'deepseek-v4-pro', g), 'stealth/ox-alpha');
  assert.equal(resolveModelName('settle', 'deepseek-v4-flash', g), 'stealth/ox-alpha');
  // 实测 reasoning_effort low/medium/high 平铺字段全部 200（与 opencode 免费档 medium→400 不同）→ 不设 cap
  assert.equal(capReasoningEffort('medium', g), 'medium');
  assert.equal(capReasoningEffort('high', g), 'high');
  // 对照组：opencode_go_free 的 medium 仍归并 high（行为不回归）
  assert.equal(capReasoningEffort('medium', { provider: 'opencode_go_free', routes: {} }), 'high');
});

test('stealth/ox-alpha 计价记 0，不走 UNKNOWN_PRICE 虚高', () => {
  const p = getPrice('stealth/ox-alpha');
  assert.equal(p.hit, 0);
  assert.equal(p.miss, 0);
  assert.equal(p.output, 0);
});

test('连接测试模型选择跟随服务商运行时真值（不硬编码 DeepSeek 名单）', () => {
  // OpenRouter 名单下必须选实际运行的 stealth/ox-alpha——旧逻辑选 models[0] 无关模型，
  // 触发数据政策 404 误报"模型未开通"（2026-08-24 实测）
  const orModels = ['meta/muse-spark-1.2-contributor', 'stealth/ox-alpha', 'google/gemini-3.7-flash'];
  assert.equal(pickTestModel(orModels, { provider: 'openrouter', routes: {}, writingModel: 'flash' }), 'stealth/ox-alpha');
  // DeepSeek 官方回归：仍选 deepseek-v4-flash
  const dsModels = ['deepseek-v4-flash', 'deepseek-v4-pro'];
  assert.equal(pickTestModel(dsModels, { provider: 'deepseek_official', routes: {}, writingModel: 'flash' }), 'deepseek-v4-flash');
});

// ---- 投影证据分段对齐 ----

// 取自实测 ch1 真实正文结构（省略号 + 说话人标签隔开两段对白）
const CH1_TEXT = [
 '主角推开屋门，听见灶房里有人说话。',
  '声音压得很低，但夜太静，每一个字都清清楚楚。',
  '“……若真到那一步，”是父亲的声音，“你带两个孩子先走，我断后。”',
 '沉默。灶台边传来陶碗磕木案的一声闷响，随即被手掌托住。隔着门板，主角看不见父亲的手。',
].join('\n');

function projectionPayload(evidence) {
  return {
 summary: '主角夜归，听见父母低声密谈家事危局。',
    outline_actual: {
      goal: '父母商议危局应对', conflict: '走与守不可兼得',
      dramatic_question: '家里是否要散', counterforce: '门外大势逼近',
 turn: '父亲说出断后打算', irreversible_change: '主角知道了家里可能守不住',
      choice_cost: '父亲选择断后', reader_gain: '危局浮出水面', reader_pull: '那一步何时到来',
      evidence,
      scenes: [{ id: 's1', beat: '父母灶房密谈', evidence }],
    },
  };
}

test('被说话人标签隔开的真实拼接引文不再误杀', () => {
  // 模型实际输出：把标签两侧两段真实原句拼成一条
  const stitched = '若真到那一步，你带两个孩子先走，我断后。';
  const normalized = validateNarrativeProjection(projectionPayload(stitched), CH1_TEXT, { idx: 1 });
  assert.equal(normalized.outline_actual.evidence, stitched);
});

test('幻觉引文仍判废', () => {
  assert.throws(
 () => validateNarrativeProjection(projectionPayload('主角拔刀冲向元军大营。'), CH1_TEXT, { idx: 1 }),
    /PROJECTION_EVIDENCE_MISSING|缺少可在当前正文逐字定位的证据/,
  );
});

test('乱序拼接仍判废', () => {
  assert.throws(
    () => validateNarrativeProjection(projectionPayload('你带两个孩子先走，若真到那一步。'), CH1_TEXT, { idx: 1 }),
    /缺少可在当前正文逐字定位的证据/,
  );
});

test('无强锚点的碎片拼接仍判废', () => {
  // 两段都真实存在但都 <6 字，不足以证明 grounded
  assert.throws(
    () => validateNarrativeProjection(projectionPayload('夜太静，沉默。'), CH1_TEXT, { idx: 1 }),
    /缺少可在当前正文逐字定位的证据/,
  );
});

test('连续原句引用不受影响（回归）', () => {
  const contiguous = '灶台边传来陶碗磕木案的一声闷响';
  const normalized = validateNarrativeProjection(projectionPayload(contiguous), CH1_TEXT, { idx: 1 });
  assert.equal(normalized.outline_actual.scenes[0].evidence, contiguous);
});

// 取自实测 ch2 真实正文结构（短段对白被“父亲说”隔开：全段 <6 字）
const CH2_TEXT = [
  '父亲夹了一筷子菜，搁在碗沿上。筷子停了停，他说：“明天天不亮，你娘带你跟昱儿往南走。”',
 '主角的筷子顿住。',
  '“翻青林坳，”父亲说，“走大路，别回头。”',
  '“爹，你呢？”',
  '父亲端起粥碗，喝了一口：“我留下看几天。家里牲口，谷子，都是事。”',
].join('\n');

test('全短段对白拼接被说话人标签隔开不再误杀（实测 ch2 实证）', () => {
  // 模型实际输出：翻青林坳(4)/走大路(3)/别回头(3) 全 <6 字，但总长 10 ≥8 且跨度贴段长
  const stitched = '翻青林坳，走大路，别回头。';
  const normalized = validateNarrativeProjection(projectionPayload(stitched), CH2_TEXT, { idx: 2 });
  assert.equal(normalized.outline_actual.evidence, stitched);
});

test('全短段但远距离碰巧按序出现仍判废', () => {
  // 搁在碗沿上(5)+都是事(3) 总长 8 且都真实存在，但分处章首章尾——幻觉拼接不得放行
  assert.throws(
    () => validateNarrativeProjection(projectionPayload('搁在碗沿上，都是事。'), CH2_TEXT, { idx: 2 }),
    /缺少可在当前正文逐字定位的证据/,
  );
});

// 取自实测 ch6 真实正文结构（全角引号「“安”」）
const CH6_TEXT = '他摸了摸怀里，摸到那块粗布护身符。布角已经被他磨得起了毛，那个“安”字，针脚走得乱，有几针跳了线。他指腹沿着那道线痕轻轻描了一遍。';

test('模型引文用半角引号、正文用全角引号不再误杀（实测 ch6 实证）', () => {
  // 引号风格差异不影响逐字语义：归一化双侧都剥除半角 ' "
  const halfWidthQuote = "那个'安'字，针脚走得乱，有几针跳了线";
  const normalized = validateNarrativeProjection(projectionPayload(halfWidthQuote), CH6_TEXT, { idx: 6 });
  assert.equal(normalized.outline_actual.evidence, halfWidthQuote);
});

test('引号归一化不为内容幻觉开口子（回归）', () => {
  // 内容本身不在正文（跳了线→断了线），光引号对齐不得放行
  assert.throws(
    () => validateNarrativeProjection(projectionPayload("那个'安'字，针脚走得乱，有几针断了线"), CH6_TEXT, { idx: 6 }),
    /缺少可在当前正文逐字定位的证据/,
  );
});

test('多条证据失效一次性聚合上报（反馈重答才能一次修完，实测 ch2 实证）', () => {
  // 重建第三轮实证：校验在第一条坏证据即抛，反馈只提一条，模型修一条又踩一条（打地鼠）。
  // 聚合后一次抛出的错误必须同时包含所有坏证据，供唯一一次反馈重答整体修正。
 const payload = projectionPayload('主角拔刀冲向元军大营。'); // 实际章纲 + 场景1 均坏
 payload.facts = [{ subject: '主角', predicate: '斩杀', object: '元军统领', evidence: '主角一刀斩下元军统领的头颅。' }];
  let caught = null;
  try {
    validateNarrativeProjection(payload, CH1_TEXT, { idx: 1 });
  } catch (error) { caught = error; }
  assert.ok(caught, '必须抛错');
  assert.equal(caught.code, 'PROJECTION_EVIDENCE_MISSING');
 assert.match(caught.message, /主角拔刀冲向元军大营/);
 assert.match(caught.message, /主角一刀斩下元军统领的头颅/);
});

test('跨段落远距离缝合仍判废（实测 ch2 赵四实证）', () => {
  // 两句都真实存在但相隔两个段落、分属不同时刻——超过跨度护栏即拒绝
  const stitched = '赵四站着没动。他没有再劝，抬起手，在父亲脚边的墙砖上拍了一下';
  const text = [
 '父亲在墙头上沉默了很久。赵四站着没动。主角趴在窗缝边，脚底板凉透了。',
 '主角没有说话。'.repeat(30), // 隔开两个时刻（真实正文此处相隔约 170 字、分属两段）
    '“你呢？”赵四问。“我守着。”',
    '赵四在墙根下站了片刻。他没有再劝，抬起手，在父亲脚边的墙砖上拍了一下，像拍一匹马的脖子，转身消失在黑影里。',
  ].join('\n');
  assert.throws(
    () => validateNarrativeProjection(projectionPayload(stitched), text, { idx: 2 }),
    /缺少可在当前正文逐字定位的证据/,
  );
});
