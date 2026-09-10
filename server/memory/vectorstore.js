// server/memory/vectorstore.js —— 向量索引与检索（余弦相似度，本地全量扫描）
// 规模预期：单本书数千条 chunk（每条 512 字），全量扫描毫秒级，无需 ANN。
'use strict';
import * as store from '../db/store.js';
import { embedOne } from './embedding.js';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 语义检索：query → 向量 → 与库内所有向量比余弦。
 * @param {string} bookId
 * @param {string} query
 * @param {number} [k=6]
 * @param {string} [kind] 限定类型 chapter|fact|summary|foreshadow
 * @returns {Promise<Array<{kind:string, refId:string, chunk:string, score:number}>>} embedding 不可用时返回 []
 */
export async function semanticSearch(bookId, query, k = 6, kind) {
  const qv = await embedOne(query);
  if (!qv) return [];
  const rows = store.vectors.list(bookId, kind);
  if (!rows.length) return [];
  const scored = [];
  for (const r of rows) {
    let vec;
    try { vec = JSON.parse(r.embedding_json); } catch { continue; }
    if (!vec || vec.length !== qv.length) continue;
    scored.push({ kind: r.kind, refId: r.ref_id, chunk: r.chunk, score: cosine(qv, vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * 统一检索：优先语义，降级关键词（factbook.relevantFacts 由调用方兜底）。
 * @returns {Promise<{semantic:Array, available:boolean}>}
 */
export async function search(bookId, query, k = 6) {
  const semantic = await semanticSearch(bookId, query, k);
  return { semantic, available: semantic.length > 0 || store.vectors.count(bookId) > 0 };
}

/** 将语义检索结果格式化为指令可注入文本 */
export function formatSemanticResults(results) {
  return results.map(r => `- [${r.kind}] ${r.chunk.slice(0, 200)}`).join('\n');
}
