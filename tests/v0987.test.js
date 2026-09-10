// V0.98.7 精读诊断输出瘦身：免费档流式对"大输入×长输出"会中途掐断（STREAM_INCOMPLETE），
// 输出压进 1800 字安全区后实测 23-35s 稳定完成（此前 56-64s 撞线被掐）。
import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('V0.98.7 诊断指令带量化输出体量纪律（写审同源可检）', async () => {
  const { openingDiagnosisInstruction } = await import('../server/engine/prompts.js');
  const text = openingDiagnosisInstruction({
    book: { title: '测试书', blurb: '简介' }, storyPromise: '宪章',
    fullChapters: [{ idx: 1, title: '一', text: '正文。' }],
    laterChapters: [], localSignals: {},
  });
  assert.ok(text.includes('输出体量纪律'), '指令必须声明体量纪律');
  assert.ok(text.includes('1800 字以内'), '总量上限量化');
  assert.ok(text.includes('≤40 字') && text.includes('≤30 字'), '字段与引文长度量化');
  assert.ok(text.includes('issues 至多 3 条') && text.includes('tradeoffs 至多 2 条'), '条目数上限量化');
  assert.ok(text.includes('正例：{"answer"'), '禁令必须结对正例（工艺铁律）');
  // 瘦身不得破坏既有 fail-closed 证据纪律
  assert.ok(text.includes('quote 必须能在原文精确找到'));
  assert.ok(text.includes('不得新增人物、事件、冲突、物件或设定'));
});
