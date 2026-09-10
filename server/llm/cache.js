// server/llm/cache.js —— 缓存感知的请求组装（历史堆 + 尾追加；DeepSeek 前缀缓存适配核心）
'use strict';
import * as store from '../db/store.js';
import { estimateTokens } from './tokenizer.js';
import { getGlobal } from '../config.js';

/**
 * 组装一次请求的完整 messages：
 *   [...历史堆（system + 公共材料 + 已写场景）..., ...tailMessages]
 * 纪律：
 *  - 历史堆 append-only，只从 DB 读取，绝不在此修改；
 *  - 所有动态内容（细纲/检索结果/指令）必须放 tailMessages（最后一条 user 消息）；
 *  - V0.84 归档记忆（上下文压缩产物）从"拼进公共材料内部"改为"追加到末条 user 指令末尾"——
 *    此前拼进 history[1]（公共材料）：归档发生时公共材料文本整体变化 → system+公共材料+全部正文前缀
 *    一次性失效（几十万 tokens 全 miss）。移到指令末尾后：system+公共材料+已写正文前缀恒定，
 *    归档变化只失效尾部指令段，命中率不掉。
 *  - 此函数不改变任何状态。
 */
export function assembleMessages(bookId, tailMessages) {
  const history = store.history.list(bookId).map(h => ({ role: h.role, content: h.content }));
  const archiveText = archiveInjectionText(bookId);
  const tails = (tailMessages || []).map(m => ({ role: m.role, content: m.content }));
  if (archiveText) {
    // 归档记忆并入末条 user 指令（保持前缀 system→user→assistant→…→user 结构，不新增连续 user）
    const last = tails[tails.length - 1];
    if (last && last.role === 'user') last.content += `\n\n${archiveText}`;
    else tails.push({ role: 'user', content: archiveText });
  }
  return [...history, ...tails];
}

/**
 * 为审校/覆盖检查组装隔离上下文：只保留 system、固定设定材料和归档记忆，
 * 不携带历史堆中的旧章节正文。旧正文会让审校模型把其他章节的句子误认成当前草稿。
 * 固定材料与当前任务合并为一条 user 消息，兼容不接受连续 user 消息的 OpenAI 兼容端点。
 * V0.84：归档记忆从固定 user 中移出、追加到末条 user 末尾（归档变化不再失效 system+公共材料前缀）。
 */
export function assembleReviewMessages(bookId, tailMessages = []) {
  const history = store.history.list(bookId);
  const system = history.find(row => row.role === 'system');
  const fixed = history.find(row => row.role === 'user');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system.content });

  const tails = (tailMessages || []).map(message => ({ role: message.role, content: message.content }));
  const archiveText = archiveInjectionText(bookId);
  if (fixed) {
    let fixedContent = fixed.content;
    if (tails[0]?.role === 'user') {
      fixedContent += `\n\n【当前任务】\n${tails.shift().content}`;
    }
    // V0.95 修复：归档/卷速查注入并入 fixed user（此前 push 独立 user——当 tails 被并入 fixed 后
    // 剩余为空时会产生连续两条 user，OpenAI 兼容端点拒绝、且 mock 的 lastUser 匹配失焦）
    if (archiveText) fixedContent += `\n\n${archiveText}`;
    messages.push({ role: 'user', content: fixedContent });
  } else if (archiveText) {
    const last = tails[tails.length - 1];
    if (last && last.role === 'user') last.content += `\n\n${archiveText}`;
    else tails.push({ role: 'user', content: archiveText });
  }
  return [...messages, ...tails];
}

/** 归档记忆注入文本（V0.16：上下文压缩后常驻的结构化记忆；空 = 未归档）
 *  V0.95.0：头部增加【卷速查】——已完结卷折叠为一行卷摘要（O(卷) 替代 O(章)，
 *  show-me-the-story Arc 压缩同构）；滚动记忆部分维持最近 3 批。 */
