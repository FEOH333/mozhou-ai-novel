// V0.93 历史正文硬防线：跨年过渡与少年权限
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(`${os.tmpdir()}\\v118-history-`);

const guardrails = await import('../server/engine/historical_guardrails.js');
const prompts = await import('../server/engine/prompts.js');

describe('V0.93 历史跨年过渡', () => {
  test('元数据跨年但正文仍写七日后时拦截', () => {
    const issues = guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1246, previousYear: 1245,
 chapterText: '料道封了七日，雨停以后，主角背上的伤已经结痂。老兵甲又叫众人开工。',
    });
    assert.ok(issues.some(item => item.type === '时间线冲突' && /跨年/.test(item.issue)));
  });

  test('明确一年后和年号时允许跨年', () => {
    const issues = guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1246, previousYear: 1245,
 chapterText: '一年过去。淳祐六年春，钓鱼山北坡的料道再次开工，主角已经十四岁。',
    });
    assert.equal(issues.some(item => item.type === '时间线冲突' && /跨年/.test(item.issue)), false);
  });
});

describe('V0.93 少年权限正文硬闸', () => {
  test('细纲与正文提示在历史少年阶段提前禁止机密和成人指挥权', () => {
    const outlinePrompt = prompts.chapterOutlineInstruction({
 bookTitle: '示例历史长篇', chapterIdx: 12, historicalChapterFrame: '淳祐四年（1244），主角12岁',
    });
    const scenePrompt = prompts.writeSceneInstruction({
 bookTitle: '示例历史长篇', chapterIdx: 12, chapterTitle: '夜哨',
      scene: { id: 's1', beat: '传递公开工图', target_words: 800 }, scenesBefore: [],
      historicalChapterFrame: '淳祐四年（1244），主角12岁', isHistory: true,
    });
    for (const text of [outlinePrompt, scenePrompt]) {
      assert.match(text, /暗门准确位置/);
      assert.match(text, /成人.*复核|成人.*下令/);
    }
  });

  test('十六岁前不得记录暗门准确位置或保管销毁军情图', () => {
    assert.equal(typeof guardrails.historicalYouthAuthorityTextIssues, 'function');
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1244, protagonistAge: 12,
 chapterText: '冉璞带主角走进暗门，让他把准确位置画入随身工册。陈七又把哨探图交给他，说若回灯不见，就烧了第七页。',
    });
    assert.ok(issues.some(item => item.type === '角色越权' && /机密|暗门|军情/.test(item.issue)));
  });

  test('机密由成人另册保管、少年只记公开工序时允许', () => {
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1244, protagonistAge: 12,
 chapterText: '冉璞在暗门外停住，明确说准确位置不得写进工册，由守门军士另册保管。主角只记公开料道的排水工序。',
    });
    assert.deepEqual(issues, []);
  });

  test('少年不得未经成人授权直接调度成年工役', () => {
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1246, protagonistAge: 14,
 chapterText: '主角把三十名成年民夫重新分组，下令老兵甲去守东绳，又命什长乙带人撤下料架。众人只听他的号令。',
    });
    assert.ok(issues.some(item => item.type === '角色越权' && /调度|号令|成人/.test(item.issue)));
  });

  test('成人批准并下令、少年仅提议复诵和记录时允许', () => {
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1246, protagonistAge: 14,
 chapterText: '主角向老兵甲提出轮歇办法。老兵甲逐项核过，亲自给成年民夫分组下令；主角只负责记号、复诵和报时。',
    });
    assert.deepEqual(issues, []);
  });

  test('“叫作地名”“让墨变干”等普通叙述不得误判成少年号令', () => {
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1244, protagonistAge: 12,
 chapterText: '余制使看中一处山，叫钓鱼山。什长乙在前头开口：“今日去察勘地基。”主角把图纸放在风口，让墨快些干。什长乙踱到他身后，又走过去验墙。',
    });
    assert.deepEqual(issues, []);
  });

  test('成年人命令少年执行任务不得反向误判成少年指挥成人', () => {
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1246, protagonistAge: 14,
 chapterText: '老兵甲让主角去报时，又叫他把工册交来。主角只负责复诵和记录。',
    });
    assert.deepEqual(issues, []);
  });

  test('明确否定交付军情图时不得误判成少年掌握机密', () => {
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1245, protagonistAge: 13,
 chapterText: '军士没有把哨探图交给主角，只让他核对公开工段时刻；密页仍由值夜军士锁柜保管。',
    });
    assert.deepEqual(issues, []);
  });

  test('少年按成年工头分派记录和复诵不得误判成独立调度', () => {
    const issues = guardrails.historicalYouthAuthorityTextIssues({
 bookTitle: '示例历史长篇', year: 1246, protagonistAge: 14,
 chapterText: '主角按老兵甲的分派记下位置。老兵甲亲自下令，主角只在侧线复诵和报时。',
    });
    assert.deepEqual(issues, []);
  });
});
