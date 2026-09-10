// 正文排版归一化：场景内段落间距收敛为单换行（\n\n → \n），去行尾空白、统一换行符。
// 只允许纯空白变更（内容字符流必须逐字一致，否则失败关闭跳过该场景）。
// 变更章在同一事务内同步：场景正文 + 历史堆 + 字数 + 结算指纹（sha256 全文）。
// 默认只读扫描；应用：node server/maintenance/normalize-prose-spacing.js --book <书名或ID> --apply
// V0.93.1
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../db/store.js';
import { estimateChineseChars } from '../llm/tokenizer.js';

const BOOK_ARG = process.argv.find((arg, i) => process.argv[i - 1] === '--book');
const APPLY = process.argv.includes('--apply');
if (!BOOK_ARG) {
  console.error('用法：node server/maintenance/normalize-prose-spacing.js --book <书名或ID> [--apply]');
  process.exit(2);
}

/** 段落间距归一化：单换行分隔、去行尾空白、去首尾空行 */
export function normalizeProseSpacing(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const paragraphs = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  return paragraphs.join('\n');
}

/** 纯空白等价校验：除去全部空白后必须逐字一致（防误改内容） */
export function isWhitespaceOnlyChange(before, after) {
  return String(before || '').replace(/\s/g, '') === String(after || '').replace(/\s/g, '');
}

function findBook() {
  const books = store.books.list();
  const hit = books.find(b => b.id === BOOK_ARG) || books.find(b => String(b.title || '').includes(BOOK_ARG));
  if (!hit) {
    console.error(`未找到匹配书籍：${BOOK_ARG}`);
    console.error(`现有书籍：${books.map(b => `${b.title}(${b.id})`).join('；')}`);
    process.exit(2);
  }
  return hit;
}

function scan(bookId) {
  const chapters = store.chapters.list(bookId).sort((a, b) => a.idx - b.idx);
  const plan = [];
  let abnormal = 0;
  for (const chapter of chapters) {
    const scenePatches = [];
    for (const scene of store.scenes.list(chapter.id)) {
      if (!scene.content) continue;
      const next = normalizeProseSpacing(scene.content);
      if (next === scene.content) continue;
      if (!isWhitespaceOnlyChange(scene.content, next)) {
        console.error(`[失败关闭] 第${chapter.idx}章 场景${scene.idx}：归一化将改动非空白字符，已跳过`);
        abnormal++;
        continue;
      }
      scenePatches.push({ scene, next });
    }
    if (scenePatches.length) plan.push({ chapter, scenePatches });
  }
  return { plan, abnormal };
}

const book = findBook();
const { plan, abnormal } = scan(book.id);

if (!plan.length) {
  console.log(`《${book.title}》：所有场景段落间距已归一，无需变更${abnormal ? `（${abnormal} 个场景异常跳过）` : ''}。`);
  process.exit(abnormal ? 1 : 0);
}

console.log(`《${book.title}》扫描结果：${plan.length} 章 ${plan.reduce((n, p) => n + p.scenePatches.length, 0)} 个场景存在段落间距不一致。`);
for (const { chapter, scenePatches } of plan) {
  console.log(`  第${chapter.idx}章《${chapter.title}》：${scenePatches.map(p => `场景${p.scene.idx}(${p.scene.content.length}→${p.next.length}字符)`).join('、')}`);
}

if (!APPLY) {
  console.log('\n未加 --apply，只读扫描结束。确认无误后加 --apply 执行（执行前自动备份、事务化、幂等可重跑）。');
  process.exit(abnormal ? 1 : 0);
}

// 执行：备份 → 事务（正文+历史堆+字数+结算指纹） → 幂等复验
await store.backup({ prefix: 'pre_prose_normalize_' });
store.transaction(() => {
  for (const { chapter, scenePatches } of plan) {
    for (const { scene, next } of scenePatches) {
      store.scenes.update(scene.id, { content: next });
      if (scene.history_seq) store.history.replace(chapter.book_id, scene.history_seq, 'assistant', next);
    }
    const fullText = store.chapters.fullText(chapter.id);
    store.chapters.update(chapter.id, { wordCount: estimateChineseChars(fullText) });
    const settlement = store.chapterSettlements.get(chapter.id);
    if (settlement) {
      const contentHash = createHash('sha256').update(fullText).digest('hex');
      store.chapterSettlements.set(chapter.book_id, chapter.id, { contentHash, result: settlement.result || {} });
    }
  }
});

// 幂等复验：再次扫描必须零变更
const { plan: leftover, abnormal: leftoverAbnormal } = scan(book.id);
if (leftover.length || leftoverAbnormal) {
  console.error(`[复验失败] 重扫仍有 ${leftover.length} 章 ${leftoverAbnormal} 异常，请检查数据库。`);
  process.exit(1);
}
console.log('已应用并复验通过：段落间距归一化幂等完成。');
