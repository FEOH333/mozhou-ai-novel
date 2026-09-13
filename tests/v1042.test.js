// V0.104.2：审校预算耗尽后的 leftover defer 不是系统性漂移；
// 已有完成章的卷禁止恢复路径重生卷纲；重规划中断不得留下空细纲。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const store = await import('../server/db/store.js');
const {
  recordChapterHealth, detectDrift, replanFrom, shouldRegenerateVolumeOutline,
} = await import('../server/engine/recovery/recovery.js');

const ROOT = process.cwd();
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function seedVolumeBook() {
  const book = store.books.create({ title: '恢复误伤卷纲', genre: '历史' });
  store.materials.set(book.id, 'contract', '硬核军事推演');
  store.materials.set(book.id, 'world', '合州钓鱼城');
  const volume = store.volumes.create(book.id, 5, {
    title: 'KEEP-VOL',
    goal: '守住北崖',
    status: 'outlined',
    outline: {
      title: 'KEEP-VOL',
      goal: '守住北崖',
      chapterCount: 4,
      chapters: [
        { idx: 1, title: '已写一', beat: '验工', year: 1259 },
        { idx: 2, title: '已写二', beat: '夜袭', year: 1259 },
        { idx: 3, title: 'KEEP-41', beat: 'KEEP-BEAT', year: 1259, era_year: '开庆元年', protagonist_age: 27 },
        { idx: 4, title: 'KEEP-42', beat: 'KEEP-BEAT-2', year: 1259, era_year: '开庆元年', protagonist_age: 27 },
      ],
    },
  });
  const done = (idx, title) => {
    const chapter = store.chapters.create(book.id, volume.id, idx, { title, status: 'done' });
    store.scenes.create(chapter.id, 1, { content: `第${idx}章已发生的事。`, status: 'done' });
    store.summaries.set(chapter.id, book.id, `第${idx}章摘要`);
    return chapter;
  };
  done(39, '已写一');
  done(40, '已写二');
  const planned41 = store.chapters.create(book.id, volume.id, 41, {
    title: 'KEEP-41',
    status: 'planned',
    outline: { beat: 'KEEP-BEAT', year: 1259, era_year: '开庆元年', protagonist_age: 27 },
  });
  const planned42 = store.chapters.create(book.id, volume.id, 42, {
    title: 'KEEP-42',
    status: 'planned',
    outline: { beat: 'KEEP-BEAT-2', year: 1259, era_year: '开庆元年', protagonist_age: 27 },
  });
  return { book, volume, planned41, planned42 };
}

test('V0.104.2 审校预算耗尽的 leftover defer 不触发债务累积漂移', () => {
  const book = store.books.create({ title: '记债放行不是漂移', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, { title: '卷一' });
  for (const idx of [39, 40]) {
    const leftover = Array.from({ length: 12 }, () => ({ type: '文学性', severity: 'medium' }));
    leftover.push({ type: '事实矛盾', severity: 'high', proseFix: true });
    const chapter = store.chapters.create(book.id, volume.id, idx, { title: `第${idx}章`, status: 'done' });
    recordChapterHealth(book.id, chapter.id, {
      verdict: 'defer',
      issues: leftover,
      failed: false,
      wordCount: 6000,
    });
  }
  const drift = detectDrift(book.id);
  assert.equal(drift.trigger, false, `leftover defer 不应触发漂移，实际：${drift.reason}`);
  assert.equal(drift.signals.some(s => /债务累积/.test(s)), false);
});

test('V0.104.2 多章 defer 且每章 high≥2 仍算债务累积', () => {
  const book = store.books.create({ title: '真债务累积', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, { title: '卷一' });
  for (const idx of [1, 2]) {
    const chapter = store.chapters.create(book.id, volume.id, idx, { title: `第${idx}章`, status: 'done' });
    recordChapterHealth(book.id, chapter.id, {
      verdict: 'defer',
      issues: [
        { type: '设定冲突', severity: 'high' },
        { type: '事实编造', severity: 'high' },
        { type: '文学性', severity: 'medium' },
        { type: '文学性', severity: 'medium' },
        { type: '文学性', severity: 'medium' },
      ],
      failed: false,
    });
  }
  const drift = detectDrift(book.id);
  assert.equal(drift.trigger, true);
  assert.ok(drift.signals.some(s => /债务累积/.test(s)), `应含债务累积，实际：${drift.signals.join('；')}`);
});

test('V0.104.2 已有完成章的卷不得重生卷纲，中断时保留未写章细纲', async () => {
  const { book, volume, planned41 } = seedVolumeBook();
  assert.equal(shouldRegenerateVolumeOutline(volume.id), false);

  const outlineBefore = store.volumes.get(volume.id).outline_json;
  const events = [];
  const ctrl = new AbortController();
  await replanFrom(book.id, 41, {
    regenerateVolume: true,
    signal: ctrl.signal,
    onEvent: event => {
      events.push(event);
      if (/将重规划/.test(event.message || '')) ctrl.abort();
    },
  });

  const messages = events.map(event => event.message || '').join('\n');
  assert.equal(store.volumes.get(volume.id).title, 'KEEP-VOL');
  assert.equal(store.volumes.get(volume.id).outline_json, outlineBefore, '卷纲 JSON 不得被重生覆盖');
  assert.ok(/跳过重生|已有完成章|既有卷纲/.test(messages), `应声明跳过重生卷纲，实际：${messages}`);
  assert.equal(/重新生成第5卷大纲/.test(messages), false, '不得再发重生卷纲阶段消息');
  const kept = store.chapters.outline(planned41.id);
  assert.equal(kept.beat, 'KEEP-BEAT', '重规划中断不得先把未写章细纲清成空对象');
  assert.equal(kept.year, 1259);
});

test('V0.104.2 完成章遗留的质量门冲突应随完成态核销', () => {
  const book = store.books.create({ title: '质量门陈旧债', genre: '历史' });
  const chapter = store.chapters.create(book.id, null, 38, { title: '断汲之危', status: 'done' });
 store.scenes.create(chapter.id, 1, { content: '主角把水车闸板落下。', status: 'done' });
  const row = store.conflicts.create(book.id, {
    chapterId: chapter.id, type: '质量门未通过',
    issue: '章节审校在 3 轮修复后仍为 replan，已停在本章等待自动重试', quote: '',
  });
  const count = store.conflicts.resolveRecoveredChapter(chapter.id, store.chapters.fullText(chapter.id));
  assert.ok(count >= 1);
  assert.notEqual(store.conflicts.list(book.id).find(item => item.id === row.id).resolution, 'open');
});

test('V0.104.2 下一章续写不得再标成补写被跳过', () => {
  const src = read('server/engine/pipeline/pilot.js');
  assert.match(src, /续写第 \$\{ch\.idx\} 章/, 'maxDone+1 的下一章应显示续写，不是被跳过');
  assert.match(src, /ch\.idx < maxDone/, '只有进度内部的洞才叫补写被跳过');
});
