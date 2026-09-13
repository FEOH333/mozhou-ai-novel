// V0.95.3 审校解析容错根修（用户实测 ch27 卡 quality_blocked）
// 证据链：14:30 audit completion=2353（未截断）+ audit_repair 1124 后仍抛「审校等级无效」→
// 整章卡死。真凶：verdict 枚举外变体（思考模型输出"通过，但有建议"式长句；修复器按
// "不新增不删除不推断"原则原样保留 → 二次仍无效）。grade 非法（"中等"式）同款过严。
// 修复：verdict 表外 → 按 issues 严重度推断（裁决核心仍由 issues 驱动 + sanitize 二次清洗）；
// grade 非法 → 丢弃（UI 分档展示字段，auditChapter 有推断兜底）；issues 结构无效仍 fail-closed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import { parseAuditResponse } from '../server/engine/pipeline/audit.js';

test('V0.95.3 verdict 枚举外变体不再卡章：按 issues 严重度推断裁决（ch27 实证形态）', () => {
  // 思考模型实测输出形态：verdict 是长句、issues 正常
  const r = parseAuditResponse({
    content: JSON.stringify({
      issues: [{ type: '语句质量', severity: 'medium', quote: 'x', issue: '破折号 22 个', fix: '压缩' }],
      verdict: '通过，但有建议', grade: 'B',
    }),
    finishReason: 'stop',
  });
  assert.equal(r.verdict, 'fix', 'issues 含 medium → 推断 fix（触发修订自愈）');
  assert.equal(r.grade, 'B');
  // 无问题 + 表外 verdict → accept
  const r2 = parseAuditResponse({
    content: JSON.stringify({ issues: [], verdict: '整体可以接受' }),
    finishReason: 'stop',
  });
  assert.equal(r2.verdict, 'accept');
});

test('V0.95.3 grade 格式非法不再卡章：丢弃 grade，裁决不受影响', () => {
  const r = parseAuditResponse({
    content: JSON.stringify({
      issues: [], verdict: 'accept', grade: '中等偏上',
    }),
    finishReason: 'stop',
  });
  assert.equal(r.verdict, 'accept');
  assert.equal(r.grade, undefined, '非法 grade 丢弃（auditChapter 按 issues 推断分档）');
});

test('V0.95.3 fail-closed 底线保持：截断与 issues 结构无效仍阻塞', () => {
  assert.throws(() => parseAuditResponse({ content: '{}', finishReason: 'length' }), /截断/);
  assert.throws(() => parseAuditResponse({
    content: JSON.stringify({ verdict: 'accept', issues: '不是数组也不是对象' }),
    finishReason: 'stop',
  }), /格式无效/);
});
