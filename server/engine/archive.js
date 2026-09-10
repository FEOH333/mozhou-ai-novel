// server/engine/archive.js —— 上下文归档引擎（V0.16）
// 借鉴：MemGPT 双阈值压力机制 + 递归摘要常驻；Anthropic structured note-taking（字段枚举+引用防丢细节）；
//       Mem0 ADD-only（结构化表只增不改）；Graphiti provenance（关键细节带来源章节可回灌）。
// 纪律：
//  - 归档只动"历史堆里的旧正文"，绝不动事实库/伏笔表/时间线/角色状态（这些只增量更新）；
//  - 归档摘要结构化（字段枚举+来源引用），禁止自由散文概述；
//  - 归档后下一次请求缓存前缀重建一次，之后继续稳定递增（归档摘要由 assembleMessages 固定注入）。
'use strict';
import * as store from '../db/store.js';
import { assembleMessages, historyTokens } from '../llm/cache.js';
import { runTask } from '../llm/router.js';
import { estimateTokens } from '../llm/tokenizer.js';
import { archiveMergeInstruction } from './prompts.js';
import { getGlobal } from '../config.js';
import { isCompletedChapter } from './chapter_status.js';
import { setRollingPinned } from './rolling.js'; // V0.95：归档写 pinned 必保块（两段式单一真源）

/** V0.95 卷级 Arc 摘要来源标记：'local'（章摘要聚合兜底）| 'review'（卷审 LLM 精炼） */
export const VOLUME_DIGEST_LOCAL = 'local';

/**
 * V0.95 卷级 Arc 压缩（show-me-the-story EnsureArcSummaries 同构）：
 * 卷内已有完成章即生成本地聚合卷摘要（零 LLM：goal + 章摘要串接），且**随卷内完成章数
 * 增长而重新聚合**（覆盖旧 local 版——pilot 逐章建章，早期「卷内仅 1 章完成」时生成的
 * 摘要不完整，必须能更新）；卷审（volumereview）产出的 LLM 精炼版带【卷审】标记，不被
 * 本地版覆盖。注入端（archiveInjectionText）用卷速查表以 O(卷) 替代 O(章)。
 * @returns {number} 本次生成/更新的卷摘要数
 */
export function ensureVolumeSummaries(bookId) {
  let generated = 0;
  for (const vol of store.volumes.list(bookId)) {
    const chapters = store.chapters.listByVolume(vol.id);
    if (!chapters.length) continue;
    const doneChapters = chapters.filter(isCompletedChapter);
    if (!doneChapters.length) continue;
    const isReviewVersion = String(vol.summary || '').startsWith('【卷审】');
    if (isReviewVersion) continue; // LLM 精炼版优先，不被本地聚合覆盖
    const parts = [];
    for (const ch of chapters) {
      const s = store.summaries.get(ch.id)?.summary || '';
      if (s) parts.push(s.replace(/\n+/g, '').trim());
    }
    if (!parts.length) continue;
    const head = `第${vol.idx}卷《${vol.title || '无题'}》${vol.goal ? `（${vol.goal}）` : ''}：`;
    const digest = (head + parts.join('→')).slice(0, 260);
    if (digest === vol.summary) continue; // 无变化不写库
    store.volumes.update(vol.id, { summary: digest });
    generated++;
  }
  return generated;
}

/** 归档配置（可在设置覆盖） */
export function archiveConfig() {
  const g = getGlobal();
  return {
    // 触发阈值：历史 tokens >= budget × ratio 时自动归档
    ratio: g.archiveRatio ?? 0.85,
    // 保留最近 N 章全文不归档（近期细节不受压缩影响；V0.83 与 config 默认 15 对齐）
    keepRecentChapters: g.keepRecentChapters ?? 15,
    // 策略：auto 自动归档 | prompt 提示后归档 | off 关闭
    strategy: g.archiveStrategy ?? 'auto',
  };
}

function archiveResponseError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function validArchiveMerge(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Array.isArray(value.missing) || !value.missing.every(item => typeof item === 'string')) return false;
  const rolling = value.new_rolling;
  if (!rolling || typeof rolling !== 'object' || Array.isArray(rolling)) return false;
  return typeof rolling.story_state === 'string'
    && Array.isArray(rolling.characters)
    && Array.isArray(rolling.unresolved_hooks)
    && Array.isArray(rolling.key_facts)
    && typeof rolling.upcoming === 'string';
}

