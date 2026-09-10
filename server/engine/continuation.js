// server/engine/continuation.js —— V0.44 完本判定与自动续卷引擎
// 核心：网文百万字才算完本。写完规划章节 ≠ 完本。
// 判定顺序：本地硬规则（零成本，防 AI 偷懒提前完本）→ AI 完本评估（一次 flash）→ 上限保护。
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { ensureHistory, publicMaterialsText, generateVolumeOutline } from './outline.js';
import { extractJSON } from '../util/json.js';
import { logFlow } from '../util/oplog.js';
import { endingCheckInstruction, nextVolumeInstruction } from './prompts.js';
import { detectGrowthDeviation, planRemedyBridge, growthRemedyText } from './growth.js'; // V0.74 成长线补救
import { detectWorldStagnation, planWorldExpansion, worldProgressText, worldExpansionStatus } from './world_expansion.js'; // V0.76 世界展开补救
import { eraContextText, historyGrowthNote } from './history.js'; // V0.81 历史时代背景 + 成长波动
import {
  buildLifecycleContext, endingBlueprintText, endingReadiness, lifecyclePromptText,
} from './longform_lifecycle.js'; // V0.92 全书阶段与硬完本门
import { isCompletedChapter } from './chapter_status.js';
import { isHistoricalSampleBook } from './historical_longform.js'; // V0.93.2：历史特判单一实现

function isAbortError(error) {
  return error?.code === 'ABORTED' || error?.name === 'AbortError' || (typeof error?.code === 'number' && error.code === 20);
}

function parseVolumeOutline(vol) {
  try {
    const raw = vol?.outline_json;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    return JSON.parse(raw || '{}') || {};
  } catch {
    return {};
  }
}

/** 卷纲已有 chapters 且章行已建：只准续写，禁止再生成一遍卷大纲。 */
function volumeReadyToWrite(vol) {
  const chapters = store.chapters.listByVolume(vol.id);
  const outlineChapters = parseVolumeOutline(vol).chapters;
  return chapters.length > 0 && Array.isArray(outlineChapters) && outlineChapters.length > 0;
}

/** V0.93.11：中期反馈时效窗口（章数）。续卷注入侧与 doctor 体检侧共用此常量——写审同源。 */
export const STALE_MATERIAL_AFTER_CHAPTERS = 15;

/**
 * V0.93.11：过期动态材料时效过滤（纯函数，测试直测）
 * 此前无条件注入：修仙书 95 章生成的中期反馈一直注入到 125 章，过时规划污染续卷。
 * - polish_feedback：无"第N章时生成"标记 → 视为新鲜保留；生成距今超 15 章 → 过期跳过
 * - foreshadow_plan：全部目标章 ≤ 当前最新章 → 收束计划已过时跳过；无目标标记 → 保留
 */
export function filterStaleMaterials(bookId, latestChapterIdx) {
  const out = { midReviewText: '', closurePlanText: '' };
  try {
    const m = store.materials.get(bookId, 'polish_feedback')?.content || '';
    const genMatch = m.match(/第(\d+)章时生成/);
    const genAt = genMatch ? Number(genMatch[1]) : null;
    if (genAt == null || latestChapterIdx - genAt <= STALE_MATERIAL_AFTER_CHAPTERS) out.midReviewText = m;
  } catch { /* ignore */ }
  try {
    const m = store.materials.get(bookId, 'foreshadow_plan')?.content || '';
    const targets = [...m.matchAll(/目标第(\d+)章/g)].map(x => Number(x[1]));
    const stillRelevant = targets.length === 0 || targets.some(t => t > latestChapterIdx);
    if (stillRelevant) out.closurePlanText = m;
  } catch { /* ignore */ }
  return out;
}

/** 全书正文字数（所有场景 content 长度合计） */
export function countTotalChars(bookId) {
  try {
    const rows = store.db?.prepare?.('SELECT COALESCE(SUM(LENGTH(content)),0) AS n FROM scenes WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id=?)').get(bookId);
    if (rows) return rows.n;
  } catch { /* fallthrough */ }
  let n = 0;
  for (const ch of store.chapters.list(bookId)) {
    for (const sc of store.scenes.list(ch.id)) n += (sc.content || '').length;
  }
  return n;
}

