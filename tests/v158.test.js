// V0.105.2 锁定：章级字数预算（细纲 Σtarget 上限 + 写作章视野 + 自愈动态收紧）
// 实证：ch43-48 中 4 章破 135% 红线（7618/7845/6888/7412 > 6750）——
// 细纲 Σtarget 5500-5700 > 5000 目标（此前只有 90% 下限），各场景写作又普遍超
// target 20-40%（压缩阈值 1.7× 前不设防），两层叠加必然破线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import './helper.js';

const ROOT = process.cwd();
const load = async f => import(pathToFileURL(path.join(ROOT, f)));
const han = n => '汉'.repeat(n);

// ---------- ① sceneWordBudget 纯函数 ----------

test('V0.105.2 sceneWordBudget：余量充足时不收紧（保持 1.7× 既有行为）', async () => {
  const { sceneWordBudget } = await load('server/engine/write.js');
  const b = sceneWordBudget({
    lengthProfile: 5000,
    scenesBefore: [],
    scene: { target_words: 1000 },
    scenesAfter: [{ target_words: 1000 }, { target_words: 1000 }, { target_words: 1000 }],
  });
  // 首场：6750 - 0 - 3×850 = 4200 余量，远大于 1700 静态上限
  assert.equal(b.maxWords, 1700, '余量充足时上限应保持 target×1.7');
  assert.equal(b.trendingOver, false, '不应误报超支趋势');
  assert.equal(b.text, '', '首场景无前文时不注入预算行');
});

test('V0.105.2 sceneWordBudget：章超支趋势时收紧上限并给出强提示（ch48 复盘）', async () => {
  const { sceneWordBudget } = await load('server/engine/write.js');
  // ch48 实测：4 场已写约 5900（s1-s4 = 1812+2186+1693+1733 raw 中汉字估），末场 target 1000
  const b = sceneWordBudget({
    lengthProfile: 5000,
    scenesBefore: [
      { content: han(1400) }, { content: han(1700) }, { content: han(1300) }, { content: han(1350) },
    ],
    scene: { target_words: 1000 },
    scenesAfter: [],
  });
  // 余量 = 6750 - 5750 - 0 = 1000 < 1700×0.9=1530 → 趋势吃紧
  assert.ok(b.trendingOver, '应识别超支趋势');
  assert.ok(b.maxWords < 1700, `应收紧上限（实际 ${b.maxWords}）`);
  assert.ok(b.maxWords >= 1050, '收紧不低于 target×1.05（不砍剧情节拍）');
  assert.ok(b.text.includes('硬上限') && b.text.includes('收在'), '预算行应含上限与收紧指令');
  assert.ok(b.text.includes('5750'), '预算行应报告已写字数');
});

test('V0.105.2 sceneWordBudget：中间场景为后续留最低需求（不为守预算饿死后面场景）', async () => {
  const { sceneWordBudget } = await load('server/engine/write.js');
  const b = sceneWordBudget({
    lengthProfile: 5000,
    scenesBefore: [{ content: han(2000) }],
    scene: { target_words: 1000 },
    scenesAfter: [{ target_words: 1000 }, { target_words: 1000 }],
  });
  // 余量 = 6750 - 2000 - 1700 = 3050 > 1700 → 不收紧
  assert.equal(b.maxWords, 1700);
  assert.ok(b.text.includes('2000'), '非首场景应注入已写进度');
});

// ---------- ② 指令注入（写与自愈同源） ----------

test('V0.105.2 writeSceneInstruction：sceneMaxWords 收紧字数硬约束、chapterBudgetText 注入', async () => {
  const { writeSceneInstruction } = await load('server/engine/prompts.js');
  const base = {
 bookTitle: 'T', chapterIdx: 9, scene: { id: 's5', pov: '主角', target_words: 1000, beat: '收束' }, scenesBefore: [{}],
  };
  const normal = writeSceneInstruction(base);
  assert.ok(normal.includes('850-1700'), '默认场景字数区间应为 850-1700（target 1000）');
  const tight = writeSceneInstruction({ ...base, sceneMaxWords: 1050, chapterBudgetText: '【章字数预算】本章目标 5000 字（硬上限 6750）；前面场景已写 5750 字。章累计已吃紧——本场务必收在 1050 字内。' });
  assert.ok(tight.includes('850-1050'), `收紧后区间应含动态上限（${tight.match(/输出 \d+-\d+ 字/)?.[0]}）`);
  assert.ok(tight.includes('【章字数预算】'), '预算行应注入指令');
  assert.ok(tight.includes('硬上限 6750'), '预算行内容应完整');
});

