// server/engine/items.js —— V0.95 物品/势力场景卡注入 + 锚点推进
// 背景：审计实证 items/factions 零注入写作与审校上下文——法宝/信物/战利品是网文长程一致性
// 高敏资产，ch5 得到的道具到 ch200 被遗忘/属性写错/无故消失，本地规则抓不到（审校看不到物品表）。
// 与 characterCardsText 同构：场景提及才注入（按需召回，不撑上下文）。
'use strict';
import * as store from '../db/store.js';
import { sanitizeStoryMemoryText } from './rules.js';

/**
 * 物品/势力场景卡文本（纯函数）：场景文本（节拍/地点/POV）或出场实体名命中才注入。
 * @param {object} opts { sceneText, names?: 额外实体名, limit }
 */
export function itemCardsText(bookId, { sceneText = '', names = [], limit = 5 } = {}) {
  const scene = String(sceneText || '');
  const nameSet = new Set((names || []).filter(Boolean));
  const out = [];
  for (const it of store.items.list(bookId)) {
    if (out.length >= limit) break;
    if (!(scene.includes(it.name) || nameSet.has(it.name))) continue;
    let detail = '';
    try {
      const c = JSON.parse(it.card_json || '{}');
      detail = sanitizeStoryMemoryText(c.detail || c.type || '').trim();
    } catch { /* ignore */ }
    let state = '';
    try {
      const s = JSON.parse(it.state_json || '{}');
      state = Object.entries(s).slice(0, 3)
        .map(([k, v]) => sanitizeStoryMemoryText(`${k}=${v}`).trim())
        .filter(Boolean)
        .join('；');
    } catch { /* ignore */ }
    out.push(`- ${it.name}${it.owner ? `（${it.owner}）` : ''}${detail ? `：${detail}` : ''}${state ? `｜${state}` : ''}`);
  }
  for (const f of store.factions.list(bookId)) {
    if (out.length >= limit + 3) break;
    if (!(scene.includes(f.name) || nameSet.has(f.name))) continue;
    let detail = '';
    try {
      const c = JSON.parse(f.card_json || '{}');
      detail = sanitizeStoryMemoryText(c.detail || '').trim();
    } catch { /* ignore */ }
    out.push(`- ${f.name}（势力）${detail ? `：${detail}` : ''}`);
  }
  if (!out.length) return '';
  return `【物品/势力卡】（前文既定——持有者/属性/状态必须一致，不得无故消失或变形）\n${out.join('\n')}`;
}

/**
 * 物品锚点推进（零 LLM，仿 touchCharacters）：物品/势力名在正文出现即推进 last_chapter。
 * @returns {string[]} 被推进的实体名
 */
export function touchItems(bookId, chapterText, chapterIdx) {
  if (!chapterText || !Number.isInteger(chapterIdx)) return [];
  const touched = [];
  for (const api of [store.items, store.factions]) {
    for (const e of api.list(bookId)) {
      const name = String(e.name || '').trim();
      if (name.length < 2 || !chapterText.includes(name)) continue;
      if (Number(e.last_chapter) === Number(chapterIdx)) continue;
      api.update(e.id, { lastChapter: chapterIdx });
      touched.push(name);
    }
  }
  return touched;
}
