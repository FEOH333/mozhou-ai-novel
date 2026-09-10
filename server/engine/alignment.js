// server/engine/alignment.js —— V0.45 大纲对齐系统（三层检测 + 自动修订）
// 问题：书纲/卷纲/章名写前一次性生成，写作推进慢于规划且从不回填 → 卷名与内容脱节、大纲失真。
// 方案：三层对齐——章级（章名-摘要本地粗筛，零成本）/ 卷级（卷名-摘要 + 卷体检 goal_met）/ 书级（每 3 卷书纲对齐）。
// 原则：只改规划记录（卷大纲/卷名/章名/书纲材料），永不动正文；修订前快照、失败降级、全程日志。
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { ensureHistory, rebuildHistory } from './outline.js';
import { extractJSON } from '../util/json.js';
import { logFlow } from '../util/oplog.js';
import {
  chapterRenameInstruction, volumeRenameInstruction, volumeOutlineRewriteInstruction, bookOutlineRewriteInstruction,
} from './prompts.js';
import { formatBookOutline } from './outline.js';
import { historicalLongformPlanText } from './historical_longform.js'; // V0.93.9：对齐注入十五卷年代总表
import { resolveBookStage } from './longform_lifecycle.js'; // V0.92：对齐不得剥掉阶段/收尾元数据
import { isCompletedChapter, isCompletedVolume } from './chapter_status.js';
import { chapterTitleDeliveryIssues } from './rules.js'; // V0.107：章名↔正文核对闸（写审同源词表）

// ==================== 本地启发式（零成本粗筛） ====================

/** 标题（去'第N章/第N卷'前缀，支持中文数字）的 2-4 字窗口是否出现在文本中；标题无效返回 null */
export function titleHitsText(title, text) {
  let t = String(title || '').replace(/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|卷|回|节)\s*[:：]?\s*/, '').trim();
  // 去掉'第一卷'等骨架后若只剩'卷/章'等 → 视为无有效标题（不判断）
  t = t.replace(/^第?\s*[\d一二三四五六七八九十百]+\s*(卷|章|回|节)?$/, '');
  if (!t) return null;
  const s = String(text || '');
  if (!s) return false;
  if (s.includes(t)) return true;
  const chars = [...t];
  for (let len = Math.min(4, chars.length); len >= 2; len--) {
    for (let i = 0; i + len <= chars.length; i++) {
      const w = chars.slice(i, i + len).join('');
      if (w.length >= 2 && s.includes(w)) return true;
    }
  }
  return false;
}

/** 动作直述型标题黑名单（AI 味重、无文学性）：命中即视为"名不副实"需改名
 *  V0.83：剔除中性意象词（真相/秘密/身世/生死/一线——"生死之间"是合法文学标题，此前被误杀）；去重"夜探" */
const AI_FLAT_TITLES = [
  '夜探', '夜袭', '夜潜', '夜掘', '夜访', '夜闯', '突破', '反杀', '逃离', '决战', '伏击', '突袭',
  '潜入', '追捕', '围剿', '单挑', '血战', '死战', '翻盘', '绝地', '逆袭', '觉醒', '拜师', '结盟',
  '联手', '反目', '暴露', '归途', '上山', '下山', '进京',
  '闯关', '破阵', '夺宝', '寻宝', '追杀', '逃亡', '对峙', '试探', '窥探', '探查',
  '暗道', '暗渠', '密道', '旧宅', '废田', '废宅', '废墟', '杂物间',
];
// V0.83：流水账/现代感/超长标题软信号（autoFix=false 只标记，不强制改名——避免误伤意象型标题）
const AI_FLAW_TITLES = [
  '第X章', '第X卷', '第一章', '初探', '赶路', '日常', '杂役', '打坐', '修炼', '炼丹', '炼器',
  '逛街', '吃饭', '睡觉', '考试', '测试', '开会', '汇报', '报告', '方案', '计划', '系统', '面板',
  '解锁', '新手村', '刷怪', '副本', '任务', '奖励', '进度', '等级', '成就', '命运齿轮', '才刚刚开始',
];
/** 标题是否"AI 味动作直述"（去掉章号前缀后，标题主体以黑名单词开头的）
 *  V0.83：黑名单已剔除中性意象词，防误杀"生死之间/真相之前"类合法文学标题 */
