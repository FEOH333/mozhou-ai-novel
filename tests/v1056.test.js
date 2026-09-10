// V0.105.6 复合短语动作核：连接词切出的 ≥4 字复合短语（北崖善后/粮道破局）此前
// 只做字面精确匹配，模型写进 beat 的同义在场动作（清理余波/私盐引换粮）全被判负
// → 实测 ch53 细纲三连败 OUTLINE_GUARD_FAILED 卡章。修复：字面 + 尾部 2 字动作核
// 双层命中；formatPhaseDutyRule 同步告知模型可写动作核（写审同源）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = process.cwd();
const g = await import(pathToFileURL(path.join(ROOT, 'server/engine/historical_guardrails.js')));

const PHASE = '北崖善后与粮道破局';

describe('V0.105.6 复合短语动作核匹配', () => {
  test('①事故复现：同义在场动作（清理余波/私盐引换粮）不得再被判未落实', () => {
    // ch53 卷纲 beat 的实际写法：善后=清理周大牛案余波；粮道破局=私盐引换荆襄粮
    const scenes = [
 { beat: '主角在北崖清理周大牛案余波，处置私兵名录，面临合州军粮见底危机。' },
      { beat: '他决定启用私盐引换取荆襄粮食，秦月质疑其越法，两人爆发激烈争吵后冷战。' },
    ];
    const checkpoints = ['北崖案卷善后完毕，名录封存', '粮道以盐引破局，首批荆襄粮启运'];
    const issues = g.historicalOutlineIssues({ phase: PHASE, scenes, checkpoints });
    assert.deepEqual(issues, [], `同义在场动作应放行（实际 ${JSON.stringify(issues.map(i => i.issue))}）`);
  });

  test('②真换题仍拦截：善后与粮道全部不在场', () => {
    const scenes = [
 { beat: '蒙古前锋夜袭渠江口，主角带水军伏击敌船，焚其粮船三艘。' },
 { beat: '王坚苏醒，与主角彻夜对弈，商议来年开春的北伐方略。' },
    ];
    const checkpoints = ['渠江口水战告捷', '北伐方略初定'];
    const issues = g.historicalOutlineIssues({ phase: PHASE, scenes, checkpoints });
    assert.ok(issues.length >= 1, '善后/破局全不在场必须判换题拦截');
    assert.match(issues[0].issue, /没有落实到/);
  });

  test('③单调放松回归：字面命中照旧、旧概念词表不受影响', () => {
    // 已知词表概念（难民/围城）同义命中照旧
    const ok = g.phaseCoveredByText('难民安置', '流民入寨，各自落脚');
    assert.ok(ok, '词表概念同义命中应保持');
    // 字面直接命中的复合短语
 assert.ok(g.phaseCoveredByText(PHASE, '主角完成北崖善后，随即部署粮道破局之策'));
    // 整句 phase 原文包含
    assert.ok(g.phaseCoveredByText(PHASE, '本章落实北崖善后与粮道破局两项任务'));
  });

  test('④写审同源：formatPhaseDutyRule 告知域内窗匹配', () => {
    const rule = g.formatPhaseDutyRule(PHASE);
    assert.match(rule, /北崖善后、粮道破局/, '应列出复合任务全文');
    assert.match(rule, /两字词根\/动作核在场即视为同域/, '应告知域内窗核验（写审一把尺）');
    // 词表概念不加切分窗提示（回归：不加噪音）
    const plain = g.formatPhaseDutyRule('难民安置');
    assert.doesNotMatch(plain, /两字词根/);
  });

  test('⑤源码断言：切分概念窗匹配与零交集拦截分工', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/historical_guardrails.js'), 'utf8');
    assert.ok(src.includes('function slidingWindowMatcher'), '切分短语应有 2 字滑窗域内匹配器');
    assert.ok(src.includes('function literalMatcher'), '过渡式/单概念应保持字面匹配器');
    assert.ok(src.includes("mode === 'cut'"), '词表/过渡式/切分概念应分流命中要求');
  });
});
