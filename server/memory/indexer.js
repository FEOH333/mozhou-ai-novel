// server/memory/indexer.js —— 章节/事实/伏笔 → 分块 → 向量，后台索引
'use strict';
import * as store from '../db/store.js';
import { embed } from './embedding.js';
import { getGlobal } from '../config.js';

/** 文本分块（按字数滑窗，重叠 overlap） */
export function chunkText(text, { words = 512, overlap = 64 } = {}) {
  if (!text) return [];
  const chunks = [];
  let i = 0;
  const step = Math.max(1, words - overlap);
  while (i < text.length) {
    chunks.push(text.slice(i, i + words));
    i += step;
  }
  return chunks;
}

/** 索引一本书的全部可检索内容（幂等：先清空该书向量） */
export async function indexBook(bookId, { onProgress } = {}) {
  const g = getGlobal();
  if (!g.embedding?.enabled) return { indexed: 0, skipped: true };
  const cfg = g.retrieval || {};
  const words = cfg.chunkWords || 512;
  const overlap = cfg.overlapWords || 64;

  store.vectors.clear(bookId);
  const chapters = store.chapters.list(bookId);
  let total = 0;
  const items = [];

  for (const ch of chapters) {
    const text = store.chapters.fullText(ch.id);
    const summary = store.summaries.get(ch.id)?.summary;
    for (const c of chunkText(text, { words, overlap })) items.push({ kind: 'chapter', refId: ch.id, chunk: c });
    if (summary) items.push({ kind: 'summary', refId: ch.id, chunk: `第${ch.idx}章摘要：${summary}` });
  }
  for (const f of store.facts.list(bookId, { status: 'active' })) {
    items.push({ kind: 'fact', refId: f.id, chunk: `${f.subject}${f.predicate ? ' ' + f.predicate : ''}${f.object ? ' ' + f.object : ''}` });
  }
  for (const fs of store.foreshadows.list(bookId)) {
    items.push({ kind: 'foreshadow', refId: fs.id, chunk: `${fs.desc}（${fs.status}）` });
  }

  // 分批 embed（每批 32）
  const BATCH = 32;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const vecs = await embed(batch.map(b => b.chunk));
    if (!vecs) return { indexed: total, error: 'embedding 不可用' };
    batch.forEach((b, j) => {
      store.vectors.add(bookId, { kind: b.kind, refId: b.refId, chunk: b.chunk, embedding: vecs[j] });
      total++;
    });
    onProgress?.({ indexed: total, total: items.length });
  }
  return { indexed: total, total: items.length };
}

/**
 * V0.95 增量索引单章（幂等：先清该章旧向量再重建）——settle 落库后自动触发，
 * 盘活闲置的向量管道（审计实证：indexBook 仅手动 HTTP 触发，semanticSearch 只检索 fact，
 * 章节正文向量从不进写作上下文——300 章后早期细节"按语义召回"名存实亡）。
 * embedding 不可用/未启用 → 返回 { skipped: true }，绝不抛错（降级铁律：不阻断结算）。
 */
export async function indexChapter(bookId, chapterId, { onProgress } = {}) {
  const g = getGlobal();
  if (!g.embedding?.enabled) return { skipped: true, reason: 'embedding 未启用' };
  const cfg = g.retrieval || {};
  const words = cfg.chunkWords || 512;
  const overlap = cfg.overlapWords || 64;
  const chapter = store.chapters.get(chapterId);
  if (!chapter) return null;
  try { store.vectors.removeByRef(bookId, 'chapter', chapterId); } catch { /* 旧库无该方法忽略 */ }
  try { store.vectors.removeByRef(bookId, 'summary', chapterId); } catch { /* ignore */ }
  const text = store.chapters.fullText(chapterId);
  const summary = store.summaries.get(chapterId)?.summary;
  const items = [];
  for (const c of chunkText(text, { words, overlap })) items.push({ kind: 'chapter', refId: chapterId, chunk: c });
  if (summary) items.push({ kind: 'summary', refId: chapterId, chunk: `第${chapter.idx}章摘要：${summary}` });
  if (!items.length) return { indexed: 0 };
  let total = 0;
  const BATCH = 32;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const vecs = await embed(batch.map(b => b.chunk));
    if (!vecs) return { indexed: total, skipped: true, reason: 'embedding 不可用' };
    batch.forEach((b, j) => {
      store.vectors.add(bookId, { kind: b.kind, refId: b.refId, chunk: b.chunk, embedding: vecs[j] });
      total++;
    });
    onProgress?.({ indexed: total, total: items.length });
  }
  return { indexed: total };
}