export function isFlatTitle(title) {
  let t = String(title || '').replace(/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|卷|回|节)\s*[:：]?\s*/, '').trim();
  if (!t) return false;
  return AI_FLAT_TITLES.some(w => t.startsWith(w));
}

/** V0.83：流水账/现代感/超长/过短标题软信号（autoFix=false——只标记不强制改名） */
export function hasFlatTitleFlaw(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  // 长度异常（2-8 字为佳）
  if (t.length < 2 || t.length > 12) return true;
  // 残留章号前缀（"第6章 标题"）或纯骨架
  if (/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|卷|回|节)\s*[:：]?\s*$/.test(t)) return true;
  if (/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|卷|回|节)\s*[:：]/.test(t)) return true;
  // 流水账/现代感词（中间出现也算，如"药园杂役"）
  return AI_FLAW_TITLES.some(w => t.includes(w));
}

/** 章级检测：章名 vs 章摘要（本地，零成本）
 *  V0.73 增强——aligned 表示"章名与内容是否贴切"（保留标题不出现在摘要即脱节的检测）；
 *  autoFix 表示"确定性坏标题，应自动改名"（重名/动作直述/空标题——意象型标题不出现在
 *  摘要时 autoFix=false，只标记不强制改名，避免误伤泥地里的火种这类好标题）。
 */
export function checkChapterAlignment(bookId, chapterId) {
  const ch = store.chapters.get(chapterId);
  if (!ch) return { aligned: true, local: true, autoFix: false };
  const raw = ch.title || '';
  // 无有效标题（空/骨架残留如"第6章"/纯数字）→ 确定性坏
  const normTitle = String(raw).replace(/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|回|节)\s*[:：]?\s*/, '').trim();
  if (!normTitle) return { aligned: false, local: true, autoFix: true, reason: '章名为空或仅剩骨架前缀' };
  // ① 重名检测：同书其他章有相同标题（去章号前缀比较）→ 确定性坏
  const dup = store.chapters.list(bookId).some(c =>
    c.id !== ch.id &&
    String(c.title || '').replace(/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|回|节)\s*[:：]?\s*/, '').trim() === normTitle);
  if (dup) return { aligned: false, local: true, autoFix: true, reason: `章名「${normTitle}」与同书其他章重名` };
  // ② AI 味动作直述标题 → 确定性坏
  if (isFlatTitle(ch.title)) {
    return { aligned: false, local: true, autoFix: true, reason: `章名「${ch.title}」是 AI 味动作直述，缺乏文学性` };
  }
  // ④ V0.107：章名↔正文核对闸（写审同源 TITLE_EVENT_LEXICON；审校侧 revise 已先修过一轮，
  // 这里是写完后的兜底——事件承诺零在场 → 改名候选；具象 bigram 零命中 → 只降 aligned 不强制）。
  const full = store.chapters.fullText(chapterId).trim();
  if (full) {
    const delivery = chapterTitleDeliveryIssues(ch.title, full);
    const eventMiss = delivery.find(d => d.severity === 'high');
    if (eventMiss) return { aligned: false, local: true, autoFix: true, reason: `章名承诺的事件正文零在场——${eventMiss.issue}` };
    const concreteMiss = delivery.find(d => d.severity === 'medium');
    if (concreteMiss) return { aligned: false, local: true, autoFix: false, reason: concreteMiss.issue };
  }
  // ③ 标题不出现在摘要 → 可能脱节（意象型标题的误报，autoFix=false 只标记）
  const sum = store.summaries.get(chapterId);
  const summary = (sum?.summary || '').slice(0, 300);
  if (!summary) return { aligned: true, local: true, autoFix: false }; // 无摘要不判断
  const hit = titleHitsText(ch.title, summary);
  if (hit === null) return { aligned: true, local: true, autoFix: false }; // 无有效标题
  return { aligned: hit, local: true, autoFix: false, reason: hit ? '' : `章名「${ch.title}」未出现在本章摘要，可能脱节` };
}

