// server/engine/planning/signing.js —— 开篇文本发布前预审（不模拟平台结果）
// 读取读者真正会看到的正文，以带引文的问题清单帮助作者发布前检查；不预测签约、推流或留存。
// 数据：materials('signing_review')（文本，幂等）+ settings_json.signingReview（结构化）
'use strict';
import { createHash } from 'node:crypto';
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { assembleReviewMessages } from '../../llm/cache.js';
import { signingReviewInstruction } from '../prompts.js';
import { extractJSON } from '../../util/json.js';
import { isCompletedChapter, transitionChapterStatus } from '../pipeline/chapter_status.js'; // V0.93.2：状态写入单一真源
import { markNarrativeStateStale } from '../narrative/narrative_state.js';
import { collectOpeningInput, openingDiagnosisStatus, openingFingerprint, openingSlices } from './opening_diagnosis.js';
import { storyPromiseProfileText } from './story_promise.js';
import { platformGuidanceText } from '../../data/platform_guidance.js';
import { fanqieGenreProfileText } from '../../data/fanqie_genre_profiles.js';

const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function safeSettings(bookId) {
  try { return store.books.settings(bookId) || {}; } catch { return {}; }
}

/** 收集首三章全文与第4—10章首尾切片；摘要只是补充，不能代替正文。 */
export function collectSigningInput(bookId) {
  const base = collectOpeningInput(bookId);
  const completedIds = new Set(store.chapters.list(bookId).filter(isCompletedChapter).map(chapter => chapter.id));
  const chapters = base.chapters.filter(chapter => completedIds.has(chapter.id)).slice(0, 10);
  if (chapters.length < 3) {
    const error = new Error('至少完成前三章正文后才能运行开篇文本预审');
    error.code = 'SIGNING_REVIEW_NOT_READY';
    throw error;
  }
  const fullChapters = chapters.filter(chapter => chapter.idx <= 3)
    .map(({ idx, title, text }) => ({ idx, title, text }));
  const laterChapters = chapters.filter(chapter => chapter.idx >= 4).map(chapter => {
    const slices = openingSlices(chapter.text);
    return { idx: chapter.idx, title: chapter.title, summary: chapter.summary, head300: slices.head300, tail200: slices.tail200 };
  });
  const diagnosisStatus = openingDiagnosisStatus(bookId);
  const openingDiagnosis = diagnosisStatus.exists && !diagnosisStatus.stale ? diagnosisStatus.report : null;
  const opening_source_fingerprint = openingFingerprint(base.book, chapters);
  const source_fingerprint = hashJson({
    opening_source_fingerprint,
    promise_profile_fingerprint: base.promise_profile_fingerprint,
    diagnosis_source_fingerprint: openingDiagnosis?.source_fingerprint || '',
    diagnosis_created_at: openingDiagnosis?.created_at || 0,
  });
  return {
    ...base,
    chapters, fullChapters, laterChapters, openingDiagnosis,
    opening_source_fingerprint, source_fingerprint,
    evidence_basis: {
      chapter_count: chapters.length,
      full_text_chapters: fullChapters.map(chapter => chapter.idx),
      sliced_text_chapters: laterChapters.map(chapter => chapter.idx),
      diagnosis_included: Boolean(openingDiagnosis),
    },
  };
}

export function formatSigningInput(input) {
  const full = input.fullChapters.map(chapter =>
    `\n--- 第${chapter.idx}章《${chapter.title}》全文 ---\n${chapter.text}`
  ).join('\n');
  const later = input.laterChapters.map(chapter =>
    `\n--- 第${chapter.idx}章《${chapter.title}》切片 ---\n摘要：${chapter.summary || '（无）'}\n章首：${chapter.head300}\n章末：${chapter.tail200}`
  ).join('\n');
  return `${full}${later}`.trim();
}

function storedSigningReview(bookId) {
  const structured = safeSettings(bookId).signingReview;
  if (structured && typeof structured === 'object') return structured;
  return null;
}

