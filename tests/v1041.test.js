// V0.104.1：章细纲硬闸不得把文学结果口号当精确抄写；补写失败不得立刻再烧一轮。
// 实证：第 37 章《血染干沟》phase「受挫并付代价，确立新战术逻辑」被切成两段精确短语，
// 模型写干沟死伤/改打法仍 3×2 轮 OUTLINE_GUARD_FAILED，补写吞错后主循环立刻重开。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isPlanningMetaPhase, historicalOutlineIssues, phaseCoveredByText, formatPhaseDutyRule,
} from '../server/engine/historical_guardrails.js';
import { futureOutlineBase } from '../server/engine/narrative_state.js';
import { mergeHistoricalChapterFrame } from '../server/engine/historical_longform.js';

const SLOGAN_PHASE = '受挫并付代价，确立新战术逻辑';
const BATTLE_BEAT = '干沟里第一拨夜摸队被砲石砸散，主角没拦住柳二，人拖下去时枪头还卡在泥里。王坚改口令：不再沿沟底对射，改从北崖侧后打灯诱其露头。';
const BATTLE_CHECKPOINT = '干沟夜袭折损已成事实；北崖改诱敌、不再沿沟底对射';

test('V0.104.1 受挫付代价/确立战术逻辑是文学结果口号，临战收网不是', () => {
  assert.equal(isPlanningMetaPhase(SLOGAN_PHASE), true);
  assert.equal(isPlanningMetaPhase('临战收网'), false);
  assert.equal(isPlanningMetaPhase('百姓进寨'), false);
});

test('V0.104.1 换版丢掉口号 phase，不把口号锁进下一章细纲', () => {
  const dropped = futureOutlineBase({
    year: 1259, era_year: '开庆元年', protagonist_age: 27,
    phase: SLOGAN_PHASE, goal: '应被丢掉的动态目标',
  });
  assert.equal(dropped.year, 1259);
  assert.equal(dropped.phase, undefined);
  const kept = futureOutlineBase({ year: 1258, phase: '临战收网' });
  assert.equal(kept.phase, '临战收网');
});

test('V0.104.1 口号 phase 不要求 scene.beat 逐字抄写，干沟死伤细纲应通过', () => {
  const outline = {
    phase: SLOGAN_PHASE,
    year: 1259,
    protagonist_age: 27,
    scenes: [{ beat: BATTLE_BEAT }],
    checkpoints: [BATTLE_CHECKPOINT],
  };
  assert.deepEqual(historicalOutlineIssues(outline), [],
    '文学结果口号不得因未抄「受挫并付代价」整词而驳回已有死伤/改打法的细纲');
  assert.equal(formatPhaseDutyRule(SLOGAN_PHASE), '',
    '指令不得把口号列成必须落实的在场动作');
});

test('V0.104.1 规划套话里若有在场动作，仍核验动作而不是口号', () => {
  const phase = '成长补救：主动争取条件，尝试越权';
  assert.equal(
 phaseCoveredByText(phase, '主角请领北崖临时调度，越权把干沟封死等王坚追认'),
    true,
  );
 assert.equal(phaseCoveredByText(phase, '主角把墙基尺寸记入工册交差'), false);
  const off = {
    phase,
 scenes: [{ beat: '主角把墙基尺寸记入工册交差' }],
    checkpoints: ['工册已更新'],
  };
  assert.equal(historicalOutlineIssues(off).length, 1);
});

test('V0.104.1 过渡式阶段与无动作换题仍拦截（ch27 合同不回退）', () => {
  const phase = '从执行者到布防者的过渡起点';
  const offTopic = {
    phase,
 scenes: [{ beat: '主角在重庆城中采买皮料，与郑货郎周旋' }],
 checkpoints: ['主角带回一捆皮料'],
  };
  assert.equal(historicalOutlineIssues(offTopic).length, 1);
});

test('V0.104.1 卷名钓鱼城头不是在场动作，不得当精确抄写硬闸', () => {
  const outline = {
    phase: '钓鱼城头',
    scenes: [{ beat: BATTLE_BEAT }],
    checkpoints: [BATTLE_CHECKPOINT],
  };
  assert.deepEqual(historicalOutlineIssues(outline), [],
    '卷阶段标题不能逼细纲把「钓鱼城头」四字抄进 beat');
  assert.equal(formatPhaseDutyRule('钓鱼城头'), '');
  assert.equal(phaseCoveredByText('临战收网', '北崖临战收网，干沟不再对射'), true,
    '临战仍是围城类在场动作，合同不回退');
});

test('V0.104.1 merge 不得用口号或卷名覆盖模型已写的在场阶段', () => {
  const merged = mergeHistoricalChapterFrame(
    { phase: '干沟夜袭，改诱敌打法', scenes: [{ beat: BATTLE_BEAT }] },
    { year: 1259, era_year: '开庆元年', protagonist_age: 27, phase: SLOGAN_PHASE },
    { title: '钓鱼城头', startYear: 1259 },
  );
  assert.equal(merged.year, 1259);
  assert.equal(merged.protagonist_age, 27);
  assert.notEqual(merged.phase, SLOGAN_PHASE);
  assert.notEqual(merged.phase, '钓鱼城头');
  assert.match(String(merged.phase), /干沟|诱敌|夜袭/);
  const emptyModel = mergeHistoricalChapterFrame(
    { scenes: [{ beat: BATTLE_BEAT }] },
    { year: 1259, phase: SLOGAN_PHASE },
    { title: '钓鱼城头', startYear: 1259 },
  );
  assert.notEqual(emptyModel.phase, '钓鱼城头');
  assert.notEqual(emptyModel.phase, SLOGAN_PHASE);
});

