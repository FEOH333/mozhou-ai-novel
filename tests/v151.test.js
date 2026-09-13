// V0.95.8 山河尺度分层纪律（调研驱动：docs/历史磅礴感与山河尺度调研报告.md）
// 用户定调："文风和描写会不会不够大气、不太有历史的磅礴感？像在写求生冒险文？
// 前期可以写的收一点，但中后期随着主角身份、眼界的提高以及大局展开，应当写大气一些。"
// 实测 26 章实证：微观白描过硬但只有一个焦距；ch26《北望长河》全章在灵帐对账页，"长河"零出现。
// 机制根因：povScale 只作为上限注入卷纲（"禁止跳脑"），从未作为递增要求进入写作/审校。
// 修复：四层尺度配额（远景一瞥→中景→全景段+数字重量+地理俯瞰→群像+史笔），
// 写作/细纲/审校三处同源注入（一把尺）；仅结构化长篇生效，其他书零影响。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import './helper.js';
import {
  historicalScaleTier, historicalScaleRegisterText, historicalScaleBeatRule,
} from '../server/engine/longform/historical_longform.js';
import * as prompts from '../server/engine/prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = { title: '示例历史长篇' };
const PHASE4 = { title: '风雨欲来', povScale: '一城、数寨与四川防区' };

describe('V0.95.8 山河尺度分层', () => {
  test('层级映射：卷1-2→1 / 卷3-4→2 / 卷5-8→3 / 卷9-15→4（对应用户"前期收、中后期放大"）', () => {
    assert.equal(historicalScaleTier(1), 1);
    assert.equal(historicalScaleTier(2), 1);
    assert.equal(historicalScaleTier(3), 2);
    assert.equal(historicalScaleTier(4), 2);
    assert.equal(historicalScaleTier(5), 3);
    assert.equal(historicalScaleTier(8), 3);
    assert.equal(historicalScaleTier(9), 4);
    assert.equal(historicalScaleTier(15), 4);
  });

  test('纪律文本：每层禁-正例-量化齐备，且配额随层递增（收→放单调不减）', () => {
    const t1 = historicalScaleRegisterText(1, PHASE4);
    const t2 = historicalScaleRegisterText(4, PHASE4);
    const t3 = historicalScaleRegisterText(6, PHASE4);
    const t4 = historicalScaleRegisterText(12, PHASE4);
    for (const [t, name] of [[t1, '第1层'], [t2, '第2层'], [t3, '第3层'], [t4, '第4层']]) {
      assert.ok(t.includes('【山河尺度纪律'), `${name}应有纪律标题`);
      assert.ok(/禁：/.test(t) && /正例/.test(t) && /量化：/.test(t), `${name}须禁-正例-量化三件齐备`);
    }
    assert.ok(t2.includes('中景') && t2.includes('粮册'), '第2层应要求中景+具体载体（军报/粮册/长官之口）');
    assert.ok(t3.includes('全景段') && t3.includes('数字的重量') && t3.includes('地理俯瞰'), '第3层应有全景段/数字重量/地理俯瞰三配额');
    assert.ok(t4.includes('群像') && t4.includes('史笔'), '第4层应加群像+史笔');
    assert.ok(t1.includes('远景一瞥'), '第1层应是远景一瞥（前期收）');
    assert.ok(t1.includes('微观白描为主基调'), '第1层不许丢微观白描功力（防矫枉过正）');
  });

  test('写审同源总纲在位 + povScale 上限兼容（拉远仍是主角的眼睛在看，不跳脑）', () => {
    const t3 = historicalScaleRegisterText(6, PHASE4);
    assert.ok(t3.includes('写作与审校同一把尺'), '纪律文本须声明写审同源');
    assert.ok(t3.includes('镜头拉远，仍是他的眼睛在看'), '全景须保持贴身限知（与 povScale 上限兼容）');
    assert.ok(t3.includes('一城、数寨与四川防区'), '本卷视野尺度（povScale）应注入纪律头部');
    assert.ok(t3.includes('式形容词'), '总纲须示范"禁形容词式大气"——"气势磅礴"只作为反面例出现（大气=镜头拉远后的具体）');
  });

  test('非结构化长篇零影响：phase 为空返回空串（其他书/非历史书不注入）', () => {
    assert.equal(historicalScaleRegisterText(4, null), '');
    assert.equal(historicalScaleRegisterText(4, undefined), '');
    assert.equal(historicalScaleBeatRule(4, null), '');
  });

  test('细纲节拍规则：要求把配额落到具体场景与载体（写作才有得执行）', () => {
    const rule = historicalScaleBeatRule(4, PHASE4);
    assert.ok(rule.includes('细纲执行要求'), '细纲层应有节拍指定要求');
    assert.ok(rule.includes('scenes') && rule.includes('载体'), '须指定哪一场承担、载体写进 beat');
  });
});

describe('V0.95.8 三处注入接线（写审同源源断言）', () => {
  test('write.js：场景指令注入 scaleRegisterText（历史门控）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    assert.ok(src.includes('historicalScaleRegisterText(volumeIdx, volumePhase)'),
      'write.js 应按卷计算并注入尺度纪律');
  });

  test('writeSceneInstruction 渲染：scaleRegisterText 非空时出现纪律块，空时不渲染', () => {
    const base = {
 bookTitle: '示例历史长篇', chapterIdx: 28, chapterTitle: '试写',
 scene: { id: 's1', idx: 1, pov: '主角', location: '隘口', beat: '巡视桩位', target_words: 1000 },
      scenesBefore: [], sceneAfter: null, prevTail: '', prevSceneSummary: '',
      worldbookText: '', factsText: '', foreshadowsText: '', rules: '', rollingSummary: '',
      recentSummaries: [], timelineEvents: [], futureChapters: [], constraints: '',
    };
    const withScale = prompts.writeSceneInstruction({
      ...base, scaleRegisterText: historicalScaleRegisterText(4, PHASE4),
    });
    assert.ok(withScale.includes('【山河尺度纪律'), '传入时应渲染纪律块');
    const withoutScale = prompts.writeSceneInstruction(base);
    assert.ok(!withoutScale.includes('山河尺度纪律'), '不传时零渲染（非历史书零影响）');
  });

  test('chapterOutlineInstruction 渲染 scaleBeatRule + auditInstruction 渲染 3.12 核查项', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(src.includes('${scaleBeatRule ? scaleBeatRule + \'\\n\' : \'\'}'), '细纲指令应渲染节拍规则');
    assert.ok(src.includes('3.12 山河尺度核查'), '审校指令应有 3.12 尺度核查项');
    assert.ok(src.includes('verdict 至少 fix'), '配额未达须推 verdict 至 fix（否则配额无约束力）');
  });

  test('outline.js / audit.js 注入接线（源断言）', () => {
    const outlineSrc = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    const auditSrc = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/audit.js'), 'utf8');
    assert.ok(outlineSrc.includes('historicalScaleBeatRule(vol?.idx || 1'), '细纲生成应按卷注入节拍规则');
    assert.ok(auditSrc.includes('historicalScaleRegisterText('), '审校应按卷注入同一把尺');
  });
});