/** 是否触发文本预审：番茄、前三章已完成，且没有与当前正文/画像匹配的成功报告。 */
export function signingDue(bookId) {
  try {
    const book = store.books.get(bookId);
    if (!book || book.platform !== '番茄') return false;
    const chapters = store.chapters.list(bookId).filter(isCompletedChapter);
    if (chapters.length < 3) return false;
    const input = collectSigningInput(bookId);
    const previous = storedSigningReview(bookId);
    return !previous
      || previous.version !== 2
      || previous.source_fingerprint !== input.source_fingerprint
      || previous.promise_profile_fingerprint !== input.promise_profile_fingerprint;
  } catch { return false; }
}

function hasPredictionField(value, path = '') {
  if (Array.isArray(value)) return value.some((item, index) => hasPredictionField(item, `${path}.${index}`));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    const next = path ? `${path}.${key}` : key;
    if (/metrics|expected.*(retention|follow|completion)|retention.*rate|follow.*rate|signing.*probab|推流概率|签约概率|预计.*率/i.test(next)) return true;
    return hasPredictionField(child, next);
  });
}

export function validateSigningReview(value, chapters) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文本预审结果不是 JSON 对象');
  if (hasPredictionField(value)) throw new Error('文本预审含伪造的平台概率或留存预测字段');
  if (!['pass', 'revise', 'reject'].includes(value.verdict)) throw new Error(`未知文本预审结论：${String(value.verdict || '空')}`);
  const score = Number(value.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('文本预审 score 必须在 0—100');
  if (!Array.isArray(value.issues)) throw new Error('文本预审 issues 必须是数组');
  if (!String(value.evidence_limits || '').trim() || !Array.isArray(value.observation_plan)) {
    throw new Error('文本预审缺少证据边界或发布后观察计划');
  }
  const byIdx = new Map(chapters.map(chapter => [Number(chapter.idx), String(chapter.text || '')]));
  const issues = value.issues.map((issue, index) => {
    const chapter = Number(issue?.chapter);
    const quote = String(issue?.quote || '').trim();
    if (!['high', 'medium', 'low'].includes(issue?.severity)) throw new Error(`issues[${index}] severity 无效`);
    if (!Number.isInteger(chapter) || !byIdx.has(chapter) || !quote || !byIdx.get(chapter).includes(quote)) {
      throw new Error(`issues[${index}] 缺少可在正文核对的章节与引文`);
    }
    if (!String(issue.issue || '').trim() || !String(issue.fix || '').trim()) throw new Error(`issues[${index}] 缺少问题或最小改法`);
    return { ...issue, chapter, quote };
  });
  return { ...structuredClone(value), score, issues };
}

function recordSigningFailure(bookId, error) {
  const settings = safeSettings(bookId);
  settings.signingReviewLastAttempt = { failed_at: Date.now(), error: error?.message || String(error) };
  store.books.update(bookId, { settings });
}

