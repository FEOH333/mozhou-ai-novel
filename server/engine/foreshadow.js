// server/engine/foreshadow.js —— 伏笔 ledger 操作（埋设/推进/回收/遗忘预警）
'use strict';
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { extractJSON } from '../util/json.js';
import { foreshadowClosureInstruction } from './prompts.js';
import { isCompletedChapter } from './chapter_status.js';
import { hookDescriptionsMatch } from '../util/text.js'; // V0.95：伏笔回收 → 快感钩子兑现联动（单一匹配实现）
import { sanitizeStoryMemoryText } from './rules.js';

function storyText(value) {
  return sanitizeStoryMemoryText(String(value || '')).trim();
}

/** 活跃伏笔文本（供正文指令注入，预算裁剪）
 *  V0.95.0 排序修复：审计实证旧排序（importance→created_at 升序 slice(0,6)）下
 *  6 条 high 老伏笔永久霸占注入位，新埋伏笔（medium/low）被挤出上下文、只能等"超期"
 *  才被提起——伏笔"埋设→推进→回收"链在中后期断裂（挖坑不填的机制原因）。
 *  新排序：超期最优先 + 最近埋设其次（对齐 pleasure.prioritizeAuditHooks 范式）。 */
export function activeForeshadowsText(bookId, limit = 6, currentChapter = null) {
  const fs = store.foreshadows.active(bookId);
  if (!fs.length) return '';
  const now = Number.isInteger(currentChapter)
    ? currentChapter
    : fs.reduce((m, f) => Math.max(m, Number(f.planted_chapter) || 0), 0);
  const isOverdue = f => Number(f.payoff_chapter) > 0 && now > Number(f.payoff_chapter);
  const sorted = [...fs].sort((a, b) => {
    const oa = isOverdue(a) ? 0 : 1;
    const ob = isOverdue(b) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return (Number(b.planted_chapter) || 0) - (Number(a.planted_chapter) || 0);
  });
  return sorted.map(f => ({ ...f, cleanDesc: storyText(f.desc) }))
    .filter(f => f.cleanDesc)
    .slice(0, limit)
    .map(f =>
      `- [${f.id}] ${f.cleanDesc}（${f.importance === 'high' ? '重要' : '一般'}${f.payoff_chapter ? `，计划第${f.payoff_chapter}章回收` : ''}${f.planted_chapter ? `，第${f.planted_chapter}章埋设` : ''}${f.status === 'advanced' ? '，推进中' : ''}${isOverdue(f) ? '，已超期' : ''}）`
    ).join('\n');
}

/** 临近回收伏笔文本（距回收章 ≤2 章：注入"可开始收束"提示） */
export function approachingForeshadowsText(bookId, currentChapter, window = 2) {
  const fs = store.foreshadows.approachingPayoff(bookId, currentChapter, window);
  if (!fs.length) return '';
  return fs.map(f => ({ ...f, cleanDesc: storyText(f.desc) }))
    .filter(f => f.cleanDesc)
    .map(f =>
      `- [${f.id}] ${f.cleanDesc}（计划第${f.payoff_chapter}章回收，本章可开始收束铺垫）`
    ).join('\n');
}

/** 超期伏笔文本（>target+容忍章数：注入"本章应优先回收"警告） */
export function overdueForeshadowsText(bookId, currentChapter, tolerance = 3) {
  const fs = store.foreshadows.forgotten(bookId, currentChapter, tolerance);
  if (!fs.length) return '';
  return fs.map(f => ({ ...f, cleanDesc: storyText(f.desc) }))
    .filter(f => f.cleanDesc)
    .map(f =>
      `- [${f.id}] ${f.cleanDesc}（计划第${f.payoff_chapter}章回收，已超期，本章应优先处理）`
    ).join('\n');
}

/** 伏笔表文本（供审校/结算注入）
 *  V0.95.0 限流：审校上下文全量注入在长书下退化为 100+ 条稀释注意力——
 *  超期+最近埋设优先（active 类）；回收类（paid_off/abandoned）只保留最近 10 条供对照。 */
