import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v100-narrative-lessons-'));
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const { narrativeLessonsText, lessonsForChapter } = await import('../server/engine/narrative_lessons.js');

test('V0.100 only active, confident and in-scope lessons enter creative prompts', () => {
  const book = store.books.create({ title: '经验作用域测试' });
  store.narrativeLessons.upsert(book.id, {
    key: 'active-choice', source: 'recommendation_recovery', status: 'active',
    problem: '人物连续等待成人裁决', positiveTarget: '让核心人物主动选择并承担一个在本章落地的代价',
    evidence: [{ chapter: 8, quote: '仍在等待' }], scopeStart: 9, scopeEnd: 20, confidence: 0.86,
  });
  store.narrativeLessons.upsert(book.id, {
    key: 'provisional', source: 'failed_candidate', status: 'provisional',
    problem: '未经验证', positiveTarget: '不应注入', evidence: [{ chapter: 8, quote: '猜测' }],
    scopeStart: 9, scopeEnd: 20, confidence: 0.9,
  });
  store.narrativeLessons.upsert(book.id, {
    key: 'expired', source: 'recommendation_recovery', status: 'active',
    problem: '旧问题', positiveTarget: '过期目标不应注入', evidence: [{ chapter: 1, quote: '旧证据' }],
    scopeStart: 2, scopeEnd: 8, confidence: 0.95,
  });

  const selected = lessonsForChapter(book.id, 10);
  const text = narrativeLessonsText(book.id, 10);
  assert.deepEqual(selected.map(item => item.lesson_key), ['active-choice']);
  assert.match(text, /主动选择.*代价/);
  assert.doesNotMatch(text, /未经验证|过期目标|仍在等待/,
    '提示只注入正向目标，不复述坏例句给模型模仿');
});

test('V0.100 outline and prose prompts consume the same scoped learning ledger', () => {
  const root = process.cwd();
  const outline = fs.readFileSync(path.join(root, 'server/engine/outline.js'), 'utf8');
  const write = fs.readFileSync(path.join(root, 'server/engine/write.js'), 'utf8');
  const prompts = fs.readFileSync(path.join(root, 'server/engine/prompts.js'), 'utf8');
  assert.match(outline, /narrativeLessonsText\(bookId, chapter\.idx\)/);
  assert.match(write, /narrativeLessonsText\(bookId, chapter\.idx\)/);
  assert.match(prompts, /narrativeLessons/);
});
