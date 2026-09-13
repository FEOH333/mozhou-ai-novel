// 结算指纹失配修复：chapter_settlements.content_hash 与当前正文 sha256 不一致时，
// 仅当章节确实完整（isCompletedChapter 真源判定）且已有摘要时，才允许在同一事务内
// 把指纹刷新为当前正文哈希（result_json 原样保留，不掩盖任何派生状态污染）。
// 默认只读扫描；应用：node server/maintenance/repair-stale-fingerprints.js --book <书名或ID> [--apply]
// V0.93.1
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../db/store.js';
import { isCompletedChapter } from '../engine/pipeline/chapter_status.js';

const BOOK_ARG = process.argv.find((arg, i) => process.argv[i - 1] === '--book');
const APPLY = process.argv.includes('--apply');
if (!BOOK_ARG) {
  console.error('用法：node server/maintenance/repair-stale-fingerprints.js --book <书名或ID> [--apply]');
  process.exit(2);
}

const book = store.books.list().find(b => b.id === BOOK_ARG || String(b.title || '').includes(BOOK_ARG));
if (!book) {
  console.error(`未找到匹配书籍：${BOOK_ARG}`);
  console.error(`现有书籍：${store.books.list().map(b => `${b.title}(${b.id})`).join('；')}`);
  process.exit(2);
}

const stale = [];
const blocked = [];
for (const chapter of store.chapters.list(book.id)) {
  const settlement = store.chapterSettlements.get(chapter.id);
  if (!settlement) continue;
  const text = store.chapters.fullText(chapter.id) || '';
  const hash = createHash('sha256').update(text).digest('hex');
  if (settlement.content_hash === hash) continue;
  const complete = isCompletedChapter(chapter);
  const hasSummary = Boolean(store.summaries.get(chapter.id)?.summary);
  if (complete && hasSummary) stale.push({ chapter, hash, settlement });
  else blocked.push({ chapter, complete, hasSummary });
}

if (blocked.length) {
  console.log(`[失败关闭] 以下章节指纹失配但未满足"完整且已摘要"门槛，不予刷新，需人工核查：`);
  for (const b of blocked) console.log(`  第${b.chapter.idx}章《${b.chapter.title}》：complete=${b.complete} hasSummary=${b.hasSummary}`);
}

if (!stale.length) {
  console.log(`《${book.title}》：结算指纹与正文全部一致${blocked.length ? `（${blocked.length} 章失败关闭待核查）` : ''}。`);
  process.exit(blocked.length ? 1 : 0);
}

console.log(`《${book.title}》发现 ${stale.length} 章结算指纹失配（章节完整且已摘要，可安全刷新）：`);
for (const { chapter } of stale) console.log(`  第${chapter.idx}章《${chapter.title}》 [${chapter.status}]`);

if (!APPLY) {
  console.log('\n未加 --apply，只读扫描结束。确认后加 --apply（自动备份 + 事务 + 幂等复验）。');
  process.exit(0);
}

await store.backup({ prefix: 'pre_fingerprint_repair_' });
store.transaction(() => {
  for (const { chapter, hash, settlement } of stale) {
    store.chapterSettlements.set(chapter.book_id, chapter.id, { contentHash: hash, result: settlement.result || {} });
  }
});

// 幂等复验
const leftovers = [];
for (const { chapter } of stale) {
  const settlement = store.chapterSettlements.get(chapter.id);
  const text = store.chapters.fullText(chapter.id) || '';
  const hash = createHash('sha256').update(text).digest('hex');
  if (settlement.content_hash !== hash) leftovers.push(chapter.idx);
}
if (leftovers.length) {
  console.error(`[复验失败] 第 ${leftovers.join('、')} 章指纹仍未同步，请检查数据库。`);
  process.exit(1);
}
console.log(`已刷新 ${stale.length} 章结算指纹并幂等复验通过。`);
