import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-polish-chunks-'));
process.env.NOVEL_NO_OPEN = '1';

const { chunkPolishChapters } = await import('../server/engine/polish.js');

test('长篇终审按完整章节分块，覆盖后段且不从章中间截断', () => {
  assert.equal(typeof chunkPolishChapters, 'function');
  const chapters = [
    { id: 'ch1', idx: 1, title: '一' },
    { id: 'ch2', idx: 2, title: '二' },
    { id: 'ch3', idx: 3, title: '三' },
  ];
  const texts = new Map([
    ['ch1', '甲'.repeat(60)],
    ['ch2', '乙'.repeat(60)],
    ['ch3', '丙'.repeat(60)],
  ]);
  const chunks = chunkPolishChapters(chapters, {
    limit: 150,
    getText: chapter => texts.get(chapter.id),
  });

  assert.ok(chunks.length > 1, '超过单块预算后必须覆盖后续正文');
  assert.deepEqual(chunks.flatMap(chunk => chunk.chapters.map(ch => ch.idx)), [1, 2, 3]);
  for (const chunk of chunks) {
    for (const chapter of chunk.chapters) {
      assert.ok(chunk.fullText.includes(texts.get(chapter.id)), `第${chapter.idx}章必须完整进入终审`);
    }
  }
});
