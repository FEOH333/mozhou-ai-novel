// 由 recommendation_recovery.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../../db/store.js';
import { isCompletedChapter } from '../pipeline/chapter_status.js';
import { buildPublicationFeedbackContext } from '../quality/publication_feedback.js';
import {
  RECOVERY_CONTRACT_VERSION,
  RECOVERY_PLAN_CONTRACT_VERSION,
  candidateValidationStats,
  hasCompleteCandidateProvenance,
  normalizeCandidateProvenance,
  normalizeRecoveryPolicy,
  recoveryFailureLedgerKey,
  recoveryWorkOrderFingerprint,
  resolveRecoveryPolicy,
  RECOVERY_WINDOW_LENGTH_RATIOS,
} from './recovery_contract.js';

import {
  recoveryError,
} from './recovery_shared.js';
import {
  diagnosisWorkOrders,
  priorGlobalReviewFailure,
} from './recovery_global_review.js';

export function completedScope(bookId, startChapter, endChapter) {
  const chapters = store.chapters.list(bookId)
    .filter(chapter => chapter.idx >= startChapter && chapter.idx <= endChapter)
    .filter(isCompletedChapter)
    .map(chapter => ({ ...chapter, text: store.chapters.fullText(chapter.id) }));
  if (!chapters.length) throw recoveryError('返工范围内没有已完成正文');
  return chapters;
}

export function diagnosisFingerprint({ book, chapters, feedback, suspectedTurnChapter }) {
  return createHash('sha256').update(JSON.stringify({
    contract: 'recommendation-diagnosis-v1007.1',
    book: { id: book.id, title: book.title },
    suspectedTurnChapter,
    feedback,
    chapters: chapters.map(chapter => ({ idx: chapter.idx, title: chapter.title, text: chapter.text })),
  })).digest('hex');
}

export function wholeRangePlanRequired(run, workOrders = run?.work_orders || []) {
  return Array.isArray(workOrders) && workOrders.length > 0
    && Math.max(
      Array.isArray(run?.quality_curve) ? run.quality_curve.length : 0,
      Number(run?.end_chapter) - Number(run?.start_chapter) + 1,
    ) > 5;
}

export function hasCurrentRecoveryPlan(run, workOrders = run?.work_orders || []) {
  if (!wholeRangePlanRequired(run, workOrders)) return true;
  return Boolean(run?.result?.repair_plan)
    && run.result.repair_plan_contract_version === RECOVERY_PLAN_CONTRACT_VERSION;
}

export function staleRecoveryPlan(run, workOrders = run?.work_orders || []) {
  return wholeRangePlanRequired(run, workOrders) && !hasCurrentRecoveryPlan(run, workOrders);
}

/**
 * 尚未产生任何可复用诊断事实的零批次前缀。它可以安全绑定当前输入后从第一章重启：
 * 没有质量曲线、工单、候选或综合计划可被误当成旧结论沿用。
 */

/**
 * 尚未产生任何可复用诊断事实的零批次前缀。它可以安全绑定当前输入后从第一章重启：
 * 没有质量曲线、工单、候选或综合计划可被误当成旧结论沿用。
 */
export function emptyDiagnosisCheckpoint(candidate) {
  const result = candidate?.result || {};
  const curve = Array.isArray(candidate?.quality_curve) ? candidate.quality_curve : [];
  const workOrders = Array.isArray(candidate?.work_orders) ? candidate.work_orders : [];
  const verdicts = Array.isArray(result.segment_verdicts) ? result.segment_verdicts : [];
  const candidateCount = Array.isArray(result.candidates)
    ? result.candidates.length
    : Math.max(0, Number(candidate?.candidateStats?.total) || 0);
  return curve.length === 0
    && workOrders.length === 0
    && verdicts.length === 0
    && candidateCount === 0
    && !result.repair_plan
    && (result.completed_batches == null || Number(result.completed_batches) === 0)
    && (result.completed_through == null || result.completed_through === '');
}

