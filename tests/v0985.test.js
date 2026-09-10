// V0.98.5 免费档端点适配：reasoning 封顶 + 默认流式 + 非流式失败翻流式 + 思考吃空自愈
// 实证（ox-alpha-free，2026-08-22）：非流式长请求随机 500/503；流式通道稳定；
// reasoning_effort medium → HTTP 400、缺省 → 思考吃空输出正文为零、low → 完整出稿。
import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { createOpeningFixture, validDiagnosis } from './helpers/opening_fixture.js';

let firstScene;
beforeEach(() => {
  ({ firstScene } = createOpeningFixture(store));
});

test('V0.98.5/98.13 免费档预设：preferStream + 思考档位收敛（V0.98.13 模型换代后 high 放行）', async () => {
  const { PROVIDER_PRESETS, capReasoningEffort } = await import('../server/config.js');
  const preset = PROVIDER_PRESETS.opencode_go_free;
  assert.equal(preset.preferStream, true, '免费档默认走流式（非流式队列拥堵实证）');
  // V0.98.13 实测更新：模型/网关换代后 high 可用且输出完整（134s/350字），medium 仍 400——
  // cap 升 high；规划/设计类任务思考拉满（用户实测"思考拉满才强"），判定门 low 档保持
  assert.equal(preset.reasoningEffortCap, 'high', '免费档 effort 上限 high（V0.98.13 实测；旧 low 封顶已随模型换代解除）');
  const g = { provider: 'opencode_go_free' };
  assert.equal(capReasoningEffort('high', g), 'high', 'high 档放行（思考拉满才强）');
  assert.equal(capReasoningEffort('medium', g), 'high', 'medium 该端点 400，归并思考拉满档');
  assert.equal(capReasoningEffort('low', g), 'low', '判定门 low 档保持确定性优先');
  assert.equal(capReasoningEffort(undefined, g), 'high', '缺省档位落到上限');
  const ds = { provider: 'deepseek_official' };
  assert.equal(capReasoningEffort('high', ds), 'high', '无封顶预设保持原值');
  assert.equal(capReasoningEffort('medium', { provider: 'opencode_go' }), 'medium');
});

test('V0.98.5 客户端流式回退：非流式撞可重试错误后自动翻流式重试成功', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  process.env.NOVEL_FAULT = '500:1';
  const { chatCompletion } = await import('../server/llm/client.js');
  const retries = [];
  const r = await chatCompletion({
    model: 'mock', apiKey: 'k', baseUrl: 'https://mock.example',
    messages: [{ role: 'user', content: '写一句摘要。' }],
    stream: false, onRetry: event => retries.push(event),
    resilience: { retryBackoffMs: 1, jitterMs: 0 },
  });
  assert.ok((r.content || '').length > 0, '重试轮应成功拿到正文');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].streamFallback, true, '非流式失败后必须翻流式重试');
  process.env.NOVEL_FAULT = '';
});

test('V0.98.5 router 思考吃空自愈：正文空+reasoning 在场（finishReason=stop）→ effort low 重试成功', async () => {
  process.env.NOVEL_MOCK_LLM = '1';
  process.env.NOVEL_REASONING_BURN = '1';
  const { runTask } = await import('../server/llm/router.js');
  const result = await runTask({
    task: 'summarize', messages: [{ role: 'user', content: '写一段摘要。' }],
  });
  assert.ok((result.content || '').trim().length > 0, '首次调用被思考吃空（finishReason=stop），降档重试必须拿到正文');
  process.env.NOVEL_REASONING_BURN = '';
});

test('V0.98.5 精读诊断：软意见字段残缺只隔离单条，不拖垮整份报告（免费档实证）', async () => {
  const { validateOpeningDiagnosis } = await import('../server/engine/opening_diagnosis.js');
  const text = store.chapters.fullText(firstScene.chapter_id);
  const report = structuredClone(validDiagnosis);
  report.issues = [
    { severity: 'medium', quote: '天边压着一线暗红', cause: '有因无章', smallest_fix: '压缩' }, // 缺 chapter
    { severity: 'weird', chapter: 1, quote: '天边压着一线暗红', cause: '坏 severity', smallest_fix: '改' },
    { severity: 'medium', chapter: 1, quote: '天边压着一线暗红', cause: '真实问题', smallest_fix: '压缩这句' }, // 完整
  ];
  report.tradeoffs = [
    { quote: '天边压着一线暗红', reason: '缺 chapter 字段' }, // 结构残缺
  ];
  const result = validateOpeningDiagnosis(report, [{ idx: 1, text }]);
  assert.equal(result.issues.length, 1, '结构完整的意见保留');
  assert.deepEqual(result.validation_warnings.map(w => `${w.kind}:${w.code}`).sort(), [
    'issue:invalid_structure', 'issue:invalid_structure', 'tradeoff:invalid_structure',
  ]);
  assert.equal(result.recommendation.kind, 'baseline', '发生隔离后本轮只能建议保留原稿');
});
