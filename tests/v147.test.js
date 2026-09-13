// V0.95.3 终值锁定：正文型任务「预算全耗推理」根修（ch27 连环卡章实证）
// 证据链（usage_logs 8/16）：revise completion=4000/8000 两档打满（=maxTokens 上限）且 content 为空
// ——OpenCode Go 端点 flash 在 reasoning_effort≥medium 时把全部 completion 预算烧成推理、正文为零；
// write effort high 延迟翻倍连续超时（4 次 NETWORK_ERROR）；audit enabled+medium 致 verdict 漂移
// （"通过，但有建议"）+ 输出截断 ×3。V0.95.2 参数全线回退 + router 结构级自愈兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './helper.js';
import { DEFAULT_ROUTES } from '../server/config.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('V0.95.3 router 正文空转自愈：finishReason=length 且 content 空 → 强制 effort low + 预算×1.5 重试', () => {
  const src = read('server/llm/router.js');
  assert.ok(src.includes('proseStarved'), '应存在正文空转（proseStarved）判定');
  assert.ok(/proseStarved = !jsonMode && first\.finishReason === 'length' && !\(first\.content \|\| ''\)\.trim\(\)/.test(src),
    '空转判定 = 非 jsonMode + length + content 空（三者缺一不可，防误触发）');
  // V0.98.5 扩展：输出被思考吃空不再依赖 finishReason——「正文空+思考在场」（reasoningBurn）同样降档，
  // 免费档流式端点可无 finish/[DONE] 完成标记（ox-alpha-free 实证）。
  assert.ok(/reasoningBurn = !\(first\.content \|\| ''\)\.trim\(\) && !!\(first\.reasoningContent \|\| ''\)\.trim\(\)/.test(src),
    'reasoningBurn 判定 = content 空 + reasoningContent 在场');
  // V0.98.8 终值：空输出一律重试（emptyOutput 为总闸，含 finish=stop 且无思考的瞬时坏响应）。
  assert.ok(/emptyOutput = !\(first\.content \|\| ''\)\.trim\(\)/.test(src), 'emptyOutput = content 空即触发');
  assert.ok(src.includes('if (!jsonTruncated && !emptyOutput)'), '空输出重试总闸');
  assert.ok(src.includes('const downgrade = emptyOutput'), '空输出重试必须降档 effort low');
  assert.ok(src.includes("reasoningEffort: downgrade ? 'low'"), '空转重试必须强制 effort low（根因即推理吃预算）');
  assert.ok(src.includes('正文空转(finishReason=length 且 content 空'), '空转重试应留操作日志（可观测）');
});

test('V0.95.3 引擎硬编码 routeOverride 与 config 同步：无 enabled/medium 残留在每章路径', () => {
  // 三判定门引擎侧覆盖回退 disabled+low（写审同源：config 与 engine 同一把尺子）
  for (const f of ['server/engine/quality/attraction.js', 'server/engine/planning/promise.js', 'server/engine/planning/signing.js']) {
    const src = read(f);
    assert.ok(!src.includes("thinking: 'enabled'"), `${f} 不应再有 enabled 思考覆盖`);
    assert.ok(!src.includes("reasoningEffort: 'medium'"), `${f} 不应再有 medium effort 覆盖`);
  }
  // reviseScene：effort low 单值（不再有重复键 medium/low 并存的补丁形态）
  const auditSrc = read('server/engine/pipeline/audit.js');
  assert.ok(!auditSrc.includes("reasoningEffort: 'medium'"), 'audit.js 不应再有 medium effort（reviseScene/长度自愈全 low）');
  assert.ok(/revise', bookId, chapterId, messages,\s*\n\s*routeOverride: \{\s*\n\s*thinking: 'disabled', reasoningEffort: 'low', temperature: 0\.4,/.test(auditSrc),
    'reviseScene 覆盖应为 disabled+low 单值形态');
  // 长度自愈（write.js）同款
  const writeSrc = read('server/engine/pipeline/write.js');
  assert.ok(!writeSrc.includes("reasoningEffort: 'medium'"), 'write.js 不应再有 medium effort');
});

test('V0.95.3 config 正文/判定全线 low：write/revise/attraction/signing_review/promise_check/pleasure_audit', () => {
  for (const task of ['write', 'revise', 'attraction', 'signing_review', 'promise_check', 'pleasure_audit']) {
    const r = DEFAULT_ROUTES[task];
    assert.equal(r.thinking, 'disabled', `${task} thinking disabled`);
    assert.equal(r.reasoningEffort, 'low', `${task} effort low（端点实证稳定形态）`);
  }
});

test('V0.95.3 reviseScene 空结果兜底重试保留（再空才抛错，引擎级第二道保险）', () => {
  const src = read('server/engine/pipeline/audit.js');
  // 断言行为而非精确格式：空结果必须先有一次同参数大预算重试
  assert.match(src, /if\s*\(!content\)\s*\{[\s\S]{0,120}?const retry = await runTask\(/,
    'revise 空结果应有一次同参数大预算重试');
  assert.ok(src.includes("if (!content) throw new Error('修订结果为空，请重试')"),
    '重试仍空必须 fail-closed 抛错');
});
