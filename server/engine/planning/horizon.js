// V0.102 卷缝与长线压力编译器。
// 卷纲/章纲只吃编译结果：上一卷实际出口、停滞弧、有界兑付队列。禁止把全量台账灌进指令。
'use strict';

import * as store from '../../db/store.js';
import { namesMatch } from '../../util/text.js';
import { isCompletedChapter } from '../pipeline/chapter_status.js';
import { narrativePatternSignature } from '../quality/narrative_patterns.js';
import { HORIZON_SEAM_TEXT } from '../../data/literary_techniques.js';
import { sanitizeStoryMemoryText } from '../quality/rules.js';

export const HOOK_AGE_GRACE = Object.freeze({
  short: 4,
  medium: 12,
  long: 15,
  super: 15,
});

export const PAYOFF_QUEUE_CAP = 6;
export const CHAPTER_HORIZON_PAYOFF_CAP = 4;
export const CHAPTER_FORESHADOW_CAP = 6;
export const UNSCHEDULED_FORESHADOW_GRACE = 8;
export const STALE_ARC_CAP = 4;

const GENERIC_TOKENS = new Set([
  '本章', '主角', '他们', '我们', '自己', '一个', '这个', '那个', '什么', '如何',
  '已经', '开始', '继续', '出现', '发生', '进行', '回到', '确认', '方向', '时候',
  '之后', '之前', '现在', '当时', '于是', '因为', '所以', '但是', '如果', '不是',
]);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function textOf(value) {
  return sanitizeStoryMemoryText(String(value || '')).trim();
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function hookKind(hook) {
  return String(hook?.kind || 'short');
}

function hookDue(hook) {
  return num(hook?.dueChapter ?? hook?.due_chapter, 0);
}

function hookProgress(hook) {
  const status = String(hook?.status || '');
  if (status === 'progressing' || status === 'confirmed') return true;
  return num(hook?.lastProgressChapter ?? hook?.last_progress_chapter, 0) > 0;
}

function graceFor(kind) {
  return HOOK_AGE_GRACE[kind] ?? HOOK_AGE_GRACE.long;
}

/**
 * 纯函数：哪些开放钩子已超期且无推进，应老化。
 * 短/中线 expire 不转伏笔；长/超长仍由 settleHookLedger 转伏笔台账。
 */
export function hooksDueToAge(hooks = [], currentChapter, grace = HOOK_AGE_GRACE) {
  const now = num(currentChapter, 0);
  const merged = { ...HOOK_AGE_GRACE, ...grace };
  return (Array.isArray(hooks) ? hooks : []).filter(hook => {
    const status = String(hook?.status || 'open');
    if (status && status !== 'open') return false;
    const due = hookDue(hook);
    if (due <= 0 || now <= 0) return false;
    if (hookProgress(hook)) return false;
    const overdue = now - due;
    const kind = hookKind(hook);
    const wait = merged[kind] ?? merged.long;
    return overdue > wait;
  });
}

function parseJson(raw, fallback = {}) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '{}') || fallback; } catch { return fallback; }
}

function emptySeam() {
  return {
    previousVolumeIdx: 0,
    previousVolumeTitle: '',
    exitFacts: [],
    unpaidTurn: '',
    staleArcs: [],
    payoffQueue: [],
    microLoop: false,
    lastChapter: null,
    previousSignatures: [],
  };
}

const MICRO_OBSERVE = /观察|发现|看见|察觉|辨认|复核|脚印|痕迹|焦痕|测距|看桩|看图|辨迹/;
const MICRO_RECORD = /记入|写入|工册|账册|落册|标记|地图|请示|验证|等候/;

export function isMicroLoopSignature(signature) {
  const parts = String(signature || '').split('>');
  return parts.includes('observe') && parts.includes('record');
}

export function isMicroLoopText(text) {
  const src = String(text || '');
  return MICRO_OBSERVE.test(src) && MICRO_RECORD.test(src);
}

function extractExitFacts(lastChapter = {}) {
  const facts = [];
  const title = textOf(lastChapter.title);
  if (title) facts.push(title);
  const blob = [lastChapter.summary, lastChapter.tail, lastChapter.goal].map(textOf).filter(Boolean).join('。');
  for (const clause of blob.split(/[，。；、！？\n]/)) {
    const t = clause.trim();
    if (t.length >= 4 && t.length <= 40) facts.push(t);
  }
  return unique(facts).slice(0, 8);
}

