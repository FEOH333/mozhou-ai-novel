// server/engine/world_expansion.js —— V0.76 世界观阶梯展开引擎
// 问题：一百多章困在同一小地域（如平凡少年修仙：青阳镇/青云宗/药园反复用），世界观不随主角成长展开。
// 方案：题材包 worldScale 定义区域/势力层级阶梯 → worldExpansionStatus 检测当前展开层级与停滞 →
//       detectWorldStagnation 判严重 → planWorldExpansion 生成"相邻层级自然展开"落 materials('world_progress') →
//       卷大纲/续卷/章细纲注入硬约束；settle 通过 touchEntities 记录地点/势力登场章节（first/last_chapter）。
// 原则：只做规划、不重写已写正文；world_progress/entity_chapters 材料不进公共缓存前缀（与 growth_remedy 同模式）。
'use strict';
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { extractJSON } from '../util/json.js';
import { worldScaleFor } from '../data/creative_packs.js';
import { worldExpansionRemedyInstruction } from './prompts.js';
import { isCompletedChapter } from './chapter_status.js';
import { lastChapterTail, extractVolumeTitle } from '../util/text.js'; // V0.93.1：收编重复实现

const ENTITY_CHAPTERS_BACKFILL_VERSION = 'v1';

/** V0.83：正则转义（progressVerbs 组词表含特殊字符安全） */
function escapeReg(s) { return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 层级标签辅助（-1 → 未展开任何层级） */
function labelAt(level, ws) {
  if (level < 0) return '未展开';
  return ws.ladder[level] || '未知层级';
}

/**
 * V0.76 世界展开状态检测：读 locations/factions/worldbook/world材料/事实库/主角状态，
 * 逐层匹配 worldScale.ladderKeywords；只有 first_chapter != null（正文真正登场过）才计为已展开。
 * @returns {{text:string, shortText:string, dimension:string, ladder:string[], example:string, genre:string|undefined,
 *            doneChapters:number, currentLevel:number, currentLabel:string, nextLevel:number, nextLabel:string|null,
 *            stagnant:boolean, severity:string, reason:string, levelHits:Array, confirmedLevels:Array}}
 */
export function worldExpansionStatus(bookId) {
  const book = store.books.get(bookId);
  const ws = worldScaleFor(book?.genre);
  const doneChapters = store.chapters.list(bookId)
    .filter(isCompletedChapter).length;

  // —— 采集证据源（全部本地、零 LLM）——
  const locations = store.locations.list(bookId);
  const factions = store.factions.list(bookId);
  const worldbook = store.worldbook.list(bookId);
  const worldText = store.materials.get(bookId, 'world')?.content || '';
  const protagState = (() => {
    try {
      return JSON.parse(store.characters.list(bookId).find(c => c.tier === 'protagonist' || c.name === book?.protagonist)?.state_json || '{}');
    } catch { return {}; }
  })();
  const activeFacts = store.facts.list(bookId, { status: 'active' }).slice(0, 200);

    // V0.76 修正：confirmed 只由"正文真正登场"的 locations/factions（first_chapter 非空）决定；
    // worldbook/fact/state 只是"提及"证据（不计 confirmed），避免"以异界之魂为钥"这类身份伏笔
    // 误把"异界/最终舞台"判为已展开。
    // V0.83 防闪现顶格：高层级（index≥2）须"近期活跃"（last_chapter 在最近 25 章内）才算展开——
    // 早年一次"入京"闪现不再永久把 currentLevel 顶到朝廷层
    const levelHits = ws.ladder.map((label, i) => {
      const re = ws.ladderKeywords[i];
      const hits = [];
      const push = (name, kind, firstCh, lastCh) => hits.push({ name, kind, firstChapter: firstCh, lastChapter: lastCh });
      for (const l of locations) if (re.test(l.name)) push(l.name, 'location', l.first_chapter, l.last_chapter);
      for (const f of factions) if (re.test(f.name)) push(f.name, 'faction', f.first_chapter, f.last_chapter);
      for (const wb of worldbook) {
        let kws = []; try { kws = JSON.parse(wb.keywords || '[]'); } catch { /* ignore */ }
        if (re.test((kws.concat([wb.content || '']).join(' ')))) push(wb.content?.slice(0, 16), 'worldbook', null, null);
      }
      for (const f of activeFacts) { if (re.test(f.object || '')) push(f.object, 'fact', f.source_chapter, null); }
      for (const [k, v] of Object.entries(protagState)) { if (re.test(String(v))) push(`${k}=${v}`, 'state', null, null); }
      void worldText; // world 材料文本作为补充证据源（可选扩展）
      // confirmed 仅看 locations/factions 的 firstChapter；高层级须近期活跃（防早年闪现顶格）
      // V0.83 修正：lastChapter 缺失（回填未跑/仅首现）时用 firstChapter 判断——近期首现（如 117 章书 ch115 入京）即算展开
      const recentActive = h => (h.kind === 'location' || h.kind === 'faction')
        ? (i >= 2 ? ((h.lastChapter != null && h.lastChapter >= doneChapters - 25) || (h.lastChapter == null && h.firstChapter != null && h.firstChapter >= doneChapters - 25)) : true)
        : false;
      const confirmed = hits.some(h => (h.kind === 'location' || h.kind === 'faction') && h.firstChapter != null && recentActive(h));
      return { index: i, label, hits, count: hits.length, confirmed };
    });

  const confirmedLevels = levelHits.filter(l => l.confirmed);
  const currentLevel = confirmedLevels.length ? Math.max(...confirmedLevels.map(l => l.index)) : -1;
  const nextLevel = currentLevel + 1;

  // —— 停滞判定（V0.76：<30 章铺垫期不判）——
  let stagnant = false;
  let severity = 'none';
  let reason = '';
  if (doneChapters >= 30) {
    if (doneChapters >= 100 && currentLevel <= 1) {
      stagnant = true; severity = 'severe';
      reason = `已写 ${doneChapters} 章，故事仍困在「${labelAt(currentLevel, ws)}」级小地域，未展开到「${ws.ladder[2] || '更大舞台'}」级——世界观严重未展开`;
    } else if (doneChapters >= 60 && currentLevel <= 1 && !confirmedLevels.some(l => l.index >= 2)) {
      stagnant = false; severity = 'mild';
      reason = `已写 ${doneChapters} 章仍主要在「${labelAt(currentLevel, ws)}」级活动，建议本卷推进到「${ws.ladder[nextLevel] || '下一层'}」级新区域`;
    }
  }

  // —— 注入文本（卷级，含硬约束信息）——
  const text = doneChapters ? [
    '【世界展开状态】',
    `层级阶梯：${ws.example}`,
    `当前已展开到「${labelAt(currentLevel, ws)}」级｜下一层应为「${ws.ladder[nextLevel] || '最终舞台'}」级`,
    severity !== 'none' ? `⚠ ${reason}，本卷必须推进到「${ws.ladder[nextLevel] || '下一层'}」级新区域！` : `建议本卷推进到「${ws.ladder[nextLevel] || '下一层'}」级新区域。`,
  ].join('\n') : '';

  // —— 章细纲轻量提示 ——
  const shortText = doneChapters ? `【世界展开提示】当前「${labelAt(currentLevel, ws)}」级 → 本卷目标「${ws.ladder[nextLevel] || '下一层'}」级；本章若涉及场景/势力转移，优先推进到新区域，避免困守原地。` : '';

  return {
    text, shortText, dimension: ws.dimension, ladder: ws.ladder, example: ws.example,
    genre: book?.genre, doneChapters,
    currentLevel, currentLabel: labelAt(currentLevel, ws),
    nextLevel, nextLabel: ws.ladder[nextLevel] || null,
    stagnant, severity, reason, levelHits, confirmedLevels,
  };
}

/**
 * V0.76 世界展开停滞检测（仿 growth.detectGrowthDeviation）。
 * @returns 与 worldExpansionStatus 同构，stagnant=true 表示严重未展开（应补救）
 */
export function detectWorldStagnation(bookId) {
  const ws = worldExpansionStatus(bookId);
  if (ws.doneChapters < 30) {
    return { ...ws, stagnant: false, severity: 'none', reason: '铺垫期（<30章）不判定世界展开停滞' };
  }
  // V0.83：mild（60 章仍困基层）也判 stagnant → 生成补救桥段（此前只有 severe 100 章才补救）
  return { ...ws, stagnant: ws.severity !== 'none' };
}

/**
 * V0.77 生成世界展开补救桥段：LLM 规划相邻层级自然展开（旧线索驱动 + 新区域落点），
 * 落 materials(kind='world_progress')，幂等（已有则跳过）。data 可注入（测试友好）。
 * @returns {{planned:number, deviation:object, note:string}}
 */
export async function planWorldExpansion(bookId, { onEvent, signal, data } = {}) {
  const dev = detectWorldStagnation(bookId);
  if (!dev.stagnant) return { planned: 0, deviation: dev, note: '世界观展开无明显停滞，无需补救' };
  if (store.materials.get(bookId, 'world_progress')?.content) {
    return { planned: 1, deviation: dev, note: '已有世界展开补救材料，跳过生成' };
  }
  const book = store.books.get(bookId);
  const ws = worldScaleFor(book.genre);
  const completed = store.chapters.list(bookId).filter(isCompletedChapter).sort((a, b) => a.idx - b.idx);
  const lastTail = lastChapterTail(completed, id => store.summaries.get(id)?.summary || '');
  const nextVolumeIdx = store.volumes.list(bookId).reduce((max, volume) => Math.max(max, volume.idx || 0), 0) + 1;
  const nextVol = extractVolumeTitle(store.materials.get(bookId, 'outline')?.content || '', nextVolumeIdx);
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const worldview = store.materials.get(bookId, 'world')?.content || '';

  const tail = [{
    role: 'user',
    content: worldExpansionRemedyInstruction({
      bookTitle: book.title, genre: book.genre, worldScaleText: ws.example,
      deviation: dev.reason, currentLevel: dev.currentLabel, nextLevel: dev.nextLabel,
      lastTail, nextVolumeTitle: nextVol, contract, worldview,
    }),
  }];
  const messages = assembleMessages(bookId, tail);
  const res = data ? { content: JSON.stringify(data) } : await runTask({ task: 'world_progress', bookId, messages, jsonMode: true, signal });
  const parsed = extractJSON(res.content) || {};
  if (!parsed.expansion || !parsed.expansion.toLevel) {
    return { planned: 0, deviation: dev, note: '世界展开补救解析失败（缺 expansion.toLevel）' };
  }
  const text = formatWorldRemedy(parsed, dev.doneChapters);
  store.materials.set(bookId, 'world_progress', text);
  onEvent?.({
    type: 'world_progress', planned: 1,
    note: `世界展开补救：${parsed.expansion.fromLevel || '?'}→${parsed.expansion.toLevel}（${parsed.expansion.region || '?'}）`,
  });
  return { planned: 1, deviation: dev, note: `已生成世界展开补救（${parsed.expansion.fromLevel || '?'}→${parsed.expansion.toLevel}）` };
}

/** V0.76 读世界展开补救材料（供续卷/卷大纲注入） */
export function worldProgressText(bookId) {
  return store.materials.get(bookId, 'world_progress')?.content || '';
}

/**
 * V0.76 记录地点/势力登场章节（零 LLM，纯子串匹配）：settle 每章调用，写 first_chapter/last_chapter。
 * 这是"世界展开状态"判定"某层级是否真正登场"的数据来源。
 * V0.83 收紧：first_chapter 只在"正文命中 + 同句含进展动词（赴任/出征/入京/抵达…）"时写入——
 * 纯书信/传闻提及（如诏书里念到"临安"）不视为"主角实质接入"，防"提及即达成"误判。
 * @returns {string[]} 本章实质登场的地点/势力名
 */
export function touchEntities(bookId, chapterText, chapterIdx) {
  const book = store.books.get(bookId);
  const ws = worldScaleFor(book?.genre);
  // V0.83 实质登场动词：题材 progressVerbs + 通用移动/驻留词（"走进/来到/抵达"等是主角实质进入的最高频表达）
  const verbSet = new Set([
    ...(ws?.progressVerbs || []),
    '走进', '走入', '来到', '赶到', '奔赴', '抵达', '进入', '踏入', '返回', '回到', '进驻', '驻守', '驻扎', '移师', '转战', '赶赴', '抵达', '前往', '到达', '现身', '露面', '登场', '入主', '接管', '入城', '入京', '出镇', '赴任',
  ]);
  const progressRe = new RegExp(`(?:${[...verbSet].map(escapeReg).join('|')})`, 'g');
  const touched = [];
  for (const kind of ['locations', 'factions']) {
    for (const e of store[kind].list(bookId)) {
      if (!chapterText.includes(e.name)) continue;
      const patch = {};
      // 实质登场：同句（前后 80 字内）含进展/移动动词才计 first_chapter（V0.83 防"提及即达成"）
      if (e.first_chapter == null) {
        const idx = chapterText.indexOf(e.name);
        const window = chapterText.slice(Math.max(0, idx - 80), idx + 80 + e.name.length);
        progressRe.lastIndex = 0;
        if (progressRe.test(window)) patch.firstChapter = chapterIdx;
      }
      patch.lastChapter = chapterIdx;
      if (Object.keys(patch).length) store[kind].update(e.id, patch);
      touched.push(e.name);
    }
  }
  return touched;
}

/**
 * V0.76 存量书一次性回填 locations/factions 的 first/last_chapter（幂等：标记材料 entity_chapters）。
 * 首次调用扫描全部已写章节回填；之后由 settle 的 touchEntities 增量维护。
 * @returns {boolean} 是否执行了回填
 */
export function ensureEntityChaptersBackfilled(bookId) {
  if (store.materials.get(bookId, 'entity_chapters')?.content === ENTITY_CHAPTERS_BACKFILL_VERSION) return false;
  const locs = store.locations.list(bookId);
  const factions = store.factions.list(bookId);
  if (!locs.length && !factions.length) return false;
  const done = store.chapters.list(bookId)
    .filter(isCompletedChapter);
  for (const ch of done) {
    touchEntities(bookId, store.chapters.fullText(ch.id), ch.idx);
  }
  store.materials.set(bookId, 'entity_chapters', ENTITY_CHAPTERS_BACKFILL_VERSION);
  return true;
}

// ==================== 私有辅助 ====================

/** 补救桥段 JSON → 注入文本 */
function formatWorldRemedy(parsed, doneChapters) {
  const parts = [`【世界展开补救桥段】（第${doneChapters}章生成，下一卷及后续必须落实）`];
  if (Array.isArray(parsed.reinterpretation) && parsed.reinterpretation.length) {
    parts.push('【重新定义前文】' + parsed.reinterpretation.map(r => `${r?.意象 || '?'}=${r?.重新定义 || '?'}`).join('；'));
  }
  const ex = parsed.expansion || {};
  if (ex.toLevel) {
    const steps = Array.isArray(ex.steps) && ex.steps.length
      ? ex.steps.map(s => `第${s?.chapter || '?'}章：${s?.event || s?.stage || '?'}（${s?.trigger || ''}）${s?.beat ? '——' + s.beat : ''}`).join('\n')
      : '';
    parts.push(`【相邻层级展开】第${ex.startChapter || doneChapters + 1}章起：${ex.fromLevel || '?'}→${ex.toLevel}${ex.region ? `（新区域：${ex.region}）` : ''}${steps ? '\n' + steps : ''}`);
  }
  if (parsed.volume_plan) parts.push(`【本卷规划】${parsed.volume_plan}`);
  const sc = parsed.state_cleanup || {};
  if (Array.isArray(sc.keep) && sc.keep.length) parts.push(`【状态清理】保留：${sc.keep.join('、')}${Array.isArray(sc.drop_examples) && sc.drop_examples.length ? `；丢弃示例：${sc.drop_examples.slice(0, 5).join('、')}` : ''}`);
  return parts.join('\n');
}
