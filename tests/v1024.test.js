// V0.102.4：跨年开篇/接续标记类「时间线冲突」不得把已写正文整章重规划。
// 实证：第 35 章五场写完后审校报时间线冲突 → replan 清稿重写；进程在第 5 场中断。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix } from '../server/engine/historical_guardrails.js';
import { detectTimelineAnchorConflict } from '../server/engine/rules.js';
import { hasOutlineRootIssue, auditIssueRepairMode, normalizeAuditForRepair } from '../server/engine/pipeline.js';

test('V0.102.4 开篇缺跨年的 LLM 时间线冲突打 proseFix，不走 replan', () => {
  const stamped = stampOpeningTimelineProseFix([
    { type: '时间线冲突', severity: 'high', quote: '晨雾', issue: '跨年开篇没有年号', fix: '开头补开庆元年' },
    { type: '时间线冲突', severity: 'high', quote: '王坚已死', issue: '细纲与既定事实矛盾，人物不该在场', fix: '按史实改细纲' },
  ]);
  assert.equal(stamped[0].proseFix, true);
  assert.equal(stamped[1].proseFix, undefined);
  assert.equal(hasOutlineRootIssue({ issues: stamped }), true, '真正的事实时间线仍算细纲根因');
  assert.equal(auditIssueRepairMode({
    verdict: 'fix',
    issues: [{ type: '时间线冲突', severity: 'high', quote: '晨雾', issue: '缺跨年标记', fix: '开头写次年' }],
  }), 'revise');
});

test('V0.102.4 章首接续标记与跨年冲突也是正文可修，不是整章重规划', () => {
  const issues = detectTimelineAnchorConflict({
 headText: '翌日天还没亮，主角就摸到北崖墙根。',
    year: 1259,
    prevYear: 1258,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].proseFix, true);
  assert.equal(hasOutlineRootIssue({ issues }), false);
});

test('V0.102.4 遗体跨年等连续性硬伤不得被当成开篇形态问题', () => {
  const stamped = stampOpeningTimelineProseFix([{
    type: '时间线冲突', severity: 'high',
    quote: '草席里的弟弟',
    issue: '跨年后仍携带完整遗体',
    fix: '改为骨殖或安葬',
  }]);
  assert.equal(stamped[0].proseFix, undefined);
});

test('V0.102.4 LLM 直接判 replan 但只有开篇时间线时降为 revise', () => {
  const next = normalizeAuditForRepair({
    verdict: 'replan',
    issues: [{ type: '时间线冲突', severity: 'high', quote: '晨雾', issue: '跨年开篇没有年号', fix: '开头补开庆元年' }],
  });
  assert.equal(next.verdict, 'fix');
  assert.equal(next.issues[0].proseFix, true);
  assert.equal(auditIssueRepairMode(next), 'revise');
});

test('V0.102.4 真正的细纲时间线 LLM replan 保持', () => {
  const next = normalizeAuditForRepair({
    verdict: 'replan',
    issues: [{ type: '时间线冲突', severity: 'high', quote: '王坚', issue: '细纲与既定事实矛盾', fix: '按史实改细纲' }],
  });
  assert.equal(next.verdict, 'replan');
  assert.equal(hasOutlineRootIssue(next), true);
});
