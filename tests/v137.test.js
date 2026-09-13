// tests/v137.test.js —— V0.94.0 根因修复（二）：细纲质量门 + 指令/审校升级 + 纪律文本落位
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chapterOutlineQualityIssues, lengthProfileOf } from '../server/engine/planning/outline.js';
import { writeSceneInstruction, chapterOutlineInstruction, auditInstruction, lengthRequirementText } from '../server/engine/prompts.js';
import { SCENE_BOUNDARY_TEXT, DIALOGUE_VOICE_TEXT } from '../server/data/literary_techniques.js';
import { RED_LINES } from '../server/data/history.js';

const ROOT = process.cwd();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V0.94 chapterOutlineQualityIssues 细纲质量门', () => {
  test('场景 target 总和低于单章下限 → 报短章问题', () => {
    const issues = chapterOutlineQualityIssues({
      scenes: [
        { id: 's1', beat: '甲在城南查验水痕', target_words: 700 },
        { id: 's2', beat: '乙在城北修墙', target_words: 700 },
      ],
    }, { chapterLength: 3500 });
    assert.ok(issues.some(i => i.issue.includes('单章硬下限')), '应报字数下限问题');
  });

  test('两个场景 beat 高度相似 → 报功能重复', () => {
    const issues = chapterOutlineQualityIssues({
      scenes: [
 { id: 's1', beat: '主角发现料场渗水，什长乙下锹验证渗水痕迹，确认水源', target_words: 1200 },
 { id: 's2', beat: '旧基槽渗水由余玠和工匠实地验证，什长乙再次下锹验证渗水', target_words: 1200 },
        { id: 's3', beat: '夜里游骑警讯骤至，全员撤回', target_words: 1200 },
      ],
    }, { chapterLength: 3500 });
    assert.ok(issues.some(i => i.issue.includes('功能重复')), '应报场景功能重复');
  });

  test('合格细纲（字数足、场景功能互异）零问题', () => {
    const issues = chapterOutlineQualityIssues({
      scenes: [
 { id: 's1', beat: '清晨点卯，主角第一次领弓，独耳陈考较弓的来历', target_words: 1100 },
 { id: 's2', beat: '午后入营塾，文书吏教握笔，主角写出自己名字', target_words: 1200 },
 { id: 's3', beat: '黄昏北坡土坡，主角望北想起父亲，立下守护之誓', target_words: 1200 },
      ],
    }, { chapterLength: 3500 });
    assert.equal(issues.length, 0);
  });

  test('target_words 缺失按 1000 估不误伤', () => {
    const issues = chapterOutlineQualityIssues({
      scenes: [
        { id: 's1', beat: '甲在城南查验水痕与地势' },
        { id: 's2', beat: '乙在城北修墙遇到暴雨' },
        { id: 's3', beat: '丙夜巡发现敌踪' },
      ],
    }, { chapterLength: 3200 });
    assert.equal(issues.filter(i => i.issue.includes('硬下限')).length, 0, '3×1000 ≥ 2880 不报');
  });
});