/** 出口匹配用词：去掉每条事实开头像人名的两字，避免只因主角名过闸。 */
export function exitMatchTokens(facts = []) {
  const tokens = [];
  for (const fact of facts) {
    const src = String(fact || '').trim();
    if (src.length < 2) continue;
    tokens.push(src);
    const rest = src.slice(2).replace(/^(?:已|在|的|了)/, '');
    if (rest.length >= 2) {
      tokens.push(rest);
      for (let size = 2; size <= Math.min(4, rest.length); size++) {
        for (let i = 0; i + size <= rest.length; i++) {
          const gram = rest.slice(i, i + size);
          if (!GENERIC_TOKENS.has(gram)) tokens.push(gram);
        }
      }
    }
  }
  return unique(tokens).filter(t => t.length >= 2 && !GENERIC_TOKENS.has(t));
}

function turnLanded(turn, summaries = []) {
  const goal = textOf(turn);
  if (!goal || goal.length < 4) return true;
  const blob = summaries.map(textOf).join('');
  if (!blob) return false;
  if (blob.includes(goal)) return true;
  const tokens = exitMatchTokens([goal]).filter(t => t.length >= 3);
  return tokens.some(t => blob.includes(t));
}

function rankPayoff(item, lastIdx) {
  const due = num(item.due_chapter ?? item.dueChapter ?? item.payoff_chapter ?? item.payoffChapter, 0);
  const planted = num(item.planted_chapter ?? item.plantedChapter, 0);
  const overdue = due > 0 ? Math.max(0, lastIdx - due) : (planted > 0 ? Math.max(0, lastIdx - planted) : 0);
  const unscheduled = due <= 0 && !num(item.payoff_chapter ?? item.payoffChapter, 0);
  return (unscheduled ? 1000 : 0) + overdue * 10 + (lastIdx - planted);
}

