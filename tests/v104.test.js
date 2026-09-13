// V0.91 历史题材多类型阅读回报与留存闸门
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v104-reader-value-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
const attraction = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/attraction.js')));

describe('V0.91 历史题材平台规则分流', () => {
  test('番茄历史书不再硬套暴力开场与三章打脸，改为事件变化和阅读回报', () => {
 const text = prompts.buildSystemPrompt({ title: '示例历史长篇', genre: '历史', platform: '番茄', blurb: '淳祐元年' });
    assert.doesNotMatch(text, /3 章内必须有小爽点（打脸\/碾压\/装逼）/);
    assert.doesNotMatch(text, /炸了\/断了\/打了\/冲了/);
    assert.match(text, /阅读回报/);
    assert.match(text, /依恋|信息/);
  });

  test('历史铺垫章六问明确允许无伤害和无肢体冲突', () => {
    const text = prompts.fiveQuestionsInstruction({
 bookTitle: '示例历史长篇', chapterIdx: 1, chapterTitle: '灯下家书',
      outline: { pace: 'setup', reward_mode: '依恋', ending_hook: '城外犬吠突然停了' }, isHistory: true,
    });
    assert.match(text, /依恋建立/);
    assert.match(text, /q1、q2.*不.*硬性|q1.*q2.*可为.?无/);
    assert.match(text, /reader_value/);
  });
});

describe('V0.91 阅读回报判定', () => {
  test('历史铺垫章可凭关系变化与钩子通过，不要求受伤打斗', () => {
    const result = outline.evaluateOutlineQuestions({
      q1_visible_harm: '无', q2_physical_conflict: '无', q3_satisfaction: '无',
      q4_ending_hook: '悬念：城外犬吠停了', q5_open_300: '母亲临时改口，让他藏好盐袋',
      q6_emotional_change: '母子从拌嘴变成彼此担心',
      reader_value: { type: '依恋', gain: '读者记住母亲怕冷却把炭让给孩子', cost: '不安加深' },
      pass: false, fail_reason: '无肢体冲突',
    }, { platform: '番茄', isHistory: true, pace: 'setup', rewardMode: '依恋' });
    assert.equal(result.pass, true);
  });

  test('历史释放章仍须有具体回报，只有钩子不能空转', () => {
    const empty = outline.evaluateOutlineQuestions({
      q4_ending_hook: '危机：敌军又来', q6_emotional_change: '无', reader_value: { type: '无', gain: '无' }, pass: true,
    }, { platform: '番茄', isHistory: true, pace: 'payoff', rewardMode: '战术' });
    assert.equal(empty.pass, false);

    const earned = outline.evaluateOutlineQuestions({
      q4_ending_hook: '反转：诱敌并非为杀敌',
      reader_value: { type: '战术', gain: '主角用撤灶识破敌军虚实，保住撤民通道', cost: '斥候一死一伤' },
      pass: false,
    }, { platform: '番茄', isHistory: true, pace: 'payoff', rewardMode: '战术' });
    assert.equal(earned.pass, true);
  });

  test('非历史番茄书继续服从原有全项判定', () => {
    assert.equal(outline.evaluateOutlineQuestions({ pass: false, q4_ending_hook: '危机' }, { platform: '番茄', isHistory: false }).pass, false);
    assert.equal(outline.evaluateOutlineQuestions({ pass: true }, { platform: '番茄', isHistory: false }).pass, true);
  });

  test('历史吸引力修订提示不强迫当众碾压', () => {
    const text = prompts.attractionRevisionNote({ isHistory: true, rewardMode: '关系' });
    assert.doesNotMatch(text, /当众|碾压/);
    assert.match(text, /阅读回报/);
    assert.match(text, /关系/);
  });

  test('本地历史门把依恋与选择识别为阅读回报', () => {
    const text = '母亲把仅剩的炭推给他。他记住她怕冷的手，选择把盐袋藏进弟弟襁褓。门外犬吠突然停了。';
    const issues = attraction.attractionLocalRules(text.repeat(8), { isHistory: true });
    assert.ok(!issues.some(issue => issue.type === '本章无阅读回报'));
  });
});