/** 卷级检测：卷名 vs 卷内全部章摘要集合 + 卷体检 goal_met（若已有） */
export function checkVolumeAlignment(bookId, volumeId) {
  const vol = store.volumes.get(volumeId);
  if (!vol) return { aligned: true, titleHits: true, goalMet: true, local: true };
  const chs = store.chapters.listByVolume(vol.id);
  const sums = chs.map(c => (store.summaries.get(c.id) || {}).summary || '').filter(Boolean).join('\n');
  const titleHits = titleHitsText(vol.title, sums);
  let goalMet = true;
  try {
    const vr = store.volumeReviews.byVolume(bookId, vol.idx);
    if (vr?.report_json) {
      const rep = JSON.parse(vr.report_json);
      goalMet = rep.goal_met !== false;
    }
  } catch { /* 无审阅记录视为对齐 */ }
  return { aligned: titleHits !== false && goalMet, titleHits, goalMet, local: true };
}

/** 卷是否全部完成；planned/partial/quality_blocked 永远不能冒充“已写事实”。 */
export function isVolumeComplete(vol) {
  return isCompletedVolume(vol);
}

const volumeDone = isVolumeComplete;

/** 卷是否已做过大纲对齐（幂等：有记录不再重复重写/改名；查 op 字段——logFlow 的 op='卷大纲对齐 第N卷'） */
export function volumeAlignedRecently(bookId, volumeIdx) {
  try {
    const logs = store.operationLogs.list({ category: 'flow', bookId, limit: 200 }).items;
    const mark = `卷大纲对齐 第${volumeIdx}卷`;
    // V0.93 之前的对齐会把 planned 章当作已写章，旧日志不能作为新算法的幂等凭证。
    return logs.some(l => ((l.op || '').includes(mark) || (l.detail || '').includes(mark))
      && `${l.op || ''} ${l.detail || ''}`.includes('V0.93'));
  } catch { return false; }
}

/** 书级检测：距上次书级对齐 >= intervalChapters 章（默认 8 章）或已写卷数增量 >= 3 → 需要书级对齐 */
export function bookAlignDue(bookId, opts = {}) {
  const { intervalChapters = 8 } = opts;
  const vols = store.volumes.list(bookId);
  const writtenCount = vols.filter(volumeDone).length;
  if (writtenCount < 1) return false;
  const chapters = store.chapters.list(bookId);
  const doneCount = chapters.filter(isCompletedChapter).length;
  let lastAlignChapters = 0;
  let lastAlignVols = 0;
  try {
    const logs = store.operationLogs.list({ category: 'flow', bookId, limit: 100 }).items;
    for (const l of logs) {
      const m = (l.detail || '').match(/书级对齐@(\d+)卷(\d+)章/);
      if (m) {
        lastAlignVols = Math.max(lastAlignVols, parseInt(m[1], 10));
        lastAlignChapters = Math.max(lastAlignChapters, parseInt(m[2], 10));
      }
    }
  } catch { /* ignore */ }
  // V0.62：章数间隔优先（长书写作中持续对齐，不等写完 3 卷）——doneCount - lastAlignChapters >= 8
  if (doneCount - lastAlignChapters >= intervalChapters) return true;
  return writtenCount - lastAlignVols >= 3;
}

// ==================== 修订器（只改规划记录，永不动正文） ====================

/** 章名修正：章名与内容脱节 → LLM 改名（原名记日志可追溯）；失败降级不改
 *  V0.73：传入同卷章名清单防重名/雷同 + 原文意象摘句供提炼标题。 */
