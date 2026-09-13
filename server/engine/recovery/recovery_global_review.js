// 由 recommendation_recovery.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../../db/store.js';

import {
  QUALITY_LOSS_CODES,
} from './recovery_validation.js';
import {
  emitEvent,
  quoteLocated,
  recoveryError,
  requireArray,
  requireText,
  score,
} from './recovery_shared.js';
import {
  salvageGlobalReviewEvidence,
} from './recovery_rewrite.js';
import {
  candidateStatsByValidation,
  serializeCandidateAudits,
  setCandidateValidationState,
} from './recovery_checkpoint.js';

// V0.100.8 整段复核单次调用的输入体量上限（字符）。本作第 1—34 章候选合计 149,366 字，
// 按工程内 1.6 字/token 估算约 9.3 万输入 token，再叠加 mid_story_review 的 thinking enabled
// + reasoningEffort high + maxTokens 10000：一次调用超窗或被掐断会把整批候选判
// global_rejected 全部作废。分段后每段独立判定，后段带前段结论以保留跨段累积判断。
export const GLOBAL_REVIEW_SEGMENT_CHARS = 42000;

/** tune 里的事故词只有在明确否定语境中才允许保留；其余一律视为无证据造冲突。 */

/**
 * 按字符预算把候选整段切成连续分段：段内章号连续、不漏章、不重复；
 * 单章本身超过预算时自成分段（不得为了凑预算拆断一章或漏章）。
 */
export function planGlobalReviewSegments(chapters = [], { budgetChars = GLOBAL_REVIEW_SEGMENT_CHARS } = {}) {
  const list = [...(Array.isArray(chapters) ? chapters : [])]
    .sort((left, right) => Number(left?.idx) - Number(right?.idx));
  if (!list.length) return [];
  const budget = Math.max(1, Number(budgetChars) || GLOBAL_REVIEW_SEGMENT_CHARS);
  const segments = [];
  let current = [];
  let size = 0;
  for (const chapter of list) {
    const length = String(chapter?.text || '').length;
    if (current.length && size + length > budget) {
      segments.push(current);
      current = [];
      size = 0;
    }
    current.push(chapter);
    size += length;
  }
  if (current.length) segments.push(current);
  return segments;
}

export function validateGlobalReview(payload, chapters) {
  const verdict = String(payload?.verdict || '');
  if (!['pass', 'fail'].includes(verdict)) throw recoveryError('整段复核 verdict 必须是 pass 或 fail');
  if (typeof payload.sustained_progression !== 'boolean') throw recoveryError('整段复核必须判断 sustained_progression');
  const evidence = requireArray(payload.evidence, '整段复核 evidence').map(item => requireText(item, '整段复核 evidence'));
  if (!evidence.length) throw recoveryError('整段复核至少需要一条候选正文证据');
  const fullText = chapters.map(chapter => chapter.text).join('\n\n');
  const normalizedEvidence = [];
  const isolatedEvidence = [];
  for (const quote of evidence) {
    // V0.100.15：整段复核证据是展示性佐证，verdict 是主信号——模型偶会引用旧稿/相邻
    // 正文或长嵌套引文微差，单条定位失败只隔离该条并记录，不再整批 fail-closed 作废
 // （本作 run17 实证：10 章候选已通过盲审，仅因复核引文回指旧稿整批报废）。
    const located = salvageGlobalReviewEvidence(fullText, quote);
    if (located) normalizedEvidence.push(located);
    else isolatedEvidence.push(quote);
  }
  if (!normalizedEvidence.length) {
    throw recoveryError('整段复核证据均无法在候选正文定位');
  }
  return {
    verdict,
    sustained_progression: payload.sustained_progression,
    evidence: normalizedEvidence,
    reason: requireText(payload.reason, '整段复核 reason'),
    residual_risks: requireArray(payload.residual_risks, '整段复核 residual_risks').map(String),
    isolated_evidence: isolatedEvidence,
  };
}