test('V0.104.1 硬校验失败事件必须带上具体原因，禁止只说正在重做', () => {
  const src = fs.readFileSync('server/engine/outline.js', 'utf8');
  assert.match(src, /lastFailReason/, '重做细纲必须把未通过项注入下一轮');
  assert.match(src, /历史阶段或人物权限未通过硬校验[\s\S]{0,80}lastFailReason/,
    '界面事件必须带上具体硬校验原因，否则只会看见空转重做');
});

test('V0.104.1 补写遇到质量门必须落 quality_blocked，不得吞错让主循环立刻再烧一轮', () => {
  const pilot = fs.readFileSync('server/engine/pilot.js', 'utf8');
  const at = pilot.indexOf('ch.idx > maxDone + 1');
  assert.ok(at > 0, '应能定位缺章补写');
  const slice = pilot.slice(at, at + 1800);
  assert.match(slice, /chapterFailurePolicy/, '补写 catch 必须走章节失败策略');
  assert.match(slice, /qualityStop/, '质量门失败要停在卡章，不能静默 delete seen');
  assert.doesNotMatch(slice, /catch\s*\{\s*seen\.delete/, '不得再空 catch 吞掉 OUTLINE_GUARD_FAILED');
});

test('V0.104.1 非历史题材不走阶段任务硬闸（零影响）', () => {
  const outlineJs = fs.readFileSync('server/engine/outline.js', 'utf8');
  assert.match(outlineJs, /book\.genre === '历史'/);
  assert.match(outlineJs, /historicalOutlineIssues/);
});

test('V0.105 战后清理/政治压力初现是文学结果口号，不得逼细纲逐字抄写', () => {
  const phase = '战后清理与政治压力初现';
  assert.equal(isPlanningMetaPhase(phase), true);
  assert.equal(formatPhaseDutyRule(phase), '');
  const outline = {
    phase,
 scenes: [{ beat: '主角带着火工营清点断桅残骸，把还能用的钉和绳分给北崖夜哨。合州转来的公事只让他在军册边角画了一笔，没有当场辩驳。' }],
    checkpoints: ['断桅残骸已清点分发；合州公事只入册未争辩'],
  };
  assert.deepEqual(historicalOutlineIssues(outline), []);
});

test('V0.105 朝堂权谋介入战场是文学结果口号，不得逼细纲逐字抄写', () => {
  const phase = '朝堂权谋介入战场';
  assert.equal(isPlanningMetaPhase(phase), true);
  assert.equal(formatPhaseDutyRule(phase), '');
  const outline = {
    phase,
 scenes: [{ beat: '合州来人把公事摊在北崖灯下，要主角按册交差，不让他过问江面船帆。' }],
    checkpoints: ['合州公事已摊开；江面船帆暂不得过问'],
  };
  assert.deepEqual(historicalOutlineIssues(outline), []);
});

test('V0.105 斜杠分类标签不是在场动作，不得切成精确短语逼抄', () => {
  const phase = '情感事件/权力交接前奏';
  assert.equal(isPlanningMetaPhase(phase), true);
  assert.equal(formatPhaseDutyRule(phase), '');
  const outline = {
    phase,
 scenes: [{ beat: '王坚咳得说不完一句，把一叠未公开的手札按进主角手里，要他先补北崖暗门那一截。' }],
 checkpoints: ['未公开手札已交到主角手里'],
  };
  assert.deepEqual(historicalOutlineIssues(outline), [],
    '不得因未抄「情感事件」或「权力交接前奏」驳回已有托付动作的细纲');
  assert.equal(isPlanningMetaPhase('军事行动/新区域展开'), true);
  assert.equal(formatPhaseDutyRule('军事行动/新区域展开'), '');
  assert.equal(isPlanningMetaPhase('越权/请领临时调度'), false,
    '斜杠两侧仍是在场动作时必须继续核验');
  assert.equal(
    phaseCoveredByText('守规参与警戒，学会信息交接', '夜哨警戒异常，少年只负责传讯和信息交接。'),
    true,
    '信息交接动作合同不回退；权力交接不再误命中交接',
  );
});

test('V0.105 卷内文学结果短标签不得当硬闸（信任危机/战略预警/历史转折）', () => {
  for (const phase of ['内部信任危机', '战略预警', '重大历史转折', '政治博弈', '阵营内部整顿']) {
    assert.equal(formatPhaseDutyRule(phase), '', `${phase} 不得列入必须落实的在场动作`);
    assert.deepEqual(historicalOutlineIssues({
      phase,
 scenes: [{ beat: '主角把工册翻到昨夜那页，把烧黑的边角按住，问阿蛮是谁动过火折。' }],
      checkpoints: ['工册烧痕已当场核问'],
    }), [], `${phase} 不得逼抄分类标签`);
  }
});