export async function adjustChapterTitle(bookId, chapterId, { onEvent, signal } = {}) {
  const ch = store.chapters.get(chapterId);
  if (!ch) return null;
  const sum = store.summaries.get(chapterId);
  const summary = (sum?.summary || '').slice(0, 250);
  const tail = (() => {
    const scs = store.scenes.list(ch.id);
    return scs.length ? (scs[scs.length - 1].content || '').slice(-100) : '';
  })();
  // V0.73：原文意象摘句（从正文中提取含意象的句子，供模型提炼文学性标题）
  const sample = (() => {
    const scs = store.scenes.list(ch.id);
    const all = scs.map(s => s.content || '').join('\n');
    // 取含比喻/意象符号的句子：含"像/如/仿佛/月光/影子/风/火/光"等的句子
    const lines = all.split('\n').map(l => l.trim()).filter(l => l.length >= 12 && l.length <= 60);
    const pick = lines.find(l => /(像|如|仿佛|月光|影子|风|火光|灰烬|雨|雪|枯|断|碎)/.test(l)) || lines[0] || '';
    return pick.slice(0, 80);
  })();
  // V0.73：同卷其他章名（防重名/雷同；volume_id 为空时退化全书查重）
  const siblingChapters = ch.volume_id ? store.chapters.listByVolume(ch.volume_id) : store.chapters.list(bookId);
  const siblingTitles = siblingChapters
    .filter(c => c.id !== ch.id)
    .map(c => c.title || '')
    .filter(Boolean)
    .slice(0, 12);
  ensureHistory(bookId);
  const isHistory = store.books.get(bookId)?.genre === '历史';
  const tailMsg = [{
    role: 'user',
    content: chapterRenameInstruction({
      bookTitle: store.books.get(bookId)?.title || '', chapterIdx: ch.idx, oldTitle: ch.title,
      summary, tail, siblingTitles, sample, isHistory, // V0.82 历史题材改名风格约束
    }),
  }];
  const messages = assembleMessages(bookId, tailMsg);
  // V0.83：改名失败重试 1 次 + 本地质量校验（4-8 字/无章号残留/无标点结尾/非重名）
  const norm = t => String(t || '').replace(/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|回|节)\s*[:：]?\s*/, '').trim();
  let newTitle = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runTask({ task: 'chapter_rename', bookId, messages, jsonMode: true });
    const data = extractJSON(res.content) || {};
    const candidate = (data.title || '').trim();
    const normCandidate = norm(candidate);
    // 本地校验：非空 / 与旧名不同 / 长度 2-12 / 无章号残留 / 不以标点结尾 / 非重名（规范化后完全相等）
    const okLen = normCandidate.length >= 2 && normCandidate.length <= 12;
    const okPunct = !/[。！？!?；;，,、]$/.test(normCandidate) && !/^第\s*[\d一二三四五六七八九十百]+号?\s*(章|回|节)\s*[:：]?\s*$/.test(normCandidate);
    const notDup = !siblingTitles.some(s => norm(s) === normCandidate);
    if (candidate && candidate !== ch.title && okLen && okPunct && notDup) {
      newTitle = candidate.slice(0, 30);
      break;
    }
  }
  if (!newTitle) return null;
  const oldTitle = ch.title;
  // V0.107：章名与细纲 outline_json.title 双写同步（ch52 错位实证：两处分叉后细纲期校验、
  // 写前五问、chapter_diversity 读到的还是旧名）。chapters.title 是真源，outline.title 是副本。
  const co = (() => { try { return JSON.parse(ch.outline_json || '{}'); } catch { return {}; } })();
  store.chapters.update(chapterId, { title: newTitle, outline: { ...co, title: newTitle } });
  // 已发布章改名登记线上同步债务（作者须在平台手动改章名后才算同步）
  if (isPublishedChapterIdx(bookId, ch.idx)) {
    store.publicationProfiles.markPendingSync(bookId, [ch.idx]);
  }
  logFlow({ op: `章名修正 #${ch.idx}`, detail: `《${oldTitle}》→《${newTitle}》`, bookId });
  return { oldTitle, newTitle, idx: ch.idx };
}

/** V0.107：已发布边界保护——已发布章（idx ≤ published_chapter_count）的章名不得被自动改名：
 *  线上目录已按旧名展示，自动改名会造成本地/线上不一致且无同步通道；只标记建议，
 *  由作者经改名 API 手动确认（手动路径走 adjustChapterTitle 并登记 pending_sync）。 */
export function isPublishedChapterIdx(bookId, chapterIdx) {
  const published = store.publicationProfiles.get(bookId)?.published_chapter_count || 0;
  const idx = Number(chapterIdx);
  return Number.isFinite(idx) && idx > 0 && idx <= published;
}

/**
 * V0.73 章名整书体检：扫描全书，对"确定性坏标题"（AI 味动作直述 / 重名 / 空标题）
 * 逐章改名。每 5 章由 pilot 自动触发；LLM 改名失败自动跳过，不阻塞。
 * @returns {{renamed:Array<{idx,oldTitle,newTitle}>, skipped:number}}
 */