export function validateCrossSegmentReview(payload, chapters) {
  const review = validateGlobalReview(payload, chapters);
  if (typeof payload?.segment_consistency !== 'boolean') {
    throw recoveryError('跨段总复核必须判断 segment_consistency');
  }
  return { ...review, segment_consistency: payload.segment_consistency };
}

export function diagnosisWorkOrders(curve) {
  return curve.filter(item => item.action !== 'keep').map(item => ({
    chapter: item.chapter,
    action: item.action,
    objective: item.rebuild_objective,
    evidence: item.evidence,
    reason: item.reason,
    old_score: item.score,
    prior: item.prior,
  }));
}

/**
 * V0.100.6：上轮整段复核 fail 的总审结论（诊断上下文与指纹的共用输入，单源防两套写法）——
 * 零散微调救不了停滞区间，诊断需要知道"整批为什么被否"才能把工单升级为 arc 级 rebuild；
 * 结论进入指纹意味着：出现新的整段否决结论时自动触发全新诊断，结论不变仍可复用。
 */
export function priorGlobalReviewFailure(bookId, start, end) {
  const priorFailureRun = store.recommendationRecoveryRuns.list(bookId).find(candidate =>
    candidate.result?.globalReview?.verdict === 'fail'
    && Number(candidate.start_chapter) === start && Number(candidate.end_chapter) === end);
  return priorFailureRun?.result?.globalReview?.reason
    ? `结论：${String(priorFailureRun.result.globalReview.reason).slice(0, 800)}`
    : '';
}

/**
 * V0.100.15 单章 rebuild 连败史回流（诊断上下文与指纹的共用输入）：
 * 同一章在既往运行中按 rebuild 执行且被质量性拒绝 ≥2 轮，说明“重写打不过旧稿”
 * 已被反复证明（flash 重构对人工精修旧稿的实证）——诊断必须知道这个执行史，
 * 否则会按“停滞→rebuild”的机械映射反复开出注定败选的处方。回流只提示
 * “慎再开 rebuild、优先跨章合并 tune 或保留”，不替诊断做决定。
 */

/**
 * V0.100.15 单章 rebuild 连败史回流（诊断上下文与指纹的共用输入）：
 * 同一章在既往运行中按 rebuild 执行且被质量性拒绝 ≥2 轮，说明“重写打不过旧稿”
 * 已被反复证明（flash 重构对人工精修旧稿的实证）——诊断必须知道这个执行史，
 * 否则会按“停滞→rebuild”的机械映射反复开出注定败选的处方。回流只提示
 * “慎再开 rebuild、优先跨章合并 tune 或保留”，不替诊断做决定。
 */
export function repeatedRebuildLossContext(bookId, threshold = 2) {
  const lossCount = new Map();
  const countLoss = (chapterIdx) => {
    if (!Number.isInteger(chapterIdx)) return;
    lossCount.set(chapterIdx, (lossCount.get(chapterIdx) || 0) + 1);
  };
  for (const run of store.recommendationRecoveryRuns.list(bookId)) {
    const audits = Array.isArray(run.result?.candidates) ? run.result.candidates : [];
    for (const item of audits) {
      if (String(item?.order?.action || '') !== 'rebuild') continue;
      if (!QUALITY_LOSS_CODES.has(String(item?.rejection?.code || ''))) continue;
      countLoss(Number(item.chapter?.idx ?? item.chapter));
    }
    // V0.100.15：failRun 终态把拒收审计稳定落在 rejected_chapters_json，与降级统计同源。
    const rejectedRows = (() => { try { return JSON.parse(run.rejected_chapters_json || '[]'); } catch { return []; } })();
    for (const item of rejectedRows) {
      if (!QUALITY_LOSS_CODES.has(String(item.code || ''))) continue;
      countLoss(Number(item.chapter));
    }
  }
  const repeated = [...lossCount.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([chapter]) => chapter)
    .sort((left, right) => left - right);
  if (!repeated.length) return '';
  return `以下章节（第${repeated.join('、')}章）已按“重构”工单执行多轮，候选均未在盲审中证明优于现有旧稿——旧稿本身质量可能已达标，或该问题需跨章合并整改而单章重构解决不了。除非有新的强证据，本轮诊断慎再给这些章开 rebuild；优先给跨章合并压缩的 tune，或判定 keep 保留。`;
}

