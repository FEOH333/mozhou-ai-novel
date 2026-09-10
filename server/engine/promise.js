// server/engine/promise.js —— V0.80 契约承诺兑现校验
// 治本：书契约"前N章承诺"（前3章打脸/前5章功法/前10章冲突…）只作文本进前缀，无任何兑现校验——
// 承诺落空 = 读者期待落空 = 弃书。本模块：承诺结构化落库（contract_promises）+ 到期 LLM 核对 +
// 未兑现 → 约束反哺下一章 + 记债（保持 open 重试窗）。
'use strict';
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleReviewMessages } from '../llm/cache.js';
import { promiseCheckInstruction } from './prompts.js';
import { extractJSON } from '../util/json.js';

/** 只解析一次性的绝对章节期限；周期节奏（每N章/每卷末）返回 null。 */
export function absolutePromiseDue(text) {
  const source = String(text || '');
  const match = source.match(/(?:前\s*(\d+)\s*章(?:内|之内|以前|之前)?|第\s*(\d+)\s*章(?:前|以前|之前|内))/);
  if (!match) return null;
  const due = parseInt(match[1] || match[2], 10);
  return Number.isInteger(due) && due > 0 ? due : null;
}

/** 契约承诺 → contract_promises 表（幂等 sync；只登记有一次性绝对期限的承诺）。
 * “每N章/每卷末”等周期规则仍保留在书契约中，但不能伪装成第10章到期的一次性债务。 */
export function syncContractPromises(bookId, contract) {
  if (!contract || !Array.isArray(contract.promises)) return [];
  const synced = [];
  for (const raw of contract.promises) {
    const text = typeof raw === 'string' ? raw : (raw?.text || '');
    if (!text) continue;
    const due = absolutePromiseDue(text);
    if (due == null) continue;
    store.contractPromises.upsert(bookId, { text, dueChapter: due });
    synced.push({ text, due });
  }
  return synced;
}

/**
 * 到期承诺核对（每章 done 后调）：找 status='open' 且 due<=当前章 且未核对过的承诺，
 * LLM 一次核对是否兑现；未兑现 → constraints 注入"下一章优先补" + 记债 + 保持 open。
 * @returns {Promise<Array>} 本次核对的承诺结果
 */
export async function checkPromiseFulfillment(bookId, currentChapterIdx, { signal } = {}) {
  try {
    const duePromises = store.contractPromises.due(bookId, currentChapterIdx);
    if (!duePromises.length) return [];
    // 组装前 due 章摘要
    const chapters = store.chapters.list(bookId).filter(c => c.idx <= currentChapterIdx).sort((a, b) => a.idx - b.idx);
    const summaries = chapters.slice(-8).map(c => {
      const s = store.summaries.get(c.id)?.summary || store.chapters.outline(c.id)?.beat || '';
      return `ch${c.idx}《${c.title}》：${(s || '').slice(0, 80)}`;
    });
    const results = [];
    for (const p of duePromises) {
      try {
        const instruction = promiseCheckInstruction({
          bookTitle: store.books.get(bookId)?.title || '', promiseText: p.text, dueChapter: p.due_chapter, summaries,
        });
        const messages = assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]);
        const res = await runTask({
          task: 'promise_check', bookId, messages, jsonMode: true, signal,
          routeOverride: { maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low' }, // V0.95.3 回退：与 config 同步（判定门确定性优先）
        });
        const parsed = extractJSON(res.content) || {};
        const met = parsed.met !== false; // 默认视为已兑现（宽松）
        store.contractPromises.update(p.id, { checkedChapter: currentChapterIdx, status: met ? 'met' : 'open', fulfilledChapter: met ? currentChapterIdx : undefined });
        if (!met) {
          // 未兑现 → 约束注入下一章优先补 + 记债
          try {
            store.constraints.add(bookId, {
              content: `【契约承诺未兑现】${p.text}（第${p.due_chapter}章前必须兑现）——当前未兑现，下一章优先补上这个期待`,
              source: 'recovery',
              key: `promise:${p.id}`,
              scopeStart: currentChapterIdx + 1,
              scopeEnd: currentChapterIdx + 3,
            });
            store.conflicts.create(bookId, { chapterId: null, type: '契约承诺', quote: '', issue: `${p.text} 未在第${p.due_chapter}章前兑现（已到 ch${currentChapterIdx}）` });
          } catch { /* ignore */ }
        }
        results.push({ text: p.text, due: p.due_chapter, met, evidence: parsed.evidence || '', gap: parsed.gap || '' });
      } catch { /* 单条核对失败不影响其他 */ }
    }
    return results;
  } catch (e) {
    return [];
  }
}