/** 发布前文本预审；失败保留旧报告并显式返回 unreviewed，data 可注入测试。 */
export async function simulateSigningReview(bookId, { signal, onEvent, data } = {}) {
  try {
    const book = store.books.get(bookId);
    if (!book) throw new Error('作品不存在');
    const input = collectSigningInput(bookId);
    const contract = store.materials.get(bookId, 'contract')?.content || '';
    const blueprint = store.materials.get(bookId, 'opening_blueprint')?.content || '';
    let raw = data;
    if (!raw) {
      const route = input.storyPromiseProfile?.texture?.route || 'general';
      const instruction = signingReviewInstruction({
        bookTitle: book.title, genre: book.genre, description: book.blurb || '', contract, blueprint,
        opening: formatSigningInput(input),
        openingDiagnosis: input.openingDiagnosis ? JSON.stringify(input.openingDiagnosis) : '',
        storyPromise: storyPromiseProfileText(input.storyPromiseProfile),
        platformGuidance: platformGuidanceText(book.platform),
        genreProfile: fanqieGenreProfileText(book.genre, route),
      });
      const messages = assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]);
      const res = await runTask({
        task: 'signing_review', bookId, messages, jsonMode: true, signal,
        routeOverride: { maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low' },
      });
      raw = extractJSON(res.content);
    }
    const review = validateSigningReview(raw, input.chapters);
    Object.assign(review, {
      version: 2,
      source_fingerprint: input.source_fingerprint,
      opening_source_fingerprint: input.opening_source_fingerprint,
      promise_profile_fingerprint: input.promise_profile_fingerprint,
      evidence_basis: input.evidence_basis,
      created_at: Date.now(),
    });
    const text = formatSigningReview(review);
    store.materials.set(bookId, 'signing_review', text);
    const settings = safeSettings(bookId);
    settings.signingReview = review;
    delete settings.signingReviewLastAttempt;
    store.books.update(bookId, { settings });
    onEvent?.({ type: 'signing_review', verdict: review.verdict, score: review.score, issues: review.issues.length, message: `开篇文本预审：${review.verdict === 'pass' ? '未发现阻断问题' : review.verdict === 'reject' ? '存在结构或事实硬伤' : '有证据问题待修'}（${review.score} 分）` });
    return { ok: true, review };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
    try { recordSigningFailure(bookId, error); } catch { /* 不覆盖旧报告 */ }
    onEvent?.({ type: 'signing_review', verdict: 'unreviewed', message: `开篇文本预审未完成：${error.message}` });
    return { ok: false, status: 'unreviewed', error: error.message };
  }
}

/** 评审结果 → 注入文本 */
export function formatSigningReview(review) {
  const lines = [`【开篇文本发布前预审】结论：${review.verdict}｜文本评分：${review.score ?? '?'}`];
  if (review.reason) lines.push(`总评：${review.reason}`);
  for (const i of (review.issues || []).slice(0, 10)) {
    lines.push(`- [${i.severity}/${i.type}] ${i.chapter ? `ch${i.chapter}：` : ''}${i.issue}${i.fix ? ` → ${i.fix}` : ''}`);
  }
  if (review.evidence_limits) lines.push(`证据边界：${review.evidence_limits}`);
  if (review.observation_plan?.length) lines.push(`发布后观察：${review.observation_plan.join('；')}`);
  return lines.join('\n');
}

/**
 * 自动开篇修订（签约未过时）：登记修订任务与约束，不删除任何已完成正文。
 * V0.91：自动评审没有销毁用户正文的授权。正文替换必须先生成完整候选稿、通过校验后
 * 再走独立的原子替换流程；当前自动流程只做非破坏性 staging。
 */
export async function rewriteOpening(bookId, { toChapter, feedback = '', signal, onEvent } = {}) {
  const chapters = store.chapters.list(bookId).filter(isCompletedChapter).sort((a, b) => a.idx - b.idx);
  const maxDone = chapters[chapters.length - 1]?.idx || 0;
  if (!toChapter || toChapter > maxDone) {
    return { ok: false, error: `只能重写到当前最大已完成章（ch${maxDone}），其后有已结算章节，拒绝重写` };
  }
  const brief = [
    `【开篇修订任务】范围：ch1..ch${toChapter}`,
    feedback || '按签约评审逐项改进；生成完整候选稿并校验通过前，不得替换现有正文。',
  ].join('\n');
  store.materials.set(bookId, 'signing_revision_brief', brief);
  try {
    store.constraints.add(bookId, {
      content: brief, source: 'polish', key: 'signing-opening-revision', scopeStart: 1, scopeEnd: toChapter,
    });
  } catch { /* 非关键派生项 */ }
  try {
    const settings = store.books.settings(bookId);
    settings.signingRevision = { status: 'pending', fromChapter: 1, toChapter, feedback, createdAt: Date.now() };
    store.books.update(bookId, { settings_json: JSON.stringify(settings) });
  } catch { /* 材料仍是事实源 */ }
  onEvent?.({ type: 'stage', stage: 'rewrite', message: `开篇修订建议已登记：ch1..ch${toChapter} 原稿保持不变` });
  return { ok: true, staged: true, rewrittenChapters: 0, targetChapters: toChapter };
}