export function allForeshadowsText(bookId, { limit = 24 } = {}) {
  const fs = store.foreshadows.list(bookId);
  if (!fs.length) return '';
  const open = fs.filter(f => f.status === 'planted' || f.status === 'advanced');
  const closed = fs.filter(f => f.status !== 'planted' && f.status !== 'advanced');
  const fmt = f => {
    const desc = storyText(f.desc);
    return desc
      ? `- [${f.id}] ${desc}（${f.status}${f.planted_chapter ? `，埋于第${f.planted_chapter}章` : ''}${f.payoff_chapter ? `，计划第${f.payoff_chapter}章回收` : ''}）`
      : '';
  };
  // open 按最近埋设优先，closed 只留最近 N 条
  const openSorted = [...open].sort((a, b) => (Number(b.planted_chapter) || 0) - (Number(a.planted_chapter) || 0)).slice(0, limit);
  const closedKept = closed.slice(0, Math.min(10, Math.max(0, limit - openSorted.length)));
  return [...openSorted, ...closedKept].map(fmt).filter(Boolean).join('\n');
}

/**
 * 应用结算抽取的伏笔动作。
 * @param {string} bookId
 * @param {Array<{id?:string, desc?:string, action:string, note?:string}>} actions
 * @param {number} chapterIdx 当前章
 * @returns {{planted:number, advanced:number, paidOff:number, abandoned:number, unknown:Array}}
 */
export function applyForeshadowActions(bookId, actions, chapterIdx, opts = {}) {
  const result = { planted: 0, advanced: 0, paidOff: 0, abandoned: 0, isolated: 0, unknown: [] };
  const chapterText = String(opts.chapterText || '');
  const all = store.foreshadows.list(bookId);
  for (const a of actions || []) {
    const action = (a.action || '').toLowerCase();
    let target = null;
    if (a.id) target = all.find(f => f.id === a.id);
    if (!target && a.desc) {
      // desc 模糊匹配（包含关系）
      const d = (a.desc || '').replace(/\s+/g, '');
      target = all.find(f => f.desc.replace(/\s+/g, '').includes(d) || d.includes(f.desc.replace(/\s+/g, '')));
    }
    if (!target) {
      if (action === 'plant') {
        const desc = storyText(a.desc || a.note) || '（未命名伏笔）';
        const note = storyText(a.note);
        const quote = String(a.quote || a.anchor || '').trim();
        if (chapterText) {
          const anchor = quote || desc;
          if (!anchor || !chapterText.includes(anchor)) {
            result.isolated += 1;
            continue;
          }
        }
        store.foreshadows.create(bookId, {
          desc,
          type: '剧情伏笔',
          plantedChapter: chapterIdx,
          status: 'planted',
          note,
          events: [{ chapter: chapterIdx, note: note || '埋设', quote }],
        });
        result.planted++;
      } else {
        result.unknown.push({ action, desc: a.desc || a.id });
      }
      continue;
    }
    switch (action) {
      case 'advance': {
        let adv = [];
        try { adv = JSON.parse(target.advance_chapters || '[]'); } catch { adv = []; }
        if (!adv.includes(chapterIdx)) adv.push(chapterIdx);
        const note = storyText(a.note || target.note);
        store.foreshadows.update(target.id, { advanceChapters: adv, status: 'advanced', note });
        store.foreshadows.appendEvent(target.id, chapterIdx, storyText(a.note) || '推进');
        result.advanced++;
        break;
      }
      case 'payoff':
        store.foreshadows.update(target.id, { status: 'paid_off', note: storyText(a.note || target.note) });
        store.foreshadows.appendEvent(target.id, chapterIdx, storyText(a.note) || '回收');
        result.paidOff++;
        // V0.95 双台账兑现联动：结算判定 payoff 是最权威的兑现信号——同步把 desc 匹配的
        // open 快感钩标 paid（此前只有快感审计发现才标，V0.93.8 实证 ch21 正文已兑现但台账 open）
        try {
          for (const h of store.pleasureHooks.list(bookId)) {
            if (h.status === 'paid' || h.status === 'expired') continue;
            if (!hookDescriptionsMatch(h.desc, target.desc) && !String(h.desc || '').replace(/\s+/g, '').includes(String(target.desc || '').replace(/\s+/g, '').slice(0, 12))) continue;
            store.pleasureHooks.update(h.id, { status: 'paid', note: `第${chapterIdx}章伏笔回收联动` });
          }
        } catch { /* 联动失败不阻塞伏笔回收 */ }
        break;
      case 'abandon':
        store.foreshadows.update(target.id, { status: 'abandoned', note: storyText(a.note || target.note) });
        store.foreshadows.appendEvent(target.id, chapterIdx, storyText(a.note) || '废弃');
        result.abandoned++;
        break;
      case 'plant':
        // 已存在相同伏笔则视为 advance
        store.foreshadows.appendEvent(target.id, chapterIdx, storyText(a.note) || '再次提及');
        result.advanced++;
        break;
      default:
        result.unknown.push({ action, desc: a.desc || a.id });
    }
  }
  return result;
}