export async function tidyChapterTitles(bookId, { onEvent, signal, max = 5 } = {}) {
  const chapters = store.chapters.list(bookId).filter(isCompletedChapter);
  const renamed = [];
  const suggested = [];
  let skipped = 0;
  let done = 0;
  for (const ch of chapters) {
    if (signal?.aborted) break;
    if (done >= max) break; // 每轮最多改 max 个（防一次改太多）
    const ca = checkChapterAlignment(bookId, ch.id);
    // V0.73：只自动改"确定性坏"标题（重名/动作直述/空标题）；意象不符仅标记不强制
    if (ca.aligned || !ca.autoFix) continue;
    // V0.107：已发布章不自动改名（线上目录已按旧名展示），只标记建议交作者定夺
    if (isPublishedChapterIdx(bookId, ch.idx)) {
      suggested.push({ idx: ch.idx, title: ch.title, reason: ca.reason || '' });
      continue;
    }
    try {
      const r = await adjustChapterTitle(bookId, ch.id, { onEvent, signal });
      if (r) { renamed.push(r); done++; onEvent?.({ type: 'align_chapter', idx: r.idx, oldTitle: r.oldTitle, newTitle: r.newTitle }); }
      else skipped++;
    } catch { skipped++; }
  }
  if (renamed.length) {
    logFlow({ op: '整书章名体检', detail: `改名 ${renamed.length} 章、跳过 ${skipped}${suggested.length ? `、已发布待作者定夺 ${suggested.length}` : ''}`, bookId });
  }
  return { renamed, skipped, suggested };
}

/** 卷名修正：卷名与内容脱节 → LLM 改名（V0.73：传既有卷名防重复） */
export async function adjustVolumeTitle(bookId, volumeId, { onEvent, signal } = {}) {
  const vol = store.volumes.get(volumeId);
  if (!vol) return null;
  const chs = store.chapters.listByVolume(vol.id);
  const lines = chs.slice(0, 8).map(c => {
    const sum = (store.summaries.get(c.id) || {}).summary || '';
    return `第${c.idx}章《${c.title}》：${sum.slice(0, 60)}`;
  }).join('\n');
  const siblingTitles = store.volumes.list(bookId)
    .filter(v => v.id !== vol.id)
    .map(v => v.title || '')
    .filter(Boolean)
    .slice(0, 15);
  ensureHistory(bookId);
  const tailMsg = [{
    role: 'user',
    content: volumeRenameInstruction({
      bookTitle: store.books.get(bookId)?.title || '', volumeIdx: vol.idx, oldTitle: vol.title, chapters: lines, siblingTitles,
    }),
  }];
  const messages = assembleMessages(bookId, tailMsg);
  const res = await runTask({ task: 'volume_rename', bookId, messages, jsonMode: true });
  const data = extractJSON(res.content) || {};
  let newTitle = (data.title || '').trim();
  if (!newTitle || newTitle === vol.title) return null;
  if (siblingTitles.includes(newTitle) || siblingTitles.some(s => s && newTitle && (s.includes(newTitle) || newTitle.includes(s)))) return null;
  const oldTitle = vol.title;
  const outline = (() => { try { return JSON.parse(vol.outline_json || '{}'); } catch { return {}; } })();
  store.volumes.update(volumeId, { title: newTitle.slice(0, 30), outline: { ...outline, title: newTitle } });
  logFlow({ op: `卷名修正 第${vol.idx}卷`, detail: `《${oldTitle}》→《${newTitle}》`, bookId });
  return { oldTitle, newTitle, idx: vol.idx };
}

