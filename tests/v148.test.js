// V0.95.5 过渡式阶段任务概念分词根修（ch27 重规划 5 连败卡章实证）
// 现场（8/16 16:25-16:45）：audit 判 replan → 重规划候选 5 版细纲全部被
// historicalOutlineIssues 驳回（OUTLINE_GUARD_FAILED）→ pilot 停机。
// 根因：阶段任务「从执行者到布防者的过渡起点」在 PHASE_CONCEPTS 无命中、
// 无连接词可切 → phaseConcepts 退化为单一概念=整句 13 字精确匹配——
// 候选只要把「过渡起点」写成「转变/转型」即全灭（模型无法猜到必须逐字抄写）。
// 修复：结构分词——「从A到B[的C]」→ 概念 [A,B,C]；无分隔长短语按「的」切分。
// 概念命中阈值（≥60%）不变：两端点概念在场才算落实，真正换题仍拦截。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import { phaseCoveredByText, historicalOutlineIssues } from '../server/engine/longform/historical_guardrails.js';

const PHASE = '从执行者到布防者的过渡起点';

describe('V0.95.5 过渡式阶段任务分词', () => {
  test('RED→GREEN：同义改写（转变/转型）应通过——两端点概念在场即落实', () => {
    // ch27 五连败形态：候选把「过渡起点」写成「转变」，两端点都在
    assert.equal(
 phaseCoveredByText(PHASE, '主角向王坚汇报新线获准设障，完成从执行者到布防者的转变，开始独立布防'),
      true,
      '「从执行者到布防者的转变」含 执行者+布防者 两端点概念，应判已落实（此前整句精确匹配误杀）',
    );
    assert.equal(
      phaseCoveredByText(PHASE, '本章完成由执行者转为布防者的过渡，隘口设障是其起点'),
      true,
      '「由执行者转为布防者」两端点在场，应通过',
    );
  });

  test('逐字原文与既有单概念语义不变（防放松过度）', () => {
    // 逐字抄写始终通过（第一分支）
    assert.equal(phaseCoveredByText(PHASE, '完成从执行者到布防者的过渡起点'), true);
    // 真正换题（两端点均不在场）仍拦截——防线语义保持
    assert.equal(
 phaseCoveredByText(PHASE, '主角在营地整理账册，与降将核对货单，发现竹管线索'),
      false,
      '无 执行者/布防者 任何端点概念 → 判未落实（换题仍拦）',
    );
    // 只有一个端点概念（1/3 < 阈值 2）不算完成过渡——单提"布防者"不提来源与转变
    assert.equal(
 phaseCoveredByText(PHASE, '主角布防者身份确立，众人称他布防者'),
      false,
      '仅 布防者 一个概念（1/3 < 2）→ 判未落实：过渡任务须两端点在场',
    );
    // 两端点在场、第三概念改写 → 2/3 ≥60% 达标（本修复的核心语义）
    assert.equal(
 phaseCoveredByText(PHASE, '主角不再是单纯的执行者，布防者的担子落在他肩上'),
      true,
      '执行者+布防者 两概念在场（2/3）→ 判已落实',
    );
  });

  test('historicalOutlineIssues：改写版细纲不再被驳回（ch27 五连败场景闭环）', () => {
    const paraphrased = {
      phase: PHASE,
 scenes: [{ beat: '主角向王坚汇报新线获准负责隘口设障，完成从执行者到布防者的转变' }],
 checkpoints: ['主角获准设障，由执行者转为布防者，隘口钉下第一根桩'],
    };
    assert.deepEqual(historicalOutlineIssues(paraphrased), [],
      '改写但两端点概念在场的细纲应通过硬防线（此前 5 连败根因）');
    const offTopic = {
      phase: PHASE,
 scenes: [{ beat: '主角在重庆城中采买皮料，与郑货郎周旋' }],
 checkpoints: ['主角带回一捆皮料'],
    };
    assert.ok(historicalOutlineIssues(offTopic).length === 1, '真正换题的细纲仍被拦截');
    assert.ok(historicalOutlineIssues(offTopic)[0].issue.includes('没有落实到'), '拦截信息保持');
  });

  test('分词对既有连接词/已知概念路径零影响（回归）', () => {
    // 已知概念表路径（安葬/安置）不受结构分词影响
    assert.equal(phaseCoveredByText('安葬与安置，建立生存根基', '众人将他下葬，留在营中落脚'), true);
    // 连接词切分路径保持
    assert.equal(phaseCoveredByText('扩编、核线、内奸线布局', '完成扩编与核线，内奸线布局就位'), true);
    // 短语无结构可切仍走整句匹配
    assert.equal(phaseCoveredByText('巡逻队带队考验', '通过巡逻队带队考验'), true);
    assert.equal(phaseCoveredByText('巡逻队带队考验', '带队出巡通过考验'), false);
  });
});
