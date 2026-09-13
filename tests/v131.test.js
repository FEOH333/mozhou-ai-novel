// V0.93.9 结局倒推：①书纲指令注入【结局倒推硬要求】（禁"卷11才反攻、卷12和解"断档）；
// ②endingClosureCheck 本地校验（反攻动作须提前到倒二卷及以前、末卷须有结算承诺）；
// ③generateBookOutline 校验失败自动重试（注入失败原因）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v131-ending-'));
const ROOT = process.cwd();
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));

const V = (title, goal, summary) => ({ idx: 0, title, goal, summary });

describe('V0.93.9 结局倒推闭环', () => {
  test('endingClosureCheck：反攻提前+末卷结算 → 通过', () => {
    const volumes = [
      V('守土', '建立根据地', '守土练兵，积蓄力量'),
      V('反攻', '反攻收复失地', '发起反攻，收复荆襄江淮'),
      V('决战', '决战定格局', '决战决胜，重塑格局，兑现誓言，和解收尾'),
    ];
    const r = outline.endingClosureCheck(volumes);
    assert.equal(r.ok, true, '倒二卷已反攻+末卷结算应通过: ' + r.issues.join('；'));
  });

  test('endingClosureCheck：断档结构（末卷才动手/全无动作/末卷无结算）→ 拒绝', () => {
    // 断档：反攻只出现在末卷
    const bad1 = [V('守土', '守城', '坚守'), V('蛰伏', '积蓄', '蛰伏待变'), V('反攻和解', '反攻并和解', '发起反攻，完成和解')];
    const r1 = outline.endingClosureCheck(bad1);
    assert.equal(r1.ok, false, '反攻只出现在末卷应拒绝');
    assert.ok(r1.issues.some(i => i.includes('倒数第二卷')), '应指出断档位置');
    // 全无推进动作
    const bad2 = [V('守土', '守城', '坚守'), V('守土2', '守城', '继续坚守'), V('和解', '和解', '和解收尾')];
    assert.equal(outline.endingClosureCheck(bad2).ok, false, '全无动作应拒绝');
    // 末卷无结算承诺
    const bad3 = [V('反攻', '反攻', '反攻展开'), V('反攻2', '反攻', '继续反攻'), V('继续打', '再打一仗', '又打了一仗')];
    const r3 = outline.endingClosureCheck(bad3);
    assert.equal(r3.ok, false, '末卷无结算承诺应拒绝');
    assert.ok(r3.issues.some(i => i.includes('结算')), '应指出末卷悬空');
    // 不足 2 卷
    assert.equal(outline.endingClosureCheck([V('一卷', 'x', 'y')]).ok, false, '不足 2 卷应拒绝');
  });

  test('非该题材零影响：通用动作词（登顶/破局）跨题材可过', () => {
    const volumes = [
      V('筑基', '入门', '宗门修炼，破局立身'),
      V('登顶', '登顶之战', '决战登顶，证道成神'),
      V('传承', '传承', '传承衣钵，安顿众生，圆满落幕'),
    ];
    const r = outline.endingClosureCheck(volumes);
    assert.equal(r.ok, true, '都市/玄幻通用词（登顶/证道/破局）应通过: ' + r.issues.join('；'));
  });

  test('书纲生成/对齐指令注入【结局倒推硬要求】', () => {
    const gen = prompts.bookOutlineInstruction({ genre: '历史', blurb: '简介', volumes: 4 });
    assert.ok(gen.includes('结局倒推硬要求'), '书纲生成指令应含结局倒推纪律');
    assert.ok(gen.includes('倒数第二卷'), '应含"倒二卷动手"量化约束');
    assert.ok(gen.includes('权谋/朝堂暗线'), '应含权斗四阶段映射要求');
    const align = prompts.bookOutlineRewriteInstruction({ bookTitle: 'T', contract: '', writtenVolumes: '', pendingVolumes: '', openForeshadows: [], totalVolumes: 12 });
    assert.ok(align.includes('结局倒推硬要求'), '书纲对齐指令应含结局倒推纪律');
  });
});