/** 全书已完成章数（修订章须同时具备完整正文与结算证据） */
export function finishedChapterCount(bookId) {
  return store.chapters.list(bookId).filter(isCompletedChapter).length;
}

/** 未回收伏笔（planted/advanced） */
export function openForeshadowCount(bookId) {
  try {
    return store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced').length;
  } catch { return 0; }
}

/** 配置默认值（V0.44）：低于该字数视为必未完本；超过该章数视为安全上限 */
export const ENDING_DEFAULTS = { minChars: 200000, maxChapters: 500, maxContinuations: 40 };

function lifecycleGateEnabled(bookId) {
  const book = store.books.get(bookId);
  const settings = store.books.settings(bookId);
  return Boolean(
    settings.longformLifecycle?.plannedVolumes
    || store.materials.get(bookId, 'longform_lifecycle')
    || store.materials.get(bookId, 'ending_blueprint')
    || (book?.genre === '历史' && isHistoricalSampleBook(book)), // V0.93.2：题材开关收敛（书名正则不再当开关）
  );
}

/**
 * 本地硬规则判定（零成本，先于 AI 评估）
 * @returns {{ done: boolean, shouldContinue: boolean, reason: string }}
 *   done=false 表示本地规则已能下结论（必须续卷 / 达到上限）；done=true 表示需 AI 评估
 */
export function localEndingCheck(bookId, opts = {}) {
  const { minChars = ENDING_DEFAULTS.minChars, maxChapters = ENDING_DEFAULTS.maxChapters } = opts;
  const chapters = finishedChapterCount(bookId);
  // V0.92：安全上限只是资源保护，不是叙事完成证据。达到上限一律暂停人工确认，
  // 绝不能由 pilot 继续走 book_done / 全书打磨，避免“写满500章=自动完本”。
  if (chapters >= maxChapters) {
    const readiness = lifecycleGateEnabled(bookId) ? endingReadiness(bookId) : null;
    const debt = readiness && !readiness.ready ? `，且仍未完本：${readiness.blockers.slice(0, 3).map(item => item.label).join('；')}` : '';
    return {
      done: true, shouldContinue: false, needsHuman: true, finished: false,
      reason: `已达安全上限 ${maxChapters} 章${debt}；自动创作已暂停，需人工确认是扩容续写还是整理结局`,
      readiness,
    };
  }
  const openForeshadows = store.foreshadows.list(bookId)
    .filter(f => (f.status === 'planted' || f.status === 'advanced') && (!lifecycleGateEnabled(bookId) || f.importance !== 'low'));
  if (openForeshadows.length > 0) {
    return { done: true, shouldContinue: true, needsHuman: false, finished: false, reason: `还有 ${openForeshadows.length} 条中高重要度伏笔未回收（如：${openForeshadows.slice(0, 2).map(f => (f.desc || '').slice(0, 20)).join('；')}），故事未讲完` };
  }
  const totalChars = countTotalChars(bookId);
  if (totalChars < minChars) {
    return { done: true, shouldContinue: true, needsHuman: false, finished: false, reason: `全书约 ${Math.round(totalChars / 10000)} 万字，低于长篇下限 ${Math.round(minChars / 10000)} 万字` };
  }
  if (lifecycleGateEnabled(bookId)) {
    const readiness = endingReadiness(bookId);
    if (!readiness.ready) {
      return {
        done: true, shouldContinue: true, needsHuman: false, finished: false,
        reason: readiness.summary, readiness, blockers: readiness.blockers,
      };
    }
  }
  return { done: false, shouldContinue: true, needsHuman: false, finished: false, reason: '' };
}

/**
 * AI 完本评估（一次 flash）：契约承诺是否兑现 / 主线伏笔是否回收 / 主要疑问是否解答
 * @returns {{ finished: boolean, reason: string, remaining: string[] }}
 */
