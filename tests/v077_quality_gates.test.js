// V0.77 质量门：审校/覆盖输出截断或畸形时必须 fail-closed
import './helper.js'; // V0.95.2：测试隔离（此前读真实 config.json，默认值巧合通过）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditResponse, parseCoverageResponse } from '../server/engine/audit.js';
import * as auditModule from '../server/engine/audit.js';
import { DEFAULT_ROUTES, resolveRoute } from '../server/config.js';
import * as routerModule from '../server/llm/router.js';
import { auditInstruction } from '../server/engine/prompts.js';
import { chooseCompressedScene } from '../server/engine/write.js';

test('审校响应必须是完整、结构合法且 verdict 受控的 JSON', () => {
  assert.throws(
    () => parseAuditResponse({ content: '{"issues":[]', finishReason: 'length' }),
    error => error.code === 'AUDIT_INVALID',
  );
  // V0.95.3：verdict 表外值不再阻塞——按 issues 推断（ch27 实证"通过，但有建议"卡章根修）
  const lenient = parseAuditResponse({ content: '{"issues":[],"verdict":"whatever"}', finishReason: 'stop' });
  assert.equal(lenient.verdict, 'accept', '表外 verdict + 空 issues → accept（推断）');
  assert.deepEqual(
    parseAuditResponse({ content: '{"issues":[],"verdict":"accept","grade":"A"}', finishReason: 'stop' }),
    { issues: [], verdict: 'accept', grade: 'A' },
  );
});

test('覆盖响应不能把不可解析、缺字段或未知 verdict 当作 pass', () => {
  for (const response of [
    { content: 'not json', finishReason: 'stop' },
    { content: '{"coverage":[]}', finishReason: 'stop' },
    { content: '{"coverage":[],"missing":[],"verdict":"accept"}', finishReason: 'stop' },
    { content: '{"coverage":[],"missing":[],"verdict":"pass"}', finishReason: 'length' },
  ]) {
    assert.throws(() => parseCoverageResponse(response), error => error.code === 'COVERAGE_INVALID');
  }
  assert.deepEqual(
    parseCoverageResponse({ content: '{"coverage":[],"missing":[],"verdict":"pass"}', finishReason: 'stop' }),
    { coverage: [], missing: [], verdict: 'pass' },
  );
});

test('审校解析兼容模型常见字段漂移，但未知判定仍然 fail-closed', () => {
  assert.deepEqual(
    parseAuditResponse({
      content: '{"problems":[],"status":"PASS","grade":"A（良好）"}',
      finishReason: 'stop',
    }),
    { issues: [], verdict: 'accept', grade: 'A' },
  );
  assert.deepEqual(
    parseAuditResponse({
      content: '{"findings":[{"type":"事实矛盾","severity":"high","quote":"原句","issue":"重复事件"}]}',
      finishReason: 'stop',
    }),
    {
      issues: [{ type: '事实矛盾', severity: 'high', quote: '原句', issue: '重复事件' }],
      verdict: 'fix',
    },
  );
  // V0.95.3：同上——表外判定按 issues 推断，不再 fail-closed（截断/结构无效仍 fail-closed，见 v146）
  assert.equal(
    parseAuditResponse({ content: '{"issues":[],"status":"whatever"}', finishReason: 'stop' }).verdict,
    'accept',
  );
});

test('非截断的畸形审校只调用一次格式修复，修复失败仍阻断', async () => {
  assert.equal(typeof auditModule.parseAuditWithRepair, 'function', '应提供一次性结构修复入口');
  let repairs = 0;
  const parsed = await auditModule.parseAuditWithRepair(
    { content: '审校结论：没有发现问题。', finishReason: 'stop' },
    async () => {
      repairs++;
      return { content: '{"issues":[],"verdict":"accept","grade":"A"}', finishReason: 'stop' };
    },
  );
  assert.equal(repairs, 1);
  assert.equal(parsed.verdict, 'accept');

  repairs = 0;
  await assert.rejects(
    auditModule.parseAuditWithRepair(
      { content: '仍然不是 JSON', finishReason: 'stop' },
      async () => {
        repairs++;
        return { content: '修复结果仍无效', finishReason: 'stop' };
      },
    ),
    error => error.code === 'AUDIT_INVALID',
  );
  assert.equal(repairs, 1, '格式修复最多一次，禁止递归重试');
});

test('审校格式修复使用低思考小输出路由', () => {
  // V0.95.3：2500→6000——修复器需重排完整 issues JSON，ch27 实证 2500 打满截断致二次解析失败
  assert.deepEqual(DEFAULT_ROUTES.audit_repair, {
    model: 'deepseek-v4-flash', temperature: 0, maxTokens: 6000,
    thinking: 'disabled', reasoningEffort: 'low', label: '审校格式修复',
  });
});

test('审校默认稳定形态（V0.95.3 回退 disabled+low），作品级局部覆盖不会丢失其余路由字段', () => {
  assert.equal(DEFAULT_ROUTES.audit.thinking, 'disabled');
  assert.equal(DEFAULT_ROUTES.audit.reasoningEffort, 'low');
  const route = resolveRoute('audit', { routes: { audit: { maxTokens: 1234 } } });
  assert.equal(route.maxTokens, 1234);
  assert.equal(route.temperature, 0.2);
  assert.equal(route.reasoningEffort, 'low');
  assert.ok(route.model);
});

test('审校调用可强制安全路由，用户误配 thinking 也不能吃满输出预算', () => {
  assert.equal(typeof routerModule.resolveTaskRoute, 'function', '路由器应支持调用级安全覆盖');
  const route = routerModule.resolveTaskRoute('audit', {}, {
    maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low',
  });
  assert.equal(route.maxTokens, 6000);
  assert.equal(route.thinking, 'disabled');
  assert.equal(route.reasoningEffort, 'low');
  assert.equal(route.temperature, 0.2);
});

test('审校提示限制问题数量并禁止输出推理正文', () => {
  const prompt = auditInstruction({
    bookTitle: '测试书', chapterTitle: '测试章', chapterText: '正文',
    factsText: '事实', foreshadowsText: '', characterStates: '', contract: '',
  });
  assert.match(prompt, /最多\s*8\s*条/);
  assert.match(prompt, /不要输出推理过程/);
});

test('压缩自愈不得接受比原文更长的失控输出', () => {
  const original = '原'.repeat(2000);
  const longer = '长'.repeat(2400);
  const bounded = '短'.repeat(1200);
  assert.equal(chooseCompressedScene(original, [longer], 650, 1700), original);
  assert.equal(chooseCompressedScene(original, [longer, bounded], 650, 1700), bounded);
});
