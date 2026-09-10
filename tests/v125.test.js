// V0.93.3 卡章根因修复：阶段任务落实指令注入 / 跨年过渡正文指令注入 /
// 细纲硬防线错误分类 / 失败信息落库
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v125-outline-duty-'));
const ROOT = process.cwd();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const write = await import(pathToFileURL(path.join(ROOT, 'server/engine/write.js')));
const pilot = await import(pathToFileURL(path.join(ROOT, 'server/engine/pilot.js')));

describe('V0.93.3 卡章根因修复', () => {
  test('细纲指令注入阶段任务落实硬要求（核心词连续出现 + 驳回警告）', () => {
    const frame = '公元1248年｜淳祐八年｜主角16岁｜阶段：阶段工程验收，形成羁绊与从军志向｜回报：关系｜情绪：温暖7';
    const text = prompts.chapterOutlineInstruction({
 bookTitle: '示例历史长篇', chapterIdx: 16,
      historicalChapterFrame: frame,
    });
    assert.match(text, /阶段任务落实硬要求/, '应注入落实硬要求段');
    assert.match(text, /工程验收/, '应把阶段任务原文写进要求');
    assert.match(text, /从军志向/, '核心词应逐字出现');
    assert.match(text, /驳回/, '应说明不满足会被驳回');
    assert.match(text, /checkpoints/, '应点名 checkpoints 落实');
  });

  test('非历史书细纲指令不注入阶段任务落实段', () => {
    const text = prompts.chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1, historicalChapterFrame: '' });
    assert.doesNotMatch(text, /阶段任务落实硬要求/, '非历史不注入');
  });

  test('跨年帧构建：正文开头必须出现跨年标记（historyFrameText 纯函数）', () => {
    const phase = { title: '山城余火', startYear: 1244, endYear: 1248 };
    const frame = write.historicalFrameText(
      { year: 1248, era_year: '淳祐八年', protagonist_age: 16, phase: '阶段工程验收，形成羁绊与从军志向', reward_mode: '关系', emotion: '温暖7' },
      phase,
      1247,
    );
    assert.match(frame, /公元1248年/);
    assert.match(frame, /跨年：由1247年→1248年/, '跨年时帧内应含跨年提示');
    assert.match(frame, /开头/, '应要求开篇场景写跨年标记');
    // 非跨年不注入
    const same = write.historicalFrameText({ year: 1247, era_year: '淳祐七年', protagonist_age: 15 }, phase, 1247);
    assert.doesNotMatch(same, /跨年：/, '同年章不注入跨年提示');
    // 历史帧无 phase 时兜底
    const fallback = write.historicalFrameText({ year: 1248 }, null, 1247);
    assert.match(fallback, /公元1248年/);
  });

  test('写作指令收到含跨年提示的帧时，开篇场景要求写跨年标记', () => {
    const text = prompts.writeSceneInstruction({
 bookTitle: '示例历史长篇', chapterIdx: 16, chapterTitle: '城火长明',
      scene: { id: 's1', beat: '开篇', target_words: 1350 },
      scenesBefore: [], sceneAfter: null, prevTail: '',
      perspective: 'third',
      historicalChapterFrame: '公元1248年｜淳祐八年｜主角16岁｜跨年：由1247年→1248年，本章开篇场景开头必须写"次年/淳祐八年"等明确跨年标记与季节，禁"七日后/翌日"',
    });
    assert.match(text, /跨年标记/, '写作指令应含跨年标记要求');
  });

  test('细纲硬防线错误分类：OUTLINE_GUARD_FAILED 属于质量门（qualityStop）', () => {
    const policy = pilot.chapterFailurePolicy('OUTLINE_GUARD_FAILED');
    assert.equal(policy.qualityStop, true, '细纲硬防线失败应归质量门');
    assert.equal(policy.status, 'quality_blocked');
    const normal = pilot.chapterFailurePolicy(undefined);
    assert.equal(normal.qualityStop, false);
  });

  test('细纲硬防线失败时错误携带 OUTLINE_GUARD_FAILED 代码', () => {
    const src = read('server/engine/outline.js');
    assert.match(src, /OUTLINE_GUARD_FAILED/, 'outline.js 抛错应带代码');
    // pilot 失败路径把错误码与信息写入健康快照 notes
    const psrc = read('server/engine/pilot.js');
    assert.match(psrc, /失败代码/, 'pilot 失败路径应记录失败代码到健康快照');
  });
});
