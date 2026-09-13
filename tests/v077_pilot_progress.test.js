// V0.77 一键创作进度：首章经 backfill 写完也必须正确计入完成数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-pilot-progress-'));
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_NO_OPEN = '1';
process.env.NOVEL_FAULT = '';

const store = await import('../server/db/store.js');
const { runBookPilot } = await import('../server/engine/pipeline/pilot.js');

test('空书 targetChapters=1 的 done/返回值显示 1/1，而不是 0/骨架章数', async () => {
  const book = store.books.create({ title: '未命名', genre: '玄幻', blurb: '测试一键创作' });
  const events = [];
  const result = await runBookPilot(book.id, { targetChapters: 1, onEvent: event => events.push(event) });
  const done = events.filter(event => event.type === 'done').at(-1);

  assert.equal(result.written, 1);
  assert.equal(result.total, 1);
  assert.equal(done.written, 1);
  assert.equal(done.total, 1);
  assert.equal(store.chapters.list(book.id).filter(ch => ['done', 'settled'].includes(ch.status)).length, 1);
});