/**
 * V0.85 通用章节重写：把 ch[fromIdx..toIdx] 打回 planned（清场景/历史/摘要/结算/健康 + facts 标 superseded）。
 * 用途：作者对已写章节不满意（写烂/偏离）时大胆重写——"不能因一粒老鼠屎坏了一锅粥"。
 * 与 rewriteOpening 的区别：守卫放宽——可重写中间任意范围（重写后由作者手动触发重写后续，或保留后续衔接）；
 * 始终先显式快照（可回滚）。默认不重生成卷纲/细纲（由作者按需触发"生成细纲/一键写本章"）。
 * @returns {{ok:boolean, rewritten:number, snapshot?:string, error?:string}}
 */
export function rewriteChapterRange(bookId, { fromIdx, toIdx, label = '章节重写' } = {}) {
  const from = Number(fromIdx) || 1;
  const to = Number(toIdx) || from;
  if (to < from) return { ok: false, error: '范围无效：toIdx 小于 fromIdx' };
  const book = store.books.get(bookId);
  if (!book) return { ok: false, error: '作品不存在' };
  const targets = store.chapters.list(bookId).filter(c => c.idx >= from && c.idx <= to);
  const changedCompleted = targets.filter(isCompletedChapter).map(ch => Number(ch.idx));
  const lastCompleted = store.chapters.list(bookId).filter(isCompletedChapter)
    .reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
  if (changedCompleted.length && to < lastCompleted) {
    return {
      ok: false,
      code: 'REWRITE_DOWNSTREAM_COMPLETED',
      error: `第${to + 1}—${lastCompleted}章已有完成正文；中间挖空会让旧剧情反压新稿，请把重写范围延伸到第${lastCompleted}章`,
      requiredToIdx: lastCompleted,
    };
  }
  // 显式快照（可回滚）
  const snap = store.snapshots.add(bookId, { label: `${label}前（ch${from}-ch${to}）`, source: 'manual', data: store.snapshotBook(bookId) });
  store.transaction(() => {
    for (const ch of targets) {
      const scs = store.scenes.list(ch.id);
      for (const s of scs) {
        try { if (s.history_seq) store.history.truncateFrom(bookId, s.history_seq, '章节重写'); } catch { /* ignore */ }
        store.scenes.remove(s.id);
      }
      try { store.summaries.remove(ch.id); } catch { /* ignore */ }
      try { store.chapterSettlements.remove(ch.id); } catch { /* ignore */ }
      try {
        const h = store.chapterHealth.getByChapter(ch.id);
        if (h) store.chapterHealth.update(h.id, { verdict: 'error', notes: JSON.stringify({ ...JSON.parse(h.notes || '{}'), rewritten: true }) });
      } catch { /* ignore */ }
      store.chapters.update(ch.id, { word_count: 0, outline: {} });
      transitionChapterStatus(bookId, ch.id, 'planned', { reason: '签约开篇重写重置' });
    }
    // facts：source_chapter 在范围内标 superseded
    try {
      for (const f of store.facts.list(bookId, { status: 'active' })) {
        if (f.source_chapter && f.source_chapter >= from && f.source_chapter <= to) store.facts.setStatus(f.id, 'superseded');
      }
    } catch { /* ignore */ }
    // 滚动摘要/时间线：重写后整体重置（防旧剧情污染；重写范围内的 timeline 清掉）
    try {
      store.rollingSummaries.set(bookId, '');
      const tl = store.timeline.list(bookId);
      for (const t of tl) {
        if (t.chapter_id) {
          const tc = store.chapters.get(t.chapter_id);
          if (tc && tc.idx >= from && tc.idx <= to) { try { store.timeline.remove(t.id); } catch { /* ignore */ } }
        }
      }
    } catch { /* ignore */ }
    if (changedCompleted.length) {
      markNarrativeStateStale(bookId, {
        fromChapter: Math.min(...changedCompleted),
        reason: `${label}已清除完成章正文，等待同版派生状态重建`,
        changedChapters: changedCompleted,
      });
    }
  });
  return {
    ok: true,
    rewritten: targets.length,
    snapshot: snap?.id,
    requiresStateRebuild: changedCompleted.length > 0,
  };
}