describe('V0.94 指令注入断言（写审同源）', () => {
 const baseScene = { id: 's1', pov: '主角', location: '营地', beat: '查验水痕', scene_type: 'dialogue', target_words: 1000 };
  const writeCtx = {
    bookTitle: '测试书', chapterIdx: 3, chapterTitle: '山城之眼', scene: baseScene,
 scenesBefore: [], sceneAfter: { id: 's2', pov: '主角', location: '北坡', beat: '余玠考较新址', target_words: 1000 },
    dashBudget: 7,
  };

  test('写作指令：场景边界硬约束 + 下一节拍注入 + 破折号预算', () => {
    const out = writeSceneInstruction(writeCtx);
    assert.match(out, /场景边界硬约束/, '应有场景边界硬约束条款');
    assert.match(out, /余玠考较新址/, '应注入下一场景节拍（越界禁区）');
    assert.match(out, /本场景预算约 7 个/, '应注入破折号场景预算');
    assert.match(out, /抽象对举式偈语.*跨句拆分/, '议论变体仍由本地检测，但创作提示不展示坏例句');
    assert.doesNotMatch(out, /不是X，更像Y|指节\/喉结/, '不得把待禁用句式和万能动作重新示范给模型');
    assert.match(out, /跨章也不得复用/, '跨章比喻红线注入');
  });

  test('写作指令：对话/情感/高潮/日常场景注入角色语言区分纪律', () => {
    const out = writeSceneInstruction(writeCtx);
    assert.match(out, /角色语言区分纪律/, 'dialogue 场景应注入 DIALOGUE_VOICE_TEXT');
    const fightOut = writeSceneInstruction({ ...writeCtx, scene: { ...baseScene, scene_type: 'fight' } });
    assert.doesNotMatch(fightOut, /角色语言区分纪律/, 'fight 场景不注入（控制指令长度）');
  });

  test('细纲指令：场景功能去重/钩型多样/近窗对手戏/章名兑现', () => {
    const out = chapterOutlineInstruction({
      bookTitle: '测试书', chapterIdx: 5, volumeGoal: '守城',
      recentSummaries: [], rollingSummary: '', activeForeshadows: [], retrieved: [],
      prevChapterTail: '', futureChapters: [], prevHookType: '悬念钩',
    });
    assert.match(out, /场景功能去重/);
    assert.match(out, /上一章显式钩型为「悬念钩」/, '应注入上一章钩型实现轮换');
    assert.doesNotMatch(out, /连续 3 章内必须/, '对手戏改为近窗换轴，不再每章同一张考卷');
    assert.match(out, /章名兑现/);
    assert.match(out, /必须在 \d+-\d+ 字之间/, 'lengthRequirementText 带总和区间（V0.105.2 下限+上限）');
    const withContract = chapterOutlineInstruction({
      bookTitle: '测试书', chapterIdx: 5, volumeGoal: '守城',
      recentSummaries: [], rollingSummary: '', activeForeshadows: [],
      diversityText: '【近窗换轴】\n- 事件类已占用：interrogation → 本章不得再用 interrogation',
    });
    assert.match(withContract, /近窗换轴/);
  });

  test('审校指令：3.9 场景越界/3.10 时间线量词/3.11 章名与台词', () => {
    const out = auditInstruction({
      bookTitle: '测试书', chapterTitle: '山城之眼', chapterText: '正文。',
      chapterOutline: '- s1@营地：查验水痕', chapterYear: 1251, prevChapterYear: 1250,
    });
    assert.match(out, /3\.9 场景越界\/双版本核查/);
    assert.match(out, /3\.10 时间线量词核查/);
    assert.match(out, /本章坐标年份 1251/);
    assert.match(out, /上一章 1250/);
    assert.match(out, /3\.11 章名兑现与台词腔调核查/);
    const noYear = auditInstruction({ bookTitle: 'b', chapterTitle: 't', chapterText: 'x' });
    assert.match(noYear, /3\.10 时间线量词核查（V0.94，全文通用）：/, '无年份时括号闭合且不注入坐标');
  });

  test('audit.js 接线新检测器（源码断言）', () => {
    const src = read('server/engine/pipeline/audit.js');
    assert.match(src, /detectSceneTailDuplication/, '场景尾部重演接线');
    assert.match(src, /detectTitleGap/, '章名兑现接线');
    assert.match(src, /detectTimelineAnchorConflict/, '时间线锚点接线');
    assert.match(src, /detectCrossChapterMetaphors/, '跨章比喻接线');
    assert.match(src, /slice\(0, 12\)/, '跨章窗口 8→12 章 + 归档卡双源（V0.95）');
  });

  test('write.js 硬闸与安全合并接线（源码断言）', () => {
    const src = read('server/engine/pipeline/write.js');
    assert.match(src, /safelyMergeContinuation\(content, cont\.content\)/, '自愈续写走安全合并');
    assert.match(src, /enforceSceneDashBudget\(content, dashBudget\)/, '写后破折号硬闸');
  });
});

describe('V0.94 纪律文本与历史红线落位', () => {
  test('SCENE_BOUNDARY_TEXT / DIALOGUE_VOICE_TEXT 量化完整（禁-正例-量化）', () => {
    assert.match(SCENE_BOUNDARY_TEXT, /不得提前写出/);
    assert.match(SCENE_BOUNDARY_TEXT, /正例/);
    assert.match(DIALOGUE_VOICE_TEXT, /每章 ≤1 处/);
    assert.match(DIALOGUE_VOICE_TEXT, /正例/);
  });

 test('历史红线补馆阁体/马灯（实测精读实证词汇穿越）', () => {
    const terms = RED_LINES.map(r => r.term);
    assert.ok(terms.includes('馆阁体'), '馆阁体（清代定名）入红线');
    assert.ok(terms.includes('马灯'), '马灯（近代形制）入红线');
  });
});
