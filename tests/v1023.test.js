// V0.102.3：卷缝章的阶段任务不得把规划套话当成必须抄进 beat 的原文。
// 实证：第 35 章 6 次细纲全部 OUTLINE_GUARD_FAILED——
// phase「接住上卷出口，建立新压力源（难民+围城前夕）」被切成精确短语，
// 模型写进寨/入蜀/合围仍被驳回，全书停在 34 章。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { phaseCoveredByText, historicalOutlineIssues } from '../server/engine/longform/historical_guardrails.js';

const SEAM_PHASE = '接住上卷出口，建立新压力源（难民+围城前夕）';

test('V0.102.3 规划套话+括号压力源：进寨与合围同义即落实，不必抄接住上卷出口', () => {
  assert.equal(
 phaseCoveredByText(SEAM_PHASE, '主角把北崖让给入城百姓进寨，塘报称蒙军已合围钓鱼城'),
    true,
    '括号内难民+围城前夕的同义事件在场即落实',
  );
  assert.equal(
    phaseCoveredByText(SEAM_PHASE, '军报入蜀，流民沿干沟撤入山城，临战检查开始'),
    true,
  );
  assert.equal(
 phaseCoveredByText(SEAM_PHASE, '主角观察门槛水珠并记入工册，等候王坚复核'),
    false,
    '观察-记录微循环未触及难民/围城，仍算换题',
  );
});

test('V0.102.3 细纲硬闸：同义落实的 scenes 通过，观察记册仍驳回', () => {
  const ok = {
    phase: SEAM_PHASE,
    scenes: [{ beat: '百姓连夜进寨，北崖改作临战警戒，合围前夕的第一批难民占满干沟' }],
    checkpoints: ['难民进寨完成，围城前夕压力落地'],
  };
  assert.deepEqual(historicalOutlineIssues(ok), []);

  const off = {
    phase: SEAM_PHASE,
 scenes: [{ beat: '主角蹲在门槛上看水珠，把脚印写入工册' }],
    checkpoints: ['工册已更新'],
  };
  assert.equal(historicalOutlineIssues(off).length, 1);
  assert.match(historicalOutlineIssues(off)[0].issue, /没有落实到/);
});

test('V0.102.3 冒号规划前缀不要求抄成长补救', () => {
  const phase = '成长补救：主动争取条件，尝试越权';
  assert.equal(
 phaseCoveredByText(phase, '主角请领北崖临时调度，越权把干沟封死等王坚追认'),
    true,
  );
  assert.equal(
 phaseCoveredByText(phase, '主角把墙基尺寸记入工册交差'),
    false,
  );
});

test('V0.102.3 既有连接词与过渡式分词零回归', () => {
  assert.equal(phaseCoveredByText('安葬与安置，建立生存根基', '众人将他下葬，留在营中落脚'), true);
  assert.equal(
 phaseCoveredByText('从执行者到布防者的过渡起点', '主角不再是单纯的执行者，布防者的担子落在他肩上'),
    true,
  );
});

test('V0.102.3 章纲指令列出可核验动作而非要求抄规划套话', () => {
  const src = fs.readFileSync('server/engine/prompts.js', 'utf8');
  assert.match(src, /formatPhaseDutyRule|phaseDutyRule/);
  assert.match(src, /规划套话|不必抄写/);
});

test('V0.102.3 非历史题材不走阶段任务硬闸（零影响）', () => {
  const outlineJs = fs.readFileSync('server/engine/planning/outline.js', 'utf8');
  assert.match(outlineJs, /book\.genre === '历史'/);
  assert.match(outlineJs, /historicalOutlineIssues/);
});