export function resumableDiagnosisRun(bookId, start, end, chapters, fingerprint, batchSize) {
  return store.recommendationRecoveryRuns.list(bookId).find((candidate) => {
    const storedFingerprint = candidate.result?.diagnosis_fingerprint;
    const canBindCurrentInput = !storedFingerprint && emptyDiagnosisCheckpoint(candidate);
    const resumableStatus = ['failed', 'cancelled'].includes(candidate.status)
      || (candidate.status === 'planned' && staleRecoveryPlan(candidate));
    if (!resumableStatus
      || Number(candidate.start_chapter) !== start
      || Number(candidate.end_chapter) !== end
      || (storedFingerprint !== fingerprint && !canBindCurrentInput)) return false;
    // 只恢复已经完整验证并原子写入的整批前缀；半批、乱序或已覆盖全部范围的异常记录不复用。
    return diagnosisCheckpointShapeOk(candidate, chapters, batchSize);
  }) || null;
}

/**
 * V0.100.1：已完成全部批次诊断的运行（planned 待执行 / failed 执行或收尾失败），同范围同指纹时
 * 直接沿用诊断结论——重新诊断等于为同一份结论再烧一遍费用，是用户实证的"又从零开始"事故。
 */

/**
 * V0.100.1：已完成全部批次诊断的运行（planned 待执行 / failed 执行或收尾失败），同范围同指纹时
 * 直接沿用诊断结论——重新诊断等于为同一份结论再烧一遍费用，是用户实证的"又从零开始"事故。
 */
export function fullyDiagnosedRun(bookId, start, end, chapters, fingerprint) {
  return store.recommendationRecoveryRuns.list(bookId).find((candidate) => {
    if (!['failed', 'cancelled', 'planned'].includes(candidate.status)
      || Number(candidate.start_chapter) !== start
      || Number(candidate.end_chapter) !== end
      || candidate.result?.diagnosis_fingerprint !== fingerprint) return false;
    const curve = Array.isArray(candidate.quality_curve) ? candidate.quality_curve : [];
    if (curve.length !== chapters.length) return false;
    if (!curve.every((item, index) => Number(item.chapter) === Number(chapters[index]?.idx))) return false;
    const needsSynthesis = chapters.length > 5 && diagnosisWorkOrders(curve).length > 0;
    return !needsSynthesis || hasCurrentRecoveryPlan(candidate);
  }) || null;
}

/** 诊断批次检查点形态校验：只认零前缀或按批次对齐的连续前缀；半批、乱序不可续。 */

/** 诊断批次检查点形态校验：只认零前缀或按批次对齐的连续前缀；半批、乱序不可续。 */
export function diagnosisCheckpointShapeOk(candidate, chapters, batchSize) {
  const curve = Array.isArray(candidate.quality_curve) ? candidate.quality_curve : [];
  const verdicts = Array.isArray(candidate.result?.segment_verdicts) ? candidate.result.segment_verdicts : [];
  if (!curve.length) return emptyDiagnosisCheckpoint(candidate);
  if (curve.length > chapters.length) return false;
  if (curve.length < chapters.length && curve.length % batchSize !== 0) return false;
  if (verdicts.length !== Math.ceil(curve.length / batchSize)) return false;
  return curve.every((item, index) => Number(item.chapter) === Number(chapters[index]?.idx));
}

/**
 * V0.100.1：为驾驶舱运行列表标注可续性（前端弹窗"选择要沿用的进度"的数据源）。
 * execute=工单在手可直接执行；diagnose=诊断中道失败、指纹一致可断点续跑；
 * stale=正文/反馈已变化不能沿用；none=进行中或已完成无可续内容。
 * 指纹按 (start,end) 范围缓存，整份列表至多每范围重算一次。
 */

