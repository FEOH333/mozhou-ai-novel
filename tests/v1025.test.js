// V0.102.5：审校把正文可修问题标成细纲根因时，不得清掉已写场景。
// 实证：第 35 章五场写完后，LLM 把「第31章」元话语标成 high 大纲偏离，
// 把「细纲写情报、草稿写成引火物」标成事实矛盾，管线立刻 replan。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stampOpeningTimelineProseFix, crossYearOpeningIssue } from '../server/engine/longform/historical_guardrails.js';
import { hasOutlineRootIssue, auditIssueRepairMode, normalizeAuditForRepair } from '../server/engine/pipeline/pipeline.js';

test('V0.102.5 开庆元年开篇是合格跨年标记，不得再报缺过渡', () => {
 const opening = '开庆元年的风还没吹透北崖墙根的冻土，寨门外泥地里已陷进几百双脚。主角站在门内阴影处，手里攥着保甲名册。';
  assert.equal(crossYearOpeningIssue(1259, 1258, opening), null);
});

test('V0.102.5 正文点出第N章的大纲偏离是措辞问题，走 revise', () => {
  const issues = stampOpeningTimelineProseFix([{
    type: '大纲偏离', severity: 'high',
    quote: '他在第31章见过这种手法。',
    issue: '正文叙述中直接出现了章节编号“第31章”，严重破坏沉浸感，违反禁止元话语的规定。细纲要求发现枯枝标记，草稿将其具体化为回忆前文章节。',
    fix: '改成回忆鸡爪滩粮道的折痕，不要写第31章',
  }]);
  assert.equal(issues[0].proseFix, true);
  assert.equal(hasOutlineRootIssue({ issues }), false);
  assert.equal(auditIssueRepairMode({ verdict: 'fix', issues }), 'revise');
});

test('V0.102.5 细纲与草稿用词不一致是改稿，不是整章重规划', () => {
  const issues = stampOpeningTimelineProseFix([{
    type: '事实矛盾', severity: 'high',
    quote: '里面是一团揉皱的麻絮，浸透了某种腥臭的油脂。',
    issue: '细纲明确设定男孩企图钻出墙缝传递情报以换取白米。草稿将物品改为引火物。',
    fix: '把引火物改回情报载体',
  }]);
  assert.equal(issues[0].proseFix, true);
  assert.equal(hasOutlineRootIssue({ issues }), false);
});

test('V0.102.5 回忆不是携带遗体；角色伤势出场是改这一处', () => {
  const stamped = stampOpeningTimelineProseFix([
    {
      type: '时间线冲突', severity: 'high',
      quote: '瞬间，他想起九岁那年跪在马前的场景，想起弟弟冰冷的手指。那时候，没有人给他这样的遮挡。',
      issue: '正文明确跨过数月或季节，却仍把未防腐遗体写成可辨面容、头发或肢体的完整状态，且章节已跨年。',
      fix: '改为骨殖或安葬',
    },
    {
      type: '事实编造', severity: 'high',
      quote: '阿蛮没说话，只是死死盯着老周头的铁锹，另一只手按在腰间的短刀柄上。',
      issue: '角色状态不符。根据角色当前状态，阿蛮此前箭伤未愈，直接出现在前线按刀不符合伤势受限。',
      fix: '让阿蛮跛着或改由陈七按刀',
    },
  ]);
  assert.equal(stamped[0].proseFix, true, '回忆引文没有遗体，不得当连续性硬伤');
  assert.equal(stamped[1].proseFix, true);
  assert.equal(hasOutlineRootIssue({ issues: stamped }), false);
});

test('V0.102.5 回忆弟弟手指不得判携带遗体', async () => {
  const { historicalContinuityIssues } = await import('../server/engine/longform/historical_guardrails.js');
 const text = '开春的风灌进寨门。主角站在门槛边，瞬间想起九岁那年跪在马前的场景，想起弟弟冰冷的手指。那时候，没有人给他这样的遮挡。';
  const issues = historicalContinuityIssues({ genre: '历史', year: 1259, previousYear: 1258, chapterText: text });
  assert.equal(issues.filter(i => /遗体/.test(i.issue || '')).length, 0);
});

test('V0.102.5 真正要改细纲的事实矛盾仍 replan', () => {
  const next = normalizeAuditForRepair({
    verdict: 'fix',
    issues: [{
      type: '事实矛盾', severity: 'high',
      quote: '王坚已死',
      issue: '细纲与既定事实矛盾，人物不该在场，应重做细纲',
      fix: '重新规划本章，按史实改细纲',
    }],
  });
  assert.equal(next.issues[0].proseFix, undefined);
  assert.equal(hasOutlineRootIssue(next), true);
  assert.equal(auditIssueRepairMode(next), 'replan');
});
