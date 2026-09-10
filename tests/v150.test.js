// V0.95.7 正文形态问题修订路由根修 + 跨年开篇写侧硬闸（ch27 重规划 3 轮耗尽卡章实证）
// 现场（8/16 17:29-17:40 事件流）：重规划候选细纲通过（V0.95.6 愈合生效）→ 重写正文 →
// 审校再报「时间线冲突」（跨年开篇缺标记，正文开头"晨雾…"氛围铺陈）/「事实矛盾」（场景尾 22 字复述）
// → 两类问题都被 OUTLINE_ROOT_ISSUES 路由成 replan 整章重写 → 新正文犯同样毛病 → 3 轮耗尽停机。
// 根因：这两类是本地确定性检测的正文形态问题（开头补一句跨年/删一段复述即可），修订可解，
// 却被当成"细纲根因"推倒重写——重写必然重新掷骰子，结构性卡死。
// 修复：① proseFix 标记（crossYearOpeningIssue/场景尾复述）→ 管线路由 revise 不 replan；
// ② 跨年开篇检查抽为单一真源 crossYearOpeningIssue（写审同源）；③ 写侧场景1硬闸（醒目指令块 +
// 写后核查定向重写 1 次）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import './helper.js';
import {
  crossYearOpeningIssue, historicalContinuityIssues,
} from '../server/engine/historical_guardrails.js';
import { detectSceneTailDuplication } from '../server/engine/rules.js';
import { hasOutlineRootIssue, auditIssueRepairMode } from '../server/engine/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ch27 实证开头（氛围铺陈，无跨年标记）
const ATMOS_OPENING = '晨雾像一匹没洗透的旧布，挂在营墙和树梢之间，湿漉漉的。三人撤回营地时，靴底的泥在帐外刮了三道，才刮得干净。主角没回自己帐里，靠着营墙根坐下，把工册摊在膝上。';

describe('V0.95.7 跨年开篇单一真源（crossYearOpeningIssue）', () => {
  test('RED→GREEN：氛围开头跨年章 → 报 issue 且带 proseFix（不再被路由 replan）', () => {
    const issue = crossYearOpeningIssue(1254, 1253, ATMOS_OPENING);
    assert.ok(issue, 'ch27 实证氛围开头应被判缺跨年标记');
    assert.equal(issue.type, '时间线冲突');
    assert.equal(issue.severity, 'high');
    assert.equal(issue.proseFix, true, '正文级可修问题必须带 proseFix 标记');
  });

  test('合格开头 / 非跨年章 → null（零误报）', () => {
 assert.equal(crossYearOpeningIssue(1254, 1253, '次年开春，宝祐二年的雪化得早，工地的木桩冒出了新茬。主角蹲下身，指腹抚过桩顶。'), null,
      '开头有"次年开春/宝祐二年"明确跨年标记，应通过');
    assert.equal(crossYearOpeningIssue(1253, 1253, ATMOS_OPENING), null, '同年章不检查跨年开篇');
    assert.equal(crossYearOpeningIssue(1254, null, ATMOS_OPENING), null, '无上章年份不检查');
  });

  test('historicalContinuityIssues 复用单一真源（回归：审侧检测语义不变）', () => {
    const issues = historicalContinuityIssues({ genre: '历史', year: 1254, previousYear: 1253, chapterText: ATMOS_OPENING });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].proseFix, true, '审侧同源带 proseFix');
    assert.ok(issues[0].issue.includes('跨年'), '拦截信息保持');
  });
});

describe('V0.95.7 修订路由：proseFix 走 revise 不走 replan', () => {
  test('hasOutlineRootIssue：proseFix 形态问题不算细纲根因；无标记的 LLM 时间线冲突仍算', () => {
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '时间线冲突', severity: 'high', proseFix: true }] }), false,
      '跨年开篇缺失是正文级问题，不应触发整章重写');
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '时间线冲突', severity: 'high' }] }), true,
      'V0.78 语义保持：LLM 判定的细纲-事实时间线冲突仍路由 replan');
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '事实矛盾', severity: 'high', proseFix: true }] }), false,
      '场景尾复述同理');
  });

  test('auditIssueRepairMode：proseFix high → revise（ch27 卡死场景闭环）', () => {
    assert.equal(auditIssueRepairMode({
      verdict: 'fix',
      issues: [{ type: '时间线冲突', severity: 'high', proseFix: true, quote: '晨雾', issue: '缺跨年标记', fix: '开头补次年' }],
    }), 'revise', '应走正文最小修订而非 replan（此前 3 轮 replan 耗尽卡死）');
    assert.equal(auditIssueRepairMode({
      verdict: 'fix',
      issues: [{ type: '时间线冲突', severity: 'high', quote: '', issue: '细纲与既定事实矛盾', fix: '' }],
    }), 'replan', '细纲根因问题 replan 路由保持');
  });

  test('detectSceneTailDuplication：场景尾复述 issue 带 proseFix（仍 high）', () => {
    const SHARED = '把石片斜向重新摆好每一块都压进沙面半指再用浮土盖住';
    const filler = '青灰色的雾贴着地面流转盖住桩基与绳尺'.repeat(20);
    const scenes = [
      { idx: 1, content: filler + SHARED },
      { idx: 2, content: SHARED + '之后众人才收工回营各自去领新配的口粮与冬衣'.repeat(15) },
    ];
    const issues = detectSceneTailDuplication(scenes);
    assert.ok(issues.length >= 1, '场景尾复述应被检出（≥18 归一字连续复述）');
    assert.equal(issues[0].severity, 'high');
    assert.equal(issues[0].proseFix, true, '删复述段即可解决，正文修订路由');
  });
});

describe('V0.95.7 写侧硬闸接线（源断言：写审同源）', () => {
  test('write.js 场景1跨年门：醒目指令块 + 写后核查定向重写', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/write.js'), 'utf8');
    assert.ok(src.includes('crossYearOpeningIssue(outlineYear, prevYear, content)'),
      '场景1写完后应用与审校同一把尺子核查跨年开篇');
    assert.ok(src.includes('跨年开篇标记缺失，定向重写场景开头'),
      '核查不答应触发定向重写（1 次，不硬拦——审侧 proseFix 修订兜底）');
    assert.ok(src.includes('crossYearOpeningRule'),
      '跨年开篇硬要求独立成醒目块注入写作指令');
  });

  test('prompts.js 渲染独立硬要求块（不再埋在坐标帧长行里）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(src.includes('【跨年开篇硬要求（本地校验逐字核查，不满足将被驳回重写）】'),
      '跨年章场景1指令应有独立醒目硬要求块');
  });

  test('pipeline.js locallyRepairable 尊重 proseFix（源断言）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline.js'), 'utf8');
    assert.ok(src.includes('i.proseFix'), 'fix 分支的可修过滤应放行 proseFix 形态问题');
  });
});