test('V0.105.2 writeScene 调用链透传预算（write.js 源码断言）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/engine/write.js'), 'utf8');
  assert.ok(src.includes('const wordBudget = sceneWordBudget({'), 'writeScene 应计算章级预算');
  assert.ok(src.includes('sceneMaxWords: wordBudget.maxWords'), '预算上限应传入指令（与自愈同源）');
  assert.ok(src.includes('maxWordsOverride: wordBudget.maxWords'), '预算上限应传入长度自愈');
  assert.ok(src.includes('chapterBudgetText: wordBudget.text'), '预算文本应传入指令');
});

// ---------- ③ 细纲源头：Σtarget 上限（指令 + 本地 heal 对称化） ----------

test('V0.105.2 lengthRequirementText：场景 target 之和含 90%-110% 区间', async () => {
  const { lengthRequirementText } = await load('server/engine/prompts.js');
  const s = lengthRequirementText(5000);
  assert.ok(s.includes('4500-5500'), '5000 字档应给出 4500-5500 的总和区间');
  assert.ok(s.includes('之间'), '总和约束应为区间表述（不再只有下限）');
});

test('V0.105.2 healOutlineWordTargets：Σtarget 超 110% 等比回收；正常区间不动；低于 90% 补足', async () => {
  const { healOutlineWordTargets } = await load('server/engine/outline.js');
  // ch48 复盘：Σtarget=5500 恰在 110% 边界内不动；5700 超线回收
  const edge = { scenes: [{ target_words: 1100 }, { target_words: 1200 }, { target_words: 1100 }, { target_words: 1100 }, { target_words: 1000 }] };
  assert.equal(healOutlineWordTargets(edge, 5000), false, '5500 = 110% 边界值不应触发回收');

  const over = { scenes: [{ target_words: 1300 }, { target_words: 1200 }, { target_words: 1100 }, { target_words: 1100 }, { target_words: 1000 }] };
  const sum = arr => arr.reduce((a, s) => a + s.target_words, 0);
  assert.equal(healOutlineWordTargets(over, 5000), true, '5700 > 5500 应回收');
  assert.ok(sum(over.scenes) <= 5500 + 4, `回收后 Σtarget 应 ≤5500（实际 ${sum(over.scenes)}，700 钳制允许极小溢出）`);
  assert.ok(over.scenes.every(s => s.target_words >= 700), '回收不得把单场压到 700 以下');

  const fine = { scenes: [{ target_words: 1150 }, { target_words: 1150 }, { target_words: 1150 }, { target_words: 1150 }] };
  const snapshot = sum(fine.scenes);
  healOutlineWordTargets(fine, 5000);
  assert.equal(sum(fine.scenes), snapshot, '区间内的 Σtarget（4600）不应被动');
});

// ---------- ④ 既有行为零回归 ----------

test('V0.105.2 无预算参数时指令与自愈行为不变（兼容存量调用）', async () => {
  const { writeSceneInstruction } = await load('server/engine/prompts.js');
  const s = writeSceneInstruction({
 bookTitle: 'T', chapterIdx: 3, scene: { id: 's1', pov: '主角', target_words: 1200, beat: 'x' }, scenesBefore: [],
  });
  assert.ok(s.includes('1020-2040'), 'target 1200 默认区间 1020-2040（1.7× 行为不变）');
  assert.ok(!s.includes('【章字数预算】'), '未传预算时不得注入预算行');
  const src = fs.readFileSync(path.join(ROOT, 'server/engine/write.js'), 'utf8');
  assert.ok(src.includes('const maxWords = maxWordsOverride > 0'), '自愈 maxWordsOverride 默认 0 时回落静态 1.7×');
});
