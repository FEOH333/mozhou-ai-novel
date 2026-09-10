// V0.102.16：空间连续性/伤情类事实矛盾是改稿；已有草稿时软标签永远不得清场。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/historical_guardrails.js';
import {
  auditIssueRepairMode, auditVerdictAfterBudget, hasOutlineRootIssue,
  isRevisionStale, shouldImmediateReplanWipe,
} from '../server/engine/pipeline.js';

const SPACE = {
  type: '事实矛盾', severity: 'high',
 quote: '主角缩进墙基后的阴影',
 issue: '场景逻辑与空间连续性严重冲突（V0.94）。前文设定主角“缩进墙基后的阴影”、“屏住呼吸”，且灰袍人转身时他仍贴着墙根。',
  fix: '补一句从墙根摸到灰袍人侧后的位移',
};

test('V0.102.16 空间连续性冲突走 revise，修订后再报也不得清场', () => {
  const issues = stampOpeningTimelineProseFix([SPACE]);
  assert.equal(issues[0].proseFix, true);
  const audit = { verdict: 'fix', issues };
  assert.equal(hasOutlineRootIssue(audit), false);
  assert.equal(auditIssueRepairMode(audit), 'revise');
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: true, reviseRound: 0 }), false);
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: true, reviseRound: 2 }), false);
  assert.equal(auditVerdictAfterBudget(audit).verdict, 'defer');
});

test('V0.102.16 已有草稿的软事实矛盾修订后仍不得清场，预算后记债', () => {
  const audit = {
    verdict: 'fix',
    issues: [{ type: '事实矛盾', severity: 'high', quote: '灰袍人吐出药丸', issue: '与上章交代不符', fix: '改口吻' }],
  };
  assert.equal(hasOutlineRootIssue(audit), true);
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: true, reviseRound: 0 }), false);
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: true, reviseRound: 2 }), false);
  assert.equal(auditVerdictAfterBudget(audit).verdict, 'defer');
  const quoteOf = q => String(q || '').replace(/\s/g, '').slice(0, 20);
  const scenes = [{ id: 's1', idx: 1, content: '灰袍人吐出药丸。' }];
  const r2 = isRevisionStale({
    audit,
    lastFixedQuotes: new Set(),
    prevHighTypes: new Set(['事实矛盾|high']),
    prevSceneHigh: new Map([['事实矛盾|high@1', 1]]),
    scenes, quoteOf,
  });
  assert.equal(r2.typeRepeatAndSceneRepeat, false);
});

test('V0.102.16 未登记角色修订后仍立刻清场，史实硬伤预算后仍拦截', () => {
  const unregistered = {
    verdict: 'fix',
    issues: [{ type: '事实编造', severity: 'high', quote: '那人是老幺', issue: '老幺未登记', fix: '改回已有角色' }],
  };
  assert.equal(shouldImmediateReplanWipe(unregistered, { hasDraft: true, reviseRound: 2 }), true);
  assert.equal(auditVerdictAfterBudget({
    verdict: 'fix',
    issues: [{ type: '史实错误', severity: 'high', issue: '史实年代错误，应重做细纲' }],
  }).verdict, 'fix');
});
