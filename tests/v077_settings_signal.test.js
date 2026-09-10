// V0.77 设定生成取消链：HTTP 断开后不得继续调用模型和落库
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('generateBookSettings 将 signal 传到 LLM，且不吞取消错误', () => {
  const source = fs.readFileSync(new URL('../server/engine/settings.js', import.meta.url), 'utf8');
  assert.match(source, /const\s*\{\s*onEvent,\s*force\s*=\s*false,\s*signal\s*\}\s*=\s*opts/);
  // V0.90：runTask 调用改为循环内（自动重试），signal 仍传入；正则放宽匹配（调用内含 task 与 signal 即可）
  assert.match(source, /runTask\(\{[\s\S]*?task:\s*'book_settings'[\s\S]*?signal[\s\S]*?\}\)/);
  assert.match(source, /if\s*\(e\?\.code\s*===\s*'ABORTED'\s*\|\|\s*e\?\.name\s*===\s*'AbortError'\)\s*throw e/);
});