export async function aiEndingCheck(bookId, opts = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  ensureHistory(bookId);
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const open = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
  const reviews = (() => { try { return store.volumeReviews.list(bookId) || []; } catch { return []; } })();
  const totalChars = countTotalChars(bookId);
  const chCount = finishedChapterCount(bookId);
  const volCount = store.volumes.list(bookId).length;
  const lifecycle = lifecycleGateEnabled(bookId) ? buildLifecycleContext(bookId) : null;
  const readiness = lifecycle ? endingReadiness(bookId) : null;
  const recent = (() => {
    const chs = store.chapters.list(bookId).slice(-3);
    const lines = [];
    for (const ch of chs) {
      const sum = store.summaries.get?.(ch.id, bookId);
      lines.push(`第${ch.idx}章《${ch.title}》：${(sum?.summary || sum?.content || '').slice(0, 80)}`);
    }
    return lines.join('\n');
  })();
  const tail = [{
    role: 'user',
    content: endingCheckInstruction({
      bookTitle: book.title, contract: contract.slice(0, 600), openForeshadows: open,
      reviews: reviews.map(r => `第${r.volume_idx || r.volume_id}卷：${r.grade} 级`).join('；') || '（无）',
      totalChars, chCount, volCount, recent,
      lifecycleText: lifecycle ? lifecyclePromptText(lifecycle) : '',
      endingBlueprintText: lifecycle ? endingBlueprintText(bookId) : '',
      readinessSummary: readiness?.summary || '',
    }),
  }];
  const messages = assembleMessages(bookId, tail);
  const res = await runTask({ task: 'ending_check', bookId, messages, jsonMode: true, signal: opts.signal });
  const data = extractJSON(res.content) || {};
  return {
    finished: data.finished === true,
    reason: data.reason || '',
    remaining: Array.isArray(data.remaining) ? data.remaining : [],
  };
}

/**
 * 完本判定入口：本地规则 → AI 评估 → 上限保护
 * @returns {{ shouldContinue: boolean, reason: string, ai?: object }}
 */
export async function shouldContinueBook(bookId, opts = {}) {
  const local = localEndingCheck(bookId, opts);
  if (local.done) return {
    shouldContinue: local.shouldContinue, reason: local.reason,
    needsHuman: local.needsHuman === true, finished: false,
    readiness: local.readiness, blockers: local.blockers,
  };
  // 本地规则无法下结论（伏笔清空 + 字数达标）→ AI 评估
  try {
    const ai = await aiEndingCheck(bookId, opts);
    if (ai.finished) {
      // V0.92 双重确认：AI 只能做最后语义判断，不能覆盖本地债务。AI 返回后再查一次，
      // 防评估期间或台账同步边界产生“刚有新债务却仍完本”的竞态。
      if (lifecycleGateEnabled(bookId)) {
        const recheck = endingReadiness(bookId);
        if (!recheck.ready) {
          return { shouldContinue: true, needsHuman: false, finished: false, reason: recheck.summary, ai, readiness: recheck };
        }
      }
      return { shouldContinue: false, needsHuman: false, finished: true, reason: ai.reason || 'AI 判定主线已收束', ai };
    }
    return { shouldContinue: true, needsHuman: false, finished: false, reason: ai.reason || 'AI 判定故事尚未讲完', ai };
  } catch (e) {
    if (isAbortError(e)) throw e;
    // AI 评估失败不阻塞：默认继续写（宁可多写不可提前完本），并记日志
    logFlow({ op: 'ending_check_failed', level: 'warn', detail: e.message, bookId });
    return { shouldContinue: true, needsHuman: false, finished: false, reason: '完本评估失败，默认继续续写' };
  }
}

