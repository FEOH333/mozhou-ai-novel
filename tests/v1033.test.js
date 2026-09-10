// V0.102.13：场景间天色/上一段冲突是改稿，首次审校不得 replan 清场。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/historical_guardrails.js';
import { auditIssueRepairMode, hasOutlineRootIssue } from '../server/engine/pipeline.js';

test('V0.102.13 上一段天色已亮与下场冲突走 revise，不得首次审校 replan', () => {
  const issues = stampOpeningTimelineProseFix([{
    type: '事实矛盾', severity: 'high',
    quote: '天色像一块洗不净的旧麻布',
 issue: '场景时间线严重冲突。上一段结尾明确描写天色已亮（“天色像一块洗不净的旧麻布”），且主角已在垛口观敌。',
    fix: '把下场开头改成天亮之后的连续动作',
  }]);
  assert.equal(issues[0].proseFix, true);
  const audit = { verdict: 'fix', issues };
  assert.equal(hasOutlineRootIssue(audit), false);
  assert.equal(auditIssueRepairMode(audit), 'revise');
});

test('V0.102.13 未登记角色仍是细纲根因', () => {
  const audit = {
    verdict: 'fix',
    issues: [{ type: '事实编造', severity: 'high', quote: '那人是老幺', issue: '老幺未登记', fix: '改回已有角色' }],
  };
  assert.equal(hasOutlineRootIssue(audit), true);
  assert.equal(auditIssueRepairMode(audit), 'replan');
});
