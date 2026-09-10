// V0.95.0 工程二+三：节奏引擎（爽点调度/钩型轮换）+ 反衰减纵深（三章一轮/纪律失守/中段疲劳）
// 依据：网文节奏工程调研（3-5 章中爽法则、平路≤3 章红线、钩型轮换占比表）+ 修仙书解剖
//（ch22 起破折号纪律失守 ρ=0.652 无人拦截、ch43-76 对话空心化、ch120-125 复读爆发）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import * as store from '../server/db/store.js';
import { schedulerCheck, hookTypeStreakCheck } from '../server/engine/pleasure.js';
import { batchQualityScan } from '../server/engine/batch_scan.js';
import { detectDrift } from '../server/engine/recovery.js';

function seedBook() {
  const b = store.books.create({ title: '节奏测试书', genre: '玄幻' });
  const vol = store.volumes.create(b.id, 1, { title: '第一卷' });
  return { b, vol };
}

function seedChapter(b, vol, idx, text) {
  const ch = store.chapters.create(b.id, vol.id, idx, { title: `第${idx}章`, status: 'done' });
  if (text) store.scenes.create(ch.id, 1, { beat: 'b', content: text, status: 'done', targetWords: 500 });
  return ch;
}

function seedHealth(b, ch, idx, { emotion = { type: '紧张', intensity: 5 }, hook = { present: true, intensity: 3 }, payoff = 1 } = {}) {
  store.chapterHealth.upsert({
    bookId: b.id, chapterId: ch.id, idx, verdict: 'ok', issues: 0, highIssues: 0, replanCount: 0, failed: 0, wordCount: 2000,
    notes: JSON.stringify({ emotion, hook, payoff_count: payoff }),
  });
}

test('V0.95 爽点调度：距上次中爽 >5 章触发强约束（3-5 章法则）', () => {
  const { b, vol } = seedBook();
  // 6 章全部 payoff_count=0（无爽点）且情绪中等
  for (let i = 1; i <= 6; i++) {
    const ch = seedChapter(b, vol, i, `第${i}章正文。`);
    seedHealth(b, ch, i, { payoff: 0, emotion: { type: '平淡', intensity: 4 } });
  }
  const rules = schedulerCheck(b.id, 6);
  assert.ok(rules.some(r => /爽点|回报/.test(r)), `无爽点 6 章必须触发爽点约束（实际：${rules.join('|')}）`);
});

test('V0.95 平路红线：连续 3 章低强度+零回报触发平路警告', () => {
  const { b, vol } = seedBook();
  for (let i = 1; i <= 3; i++) {
    const ch = seedChapter(b, vol, i, `第${i}章正文。`);
    seedHealth(b, ch, i, { payoff: 0, emotion: { type: '平淡', intensity: 2 } });
  }
  const rules = schedulerCheck(b.id, 3);
  assert.ok(rules.some(r => /平路|冲突升级/.test(r)), '连续平路必须触发升级警告');
});

test('V0.95 钩型轮换：连续 3 章同型钩子触发轮换约束（边际感染力归零）', () => {
  const { b, vol } = seedBook();
  for (let i = 1; i <= 3; i++) {
    const ch = seedChapter(b, vol, i, `第${i}章正文。`);
    store.pleasureHooks.create(b.id, { desc: `第${i}章钩子`, kind: 'short', type: '危机钩', plantedChapter: i, dueChapter: i + 1, status: 'paid', intensity: 3 });
  }
  const rules = hookTypeStreakCheck(b.id, 3);
  assert.ok(rules.some(r => /钩型|轮换/.test(r)), '危机钩三连用必须触发轮换约束');
  // 不同型不触发
  const { b: b2, vol: vol2 } = seedBook();
  const types = ['危机钩', '悬念钩', '反转钩'];
  for (let i = 1; i <= 3; i++) {
    store.pleasureHooks.create(b2.id, { desc: `b2第${i}章钩子`, kind: 'short', type: types[i - 1], plantedChapter: i, dueChapter: i + 1, status: 'paid', intensity: 3 });
  }
  assert.equal(hookTypeStreakCheck(b2.id, 3).length, 0, '钩型多样不触发');
});

test('V0.95 三章一轮批次自检：连续 3 章破折号超线 → 批次扫描产出纪律约束（修仙 ch22 式失守拦截）', () => {
  const { b, vol } = seedBook();
  let dashy = '';
  for (let i = 0; i < 25; i++) dashy += '他走了——又停下——再走——。';
  for (let i = 1; i <= 3; i++) seedChapter(b, vol, i, dashy);
  const result = batchQualityScan(b.id, 3);
  assert.ok(result.signals.some(s => /破折号/.test(s.signal)), '破折号批次信号必须被检出');
  assert.ok(result.constraints.length >= 1, '连续 3 章超线必须产出约束');
  assert.ok(result.constraints[0].includes('破折号'), '约束内容指向破折号纪律');
});

test('V0.95 三章一轮：健康批次零约束（对照）', () => {
  const { b, vol } = seedBook();
  const healthy = '“你来了。”她说。\n\n他把刀放在桌上，坐下来。“路上不太平。”\n\n“我知道。”她往灶里添了根柴，“所以我把门闩换了。”';
  for (let i = 1; i <= 3; i++) seedChapter(b, vol, i, healthy);
  const result = batchQualityScan(b.id, 3);
  assert.equal(result.constraints.length, 0, '健康批次不产约束（防噪声）');
});

test('V0.95 纪律失守信号：近 5 章破折号均值超线 → 漂移诊断触发（单章未超标但纪律已失守）', () => {
  const { b, vol } = seedBook();
  // 每章 21-22 个破折号（单章只超一点，审校可能记债放行；5 章连续=系统性失守）
  let dashy = '';
  for (let i = 0; i < 22; i++) dashy += '他走了——又停下。';
  for (let i = 1; i <= 5; i++) {
    const ch = seedChapter(b, vol, i, dashy);
    store.chapterHealth.upsert({ bookId: b.id, chapterId: ch.id, idx: i, verdict: 'ok', issues: 0, highIssues: 0, replanCount: 0, failed: 0, wordCount: 2000 });
  }
  const drift = detectDrift(b.id);
  assert.ok(drift.trigger, '5 章破折号纪律失守必须触发漂移诊断');
  assert.ok(drift.signals.some(s => /破折号|纪律/.test(s)), `信号含纪律失守（实际：${drift.signals.join('|')}）`);
});

test('V0.95 中段疲劳：连续 5 章无新实体/新地点/新钩型 → 漂移信号（100-300 章中段疲软）', () => {
  const { b, vol } = seedBook();
  const samey = '他在同一个院子里修同一张弩。“还是不行。”他说。';
  for (let i = 1; i <= 9; i++) {
    const ch = seedChapter(b, vol, i, samey);
    store.chapterHealth.upsert({ bookId: b.id, chapterId: ch.id, idx: i, verdict: 'ok', issues: 0, highIssues: 0, replanCount: 0, failed: 0, wordCount: 2000 });
  }
  // 无新地点登记、无新实体、无钩子 → 中段疲劳
  const drift = detectDrift(b.id);
  assert.ok(drift.signals.some(s => /新信息|中段|增量/.test(s)), `信号含信息增量缺失（实际：${drift.signals.join('|')}）`);
});