function buildPayoffQueue({ overdueHooks = [], plantedForeshadows = [], lastIdx = 0, cap = PAYOFF_QUEUE_CAP }) {
  const items = [];
  for (const hook of overdueHooks) {
    const desc = textOf(hook.desc);
    if (!desc) continue;
    items.push({
      desc,
      source: 'hook',
      kind: hookKind(hook),
      due_chapter: hookDue(hook),
      planted_chapter: num(hook.plantedChapter ?? hook.planted_chapter, 0),
    });
  }
  for (const fs of plantedForeshadows) {
    const desc = textOf(fs.desc);
    if (!desc) continue;
    const payoff = num(fs.payoff_chapter ?? fs.payoffChapter, 0);
    const planted = num(fs.planted_chapter ?? fs.plantedChapter, 0);
    const status = String(fs.status || 'planted');
    if (!['planted', 'advanced'].includes(status) && status) continue;
    items.push({
      desc,
      source: 'foreshadow',
      kind: payoff > 0 ? 'scheduled' : 'unscheduled',
      due_chapter: payoff,
      planted_chapter: planted,
      payoff_chapter: payoff || null,
    });
  }
  items.sort((a, b) => rankPayoff(b, lastIdx) - rankPayoff(a, lastIdx));
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.desc.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

export function compileVolumeSeam(snapshot = {}) {
  const lastChapter = snapshot.lastChapter || null;
  if (!lastChapter && !snapshot.previousVolumeIdx) return emptySeam();
  const lastIdx = num(lastChapter?.idx, 0);
  const exitFacts = extractExitFacts(lastChapter || {});
  const previousTurn = textOf(snapshot.previousTurn);
  const summaries = [
    ...(Array.isArray(snapshot.previousSummaries) ? snapshot.previousSummaries : []),
    lastChapter?.summary, lastChapter?.tail, lastChapter?.goal,
  ];
  const staleArcs = (Array.isArray(snapshot.staleArcs) ? snapshot.staleArcs : [])
    .filter(a => textOf(a?.name))
    .slice(0, STALE_ARC_CAP);
  const signatures = Array.isArray(snapshot.previousSignatures) ? snapshot.previousSignatures : [];
  const microHits = signatures.filter(isMicroLoopSignature).length;
  return {
    previousVolumeIdx: num(snapshot.previousVolumeIdx, 0),
    previousVolumeTitle: textOf(snapshot.previousVolumeTitle),
    exitFacts,
    unpaidTurn: previousTurn && !turnLanded(previousTurn, summaries) ? previousTurn : '',
    staleArcs,
    payoffQueue: buildPayoffQueue({
      overdueHooks: snapshot.overdueHooks || [],
      plantedForeshadows: snapshot.plantedForeshadows || [],
      lastIdx,
    }),
    microLoop: signatures.length >= 3 && microHits >= 3,
    lastChapter,
    previousSignatures: signatures,
  };
}

function firstChapters(outline, n = 3) {
  const chapters = Array.isArray(outline?.chapters) ? outline.chapters : [];
  return [...chapters].sort((a, b) => num(a.idx, 0) - num(b.idx, 0)).slice(0, n);
}

function chapterPlanText(ch) {
  return [ch?.title, ch?.beat, ch?.goal, ch?.conflict].map(textOf).join(' ');
}

function hitsExit(outline, seam) {
  const facts = (seam.exitFacts || []).filter((f) => {
    const t = String(f || '').trim();
    if (t.length < 4) return false;
    if (/^第\d+章$/.test(t)) return false;
    return true;
  });
  if (!facts.length) return true;
  const tokens = exitMatchTokens(facts);
  if (!tokens.length) return true;
  const first = firstChapters(outline, 1)[0];
  if (!first) return false;
  const blob = chapterPlanText(first);
  return tokens.some(t => blob.includes(t));
}

function advancesStaleArc(outline, seam) {
  const stale = seam.staleArcs || [];
  if (!stale.length) return true;
  const named = [
    ...(Array.isArray(outline?.arcs_advanced) ? outline.arcs_advanced : []),
    ...(Array.isArray(outline?.arcs_closed) ? outline.arcs_closed : []),
  ].map(textOf).filter(Boolean);
  const beats = firstChapters(outline, 3).map(chapterPlanText).join(' ');
  return stale.some(arc => {
    const name = textOf(arc.name);
    if (!name) return false;
    if (named.some(n => namesMatch(n, name))) return true;
    const entity = name.replace(/(?:感情线|权谋线|主线|暗线|支线|关系线)$/g, '');
    return entity.length >= 2 && beats.includes(entity);
  });
}

function repeatsMicroLoop(outline, seam) {
  if (!seam.microLoop) return false;
  const head = firstChapters(outline, 3);
  if (head.length < 2) return false;
  const hits = head.filter(ch => {
    const t = chapterPlanText(ch);
    return isMicroLoopText(t) || isMicroLoopSignature(narrativePatternSignature({ outline: ch, text: t }));
  }).length;
  return hits >= 2;
}

export function validateVolumeSeam(outline, seam) {
  const issues = [];
  if (!seam || !num(seam.previousVolumeIdx, 0) || !seam.lastChapter) {
    return { ok: true, issues };
  }
  if (seam.exitFacts?.length && !hitsExit(outline, seam)) {
    issues.push({
      code: 'SEAM_EXIT_IGNORED',
      chapter: 1,
      message: `新卷第1章未承接上一卷实际出口（须命中：${seam.exitFacts.slice(0, 4).join(' / ')}）`,
    });
  }
  if (seam.staleArcs?.length && !advancesStaleArc(outline, seam)) {
    issues.push({
      code: 'STALE_ARC_IGNORED',
      message: `本卷未推进停滞弧：${seam.staleArcs.map(a => a.name).join('、')}。arcs_advanced 必须包含其中至少一条原名`,
    });
  }
  if (repeatsMicroLoop(outline, seam)) {
    issues.push({
      code: 'VOLUME_MICRO_LOOP',
      message: '上一卷已是观察-记录微循环，本卷前三章不得再以观察痕迹、记入工册、请示验证为骨架',
    });
  }
  return { ok: issues.length === 0, issues };
}

export function formatVolumeSeamText(seam) {
  if (!seam || !num(seam.previousVolumeIdx, 0) || !seam.lastChapter) return '';
  const last = seam.lastChapter;
  const lines = [
    `【卷缝】上一卷实际出口（第${seam.previousVolumeIdx}卷${seam.previousVolumeTitle ? `《${seam.previousVolumeTitle}》` : ''}，以最后完成章为准，不以书纲分卷句为准）`,
    `第${last.idx || '?'}章《${textOf(last.title) || '未题'}》${last.year ? `（${last.year}）` : ''}：${textOf(last.summary).slice(0, 180)}`,
  ];
  if (textOf(last.tail)) lines.push(`章末余势：${textOf(last.tail).slice(0, 160)}`);
  if (seam.unpaidTurn) lines.push(`上卷转折未在近章落地，本卷前三章必须兑现、改写或公开放弃：${seam.unpaidTurn}`);
  if (seam.staleArcs?.length) {
    lines.push(`停滞弧（本卷必须推进至少一条）：${seam.staleArcs.map(a => `${a.name}（停于第${a.last_active_chapter || a.lastActiveChapter || '?'}章）`).join('、')}`);
  }
  if (seam.payoffQueue?.length) {
    lines.push(`有界兑付队列（${seam.payoffQueue.length}条，禁止整表灌入）：`);
    for (const item of seam.payoffQueue) lines.push(`- ${item.desc}`);
  }
  if (seam.microLoop) {
    lines.push('上卷因果骨架已是观察-记录循环。本卷前三章必须改写主动者、阻力与不可逆后果，禁止再写一卷看图辨迹。');
  }
  lines.push(HORIZON_SEAM_TEXT);
  return lines.join('\n');
}

export function compileChapterHorizon(input = {}) {
  const staleArcs = (Array.isArray(input.staleArcs) ? input.staleArcs : [])
    .filter(a => textOf(a?.name))
    .slice(0, 2);
  const duePayoffs = (Array.isArray(input.duePayoffs) ? input.duePayoffs : [])
    .map(p => ({ ...p, desc: textOf(p.desc) }))
    .filter(p => p.desc)
    .sort((a, b) => num(a.due_chapter ?? a.dueChapter, 1e9) - num(b.due_chapter ?? b.dueChapter, 1e9))
    .slice(0, CHAPTER_HORIZON_PAYOFF_CAP);
  return {
    chapterIdx: num(input.chapterIdx, 0),
    exitLine: textOf(input.exitLine),
    staleArcs,
    payoffs: duePayoffs,
    microLoop: Boolean(input.microLoop),
  };
}

export function formatChapterHorizonText(brief) {
  if (!brief) return '';
  const has = brief.exitLine || brief.staleArcs?.length || brief.payoffs?.length || brief.microLoop;
  if (!has) return '';
  const lines = ['【本章长线简报】'];
  if (brief.exitLine) lines.push(`承接：${brief.exitLine}`);
  if (brief.staleArcs?.length) {
    lines.push(`停滞弧（近章须推进其一）：${brief.staleArcs.map(a => a.name).join('、')}`);
  }
  if (brief.payoffs?.length) {
    lines.push('有界兑付（禁止把全书钩子写进本章）：');
    for (const p of brief.payoffs) lines.push(`- ${p.desc}`);
  }
  if (brief.microLoop) {
    lines.push('上一卷因果骨架已是观察-记录循环。本章禁止再以观察痕迹、记入工册、请示验证为骨架；必须改写主动者、阻力与不可逆后果。');
  }
  lines.push('优先改变在场人物的权限、关系或局势；禁止用再观察、再记录、再请示代替发展。');
  return lines.join('\n');
}

export function validateChapterHorizon(outline, brief) {
  const issues = [];
  if (!brief?.microLoop) return { ok: true, issues };
  const blob = [
    outline?.goal, outline?.conflict, outline?.beat, outline?.title,
    ...(Array.isArray(outline?.scenes) ? outline.scenes.map(scene => scene?.beat) : []),
  ].map(textOf).join(' ');
  if (isMicroLoopText(blob) || isMicroLoopSignature(narrativePatternSignature({ outline, text: blob }))) {
    issues.push({
      code: 'CHAPTER_MICRO_LOOP',
      hard: true,
      message: '上一卷已是观察-记录循环，本章细纲不得再以观察痕迹、记入工册、请示验证为骨架',
    });
  }
  return { ok: issues.length === 0, issues };
}

function previousVolume(bookId, volumeIdx) {
  return store.volumes.list(bookId).find(v => Number(v.idx) === Number(volumeIdx) - 1) || null;
}

function lastCompletedInVolume(volumeId) {
  return store.chapters.listByVolume(volumeId)
    .filter(isCompletedChapter)
    .sort((a, b) => a.idx - b.idx)
    .at(-1) || null;
}

function chapterExitRecord(chapter) {
  if (!chapter) return null;
  const outline = store.chapters.outline(chapter.id) || {};
  const summary = store.summaries.get(chapter.id)?.summary || outline.actual_beat || outline.goal || '';
  const tail = store.chapters.fullText(chapter.id).slice(-400);
  return {
    idx: chapter.idx,
    title: chapter.title || '',
    year: outline.year || '',
    summary: textOf(summary),
    tail: textOf(tail),
    goal: textOf(outline.goal || outline.beat || ''),
  };
}

function volumeSignatures(volumeId, limit = 4) {
  const chapters = store.chapters.listByVolume(volumeId)
    .filter(isCompletedChapter)
    .sort((a, b) => a.idx - b.idx)
    .slice(-limit);
  return chapters.map(ch => narrativePatternSignature({
    outline: store.chapters.outline(ch.id) || {},
    text: store.chapters.fullText(ch.id) || store.summaries.get(ch.id)?.summary || '',
  }));
}

/** store 装配：下一卷的缝。第 1 卷或没有已完成前卷时返回空缝。 */
export function buildVolumeSeam(bookId, volumeIdx) {
  const prev = previousVolume(bookId, volumeIdx);
  if (!prev) return emptySeam();
  const last = lastCompletedInVolume(prev.id);
  if (!last) return emptySeam();
  const lastRec = chapterExitRecord(last);
  const prevChapters = store.chapters.listByVolume(prev.id)
    .filter(isCompletedChapter)
    .sort((a, b) => a.idx - b.idx);
  const previousSummaries = prevChapters.slice(-4).map(ch => (
    store.summaries.get(ch.id)?.summary || store.chapters.outline(ch.id)?.actual_beat || ''
  ));
  const prevOutline = parseJson(prev.outline_json);
  return compileVolumeSeam({
    previousVolumeIdx: prev.idx,
    previousVolumeTitle: prev.title || '',
    previousTurn: prevOutline.stage_turn || prev.goal || '',
    lastChapter: lastRec,
    previousSummaries,
    staleArcs: store.storyArcs.stale(bookId, last.idx),
    overdueHooks: hooksDueToAge(store.pleasureHooks.list(bookId).filter(h => h.status === 'open'), last.idx),
    plantedForeshadows: store.foreshadows.active(bookId),
    previousSignatures: volumeSignatures(prev.id),
  });
}

function chapterExitLine(bookId, chapterIdx) {
  const prev = store.chapters.list(bookId).find(c => c.idx === chapterIdx - 1);
  if (!prev) return '';
  const rec = chapterExitRecord(prev);
  if (!rec) return '';
  const bit = rec.summary || rec.tail || rec.goal;
  return `第${rec.idx}章《${rec.title || '未题'}》：${textOf(bit).slice(0, 80)}`;
}

function duePayoffsForChapter(bookId, chapterIdx) {
  const openHooks = store.pleasureHooks.list(bookId).filter(h => ['open', 'progressing'].includes(h.status));
  const overdue = hooksDueToAge(openHooks, chapterIdx);
  const soon = openHooks.filter(h => {
    const due = hookDue(h);
    return due > 0 && due <= chapterIdx + 2 && !overdue.includes(h);
  });
  const foreshadows = store.foreshadows.active(bookId).filter(f => {
    const payoff = num(f.payoff_chapter, 0);
    const planted = num(f.planted_chapter, 0);
    if (payoff > 0) return chapterIdx + 2 >= payoff;
    return planted > 0 && chapterIdx - planted >= UNSCHEDULED_FORESHADOW_GRACE;
  });
  return [...overdue, ...soon, ...foreshadows];
}

export function buildChapterHorizon(bookId, chapterIdx) {
  const chapter = store.chapters.list(bookId).find(c => Number(c.idx) === Number(chapterIdx));
  const vol = chapter?.volume_id ? store.volumes.get(chapter.volume_id) : null;
  let microLoop = false;
  if (vol) {
    const seam = buildVolumeSeam(bookId, vol.idx);
    const volumeChapters = store.chapters.listByVolume(vol.id).sort((a, b) => a.idx - b.idx);
    const pos = volumeChapters.findIndex(c => c.id === chapter.id);
    microLoop = Boolean(seam.microLoop && pos >= 0 && pos < 3);
  }
  return compileChapterHorizon({
    chapterIdx,
    exitLine: chapterExitLine(bookId, chapterIdx),
    staleArcs: store.storyArcs.stale(bookId, chapterIdx),
    duePayoffs: duePayoffsForChapter(bookId, chapterIdx),
    microLoop,
  });
}

/** 章纲活跃伏笔有界子集：超期/临近/无回收章旧坑优先，最多 6 条。 */
export function selectActiveForeshadowsForChapter(bookId, chapterIdx, { limit = CHAPTER_FORESHADOW_CAP } = {}) {
  const now = num(chapterIdx, 0);
  const active = store.foreshadows.active(bookId);
  const score = (f) => {
    const payoff = num(f.payoff_chapter, 0);
    const planted = num(f.planted_chapter, 0);
    const overdue = payoff > 0 && now > payoff ? (now - payoff) * 100 : 0;
    const approaching = payoff > 0 && payoff >= now && payoff - now <= 2 ? 80 : 0;
    const unscheduled = !payoff && planted && now - planted >= UNSCHEDULED_FORESHADOW_GRACE ? (now - planted) : 0;
    const recency = planted;
    return overdue + approaching + unscheduled + recency / 1000;
  };
  return [...active]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

export { HORIZON_SEAM_TEXT };
