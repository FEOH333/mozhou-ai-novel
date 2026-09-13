// tests/v138.test.js —— V0.94.0b 精读复检精修：感知判别豁免 / 弱钩豁免口径 / 审校接线闭环
// 依据 2026-08-16 存量复检：ch25 三处听声辨物识步教学句被误计 medium（复检实证），
// ch18"像在等他"威胁悬置、卷末章静场收尾被误判弱钩；弱钩/母题两检测器已建但未接审校。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as rules from '../server/engine/quality/rules.js';

const ROOT = process.cwd();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V0.94.0b detectNotButPattern 感知判别豁免', () => {
  test('听声辨质句不计入（"不是碾过粗石的响，是刃口顺着石面走的声音"）', () => {
    const issues = rules.detectNotButPattern('那声音不对。不是碾过粗石的响，是刃口顺着石面走的声音。');
    assert.equal(issues.length, 0, '感知判别教学句应豁免');
  });

  test('辨物句不计入（"不是他腰间那口佩刀，是一把旧猎刀"）', () => {
    const issues = rules.detectNotButPattern('他看清了。不是他腰间那口佩刀，是一把旧猎刀，刀鞘贴着井沿搁着。');
    assert.equal(issues.length, 0);
  });

  test('识步句不计入（"不是巡哨的步点，是被催赶的跑法"）', () => {
    const issues = rules.detectNotButPattern('脚步声近了。不是巡哨的步点，是被催赶的跑法。');
    assert.equal(issues.length, 0);
  });

  test('含抽象认知词（怕/想起/判断）仍计入——感知词在场也不豁免', () => {
    const issues = rules.detectNotButPattern('他怕的不是走错一条路，是怕那十个人因他一句判断回不来。');
    assert.ok(issues.length >= 1, '议论型对比必须计入');
  });

  test('泛名词（水/路/点）不触发豁免——工艺议论句仍计入（v136 语义保持）', () => {
    const issues = rules.detectNotButPattern('墙不是先垒起来的，是先弄清人、水和路。');
    assert.ok(issues.length >= 1, '工艺总结议论不得被"水"字误豁免');
  });

  test('豁免后 ≥2 升 medium 口径不变（两句议论仍 medium）', () => {
    const issues = rules.detectNotButPattern('这不是去打架，而是去送饭。那不是恐惧，而是平静。');
    assert.ok(issues.length >= 2 && issues.every(i => i.severity === 'medium'));
  });
});

describe('V0.94.0b detectWeakEnding 豁免口径', () => {
  const staticEnd = '他望着那道墙。竹签一排排立着，像山体上才缝下的第一行针脚。';

  test('静态比喻空镜仍报弱钩（既有 v136 行为保持）', () => {
    assert.ok(rules.detectWeakEnding(staticEnd).length >= 1);
  });

  test('威胁性拟人结尾（"像在等他"）豁免——有指向的威胁意象非弱钩', () => {
    const ominous = '他闭上眼，没有睡着。远处的灰烟在夜风里微微晃了一下，又立直了。像在等他。';
    assert.equal(rules.detectWeakEnding(ominous).length, 0);
  });

  test('卷末章静场收尾豁免（volumeFinal：跨卷节奏点由新卷开篇承担钩子）', () => {
    assert.equal(rules.detectWeakEnding(staticEnd, { volumeFinal: true }).length, 0);
  });
});

describe('V0.94.0b 审校接线闭环（写审同源：检测器必须参与审校 verdict）', () => {
  test('audit.js 将弱钩与母题检测器接入本地议题', () => {
    const src = read('server/engine/pipeline/audit.js');
    assert.match(src, /detectWeakEnding\(chapterText/, '弱钩检测应接入章级 localIssues');
    assert.match(src, /detectMotifRepetition\(chapterText/, '母题配额应接入章级 localIssues');
    assert.match(src, /volumeFinal/, '弱钩检测应带卷末判定');
  });

  test('detectMotifRepetition：同章同母题 ≥4 次报 medium（写审同源：指令动作库拓宽纪律）', () => {
    const text = Array.from({ length: 4 }, (_, i) => `第${i + 1}次他蹲下，把土压实。`).join('\n');
    const issues = rules.detectMotifRepetition(text);
    assert.ok(issues.length >= 1 && issues[0].severity === 'medium');
    assert.ok(issues[0].issue.includes('蹲下'));
  });
});
