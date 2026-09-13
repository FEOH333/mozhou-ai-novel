// server/engine/planning/opening_diagnosis.js —— V0.98 开篇正文切片、指纹与客观信号
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { assembleReviewMessages } from '../../llm/cache.js';
import { extractJSON } from '../../util/json.js';
import { openingDiagnosisInstruction } from '../prompts.js';
import { storyPromiseStatus, storyPromiseProfileText } from './story_promise.js';
import { platformGuidanceText } from '../../data/platform_guidance.js';
import { fanqieGenreProfileText } from '../../data/fanqie_genre_profiles.js';

const compactLength = value => String(value || '').replace(/\s+/g, '').length;

/** 切出实际读者会看到的固定窗口；只做字符切片，不作好坏判断。 */
export function openingSlices(text) {
  const value = String(text || '').trim();
  return {
    head80: value.slice(0, 80),
    head300: value.slice(0, 300),
    head800: value.slice(0, 800),
    head2000: value.slice(0, 2000),
    tail200: value.slice(-200),
    chars: compactLength(value),
  };
}

/** 正文/简介任一变化都会产生新指纹；不把数据库更新时间混入内容指纹。 */
export function openingFingerprint(book, chapters) {
  const payload = {
    title: String(book?.title || ''),
    blurb: String(book?.blurb || ''),
    genre: String(book?.genre || ''),
    platform: String(book?.platform || ''),
    chapters: (chapters || [])
      .map(chapter => ({
        idx: Number(chapter?.idx || 0),
        title: String(chapter?.title || ''),
        text: String(chapter?.text || ''),
      }))
      .sort((a, b) => a.idx - b.idx),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * 只输出可数事实。词表未命中不能据此生成“平淡/无钩子/会流失”等语义结论。
 */
export function localOpeningSignals(chapters) {
  return {
    chapters: (chapters || []).map(chapter => {
      const text = String(chapter?.text || '');
      const paragraphs = text.split(/\n+/).map(item => item.trim()).filter(Boolean);
      const quoted = [...text.matchAll(/[“「](.*?)[”」]/gs)].map(match => match[1]);
      const dialogueChars = quoted.reduce((sum, item) => sum + compactLength(item), 0);
      const firstDialogue = quoted.length ? text.indexOf(quoted[0]) : -1;
      const duplicateParagraphs = paragraphs.length - new Set(paragraphs).size;
      return {
        idx: Number(chapter?.idx || 0),
        title: String(chapter?.title || ''),
        chars: compactLength(text),
        first_paragraph_chars: compactLength(paragraphs[0] || ''),
        first_dialogue_at: firstDialogue,
        long_paragraphs: paragraphs.filter(item => compactLength(item) > 200).length,
        dialogue_chars: dialogueChars,
        dialogue_ratio: compactLength(text) ? Number((dialogueChars / compactLength(text)).toFixed(4)) : 0,
        paragraph_count: paragraphs.length,
        duplicate_paragraphs: duplicateParagraphs,
      };
    }),
  };
}

const RUBRIC_KEYS = Object.freeze([
  'first_screen_clarity', 'protagonist_bond', 'causal_motion', 'promise_alignment',
  'chapter_one_independence', 'emotional_variety', 'structural_naturalness',
]);
const STRATEGY_KINDS = new Set([
  'baseline', 'head_rewrite', 'chapter1_cold_open', 'composite_preview', 'standalone_prologue',
]);

function safeSettings(bookId) {
  try { return store.books.settings(bookId) || {}; } catch { return {}; }
}

function diagnosisError(message) {
  const error = new Error(message);
  error.code = 'OPENING_DIAG_INVALID';
  return error;
}

function containsPredictionField(value, path = '') {
  if (Array.isArray(value)) return value.some((item, index) => containsPredictionField(item, `${path}.${index}`));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    const next = path ? `${path}.${key}` : key;
    if (/expected.*(retention|follow|completion)|retention.*rate|follow.*rate|signing.*probab|推流概率|签约概率|预计.*率/i.test(next)) return true;
    return containsPredictionField(child, next);
  });
}