/**
 * V0.100.1：为驾驶舱运行列表标注可续性（前端弹窗"选择要沿用的进度"的数据源）。
 * execute=工单在手可直接执行；diagnose=诊断中道失败、指纹一致可断点续跑；
 * stale=正文/反馈已变化不能沿用；none=进行中或已完成无可续内容。
 * 指纹按 (start,end) 范围缓存，整份列表至多每范围重算一次。
 */
export function annotateRecoveryRunsResumability(bookId, runs) {
  if (!Array.isArray(runs) || !runs.length) return runs;
  const book = store.books.get(bookId);
  if (!book) return runs;
  const profile = store.publicationProfiles.get(bookId);
  const suspectedTurnChapter = profile?.suspected_turn_chapter || 7;
  const feedback = buildPublicationFeedbackContext(bookId);
  const fingerprintCache = new Map();
  const scopeFingerprint = (start, end) => {
    const key = `${start}:${end}`;
    if (!fingerprintCache.has(key)) {
      let value = null;
      try {
        const chapters = completedScope(bookId, start, end);
        // 与诊断侧同一真源：总审否决结论参与指纹，保证"可续性"判定与幂等复用同口径
        // （rebuild 连败史只注入指令文本，不进指纹，见诊断入口注释）。
        const priorGlobalFailure = priorGlobalReviewFailure(bookId, start, end);
        value = diagnosisFingerprint({
          book, chapters,
          feedback: priorGlobalFailure ? `${feedback}\n${priorGlobalFailure}` : feedback,
          suspectedTurnChapter,
        });
      } catch { value = null; }
      fingerprintCache.set(key, value);
    }
    return fingerprintCache.get(key);
  };
  return runs.map((run) => {
    const workOrders = Array.isArray(run.work_orders) ? run.work_orders : [];
    const curve = Array.isArray(run.quality_curve) ? run.quality_curve : [];
    // 验证层级由 recovery_contract 单一判定；驾驶舱传来的 candidateStats 只是同一口径的缓存，
    // 直接传 store 原始行时也必须得到同样的数字，不能静默退化成全 0。
    const stats = candidateValidationStats(
      Array.isArray(run.result?.candidates) ? run.result.candidates : [],
    );
    const localPassed = Number(run.candidateStats?.localPassed) || Number(stats.local_passed) || 0;
    const globalPassed = Number(run.candidateStats?.globalPassed) || Number(stats.global_passed) || 0;
    const legacyUntrusted = Number(run.candidateStats?.legacyUntrusted) || Number(stats.legacy_untrusted) || 0;
    const resumableCandidates = localPassed + globalPassed;
    const base = {
      ...run,
      acceptedCandidates: resumableCandidates,
      localPassedCandidates: localPassed,
      globalPassedCandidates: globalPassed,
      untrustedCandidates: legacyUntrusted,
      resumeKind: 'none',
      resumeDetail: '',
    };
    if (['diagnosing', 'rewriting', 'verifying'].includes(run.status)) return base;
    const resumableState = ['failed', 'cancelled'].includes(run.status);
    const storedFingerprint = run.result?.diagnosis_fingerprint;
    let currentFingerprint = null;
    let fingerprintFresh = false;
    if (isCurrentDiagnosisFingerprint(storedFingerprint)
      && ['planned', 'failed', 'cancelled'].includes(run.status)) {
      currentFingerprint = scopeFingerprint(Number(run.start_chapter), Number(run.end_chapter));
      fingerprintFresh = Boolean(currentFingerprint) && storedFingerprint === currentFingerprint;
      if (!fingerprintFresh) {
        return {
          ...base,
          resumeKind: 'stale',
          resumeDetail: '正文或平台反馈已变化，该进度不能沿用',
        };
      }
    }
    // 首批模型调用/校验失败时虽然没有可复用批次，但也不应让运行从选择框消失。
    // 新运行已有指纹时先过上面的新鲜度闸；升级前无指纹的空运行没有旧事实可污染，
    // 明确选择后可安全绑定当前输入并从第一章重新开始。
    if (resumableState && emptyDiagnosisCheckpoint(run)) {
      return {
        ...base,
        resumeKind: 'diagnose',
        diagnosedThrough: null,
        resumeDetail: '尚无已验证批次，可在同一运行中从第 1 章重新开始',
      };
    }
    const planRequired = wholeRangePlanRequired(run, workOrders);
    if (planRequired && !hasCurrentRecoveryPlan(run, workOrders)) {
      // 旧计划可能缺失，也可能来自会把未来事实注入早章、允许 tune 随机造事故的旧合同。
      // 已验证逐章取证仍然有效：只回到一次全范围综合规划，不重跑前面的昂贵批次。
      const planCanResume = ['planned', 'failed', 'cancelled'].includes(run.status);
      if (planCanResume && curve.length && fingerprintFresh) {
        const diagnosedThrough = curve.at(-1)?.chapter ?? null;
        const diagnosisComplete = Number(diagnosedThrough) >= Number(run.end_chapter);
        return {
          ...base,
          resumeKind: 'diagnose',
          diagnosedThrough,
          resumeDetail: diagnosisComplete
            ? `逐章取证已完成，只需按 ${RECOVERY_PLAN_CONTRACT_VERSION} 重做一次全范围综合规划`
            : `已诊断到第 ${diagnosedThrough} 章；旧工单缺少完整计划，将从诊断检查点继续`,
        };
      }
      return {
        ...base,
        resumeKind: 'stale',
        resumeDetail: '旧版全范围计划已失效，不能继续执行；请沿用逐章取证并重做综合规划',
      };
    }
    if (workOrders.length && ['planned', 'failed', 'cancelled'].includes(run.status)) {
      const tune = workOrders.filter(order => order.action === 'tune').length;
      return {
        ...base, resumeKind: 'execute',
        resumeDetail: `工单 ${workOrders.length} 章（微调 ${tune} / 重构 ${workOrders.length - tune}）${localPassed ? ` · 本运行局部通过检查点 ${localPassed} 章` : ''}${globalPassed ? ` · 整段已通过候选 ${globalPassed} 章` : ''}${legacyUntrusted ? ` · 旧版无来源候选 ${legacyUntrusted} 章（已隔离，需重生）` : ''}`,
      };
    }
    if (['failed', 'cancelled'].includes(run.status) && curve.length) {
      const fresh = fingerprintFresh;
      return {
        ...base,
        resumeKind: fresh ? 'diagnose' : 'stale',
        diagnosedThrough: curve.at(-1)?.chapter ?? null,
        resumeDetail: fresh
          ? `已诊断到第 ${curve.at(-1)?.chapter} 章，可从断点续跑`
          : '正文或平台反馈已变化，该进度不能沿用',
      };
    }
    return base;
  });
}