export async function generateNextVolume(bookId, { onEvent, signal, reason = '' } = {}) {
  const emit = (stage, message) => onEvent?.({ type: 'stage', stage, message });
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  ensureHistory(bookId);
  const volsEarly = store.volumes.list(bookId);
  const reusable = volsEarly
    .filter(v => (v.status === 'planned' || v.status === 'outlined'))
    .sort((a, b) => (a.idx || 0) - (b.idx || 0))
    .find(v => {
      const chs = store.chapters.listByVolume(v.id);
      return chs.length === 0 || chs.every(chapter => !isCompletedChapter(chapter));
    });
  if (reusable && volumeReadyToWrite(reusable)) {
    const readyChapters = store.chapters.listByVolume(reusable.id);
    emit('setup', `续写已规划的第 ${reusable.idx} 卷《${reusable.title || ''}》（卷纲已在，跳过重生）…`);
    logFlow({
      op: `续卷（复用卷${reusable.idx}，跳过重生）`,
      detail: `${reusable.title}（${readyChapters.length} 章）`,
      bookId,
    });
    return {
      idx: reusable.idx,
      title: reusable.title || `第${reusable.idx}卷`,
      chapterCount: readyChapters.length,
      skippedOutline: true,
      reason: reason || '复用已规划续卷',
    };
  }
  // V0.74 成长线补救：读取既有补救桥段；没有则检测偏离并生成（失败不阻塞续卷）
  let remedyText = '';
  try {
    remedyText = growthRemedyText(bookId);
    if (!remedyText) {
      const dev = detectGrowthDeviation(bookId);
      if (dev.deviated) {
        emit('setup', `检测到成长线偏离（${dev.reason.slice(0, 40)}…），设计成长补救桥段…`);
        const rp = await planRemedyBridge(bookId, { onEvent, signal });
        if (rp.planned) remedyText = growthRemedyText(bookId);
      }
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    /* 补救失败不阻塞续卷 */
  }
  // V0.76 世界展开补救：读取既有世界展开补救桥段；没有则检测停滞并生成（失败不阻塞续卷）
  let worldRemedyText = '';
  try {
    worldRemedyText = worldProgressText(bookId);
    if (!worldRemedyText) {
      const wdev = detectWorldStagnation(bookId);
      if (wdev.stagnant) {
        emit('setup', `检测到世界展开停滞（${wdev.reason.slice(0, 40)}…），设计世界展开补救桥段…`);
        const wrp = await planWorldExpansion(bookId, { onEvent, signal });
        if (wrp.planned) worldRemedyText = worldProgressText(bookId);
      }
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    /* 补救失败不阻塞续卷 */
  }
  const vols = store.volumes.list(bookId);
  // V0.73 续卷衔接修复：若存在"已规划但尚无任何已完成章节"的卷，应复用该卷继续写。
  const existingPlanned = vols
    .filter(v => (v.status === 'planned' || v.status === 'outlined'))
    .sort((a, b) => (a.idx || 0) - (b.idx || 0))
    .find(v => {
      const chs = store.chapters.listByVolume(v.id);
      return chs.length === 0 || chs.every(chapter => !isCompletedChapter(chapter));
    });
  if (existingPlanned) {
    emit('setup', `复用已规划的续卷：第 ${existingPlanned.idx} 卷《${existingPlanned.title || ''}》…`);
    let plannedCount = 12;
    try { plannedCount = parseInt(JSON.parse(existingPlanned.outline_json || '{}').chapterCount, 10) || 12; } catch { /* ignore */ }
    const chapterCount = Math.min(Math.max(plannedCount, 8), 18);
    emit('setup', `第 ${existingPlanned.idx} 卷《${existingPlanned.title || ''}》生成卷大纲…`);
    await generateVolumeOutline(bookId, existingPlanned.id, { chapterCount, remedyText, worldRemedyText }, {
      onEvent, signal,
    });
    logFlow({ op: `续卷（复用卷${existingPlanned.idx}）`, detail: `${existingPlanned.title}（${chapterCount} 章）`, bookId });
    return { idx: existingPlanned.idx, title: existingPlanned.title || `第${existingPlanned.idx}卷`, chapterCount, reason: reason || '复用已规划续卷' };
  }
  const nextIdx = vols.reduce((m, v) => Math.max(m, v.idx || 0), 0) + 1;
  const nextLifecycle = buildLifecycleContext(bookId, { volumeIdx: nextIdx });
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const open = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
  const world = publicMaterialsText(bookId).world || '';
  // V0.48：书纲规划衔接——从书纲材料提取第 nextIdx 卷的规划（V0.45 书纲对齐后 volumes 有完整分卷），
  // 续卷按书纲规划走，与大纲页展示一致（无缝衔接）
  let bookVolumePlan = '';
  try {
    const om = store.materials.get(bookId, 'outline')?.content || '';
    bookVolumePlan = extractBookVolumePlan(om, nextIdx);
  } catch { /* 无书纲规划不影响续卷 */ }
  const lastVol = vols[vols.length - 1];
  // V0.93.11：过期动态材料时效过滤——foreshadow_plan 目标章已过 / polish_feedback 生成超 15 章
  // 不再注入（此前无条件注入：修仙书 95 章的中期反馈一直注入到 125 章，过时规划污染续卷）
  const latestChapterIdx = store.chapters.list(bookId).reduce((m, c) => Math.max(m, Number(c.idx) || 0), 0);
  // V0.71：创作中期审阅反馈注入（过程打磨——后续卷按反馈调整，不改已写内容）
  const { midReviewText, closurePlanText } = filterStaleMaterials(bookId, latestChapterIdx);
  // V0.67：上一卷体检反馈（驱动下一卷按需调整：节奏/遗留工单）
  let prevReviewText = '';
  if (lastVol) {
    try {
      const pv = store.volumeReviews.byVolume(bookId, lastVol.idx);
      if (pv && pv.status === 'done') {
        const rep = (() => { try { return JSON.parse(pv.report_json || '{}'); } catch { return {}; } })();
        const iss = (() => { try { return JSON.parse(pv.issues_json || '[]'); } catch { return []; } })();
        const parts = [];
        if (rep.pacing?.issue) parts.push(`节奏：${rep.pacing.issue}`);
        if (rep.reading?.issue) parts.push(`阅读体验：${rep.reading.issue}`);
        // V0.83：补读上卷末章钩子（volumeReview 已存 hooks.volume_ending）——卷间钩子承接的关键
        if (rep.hooks?.volume_ending) parts.push(`上卷末章钩子：${rep.hooks.volume_ending}`);
        const p01 = (iss || []).filter(i => i.severity === 'P0' || i.severity === 'P1').map(i => String(i.desc || i.issue || '').slice(0, 60));
        if (p01.length) parts.push(`遗留工单（${p01.length} 条）：${p01.join('；')}`);
        prevReviewText = parts.join('\n');
      }
    } catch { /* 无体检记录不影响 */ }
  }
  let lastTail = '';
  if (lastVol) {
    const chs = store.chapters.listByVolume(lastVol.id);
    const lastCh = chs[chs.length - 1];
    if (lastCh) {
      const sum = store.summaries.get?.(lastCh.id);
      // V0.83：末章结尾钩子 + 末 300 字正文（此前只有 120 字摘要——模型拿不到上卷末章钩子，靠口头要求自行推断）
      const o = (() => { try { return store.chapters.outline(lastCh.id); } catch { return null; } })();
      const hook = o?.ending_hook ? (typeof o.ending_hook === 'string' ? o.ending_hook : o.ending_hook.desc || '') : '';
      const tailText = store.chapters.fullText(lastCh.id).slice(-300);
      lastTail = `第${lastCh.idx}章《${lastCh.title}》：${(sum?.summary || '').slice(0, 120)}${hook ? `｜结尾钩子：${hook}` : ''}${tailText ? `\n【末章结尾原文】…${tailText}` : ''}`;
    }
  }
  emit('setup', `生成本书第 ${nextIdx} 卷续卷大纲（承接上文，${open.length ? `推进 ${Math.min(open.length, 3)} 条伏笔` : '推进主线'}）…`);
  const mats = store.materials.all(bookId);
  const castText = mats.find(m => m.kind === 'cast')?.content || ''; // V0.49：角色弧光与配角库
  const socialEcology = (() => {
    const w = mats.find(m => m.kind === 'world')?.content || '';
    const i = w.indexOf('【社会生态】');
    return i >= 0 ? w.slice(i) : '';
  })(); // V0.49：社会生态段
  const tail = [{
    role: 'user',
    content: nextVolumeInstruction({
      bookTitle: book.title, contract: contract.replace(/【书契约】/g, '').slice(0, 500), openForeshadows: open,
      worldview: (world || '').slice(0, 400), lastVolume: lastVol?.title || '', lastTail,
      volumeCount: vols.length, chapterCount: 12, targetHint: reason ? `续卷原因：${reason}` : '',
      bookVolumePlan, // V0.48：书纲已规划的本书卷规划（若存在）
      castText, socialEcology, // V0.49：角色弧光/配角库/社会生态注入
      prevReviewText, // V0.67：上一卷体检反馈（节奏/遗留工单——本卷须改进）
      midReviewText, // V0.71：中期审阅反馈（过程打磨——本卷规划须落实调整项）
      closurePlanText, // V0.71：伏笔收束计划（超龄伏笔本卷须落实回收）
      remedyText, // V0.74：成长补救桥段（成长线严重偏离时本卷必须落实顿悟突破）
      worldExpansion: worldExpansionStatus(bookId).text, // V0.76：世界展开状态
      worldRemedyText, // V0.76：世界展开补救桥段（世界未展开时本卷必须层级跃迁）
      // V0.81 历史：时代背景卡（史实锚点）+ 成长波动节奏
      eraContext: book.genre === '历史' ? eraContextText(bookId, { scope: 'volume', maxChars: 600 }) : '',
      historyGrowthNote: book.genre === '历史' ? historyGrowthNote() : '',
      lifecycleStage: nextLifecycle.stage.id,
      lifecycleText: lifecyclePromptText(nextLifecycle),
      endingBlueprintText: ['late_middle', 'ending', 'finale'].includes(nextLifecycle.stage.id) ? nextLifecycle.endingBlueprintText : '',
    }),
  }];
  const messages = assembleMessages(bookId, tail);
  const res = await runTask({ task: 'next_volume', bookId, messages, jsonMode: true, signal });
  const data = extractJSON(res.content) || {};
  if (!data.title) throw new Error('续卷大纲解析失败，请重试');
  const chapterCount = Math.min(Math.max(parseInt(data.chapterCount, 10) || 12, 8), 18);
  const v = store.volumes.create(bookId, nextIdx, {
    title: data.title, goal: data.goal || '', outline: {
      title: data.title, goal: data.goal || '', arc: data.arc || '',
      lifecycle_stage: data.lifecycle_stage || nextLifecycle.stage.id,
      stage_turn: data.stage_turn || nextLifecycle.stage.requiredTurn,
      arcs_advanced: Array.isArray(data.arcs_advanced) ? data.arcs_advanced : [],
      arcs_closed: Array.isArray(data.arcs_closed) ? data.arcs_closed : [],
      hooks_paid: Array.isArray(data.hooks_paid) ? data.hooks_paid : [],
      new_major_arcs: Array.isArray(data.new_major_arcs) ? data.new_major_arcs : [],
      ending_delivery: data.ending_delivery && typeof data.ending_delivery === 'object' ? data.ending_delivery : {},
    },
    status: 'planned',
  });
  emit('setup', `第 ${nextIdx} 卷《${data.title}》规划 ${chapterCount} 章，生成卷大纲…`);
  await generateVolumeOutline(bookId, v.id, { chapterCount, remedyText, worldRemedyText }, {
    onEvent, signal,
  });
  logFlow({ op: `续卷 第${nextIdx}卷`, detail: `${data.title}（${chapterCount} 章）`, bookId });
  return { idx: nextIdx, title: data.title, chapterCount, reason };
}

/** 从 formatBookOutline/旧格式中只提取指定卷的整行规划。 */
function extractBookVolumePlan(outlineText, volumeIdx) {
  if (!outlineText || !Number.isInteger(volumeIdx) || volumeIdx < 1) return '';
  const marker = `(?:第\\s*${volumeIdx}\\s*卷|卷\\s*${volumeIdx})`;
  const match = String(outlineText).match(new RegExp(`${marker}\\s*《[^》\\n]+》[^\\n]{0,160}`));
  if (!match) return '';
  return match[0].replace(new RegExp(`^卷\\s*${volumeIdx}`), `第${volumeIdx}卷`).trim();
}
