// V0.102.10：章内道具/动作跳变是改稿，首次审校不得当细纲根因清场。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/longform/historical_guardrails.js';
import { auditIssueRepairMode, hasOutlineRootIssue } from '../server/engine/pipeline/pipeline.js';

test('V0.102.10 怀里与腰间短刀跳变走 revise，不得首次审校 replan', () => {
  const issues = stampOpeningTimelineProseFix([{
    type: '事实矛盾', severity: 'high',
    quote: '隔着衣襟按了按腰间短猎刀',
    issue: '道具位置与状态跳变。前文刚写“把塘报折好，塞进怀里”，紧接着动作描写却是“隔着衣襟按了按腰间短猎刀”。',
    fix: '统一为怀里或腰间',
  }]);
  assert.equal(issues[0].proseFix, true);
  const audit = { verdict: 'fix', issues };
  assert.equal(hasOutlineRootIssue(audit), false);
  assert.equal(auditIssueRepairMode(audit), 'revise');
});

test('V0.102.10 未登记角色仍是细纲根因，首次审校 replan', () => {
  const audit = {
    verdict: 'fix',
    issues: [{ type: '事实编造', severity: 'high', quote: '那人是老幺', issue: '老幺未登记', fix: '改回已有角色' }],
  };
  assert.equal(hasOutlineRootIssue(audit), true);
  assert.equal(auditIssueRepairMode(audit), 'replan');
});