function occurrences(text, needle) {
  if (!needle) return [];
  const starts = [];
  let cursor = 0;
  while (cursor <= text.length - needle.length) {
    const found = text.indexOf(needle, cursor);
    if (found < 0) break;
    starts.push(found);
    cursor = found + 1;
  }
  return starts;
}

function closestOccurrence(starts, preferredStart) {
  if (!starts.length) return -1;
  if (!Number.isInteger(preferredStart) || preferredStart < 0) return starts[0];
  return starts.reduce((best, current) => (
    Math.abs(current - preferredStart) < Math.abs(best - preferredStart) ? current : best
  ), starts[0]);
}

function nonWhitespaceProjection(text) {
  const chars = [];
  const sourceIndexes = [];
  for (let index = 0; index < text.length; index++) {
    if (/\s/u.test(text[index])) continue;
    chars.push(text[index]);
    sourceIndexes.push(index);
  }
  return { text: chars.join(''), sourceIndexes };
}

const ADDITIVE_STORY_FIX_PATTERNS = [
  /(?:新增|新加|加入|引入|添加|安排|设置|插入|制造|创造|设计).{0,16}(?:人物|角色|反派|事件|冲突|危机|袭击|追兵|战斗|任务|线索|敌人|对手|物件|设定)/u,
  /(?:直接进入|切入|转入|改为|改成).{0,12}(?:新人物|新角色|新事件|新冲突|新危机|新线索|新设定)/u,
];

/**
 * 诊断的最小改法只能编辑现有证据。模型若把“新增剧情”当成小修，
 * 本地收敛为文本级操作，防止幻觉人物/事件进入后续候选链。
 */
export function sanitizeEvidenceBoundFix(value) {
  const text = String(value || '').trim();
  const unsafe = ADDITIVE_STORY_FIX_PATTERNS.some(pattern => pattern.test(text));
  if (!unsafe) return { text, sanitized: false };
  return {
    text: '删减、压缩、改写或重排该引文，只使用指定章节已有的人物、事件与物件；不得新增剧情事实。',
    sanitized: true,
  };
}

function isReaderPreferenceTradeoff(issue) {
  const text = `${issue?.cause || ''}\n${issue?.smallest_fix || ''}`;
  const preferenceOnly = /(?:追求|偏好).{0,8}(?:快?节奏|速度)|(?:快节奏|节奏偏快).{0,8}读者/u.test(text);
  const concreteDefect = /事实|时间线|矛盾|穿越|视角|说话人|指代不清|混淆|无法理解|需要回读|重复|跳跃|断裂|错字|误用|自相冲突/u.test(text);
  return preferenceOnly && !concreteDefect;
}

/**
 * 模型负责给逐字引文，字符范围由本地正文校准。只容忍范围错误和空白差异；
 * 无法定位的改写句不能成为证据，由上层隔离而不是进入自动修改链。
 */
function alignIssueEvidence(text, quote, preferredStart, preferredEnd) {
  if (Number.isInteger(preferredStart) && Number.isInteger(preferredEnd)
    && preferredStart >= 0 && preferredEnd > preferredStart
    && text.slice(preferredStart, preferredEnd) === quote) {
    return {
      start: preferredStart, end: preferredEnd, quote,
      evidence_alignment: 'model_exact', range_repaired: false,
    };
  }

  const exactStart = closestOccurrence(occurrences(text, quote), preferredStart);
  if (exactStart >= 0) return {
    start: exactStart, end: exactStart + quote.length, quote,
    evidence_alignment: 'local_exact', range_repaired: true,
  };

  const projectedText = nonWhitespaceProjection(text);
  const projectedQuote = nonWhitespaceProjection(quote).text;
  if (!projectedQuote) return null;
  const projectedStarts = occurrences(projectedText.text, projectedQuote);
  if (!projectedStarts.length) return null;
  const candidates = projectedStarts.map(start => ({
    projectedStart: start,
    sourceStart: projectedText.sourceIndexes[start],
    sourceEnd: projectedText.sourceIndexes[start + projectedQuote.length - 1] + 1,
  }));
  const chosen = candidates.reduce((best, current) => {
    if (!Number.isInteger(preferredStart) || preferredStart < 0) return best;
    return Math.abs(current.sourceStart - preferredStart) < Math.abs(best.sourceStart - preferredStart)
      ? current : best;
  }, candidates[0]);
  return {
    start: chosen.sourceStart, end: chosen.sourceEnd,
    quote: text.slice(chosen.sourceStart, chosen.sourceEnd),
    evidence_alignment: 'local_whitespace', range_repaired: true,
  };
}

