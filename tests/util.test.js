import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON, safeParse, deepMerge } from '../server/util/json.js';

test('extractJSON: 纯 JSON', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
});

test('extractJSON: markdown 围栏', () => {
  const s = '```json\n{"a":1}\n```';
  assert.deepEqual(extractJSON(s), { a: 1 });
});

test('extractJSON: 前后杂散文字', () => {
  const s = '好的，这是结果：\n{"a":1}\n以上。';
  assert.deepEqual(extractJSON(s), { a: 1 });
});

test('extractJSON: 尾随逗号容错', () => {
  const s = '{"a":1,"b":[1,2,],}';
  assert.deepEqual(extractJSON(s), { a: 1, b: [1, 2] });
});

test('extractJSON: 截断 JSON 容错', () => {
  const s = '{"a":1,"b":2';
  assert.deepEqual(extractJSON(s), { a: 1, b: 2 });
});

test('extractJSON: 无效输入返回 null', () => {
  assert.equal(extractJSON('不是 JSON'), null);
  assert.equal(extractJSON(''), null);
  assert.equal(extractJSON(null), null);
});

test('extractJSON: 数组', () => {
  assert.deepEqual(extractJSON('[1,2,3]'), [1, 2, 3]);
});

test('safeParse', () => {
  assert.equal(safeParse('not json', { fb: 1 }).fb, 1);
  assert.deepEqual(safeParse('{"x":2}'), { x: 2 });
  assert.equal(safeParse(''), null);
});

test('deepMerge: 嵌套合并且不修改 base', () => {
  const base = { a: { b: 1, c: 2 }, d: 3 };
  const merged = deepMerge(base, { a: { c: 9 }, e: 4 });
  assert.equal(merged.a.b, 1);
  assert.equal(merged.a.c, 9);
  assert.equal(merged.d, 3);
  assert.equal(merged.e, 4);
  assert.equal(base.a.c, 2); // 原对象未被修改
});
