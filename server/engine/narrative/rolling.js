// server/engine/narrative/rolling.js —— V0.95 滚动摘要两段式单一真源
// 背景：审计实证 settle（追加最近 12 段）与 archive（LLM 覆盖结构化 rolling）双写路径
// 格式漂移——归档后紧接着的 settle 把自由文本追加到结构化版本后面，早批次细节在 trim 中
// 持续丢失，recovery 需要 formatRollingSafe 兼容两种形态。本模块统一为：
//   rolling_summaries.content = JSON { pinned: {…归档必保块…}, recent: [{chapter,text},…] }
// settle 只写 recent（追加、保 K 条），archive 只写 pinned（跨批次必保），互不覆盖。
// 旧格式（自由文本/旧 JSON rolling）读取时兼容透传。
'use strict';
import * as store from '../../db/store.js';
import { sanitizeStoryMemoryText } from '../quality/rules.js';

const RECENT_KEEP = 12;

/** 解析滚动摘要（兼容三形态：V0.95 两段式 JSON / V0.16 结构化 rolling JSON / 自由文本） */
export function parseRolling(content) {
  const raw = String(content || '');
  if (!raw) return { pinned: null, recent: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.recent)) {
        return {
          pinned: parsed.pinned && typeof parsed.pinned === 'object' ? parsed.pinned : null,
          recent: parsed.recent.filter(x => x && Number.isInteger(x.chapter) && typeof x.text === 'string'),
        };
      }
      // V0.16 归档结构化 rolling（story_state/characters/…）→ 视为 pinned
      if (typeof parsed.story_state === 'string') return { pinned: parsed, recent: [] };
    }
  } catch { /* 自由文本 */ }
  return { pinned: null, legacy: raw, recent: [] };
}

function write(bookId, parsed) {
  store.rollingSummaries.set(bookId, JSON.stringify({ pinned: parsed.pinned || null, recent: parsed.recent }));
}

/** settle 结算后追加 recent 段（每章一段，保最近 K 条；不动 pinned） */
export function appendRollingRecent(bookId, chapterIdx, text) {
  const body = sanitizeStoryMemoryText(text).trim();
  if (!body) return;
  const parsed = parseRolling(store.rollingSummaries.get(bookId));
  const recent = parsed.recent.filter(r => r.chapter !== Number(chapterIdx));
  recent.push({ chapter: Number(chapterIdx), text: body.slice(0, 300) });
  write(bookId, { pinned: parsed.pinned, recent: recent.slice(-RECENT_KEEP) });
}

/** archive 归档后写 pinned 必保块（跨批次主线/人物/伏笔/事实；不动 recent） */
export function setRollingPinned(bookId, pinned) {
  if (!pinned || typeof pinned !== 'object') return;
  const parsed = parseRolling(store.rollingSummaries.get(bookId));
  write(bookId, { pinned, recent: parsed.recent });
}

/** pinned → 文本行（主线/人物状态/未解伏笔/关键事实/走向） */
function pinnedText(p) {
  if (!p) return '';
  const seg = [];
  const safe = value => sanitizeStoryMemoryText(value).trim();
  if (safe(p.story_state)) seg.push(`主线：${safe(p.story_state)}`);
  if (Array.isArray(p.characters) && p.characters.length) {
    const line = safe(p.characters.map(c => `${c.name || '?'}（${c.state || ''}）`).join('；'));
    if (line) seg.push(`人物状态：${line}`);
  }
  if (Array.isArray(p.unresolved_hooks) && p.unresolved_hooks.length) {
    const line = safe(p.unresolved_hooks.join('；'));
    if (line) seg.push(`未解伏笔：${line}`);
  }
  if (Array.isArray(p.key_facts) && p.key_facts.length) {
    const line = safe(p.key_facts.slice(0, 8).map(k => (typeof k === 'string' ? k : `${k.fact || ''}（第${k.ref || '?'}章）`)).join('；'));
    if (line) seg.push(`关键事实：${line}`);
  }
  if (safe(p.upcoming)) seg.push(`走向：${safe(p.upcoming)}`);
  if (Array.isArray(p.force_kept) && p.force_kept.length) {
    const line = safe(p.force_kept.join('；'));
    if (line) seg.push(`必须保留：${line}`);
  }
  return seg.join('\n');
}

/** 统一输出文本（写作/审校/诊断注入用；兼容旧格式直接透传） */
export function rollingText(bookId) {
  const parsed = parseRolling(store.rollingSummaries.get(bookId));
  if (parsed.legacy) return sanitizeStoryMemoryText(parsed.legacy); // 旧自由文本也不得回灌编辑意见
  const parts = [];
  const pt = pinnedText(parsed.pinned);
  if (pt) parts.push(`【主线必保（归档沉淀）】\n${pt}`);
  if (parsed.recent.length) {
    const recent = parsed.recent
      .map(r => ({ ...r, text: sanitizeStoryMemoryText(r.text).trim() }))
      .filter(r => r.text);
    if (recent.length) parts.push(`【近情（最近 ${recent.length} 章）】\n${recent.map(r => `【第${r.chapter}章】${r.text}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