/** 卷大纲重写：已写章 beat 用实际摘要回填 + 未写章重新规划 + goal/arc 更新（只改 outline_json） */
export async function rewriteVolumeOutline(bookId, volumeId, { onEvent, signal } = {}) {
  const vol = store.volumes.get(volumeId);
  if (!vol) return null;
  const book = store.books.get(bookId);
  const chs = store.chapters.listByVolume(vol.id).sort((a, b) => a.idx - b.idx);
  const doneChapters = chs
    .filter(isCompletedChapter)
    .map(c => {
    const sum = (store.summaries.get(c.id) || {}).summary || '';
    return {
      idx: c.idx, title: c.title, status: c.status,
      actual: sum.slice(0, 120),
      plannedBeat: (() => { try { return (JSON.parse(c.outline_json || '{}') || {}).beat || ''; } catch { return ''; } })(),
    };
    });
  const openForeshadows = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
  const oldOutline = (() => { try { return JSON.parse(vol.outline_json || '{}'); } catch { return {}; } })();
  ensureHistory(bookId);
  const tailMsg = [{
    role: 'user',
    content: volumeOutlineRewriteInstruction({
      bookTitle: book.title, volumeIdx: vol.idx, volumeTitle: vol.title,
      oldGoal: oldOutline.goal || vol.goal || '', oldArc: oldOutline.arc || '',
      doneChapters, openForeshadows,
      nextVolumeTitle: (store.volumes.list(bookId).find(v => v.idx === vol.idx + 1) || {}).title || '',
    }),
  }];
  const messages = assembleMessages(bookId, tailMsg);
  const res = await runTask({ task: 'volume_outline_rewrite', bookId, messages, jsonMode: true });
  const data = extractJSON(res.content) || {};
  if (!Array.isArray(data.chapters) || !data.chapters.length) throw new Error('卷大纲重写解析失败');
  const lifecycleStage = data.lifecycle_stage || oldOutline.lifecycle_stage || resolveBookStage(bookId, { volumeIdx: vol.idx }).id;
  const endingStage = lifecycleStage === 'ending' || lifecycleStage === 'finale';
  const newOutline = {
    title: data.title || oldOutline.title || vol.title,
    goal: data.goal || oldOutline.goal || vol.goal || '',
    arc: data.arc || oldOutline.arc || '',
    lifecycle_stage: lifecycleStage,
    stage_turn: data.stage_turn || oldOutline.stage_turn || resolveBookStage(bookId, { volumeIdx: vol.idx }).requiredTurn,
    arcs_advanced: Array.isArray(data.arcs_advanced) ? data.arcs_advanced : (Array.isArray(oldOutline.arcs_advanced) ? oldOutline.arcs_advanced : []),
    arcs_closed: Array.isArray(data.arcs_closed) ? data.arcs_closed : (Array.isArray(oldOutline.arcs_closed) ? oldOutline.arcs_closed : []),
    hooks_paid: Array.isArray(data.hooks_paid) ? data.hooks_paid : (Array.isArray(oldOutline.hooks_paid) ? oldOutline.hooks_paid : []),
    new_major_arcs: Array.isArray(data.new_major_arcs) ? data.new_major_arcs : (Array.isArray(oldOutline.new_major_arcs) ? oldOutline.new_major_arcs : []),
    // 结局兑付只属于 ending/finale。前期卷残留的“王朝已灭/崖山以后”会反向污染后续写作，必须清空。
    ending_delivery: endingStage
      ? ((data.ending_delivery && typeof data.ending_delivery === 'object')
        ? data.ending_delivery
        : (oldOutline.ending_delivery && typeof oldOutline.ending_delivery === 'object' ? oldOutline.ending_delivery : {}))
      : {},
    chapters: data.chapters.map((c, i) => ({
      idx: c.idx || i + 1, title: c.title || '', beat: c.beat || '', pov: c.pov || '',
    })),
  };
  store.volumes.update(volumeId, { outline: newOutline, goal: newOutline.goal, status: vol.status || 'outlined' });
  // 已写章回填细纲 beat（只更新已写章的 outline_json 中的 beat 记录，不动正文）
  const doneMap = new Map(doneChapters.map(d => [d.idx, d]));
  for (const c of data.chapters) {
    const chapterIdx = Number(c.idx);
    const ch = chs.find(x => x.idx === chapterIdx);
    if (!ch) continue;
    const wasDone = doneMap.has(ch.idx);
    const co = (() => { try { return JSON.parse(ch.outline_json || '{}'); } catch { return {}; } })();
    if (wasDone) {
      // 已写章：回填实际 beat（保留原 beat 为 planned_beat 记录）
      const actual = doneMap.get(ch.idx).actual;
      store.chapters.update(ch.id, { outline: {
        ...co,
        planned_beat: co.planned_beat || co.beat || '',
        beat: actual,
        actual_beat: actual,
      } });
    } else {
      store.chapters.update(ch.id, { outline: { ...co, beat: c.beat || co.beat || '' } });
    }
  }
  logFlow({ op: `卷大纲对齐 第${vol.idx}卷 V0.93`, detail: `V0.93 已回填 ${doneChapters.length} 章实际 + 重规划未写章`, bookId });
  return { volumeIdx: vol.idx, doneChapters: doneChapters.length, chapters: data.chapters.length };
}

