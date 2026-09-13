// V0.102.7：修订预算耗尽后，只剩 proseFix 的 high 记债放行，不得 QUALITY_GATE 卡死已写五场。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/longform/historical_guardrails.js';
import { auditVerdictAfterBudget } from '../server/engine/pipeline/pipeline.js';

test('V0.102.7 细纲与草稿不符是改稿，预算耗尽后记债放行', () => {
  const issues = stampOpeningTimelineProseFix([{
    type: '大纲偏离', severity: 'high',
 quote: '主角站在门内阴影处',
 issue: '细纲要求场景1中老周头等屯田老兵在门内严阵以待，且主角面对的是陈七递来的塘报。草稿中主角先在门内看名册。',
    fix: '把开场改到寨门外接塘报',
  }]);
  assert.equal(issues[0].proseFix, true);
  assert.equal(auditVerdictAfterBudget({ verdict: 'fix', issues }).verdict, 'defer');
});

test('V0.102.7 开庆元年时间线措辞问题预算耗尽后不卡章', () => {
  assert.equal(auditVerdictAfterBudget({
    verdict: 'fix',
    issues: [{
      type: '时间线冲突', severity: 'high',
      quote: '汪德臣破运山',
      issue: '汪德臣破运山发生于1258年冬，而开庆元年始于1259年。开头补一句塘报迟达即可。',
      fix: '开头写塘报迟到',
    }],
  }).verdict, 'defer');
});

test('V0.102.7 真正的史实硬伤预算耗尽后仍拦截', () => {
  assert.equal(auditVerdictAfterBudget({
    verdict: 'fix',
    issues: [{ type: '史实错误', severity: 'high', issue: '史实年代错误，应重做细纲' }],
  }).verdict, 'fix');
});