/** 遗忘预警列表（伏笔看板用） */
export function forgottenList(bookId, currentChapter, tolerance = 10) {
  return store.foreshadows.forgotten(bookId, currentChapter, tolerance);
}


/**
 * V0.71 伏笔收束计划：检查未回收伏笔的"年龄"（种下到当前章数），超龄/临近阶段收尾的
 * 伏笔由 LLM 生成回收分配（目标卷/章 + 回收方式），落 materials(kind='foreshadow_plan')（动态材料）。
 * 触发：卷写完（卷体检后）与完本判定前；注入：续卷/卷大纲/细纲。
 * @returns {{assigned:number, overdue:number, note:string}}
 */
export async function foreshadowClosurePlan(bookId, { onEvent, signal } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const chapters = store.chapters.list(bookId);
  const current = chapters.filter(isCompletedChapter).reduce((m, c) => Math.max(m, c.idx), 0);
  if (current < 8) return { assigned: 0, overdue: 0, note: '章节太少（<8），暂不安排收束' };

  const open = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
  if (!open.length) return { assigned: 0, overdue: 0, note: '无未回收伏笔' };

  // 超龄判定：种下超过 15 章 或 计划回收章已过
  const overdue = open.filter(f => {
    const planted = f.planted_chapter || 0;
    const due = f.payoff_chapter || 0;
    return (planted > 0 && current - planted >= 15) || (due > 0 && current > due);
  });
  if (!overdue.length) return { assigned: 0, overdue: 0, note: `${open.length} 条未回收伏笔均在合理周期内` };

  const listText = overdue.map(f => `- [${f.id}] ${(f.desc || '').slice(0, 60)}（种于第${f.planted_chapter || '?'}章，当前第${current}章）`).join('\n');
  const tail = [{
    role: 'user',
    content: foreshadowClosureInstruction({
      bookTitle: book.title, currentChapter: current, listText,
      totalOpen: open.length,
    }),
  }];
  const messages = assembleMessages(bookId, tail);
  const res = await runTask({ task: 'foreshadow_closure', bookId, messages, jsonMode: true });
  const data = extractJSON(res.content) || {};
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  const valid = assignments.filter(a => a && a.id && (a.action === 'resolve' || a.action === 'advance' || a.action === 'abandon'));

  if (valid.length) {
    const text = valid.map(a => `[${a.action}] ${a.desc || a.id}（目标第${a.target_chapter || '?'}章附近，计划：${(a.plan || '').slice(0, 60)}）`).join('\n');
    store.materials.set(bookId, 'foreshadow_plan', `【伏笔收束计划】（第${current}章生成，后续卷/章须落实）\n${text}`);
    // 同步更新伏笔计划回收章（供 approaching/overdue 注入用）
    for (const a of valid) {
      const f = store.foreshadows.list(bookId).find(x => x.id === a.id);
      if (f && a.target_chapter) {
        try { store.foreshadows.update(f.id, { payoffChapter: parseInt(a.target_chapter, 10) || f.payoff_chapter }); } catch { /* ignore */ }
      }
    }
  }
  onEvent?.({ type: 'foreshadow_plan', overdue: overdue.length, assigned: valid.length, note: `伏笔收束计划：${overdue.length} 条超龄，分配 ${valid.length} 条回收` });
  return { assigned: valid.length, overdue: overdue.length, note: `伏笔收束：${overdue.length} 条超龄，${valid.length} 条已分配回收（写入后续规划）` };
}
