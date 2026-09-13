// server/engine/narrative/worldbook.js —— 世界书（SillyTavern 模式：关键词触发 + 预算裁剪）
'use strict';
import * as store from '../../db/store.js';
import { estimateTokens } from '../../llm/tokenizer.js';
import { getGlobal } from '../../config.js';

/**
 * 根据文本激活世界书条目（关键词子串匹配，中文适用），按 priority 排序、预算裁剪。
 * @param {string} bookId
 * @param {string} scanText 扫描文本（通常 = 本章细纲 JSON + 场景节拍）
 * @param {number} [budgetTokens] 覆盖全局预算
 * @returns {Promise<string>} 注入文本（已按预算裁剪）
 */
export function activateEntriesText(bookId, scanText, budgetTokens) {
  const entries = store.worldbook.list(bookId, { enabledOnly: true });
  if (!entries.length) return '';
  const budget = budgetTokens ?? getGlobal().worldbookBudgetTokens ?? 2000;

  const activated = [];
  for (const e of entries) {
    let kws = [];
    try { kws = JSON.parse(e.keywords || '[]'); } catch { kws = []; }
    if (!kws.length) { activated.push(e); continue; } // 无关键词 = 常驻条目
    const hit = kws.some(kw => kw && scanText.includes(kw));
    if (hit) activated.push(e);
  }
  activated.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const parts = [];
  let used = 0;
  for (const e of activated) {
    const text = `【${e.category || '设定'}】${e.content}`;
    const t = estimateTokens(text);
    if (used + t > budget && parts.length) break; // 超出预算，停止（至少保留第一条）
    parts.push(text);
    used += t;
  }
  return parts.join('\n');
}