/** 收集第1—3章全文及第4—10章实际片段；指纹仍覆盖前10章完整正文。 */
export function collectOpeningInput(bookId) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const promise = storyPromiseStatus(bookId);
  if (!promise.exists || promise.stale) {
    const error = new Error(promise.exists ? '创作画像已过期' : '创作画像未完成');
    error.code = 'STORY_PROMISE_REQUIRED';
    throw error;
  }
  const chapters = store.chapters.list(bookId)
    .slice()
    .sort((a, b) => Number(a.idx) - Number(b.idx))
    .slice(0, 10)
    .map(chapter => ({
      id: chapter.id,
      idx: Number(chapter.idx),
      title: chapter.title || '',
      text: store.chapters.fullText(chapter.id) || '',
      summary: store.summaries.get(chapter.id)?.summary || '',
    }));
  const fullChapters = chapters.filter(chapter => chapter.idx <= 3)
    .map(({ idx, title, text }) => ({ idx, title, text }));
  const laterChapters = chapters.filter(chapter => chapter.idx >= 4).map(chapter => {
    const slices = openingSlices(chapter.text);
    return {
      idx: chapter.idx, title: chapter.title, summary: chapter.summary,
      head300: slices.head300, tail200: slices.tail200,
    };
  });
  return {
    book,
    chapters,
    fullChapters,
    laterChapters,
    localSignals: localOpeningSignals(chapters),
    storyPromiseProfile: promise.profile,
    source_fingerprint: openingFingerprint(book, chapters),
    promise_profile_fingerprint: promise.source_fingerprint,
    evidence_basis: {
      chapter_count: chapters.length,
      full_text_chapters: fullChapters.map(chapter => chapter.idx),
      summary_chapters: laterChapters.map(chapter => chapter.idx),
    },
  };
}