/** 书级大纲对齐：书纲 outline 材料 volumes 回填/对齐（已写卷用实际，未写卷对齐最新状态） */
export async function rewriteBookOutline(bookId, { onEvent, signal } = {}) {
  const book = store.books.get(bookId);
  const vols = store.volumes.list(bookId).sort((a, b) => a.idx - b.idx);
  const written = vols.filter(volumeDone);
  const pending = vols.filter(v => !volumeDone(v));
  const volLines = written.map(v => {
    const chs = store.chapters.listByVolume(v.id);
    const sum = chs.slice(0, 3).map(c => (store.summaries.get(c.id) || {}).summary || '').join('；').slice(0, 200);
    return `第${v.idx}卷《${v.title}》：${sum}`;
  });
  const openForeshadows = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  ensureHistory(bookId);
  const tailMsg = [{
    role: 'user',
    content: bookOutlineRewriteInstruction({
      bookTitle: book.title, contract: contract.replace(/【书契约】/g, '').slice(0, 400),
      writtenVolumes: volLines, pendingVolumes: pending.map(v => `${v.idx}:${v.title || ''}`).join('；'),
      openForeshadows, totalVolumes: vols.length,
      // V0.93.9：历史书注入十五卷年代总表（12卷节点/反攻号角 + 13-15反攻延伸期），对齐按新锚点重排
      historicalLongformText: historicalLongformPlanText(book),
    }),
  }];
  const messages = assembleMessages(bookId, tailMsg);
  const res = await runTask({
    task: 'book_outline_rewrite',
    bookId,
    messages,
    jsonMode: true,
    signal,
    onRetry: info => onEvent?.({ type: 'api_retry', ...info }),
  });
  const data = extractJSON(res.content) || {};
  if (!Array.isArray(data.volumes) || !data.volumes.length) throw new Error('书纲对齐解析失败');
  // 生成新书纲文本（保留原书纲的 title/logline/worldview 等头部，只更新 volumes 段）
  const oldText = store.materials.get(bookId, 'outline')?.content || '';
  const head = oldText.split(/卷规划|【分卷规划】|卷列表/)[0] || '';
  const volText = data.volumes.map(v => `卷${v.idx || ''}《${v.title || ''}》：${v.summary || v.goal || ''}`).join('\n');
  const newText = `${head.trim()}\n\n【分卷规划】（V0.45 自动对齐）\n${volText}`;
  store.materials.set(bookId, 'outline', newText);
  // V0.73 修复：公共材料（书纲）变更后必须重建历史堆前缀——否则 assembleMessages 读到的
  // 仍是旧书纲，LLM 永远看不到对齐结果（此前对齐"看似生效、实际未注入"）
  rebuildHistory(bookId, '书级大纲对齐');
  // 未写卷的卷名/goal 同步（V0.62：书纲对齐后未写卷的卷大纲 goal 也更新——后续写作按新规划走）
  for (const v of data.volumes) {
    const targetIdx = Number(v.idx);
    if (!Number.isInteger(targetIdx) || targetIdx < 1) continue;
    const target = store.volumes.list(bookId).find(x => x.idx === targetIdx);
    if (target && !volumeDone(target)) {
      const outline = (() => { try { return JSON.parse(target.outline_json || '{}'); } catch { return {}; } })();
      const patch = {};
      if (v.title && v.title !== target.title) patch.title = v.title.slice(0, 30);
      const newGoal = v.goal || v.summary || '';
      if (newGoal && newGoal !== outline.goal && newGoal !== target.goal) {
        outline.goal = newGoal;
        patch.goal = newGoal.slice(0, 100);
      }
      if (Object.keys(patch).length) {
        store.volumes.update(target.id, { ...patch, outline: { ...outline, title: patch.title || outline.title || target.title } });
      }
    }
  }
  const doneCount = store.chapters.list(bookId).filter(isCompletedChapter).length;
  logFlow({ op: '书级大纲对齐', detail: `书级对齐@${vols.length}卷${doneCount}章，回填 ${written.length} 卷实际`, bookId });
  return { volumes: data.volumes.length, written: written.length };
}