/** V0.100.15 单章 rebuild 连败轮数（本地确定性判定，用于编译层硬性降级）。
 *  统计源：rejected_chapters_json（failRun 终态稳定落库）+ result.candidates 审计。 */

/** V0.100.15 单章 rebuild 连败轮数（本地确定性判定，用于编译层硬性降级）。
 *  统计源：rejected_chapters_json（failRun 终态稳定落库）+ result.candidates 审计。 */
export function repeatedRebuildLossChapterCount(chapterIdx, bookId = '') {
  if (!bookId) return 0;
  let count = 0;
  for (const run of store.recommendationRecoveryRuns.list(bookId)) {
    const audits = Array.isArray(run.result?.candidates) ? run.result.candidates : [];
    for (const item of audits) {
      if (Number(item.chapter?.idx ?? item.chapter) !== Number(chapterIdx)) continue;
      if (String(item?.order?.action || '') !== 'rebuild') continue;
      if (!QUALITY_LOSS_CODES.has(String(item?.rejection?.code || ''))) continue;
      count++;
    }
    const rejectedRows = Array.isArray(run.rejected_chapters_json)
      ? run.rejected_chapters_json
      : (() => { try { return JSON.parse(run.rejected_chapters_json || '[]'); } catch { return []; } })();
    for (const item of rejectedRows) {
      if (Number(item.chapter) !== Number(chapterIdx)) continue;
      if (!QUALITY_LOSS_CODES.has(String(item.code || ''))) continue;
      count++;
    }
  }
  return count;
}

export function recoveryRetryHandler(onEvent, context = {}) {
  return (info = {}) => emitEvent(onEvent, 'recovery_retry', {
    ...context,
    attempt: Math.max(1, Number(info.attempt) || 1),
    reason: String(info.reason || 'NETWORK_ERROR'),
    message: String(info.message || '模型连接不稳定'),
    timeoutExtended: info.timeoutExtended === true,
    nextConnectTimeoutMs: Number(info.nextConnectTimeoutMs) || null,
    streamFallback: info.streamFallback === true,
    waitMs: Number(info.waitMs) || null,
  });
}

/**
 * 只有同时满足三层证据的整改，才会成为后续创作经验：
 * 1) 原诊断能在旧稿定位；2) 新稿双向盲审明确胜出；3) 整段推进复核通过。
 * 经验只携带“下一阶段该做到什么”，不把旧稿坏句重新塞进创作提示。
 */
export function activateRecoveryLessons(bookId, run, candidates, globalReview, narrativeRevision) {
  const curveByChapter = new Map((run.quality_curve || [])
    .map(item => [Number(item.chapter), item]));
  const scopeStart = Number(run.end_chapter) + 1;
  const scopeEnd = scopeStart + 19;
  const lessons = [];

  for (const candidate of candidates) {
    const chapterIdx = Number(candidate.chapter.idx);
    const curve = curveByChapter.get(chapterIdx) || {};
    const evidence = [...(candidate.order?.evidence || []), ...(curve.evidence || [])]
      .map(String)
      .filter((quote, index, all) => quote.length >= 4
        && all.indexOf(quote) === index
        && quoteLocated(candidate.before, quote));
    const positiveTarget = String(candidate.order?.objective || curve.rebuild_objective || '').trim();
    if (!evidence.length || !positiveTarget) continue;

    const problem = String(curve.reason
      || (curve.filler_signals || []).join('；')
      || `第${chapterIdx}章未达到推荐质量要求`).trim();
    const margins = (candidate.comparisons || [])
      .map(comparison => Number(comparison.margin))
      .filter(Number.isFinite);
    const averageMargin = margins.length
      ? margins.reduce((sum, margin) => sum + margin, 0) / margins.length
      : 0;
    const digest = createHash('sha256')
      .update(`${problem}\n${positiveTarget}`)
      .digest('hex')
      .slice(0, 16);
    const lesson = store.narrativeLessons.upsert(bookId, {
      key: `recommendation:${digest}`,
      source: 'recommendation_recovery',
      status: 'active',
      problem,
      positiveTarget,
      evidence: evidence.map(quote => ({ chapter: chapterIdx, quote })),
      scopeStart,
      scopeEnd,
      confidence: Math.min(0.95, 0.75 + Math.max(0, averageMargin) / 200),
      outcome: {
        run_id: run.id,
        revision_id: narrativeRevision.revisionId,
        validation: 'bidirectional_blind_review_and_global_pass',
        global_evidence: globalReview.evidence,
      },
    });
    lessons.push(lesson);
  }
  return lessons;
}