/** 严格验证诊断结构与引文；未知/无证据问题不能进入自动修改链路。 */
export function validateOpeningDiagnosis(input, chapters = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw diagnosisError('诊断结果不是对象');
  if (containsPredictionField(input)) throw diagnosisError('诊断含平台流量、留存或签约概率预测字段');
  const report = structuredClone(input);
  if (!report.cold_read || typeof report.cold_read !== 'object') throw diagnosisError('诊断缺少 cold_read');
  for (const key of ['protagonist', 'immediate_want_or_danger', 'continue_question', 'strongest_axis']) {
    if (!report.cold_read[key] || typeof report.cold_read[key] !== 'object') throw diagnosisError(`cold_read 缺少 ${key}`);
  }
  for (const key of ['attention_drop', 'speaker_confusion', 'artificial_or_ai_feel']) {
    if (!Array.isArray(report.cold_read[key])) throw diagnosisError(`cold_read.${key} 必须是数组`);
  }
  if (!report.rubric || typeof report.rubric !== 'object') throw diagnosisError('诊断缺少 rubric');
  for (const key of RUBRIC_KEYS) {
    const row = report.rubric[key];
    if (!row || !Number.isInteger(row.score) || row.score < 0 || row.score > 4 || !Array.isArray(row.evidence)) {
      throw diagnosisError(`rubric.${key} 结构错误或分数越界`);
    }
    row.cost = String(row.cost || '');
  }
  if (!Array.isArray(report.hard_failures)) throw diagnosisError('诊断缺少 hard_failures');
  if (!Array.isArray(report.issues)) throw diagnosisError('诊断缺少 issues');
  const byIdx = new Map(chapters.map(chapter => [Number(chapter.idx), String(chapter.text || '')]));
  const validationWarnings = [];
  const verifiedIssues = [];
  report.issues.forEach((issue, index) => {
    const chapter = Number(issue?.chapter);
    const start = Number(issue?.start);
    const end = Number(issue?.end);
    const quote = String(issue?.quote || '');
    // V0.98.5：字段级残缺（severity/chapter/quote/cause/fix 任一缺失）只隔离该条软意见，
    // 不拖垮整份诊断——免费档模型产出更粗糙，与 quote_not_found 同一治理原则（单条坏证据 ≠ 整份失败）。
    const safeFix = sanitizeEvidenceBoundFix(issue?.smallest_fix);
    const structurallyValid = ['high', 'medium', 'low'].includes(issue?.severity)
      && Number.isInteger(chapter) && quote.trim()
      && String(issue?.cause || '').trim() && safeFix.text;
    if (!structurallyValid) {
      validationWarnings.push({ kind: 'issue', index, chapter: Number.isInteger(chapter) ? chapter : null, code: 'invalid_structure' });
      return;
    }
    const text = byIdx.get(chapter);
    const aligned = text == null ? null : alignIssueEvidence(text, quote, start, end);
    if (!aligned) {
      validationWarnings.push({ kind: 'issue', index, chapter, code: 'quote_not_found' });
      return;
    }
    verifiedIssues.push({
      ...issue, chapter, ...aligned,
      smallest_fix: safeFix.text,
      ...(safeFix.sanitized ? { fix_sanitized: true } : {}),
    });
  });
  const declaredTradeoffs = [];
  if (Array.isArray(report.tradeoffs)) report.tradeoffs.forEach((item, index) => {
    const chapter = Number(item?.chapter);
    const quote = String(item?.quote || '');
    const reason = String(item?.reason || '').trim();
    // V0.98.5：tradeoff 字段残缺同样只隔离单条（免费档实证：模型偶发丢 chapter/quote 字段）。
    if (!Number.isInteger(chapter) || !quote.trim() || !reason) {
      validationWarnings.push({ kind: 'tradeoff', index, chapter: Number.isInteger(chapter) ? chapter : null, code: 'invalid_structure' });
      return;
    }
    const text = byIdx.get(chapter);
    const aligned = text == null ? null : alignIssueEvidence(text, quote, Number(item?.start), Number(item?.end));
    if (!aligned) {
      validationWarnings.push({ kind: 'tradeoff', index, chapter, code: 'quote_not_found' });
      return;
    }
    declaredTradeoffs.push({ ...item, chapter, ...aligned, reason, source: item?.source || 'reader_preference' });
  });
  const preferenceTradeoffs = verifiedIssues.filter(isReaderPreferenceTradeoff).map(issue => ({
    chapter: issue.chapter, start: issue.start, end: issue.end, quote: issue.quote,
    reason: issue.cause, source: 'reader_preference',
  }));
  report.issues = verifiedIssues.filter(issue => !isReaderPreferenceTradeoff(issue));
  report.tradeoffs = [...declaredTradeoffs, ...preferenceTradeoffs];
  if (!Array.isArray(report.strategies) || !report.strategies.length) throw diagnosisError('诊断缺少 strategies');
  for (const strategy of report.strategies) {
    if (!STRATEGY_KINDS.has(strategy?.kind)) throw diagnosisError(`未知开篇策略：${strategy?.kind || '空'}`);
  }
  if (!report.recommendation || !STRATEGY_KINDS.has(report.recommendation.kind)) throw diagnosisError('recommendation 策略无效');
  if (validationWarnings.length) {
    report.validation_warnings = validationWarnings;
    report.recommendation = {
      kind: 'baseline',
      reason: '部分模型意见缺少可核对的正文引文，已隔离；本次不据此建议修改原稿。',
    };
  } else {
    delete report.validation_warnings;
  }
  return report;
}