export function archiveInjectionText(bookId) {
  // V0.83：合并最近 2-3 个归档批次（此前只取最后一个——多次归档后早期批次细节对写作上下文不可达）
  const batches = store.archives.list(bookId).slice(-3);
  // V0.95：卷速查表（卷摘要存在即注入——不依赖归档发生）
  const volumeDigest = store.volumes.list(bookId)
    .filter(v => v.summary && String(v.summary).trim())
    .map(v => String(v.summary).replace(/\n+/g, ' ').slice(0, 200))
    .join('\n');
  if (!batches.length && !volumeDigest) return '';
  const parts = [];
  const rangeLabel = batches.length > 1
    ? `${batches[batches.length - 1].range_start}-${batches[0].range_end}`
    : batches.length ? `${batches[0].range_start}-${batches[0].range_end}` : '';
  for (const b of batches) {
    let data = null;
    try { data = JSON.parse(b.summary_json); } catch { continue; }
    const rolling = data.rolling;
    if (!rolling) continue;
    const seg = [];
    if (rolling.story_state) seg.push(`主线：${rolling.story_state}`);
    if (Array.isArray(rolling.characters) && rolling.characters.length) {
      seg.push(`人物状态：${rolling.characters.map(c => `${c.name || '?'}（${c.state || ''}）`).join('；')}`);
    }
    if (Array.isArray(rolling.unresolved_hooks) && rolling.unresolved_hooks.length) {
      seg.push(`未解伏笔：${rolling.unresolved_hooks.join('；')}`);
    }
    if (Array.isArray(rolling.key_facts) && rolling.key_facts.length) {
      // 每批只取前 5 条关键事实（防注入膨胀；早期批次事实由后续批次的 key_facts 递进覆盖）
      seg.push(`关键事实：${rolling.key_facts.slice(0, 5).map(k => (typeof k === 'string' ? k : `${k.fact || ''}（第${k.ref || '?'}章）`)).join('；')}`);
    }
    if (Array.isArray(rolling.force_kept) && rolling.force_kept.length) {
      seg.push(`必须保留：${rolling.force_kept.join('；')}`);
    }
    if (seg.length) {
      parts.push(batches.length > 1 ? `【第${b.range_start}-${b.range_end}章归档】${seg.join('\n')}` : seg.join('\n'));
    }
  }
  const digestBlock = volumeDigest ? `【卷速查】（每卷一行——已完结卷的结局与走向，细节按需检索）\n${volumeDigest}` : '';
  if (!parts.length && !digestBlock) return '';
  const head = rangeLabel
    ? `【归档记忆】（第${rangeLabel}章已压缩归档，以下为多批次必保信息合并；原文细节可按需检索）\n`
    : `【归档记忆】\n`;
  return head + [digestBlock, ...parts].filter(Boolean).join('\n\n');
}

/** 历史堆 token 估算（用于预算检查与 UI 进度条） */
export function historyTokens(bookId) {
  let total = 0;
  for (const h of store.history.list(bookId)) total += estimateTokens(h.content);
  return total;
}

/**
 * 预算检查：历史 + 尾消息 + 归档注入是否超过作品预算（默认 400K）。
 * @returns {{ok:boolean, usedTokens:number, budget:number, over:boolean}}
 */
export function budgetCheck(bookId, tailMessages = []) {
  const g = getGlobal();
  // V0.73：计入归档记忆注入（assembleMessages 会拼进 history[1]），此前预算低估
  const used = historyTokens(bookId) + estimateTokens(archiveInjectionText(bookId))
    + (tailMessages || []).reduce((s, m) => s + estimateTokens(m.content), 0);
  const budget = g.contextBudgetTokens || 400000;
  return { usedTokens: used, budget, over: used > budget, ok: used <= budget };
}

/**
 * 追加一条消息到历史堆（场景正文等）。
 * 仅允许在"正文生成完成、确认落库"时调用。
 */
export function appendHistory(bookId, role, content) {
  return store.history.append(bookId, role, content);
}

/** 历史堆统计（UI 用） */
export function historyStats(bookId) {
  const rows = store.history.list(bookId);
  let tokens = 0;
  let chars = 0;
  for (const r of rows) {
    tokens += estimateTokens(r.content);
    chars += r.content.length;
  }
  return {
    messages: rows.length,
    tokens,
    chars,
    lastSeq: store.history.lastSeq(bookId),
  };
}

/** 公共材料版本信息（缓存重建提示） */
export function materialsInfo(bookId) {
  return store.materials.all(bookId).map(m => ({ kind: m.kind, version: m.version, updatedAt: m.updated_at }));
}