export function candidateTextHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

export const GLOBAL_REVIEW_CHECKPOINT_CONTRACT = `${RECOVERY_CONTRACT_VERSION}:global-review-checkpoint-v1`;

export function globalReviewCheckpointFingerprint({
  bookTitle = '', prospective = [], qualityCurve = [], repairPlan = null, reviewSegments = [],
} = {}) {
  return createHash('sha256').update(JSON.stringify({
    contract: GLOBAL_REVIEW_CHECKPOINT_CONTRACT,
    bookTitle,
    chapters: prospective.map(chapter => ({
      idx: Number(chapter?.idx), title: String(chapter?.title || ''), text: String(chapter?.text || ''),
    })),
    qualityCurve,
    repairPlan,
    segmentBoundaries: reviewSegments.map(segment => ({
      from: Number(segment?.[0]?.idx),
      to: Number(segment?.at(-1)?.idx),
      chapters: segment.map(chapter => Number(chapter?.idx)),
    })),
  })).digest('hex');
}

export function resumableGlobalReviewCheckpoint(checkpoint, fingerprint, reviewSegments) {
  if (!checkpoint || typeof checkpoint !== 'object') return { segments: [], crossReview: null };
  if (String(checkpoint.contract || '') !== GLOBAL_REVIEW_CHECKPOINT_CONTRACT) {
    return { segments: [], crossReview: null };
  }
  if (String(checkpoint.fingerprint || '') !== String(fingerprint || '')) {
    return { segments: [], crossReview: null };
  }
  if (Number(checkpoint.total_segments) !== reviewSegments.length) {
    return { segments: [], crossReview: null };
  }
  const saved = Array.isArray(checkpoint.segments) ? checkpoint.segments : [];
  if (saved.length > reviewSegments.length
    || Number(checkpoint.completed_segments) !== saved.length) {
    return { segments: [], crossReview: null };
  }
  for (let index = 0; index < saved.length; index++) {
    const verdict = saved[index];
    const expected = reviewSegments[index];
    if (Number(verdict?.segment) !== index + 1
      || Number(verdict?.from) !== Number(expected?.[0]?.idx)
      || Number(verdict?.to) !== Number(expected?.at(-1)?.idx)
      || verdict?.verdict !== 'pass'
      || verdict?.sustained_progression !== true
      || !Array.isArray(verdict?.evidence)
      || !Array.isArray(verdict?.residual_risks)
      || !String(verdict?.reason || '').trim()) {
      return { segments: [], crossReview: null };
    }
  }
  const rawCrossReview = checkpoint.cross_review;
  const crossReview = saved.length === reviewSegments.length
    && rawCrossReview?.verdict === 'pass'
    && rawCrossReview?.sustained_progression === true
    && rawCrossReview?.segment_consistency === true
    && Array.isArray(rawCrossReview?.evidence)
    && Array.isArray(rawCrossReview?.residual_risks)
    && String(rawCrossReview?.reason || '').trim()
    ? rawCrossReview
    : null;
  return { segments: saved.map(item => ({ ...item })), crossReview };
}

