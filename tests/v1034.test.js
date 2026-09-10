// V0.102.14：开庆元年/余玠已卒被标成事实矛盾时，不得首次审校 replan。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/historical_guardrails.js';
import { auditIssueRepairMode, hasOutlineRootIssue } from '../server/engine/pipeline.js';

test('V0.102.14 开庆元年余玠已卒被标成事实矛盾走 revise', () => {
  const issues = stampOpeningTimelineProseFix([{
    type: '事实矛盾', severity: 'high',
    quote: '余玠当年定下的山城法',
    issue: '严重史实/设定冲突。当前时间为1259年（开庆元年），余玠已于1253年去世（角色状态明确标注）。',
    fix: '改成余玠旧制或王坚现行军令',
  }]);
  assert.equal(issues[0].proseFix, true);
  const audit = { verdict: 'fix', issues };
  assert.equal(hasOutlineRootIssue(audit), false);
  assert.equal(auditIssueRepairMode(audit), 'revise');
});

test('V0.102.14 未登记角色仍是细纲根因', () => {
  const audit = {
    verdict: 'fix',
    issues: [{ type: '事实编造', severity: 'high', quote: '那人是老幺', issue: '老幺未登记', fix: '改回已有角色' }],
  };
  assert.equal(hasOutlineRootIssue(audit), true);
  assert.equal(auditIssueRepairMode(audit), 'replan');
});
