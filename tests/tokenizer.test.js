import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateChineseChars } from '../server/llm/tokenizer.js';

test('estimateTokens: 中文约为字数', () => {
  const t = estimateTokens('这是一个测试句子，用来估算token。');
  // 14 个中文字 + 2 个标点 ≈ 15-20
  assert.ok(t >= 15 && t <= 25, `got ${t}`);
});

test('estimateTokens: 空与边界', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a') >= 1);
});

test('estimateTokens: 英文约 0.3/字符', () => {
  const t = estimateTokens('hello world');
  assert.ok(t >= 4 && t <= 8, `got ${t}`);
});

test('estimateChineseChars', () => {
  assert.equal(estimateChineseChars('abc中文123'), 2);
});