/**
 * V0.100.12：检查点写入必须与既有存档合并，绝不能整体覆盖——中断重跑时本轮审计只有
 * 寥寥几条，直接覆盖会把上一轮两小时攒下的已验证候选全部销毁（用户实证损失 8 章）。
 * 规则：上一轮所有审计状态都保留（accepted/rejected/frozen 等），本轮同章审计覆盖旧条目。
 * 只保留 accepted 会在“续跑后再次中断”时抹掉尚未重新处理到的拒绝/冻结账本，导致重复烧费。
 */

/**
 * V0.100.12：检查点写入必须与既有存档合并，绝不能整体覆盖——中断重跑时本轮审计只有
 * 寥寥几条，直接覆盖会把上一轮两小时攒下的已验证候选全部销毁（用户实证损失 8 章）。
 * 规则：上一轮所有审计状态都保留（accepted/rejected/frozen 等），本轮同章审计覆盖旧条目。
 * 只保留 accepted 会在“续跑后再次中断”时抹掉尚未重新处理到的拒绝/冻结账本，导致重复烧费。
 */
export function mergeCandidateAudits(previous = [], current = []) {
  const merged = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    merged.set(Number(item?.chapter?.idx ?? item?.chapter), item);
  }
  for (const item of Array.isArray(current) ? current : []) {
    merged.set(Number(item?.chapter?.idx ?? item?.chapter), item);
  }
  return [...merged.values()].sort((left, right) => Number(left.chapter) - Number(right.chapter));
}

export function failRun(bookId, runId, { globalReview = null, rejected = [], reason, candidates = [] }) {
  const existing = store.recommendationRecoveryRuns.get(runId);
  const prior = existing?.result || {};
  if (globalReview?.verdict === 'fail') {
    for (const candidate of candidates) {
      if (candidate?.status === 'accepted') setCandidateValidationState(candidate, 'global_rejected', runId);
    }
  }
  const serializedCandidates = mergeCandidateAudits(
    prior.candidates,
    serializeCandidateAudits(candidates, { checkpointRunId: runId }),
  );
  const unresolvedChapters = [...new Set((existing?.work_orders || []).map(order => Number(order.chapter)))]
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  const { failure_code: _priorFailureCode, ...stablePrior } = prior;
  const result = {
    // 失败审计是在既有诊断/执行状态上追加终态，不是另造一份结果。先保留全范围
    // repair_plan、诊断指纹和批次检查点，再覆盖本次执行结果；否则一次网络错误就会
    // 把已经付费生成的整体计划抹掉，驾驶舱也会误判为不可继续。
    ...stablePrior,
    applied: [], rejected, globalReview,
    completion: globalReview?.verdict === 'fail' ? 'global_rejected' : 'failed',
    unresolvedChapters,
    candidateStatsByValidation: candidateStatsByValidation(serializedCandidates),
    // 候选仍与正文表隔离，但保留完整审计证据，避免“失败后候选凭空消失”或再次烧模型费用。
    candidates: serializedCandidates,
  };
  store.recommendationRecoveryRuns.update(runId, {
    status: 'failed', rejectedChapters: rejected, result, error: reason,
  });
  store.publicationProfiles.upsert(bookId, { recoveryStatus: 'failed' });
  return result;
}