function parseArchiveMerge(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  let text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 检查是否需要归档（双阈值：warning 只提示，archive 线才动手）
 * @returns {{needed:boolean, usedTokens:number, budget:number, warnOnly:boolean}}
 */
export function checkArchiveNeed(bookId) {
  const cfg = archiveConfig();
  const budget = getGlobal().contextBudgetTokens || 400000;
  const used = historyTokens(bookId);
  const warnLine = budget * 0.7;
  const archiveLine = budget * cfg.ratio;
  if (used >= archiveLine) return { needed: true, warnOnly: false, usedTokens: used, budget };
  if (used >= warnLine) return { needed: false, warnOnly: true, usedTokens: used, budget };
  return { needed: false, warnOnly: false, usedTokens: used, budget };
}

/**
 * 执行一次归档：压缩最旧的已定稿章节为结构化精炼卡，重组历史堆。
 * @param {string} bookId
 * @param {object} [opts] { onEvent, signal, force }
 * @returns {Promise<{batch:number, range:[number,number], archived:number, tokensSaved:number, missing:Array, summary:object}|null>}
 */
export async function runArchive(bookId, opts = {}) {
  try { store.operationLogs.add({ ts: Date.now(), category: 'cache', level: 'info', op: 'rebuild', detail: '上下文归档（前缀注入归档记忆）', bookId }); } catch { /* ignore */ }
  const { onEvent, signal, force = false } = opts;
  const emit = (type, data) => onEvent?.({ type, ...data });
  const cfg = archiveConfig();
  if (cfg.strategy === 'off' && !force) return null;

  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const chapters = store.chapters.list(bookId).filter(isCompletedChapter);
  if (chapters.length <= cfg.keepRecentChapters + 2) {
    // 章节太少，无需归档
    return null;
  }
  const lastArchive = store.archives.last(bookId);
  const archivedUpTo = lastArchive ? lastArchive.range_end : 0;
  const candidates = chapters.filter(c => c.idx > archivedUpTo);
  const toArchive = candidates.slice(0, Math.max(0, candidates.length - cfg.keepRecentChapters));
  if (!toArchive.length) return null;

  const rangeStart = toArchive[0].idx;
  const rangeEnd = toArchive[toArchive.length - 1].idx;
  emit('archive_start', { range: [rangeStart, rangeEnd], count: toArchive.length });

  // ---- 1) 构建精炼卡（本地零成本：复用结算产物 + 场景关键句提取） ----
  const cards = toArchive.map(ch => buildChapterCard(bookId, ch));
  const cardsText = cards.map(c => JSON.stringify(c, null, 1)).join('\n');

  // ---- 2) 必保清单（防丢细节：未回收伏笔 + 契约承诺 + 关键事实） ----
  const mustKeep = buildMustKeep(bookId);
  const oldRolling = store.rollingSummaries.get(bookId);

  // ---- 3) 归档摘要融合（结构化字段枚举） ----
  const res = await runTask({
    task: 'archive', bookId, messages: assembleMessages(bookId, [{
      role: 'user',
      content: archiveMergeInstruction({
        bookTitle: book.title, oldRolling, cardsText, mustKeep: mustKeep.text,
      }),
    }]), jsonMode: true, signal,
  });
  if (['length', 'max_tokens', 'incomplete'].includes(res.finishReason)) {
    throw archiveResponseError(
      'ARCHIVE_INCOMPLETE_RESPONSE',
      '归档摘要生成被截断，已保留原滚动摘要与历史记录',
      { finishReason: res.finishReason },
    );
  }
  const merged = parseArchiveMerge(res.content);
  if (!validArchiveMerge(merged)) {
    throw archiveResponseError(
      'ARCHIVE_INVALID_RESPONSE',
      '归档摘要不是有效的完整结构，已保留原滚动摘要与历史记录',
    );
  }
  let missing = Array.isArray(merged.missing) ? merged.missing : [];
  const newRolling = merged.new_rolling;

  // ---- 4) 完整性兜底：missing 项显式附加（不依赖 LLM 自觉） ----
  if (missing.length) {
    newRolling.force_kept = missing;
    emit('archive_missing', { missing });
  }

  // ---- 5) 历史堆重组：删除归档章节的正文消息（scenes 原文永存可回灌） ----
  // V0.70 修复：nextChapter 从全量章节（含 planned/失败章）中找 idx > rangeEnd 的第一个——
  // 此前用过滤后的 done/settled 数组查找，中间若有未完成章 → nextChapter=undefined → 落入
  // "删到 lastSeq" 分支误删保留章节全部正文
  const firstSeq = firstSceneSeq(toArchive[0].id);
  const allChapters = store.chapters.list(bookId).sort((a, b) => a.idx - b.idx);
  const nextChapter = allChapters.find(c => c.idx > rangeEnd);
  const keepFromSeq = nextChapter ? firstSceneSeq(nextChapter.id) : null;
  // 删除区间 = 归档章首正文 → 下一章正文之前（无下一章正文则到归档章末尾）——
  // 只删归档区间自身，绝不触碰保留章节
  const toSeq = firstSeq
    ? (keepFromSeq ? keepFromSeq - 1 : (lastSceneSeq(toArchive[toArchive.length - 1].id) || null))
    : null;
  let tokensSaved = 0;
  const batch = (lastArchive?.batch || 0) + 1;

  // ---- 6) 原子落库：校验和只读计算全部完成后，才覆盖摘要、删历史并登记批次 ----
  store.transaction(() => {
    // V0.95：滚动摘要两段式——归档只写 pinned 必保块（跨批次主线/人物/伏笔/事实），
    // recent 段（最近 K 章增量）由 settle 维护，两条写入路径不再互相覆盖（单一真源）
    try { setRollingPinned(bookId, newRolling); } catch { store.rollingSummaries.set(bookId, formatRolling(newRolling)); }
    if (firstSeq && toSeq && toSeq >= firstSeq) {
      tokensSaved = removeHistoryRange(bookId, firstSeq, toSeq);
    }
    // V0.20 修复：归档后把被归档场景的 history_seq 置空，防止后续修订/重写老章节时
    // truncateFrom(旧seq) 误删保留章节正文（旧 seq 已随删除失效）
    for (const ch of toArchive) {
      for (const sc of store.scenes.list(ch.id)) {
        if (sc.history_seq) store.scenes.update(sc.id, { historySeq: null });
      }
    }
    store.archives.add(bookId, { batch, rangeStart, rangeEnd, summaryJson: { cards, rolling: newRolling }, tokensSaved });
  });

  emit('archive_done', { batch, range: [rangeStart, rangeEnd], tokensSaved });
  return { batch, range: [rangeStart, rangeEnd], archived: toArchive.length, tokensSaved, missing, summary: newRolling };
}

/** 构建单章精炼卡（结构化防丢细节） */
export function buildChapterCard(bookId, chapter) {
  const summary = store.summaries.get(chapter.id)?.summary || '';
  const scenes = store.scenes.list(chapter.id);
  const factsOfChapter = store.facts.list(bookId, { status: 'active' }).filter(f => f.source_chapter === chapter.idx);
  const foreshadowsOfChapter = store.foreshadows.list(bookId).filter(f =>
    f.planted_chapter === chapter.idx || JSON.parse(f.advance_chapters || '[]').includes(chapter.idx) || f.payoff_chapter === chapter.idx);
  // 关键细节：含专名的句子 + 对话 + 场景结尾句（本地提取，不依赖 LLM）
  const entities = collectEntityNames(bookId);
  const keyDetails = [];
  for (const sc of scenes) {
    for (const para of (sc.content || '').split(/\n+/)) {
      const t = para.trim();
      if (t.length < 12 || t.length > 120) continue;
      const hasEntity = entities.some(e => e && t.includes(e));
      const isDialogue = /[“"「]/.test(t);
      if (hasEntity || isDialogue) keyDetails.push({ text: t.slice(0, 100), ref: `第${chapter.idx}章·${sc.idx}` });
    }
    if (keyDetails.length >= 12) break;
  }
  const endingHook = scenes.filter(s => s.content).slice(-1)[0]?.content?.trim().slice(-80) || '';
  return {
    chapter: chapter.idx,
    title: chapter.title || `第${chapter.idx}章`,
    plot: summary || '',
    key_details: keyDetails.slice(0, 12),
    facts: factsOfChapter.map(f => `${f.subject}${f.predicate ? ' ' + f.predicate : ''}${f.object ? ' ' + f.object : ''}`),
    foreshadows: foreshadowsOfChapter.map(f => `[${f.id}] ${f.desc}（${f.status}）`),
    ending_hook: endingHook,
  };
}

/** 必保清单（防丢细节的校验基准） */
export function buildMustKeep(bookId) {
  const lines = [];
  const hooks = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
  for (const f of hooks) lines.push(`未回收伏笔 [${f.id}] ${f.desc}（计划第${f.payoff_chapter || '?'}章回收）`);
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  if (contract) lines.push(`书契约（承诺与硬约束）：${contract.slice(0, 300)}`);
  const facts = store.facts.recent(bookId, { status: 'active', limit: 15 });
  for (const f of facts) lines.push(`事实：${f.subject}${f.predicate ? ' ' + f.predicate : ''}${f.object ? ' ' + f.object : ''}（第${f.source_chapter || '?'}章）`);
  return { text: lines.join('\n'), hooks, facts };
}

/** 收集专名（角色/地点/物品/势力） */
export function collectEntityNames(bookId) {
  const names = [];
  for (const api of [store.characters, store.locations, store.items, store.factions]) {
    for (const e of api.list(bookId)) {
      if (e.name && e.name.length >= 2) names.push(e.name);
    }
  }
  return names;
}

/** 格式化滚动摘要（结构化 → 文本，供写作指令注入） */
export function formatRolling(r) {
  if (!r) return '';
  const parts = [];
  if (r.story_state) parts.push(`主线：${r.story_state}`);
  if (Array.isArray(r.characters) && r.characters.length) {
    parts.push(`人物状态：${r.characters.map(c => `${c.name || '?'}（${c.state || ''}）`).join('；')}`);
  }
  if (Array.isArray(r.unresolved_hooks) && r.unresolved_hooks.length) {
    parts.push(`未解伏笔：${r.unresolved_hooks.join('；')}`);
  }
  if (Array.isArray(r.key_facts) && r.key_facts.length) {
    parts.push(`关键事实：${r.key_facts.map(k => (typeof k === 'string' ? k : `${k.fact || ''}（第${k.ref || '?'}章）`)).join('；')}`);
  }
  if (r.upcoming) parts.push(`走向：${r.upcoming}`);
  if (Array.isArray(r.force_kept) && r.force_kept.length) {
    parts.push(`必须保留：${r.force_kept.join('；')}`);
  }
  return parts.join('\n');
}

/** 查找章节第一个场景的 history_seq（无正文返回 null） */
export function firstSceneSeq(chapterId) {
  if (!chapterId) return null;
  const scenes = store.scenes.list(chapterId).filter(s => s.history_seq);
  return scenes.length ? Math.min(...scenes.map(s => s.history_seq)) : null;
}

/** 查找章节最后一个场景的 history_seq（无正文返回 null） */
export function lastSceneSeq(chapterId) {
  if (!chapterId) return null;
  const scenes = store.scenes.list(chapterId).filter(s => s.history_seq);
  return scenes.length ? Math.max(...scenes.map(s => s.history_seq)) : null;
}

/** 删除历史堆指定 seq 区间（只删正文消息；保留 system/user）并估算节省 tokens */
function removeHistoryRange(bookId, fromSeq, toSeq) {
  if (!fromSeq || !toSeq || toSeq < fromSeq) return 0;
  const removed = store.db().prepare('SELECT content FROM history WHERE book_id=? AND seq>=? AND seq<=?').all(bookId, fromSeq, toSeq);
  let tokens = 0;
  for (const r of removed) tokens += estimateTokens(r.content);
  store.db().prepare('DELETE FROM history WHERE book_id=? AND seq>=? AND seq<=?').run(bookId, fromSeq, toSeq);
  return tokens;
}

/** 原文回灌检索（防降智：模型对存疑细节可查原文；scenes 表永存） */
export function archiveSearch(bookId, query, { limit = 5 } = {}) {
  const results = [];
  const chapters = store.chapters.list(bookId);
  const q = query.trim();
  for (const ch of chapters) {
    for (const sc of store.scenes.list(ch.id)) {
      if (!sc.content) continue;
      const idx = sc.content.indexOf(q);
      if (idx >= 0) {
        results.push({
          chapter: ch.idx,
          scene: sc.idx,
          excerpt: sc.content.slice(Math.max(0, idx - 40), idx + q.length + 60),
        });
      }
    }
    if (results.length >= limit) break;
  }
  // 归档批次摘要兜底
  if (!results.length) {
    for (const ar of store.archives.list(bookId)) {
      const cards = ar.summary_json ? JSON.parse(ar.summary_json).cards || [] : [];
      for (const card of cards) {
        const blob = JSON.stringify(card);
        if (blob.includes(q)) {
          results.push({ chapter: card.chapter, scene: 0, excerpt: (card.plot || '').slice(0, 120) + '…（来自归档批次' + ar.batch + '）' });
        }
      }
    }
  }
  return results.slice(0, limit);
}
