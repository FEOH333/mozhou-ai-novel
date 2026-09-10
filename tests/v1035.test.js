// V0.102.15：人设/职责冲突是改稿；已有草稿时，除未登记角色/重做细纲/遗体硬伤外不得首次清场。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/historical_guardrails.js';
import {
  auditIssueRepairMode, hasOutlineRootIssue, isRevisionStale, shouldImmediateReplanWipe,
} from '../server/engine/pipeline.js';

const CHENQI = {
  type: '事实矛盾', severity: 'high',
  quote: '陈七没有拦他',
  issue: '人物性格与职责严重冲突。陈七的人设是“严而不苛，关心可用之人”、“对纪律近乎固执”。面对“蒙古地道”仍纵容越权审讯。',
  fix: '改成陈七当场拦下或事后记过',
};

test('V0.102.15 陈七人设冲突走 revise，不得首次审校 replan', () => {
  const issues = stampOpeningTimelineProseFix([CHENQI]);
  assert.equal(issues[0].proseFix, true);
  const audit = { verdict: 'fix', issues };
  assert.equal(hasOutlineRootIssue(audit), false);
  assert.equal(auditIssueRepairMode(audit), 'revise');
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: true, reviseRound: 0 }), false);
});

test('V0.102.15 人设冲突连续两轮不得升级 replan', () => {
  const scenes = [{ id: 's1', idx: 1, content: '陈七没有拦他，只把皮檐往上推。' }];
  const audit = { verdict: 'fix', issues: [CHENQI] };
  const quoteOf = q => String(q || '').replace(/\s/g, '').slice(0, 20);
  const r1 = isRevisionStale({
    audit, lastFixedQuotes: new Set(), prevHighTypes: new Set(),
    prevSceneHigh: new Map(), scenes, quoteOf,
  });
  assert.equal(r1.currHighTypes.size, 0);
  const prevSceneHigh = new Map();
  prevSceneHigh.set('事实矛盾|high@1', 1);
  const r2 = isRevisionStale({
    audit,
    lastFixedQuotes: new Set(),
    prevHighTypes: new Set(['事实矛盾|high']),
    prevSceneHigh, scenes, quoteOf,
  });
  assert.equal(r2.typeRepeatAndSceneRepeat, false);
});

test('V0.102.15 已有草稿的无名事实矛盾先修订，不得立刻清场', () => {
  const audit = {
    verdict: 'fix',
    issues: [{ type: '事实矛盾', severity: 'high', quote: '灰袍人吐出药丸', issue: '与上章交代不符', fix: '改口吻' }],
  };
  assert.equal(hasOutlineRootIssue(audit), true, '标签仍算细纲根因，供无稿/失效路径使用');
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: true, reviseRound: 0 }), false);
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: true, reviseRound: 1 }), false,
    'V0.102.16：已有草稿时软标签修订后也不得清场');
  assert.equal(shouldImmediateReplanWipe(audit, { hasDraft: false, reviseRound: 0 }), true);
});

test('V0.102.15 未登记角色与重做细纲仍立刻清场', () => {
  const unregistered = {
    verdict: 'fix',
    issues: [{ type: '事实编造', severity: 'high', quote: '那人是老幺', issue: '老幺未登记', fix: '改回已有角色' }],
  };
  assert.equal(hasOutlineRootIssue(unregistered), true);
  assert.equal(auditIssueRepairMode(unregistered), 'replan');
  assert.equal(shouldImmediateReplanWipe(unregistered, { hasDraft: true, reviseRound: 0 }), true);

  const redo = {
    verdict: 'fix',
    issues: [{ type: '史实错误', severity: 'high', issue: '史实年代错误，应重做细纲' }],
  };
  assert.equal(shouldImmediateReplanWipe(redo, { hasDraft: true, reviseRound: 0 }), true);
});
