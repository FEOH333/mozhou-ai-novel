// V0.102.12：审校把开庆元年时间线标成「史实错误」时，不得 QUALITY_GATE / 首轮 replan。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/longform/historical_guardrails.js';
import { auditIssueRepairMode, auditVerdictAfterBudget, hasOutlineRootIssue } from '../server/engine/pipeline/pipeline.js';

test('V0.102.12 开庆元年被标成史实错误是措辞问题，走 revise 且预算后放行', () => {
  const issues = stampOpeningTimelineProseFix([{
    type: '史实错误', severity: 'high',
    quote: '开庆元年的风像刀子',
    issue: '时间线严重冲突。草稿开头明确标注“开庆元年（1259）初春”，但历史上蒙哥伐宋、攻入四川并围攻钓鱼城主要在当年夏秋。',
    fix: '把季节或塘报时点写清即可',
  }]);
  assert.equal(issues[0].proseFix, true);
  const audit = { verdict: 'fix', issues };
  assert.equal(hasOutlineRootIssue(audit), false);
  assert.equal(auditIssueRepairMode(audit), 'revise');
  assert.equal(auditVerdictAfterBudget(audit).verdict, 'defer');
});

test('V0.102.12 明确要求重做细纲的史实硬伤仍拦截', () => {
  const audit = {
    verdict: 'fix',
    issues: [{ type: '史实错误', severity: 'high', issue: '史实年代错误，应重做细纲' }],
  };
  assert.equal(hasOutlineRootIssue(audit), true);
  assert.equal(auditVerdictAfterBudget(audit).verdict, 'fix');
});