export function passedGlobalReviewFromSegments(segmentVerdicts) {
  if (!segmentVerdicts.length) return null;
  return {
    verdict: 'pass',
    sustained_progression: true,
    evidence: segmentVerdicts.flatMap(item => item.evidence || []),
    reason: segmentVerdicts.map(item => item.reason).filter(Boolean).join('；'),
    residual_risks: segmentVerdicts.flatMap(item => item.residual_risks || []),
    segments: segmentVerdicts.map(item => ({ ...item })),
  };
}

export function candidateNeighborFingerprint(continuityMap, chapterIdx) {
  return createHash('sha256').update(JSON.stringify({
    previous: continuityMap.get(Number(chapterIdx) - 1)?.text || '',
    next: continuityMap.get(Number(chapterIdx) + 1)?.text || '',
  })).digest('hex');
}

export function isCurrentDiagnosisFingerprint(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

export function setCandidateValidationState(candidate, validationState, checkpointRunId = '') {
  if (!candidate) return candidate;
  candidate.provenance = normalizeCandidateProvenance({
    ...(candidate.provenance || {}),
    validationState,
  }, { checkpointRunId });
  return candidate;
}

export function serializeCandidateAudits(candidates = [], { checkpointRunId = '', validationState = '' } = {}) {
  return candidates.map(item => ({
    chapter: item.chapter.idx, chapterId: item.chapter.id, title: item.chapter.title,
    before: item.before, after: item.after, order: item.order,
    status: item.status || 'generated', rejection: item.rejection || null,
    safety: item.safety, prose: item.prose, patch: item.patch || null,
    comparisons: item.comparisons || [],
    provenance: normalizeCandidateProvenance({
      ...(item.provenance || {}),
      ...(validationState ? { validationState } : {}),
    }, { checkpointRunId }),
  }));
}

export function candidateStatsByValidation(candidates = []) {
  const stats = {};
  for (const candidate of candidates) {
    const state = normalizeCandidateProvenance(candidate?.provenance || {}).validationState;
    stats[state] = (stats[state] || 0) + 1;
  }
  return stats;
}