async function requestOpeningDiagnosis(input, { signal } = {}) {
  const route = input.storyPromiseProfile?.texture?.route || 'general';
  const instruction = openingDiagnosisInstruction({
    book: input.book,
    storyPromise: storyPromiseProfileText(input.storyPromiseProfile),
    fullChapters: input.fullChapters,
    laterChapters: input.laterChapters,
    localSignals: input.localSignals,
    platformGuidance: platformGuidanceText(input.book.platform),
    genreProfile: fanqieGenreProfileText(input.book.genre, route),
  });
  const result = await runTask({
    task: 'opening_diagnosis', bookId: input.book.id, jsonMode: true, signal,
    messages: assembleReviewMessages(input.book.id, [{ role: 'user', content: instruction }]),
  });
  return extractJSON(result.content);
}

function recordDiagnosisFailure(bookId, error) {
  const settings = safeSettings(bookId);
  settings.openingDiagnosisLastAttempt = {
    failed_at: Date.now(),
    error: error?.message || String(error),
    code: error?.code || 'OPENING_DIAG_FAILED',
  };
  store.books.update(bookId, { settings });
}

export async function diagnoseOpening(bookId, { signal, onEvent, data } = {}) {
  try {
    const input = collectOpeningInput(bookId);
    onEvent?.({ type: 'opening_stage', step: 'diagnosing', detail: `读取前${input.chapters.length}章实际正文` });
    const parsed = data || await requestOpeningDiagnosis(input, { signal });
    const report = validateOpeningDiagnosis(parsed, input.chapters);
    Object.assign(report, {
      version: 3,
      source_fingerprint: input.source_fingerprint,
      promise_profile_fingerprint: input.promise_profile_fingerprint,
      evidence_basis: input.evidence_basis,
      created_at: Date.now(),
    });
    store.materials.set(bookId, 'opening_diagnosis', JSON.stringify(report));
    const settings = safeSettings(bookId);
    delete settings.openingDiagnosisLastAttempt;
    store.books.update(bookId, { settings });
    const isolated = report.validation_warnings?.length || 0;
    onEvent?.({
      type: 'opening_stage', step: 'diagnosed',
      detail: `发现${report.issues.length}条带引文问题${isolated ? `，隔离${isolated}条无法核验意见` : ''}`,
      issues: report.issues.length, isolated,
    });
    return { ok: true, report };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
    const finalError = error?.code ? error : diagnosisError(error?.message || String(error));
    recordDiagnosisFailure(bookId, finalError);
    throw finalError;
  }
}

export function openingDiagnosisStatus(bookId) {
  const row = store.materials.get(bookId, 'opening_diagnosis');
  let report = null;
  try { report = row?.content ? JSON.parse(row.content) : null; } catch { /* invalid stored legacy report */ }
  const settings = safeSettings(bookId);
  let input = null;
  try { input = collectOpeningInput(bookId); } catch { /* missing/stale promise means any prior report is stale */ }
  const stale = !report || !input
    || report.version !== 3
    || report.source_fingerprint !== input.source_fingerprint
    || report.promise_profile_fingerprint !== input.promise_profile_fingerprint;
  return {
    exists: Boolean(report), stale, report,
    source_fingerprint: report?.source_fingerprint || '',
    current_fingerprint: input?.source_fingerprint || '',
    promise_profile_fingerprint: report?.promise_profile_fingerprint || '',
    current_promise_fingerprint: input?.promise_profile_fingerprint || '',
    last_attempt_failed: settings.openingDiagnosisLastAttempt || null,
  };
}
