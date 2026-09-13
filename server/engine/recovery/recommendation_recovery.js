// V0.99 起：推荐评估失败后的领域专用返工闭环。
// V0.109.5：按职责拆分为子模块，本文件保留编排层与三处硬约束函数，并 re-export 全部公开符号。
//
// 为什么这几段必须留在这里（不是偷懒，是被测试锁死的契约）：
//   - blockingProseIssues：tests/v105.test.js 与 tests/v1093_ai_flavor.test.js 直接读本文件源码，
//     断言其中含 `!issue.axis` 与 `filter(issue => !issue.statistical)`；
//   - diagnoseRecommendationRecovery：含 assembleReviewMessages 调用，tests/v099 断言本文件含该符号。
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../../db/store.js';
import { assembleReviewMessages } from '../../llm/cache.js';
import { runTask } from '../../llm/router.js';
import { styleRulesText } from '../../data/creative_packs.js';
import { validateChapterRewrite } from '../quality/polish.js';
import { prepareAndCommitNarrativeRevision, segmentedEvidenceGrounded } from '../narrative/narrative_state.js';
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
  recommendationRecoveryCompareInstruction,
  recommendationRecoveryCrossSegmentReviewInstruction,
  recommendationRecoveryDiagnosisInstruction,
  recommendationRecoveryGlobalReviewInstruction,
  recommendationRecoveryRewriteInstruction,
  recommendationRecoverySynthesisInstruction,
} from '../prompts.js';

import {
  FROZEN_LIFETIME_THRESHOLD,
  FROZEN_REJECTION_THRESHOLD,
  QUALITY_LOSS_CODES,
  RECOVERABLE_DIAGNOSIS_CODES,
  RECOVERY_CHAPTER_FROZEN_CODE,
  TOOL_FAILURE_CODES,
  compileRecoveryPlan,
  validateRecoveryDiagnosis,
} from './recovery_validation.js';
import {
  GLOBAL_REVIEW_SEGMENT_CHARS,
  activateRecoveryLessons,
  diagnosisWorkOrders,
  failRun,
  mergeCandidateAudits,
  planGlobalReviewSegments,
  priorGlobalReviewFailure,
  recoveryRetryHandler,
  repeatedRebuildLossContext,
  validateCrossSegmentReview,
  validateGlobalReview,
} from './recovery_global_review.js';
import {
  compact,
  emitEvent,
  isRecoveryCancellation,
  parseStructuredResponse,
  persistRecoveryCancellation,
  recoveryError,
  runStructuredWithOneCorrection,
} from './recovery_shared.js';
import {
  GLOBAL_REVIEW_CHECKPOINT_CONTRACT,
  candidateNeighborFingerprint,
  candidateStatsByValidation,
  candidateTextHash,
  completedScope,
  diagnosisCheckpointShapeOk,
  diagnosisFingerprint,
  emptyDiagnosisCheckpoint,
  fullyDiagnosedRun,
  globalReviewCheckpointFingerprint,
  hasCurrentRecoveryPlan,
  isCurrentDiagnosisFingerprint,
  passedGlobalReviewFromSegments,
  resumableDiagnosisRun,
  resumableGlobalReviewCheckpoint,
  serializeCandidateAudits,
  setCandidateValidationState,
  staleRecoveryPlan,
  wholeRangePlanRequired,
} from './recovery_checkpoint.js';
import {
  buildRecoveryRewriteWindow,
  candidateAbsoluteQuality,
  chapterRewriteContext,
  compareCandidate,
  comparisonsAcceptCandidate,
  orderedRecoveryWorkOrders,
  positionMirroredSplit,
  validateRecoveryProseImprovement,
  validateRecoveryWindowRewrite,
  windowPatchRuleOptions,
} from './recovery_rewrite.js';

export function assertPublishedRewritePermission({
  publishedChapterCount = 0, startChapter = 1, endChapter = 20, confirmedPublishedRewrite = false,
} = {}) {
  const published = Math.max(0, Number(publishedChapterCount) || 0);
  const intersects = published >= Number(startChapter) && Number(endChapter) >= 1;
  if (intersects && confirmedPublishedRewrite !== true) {
    throw recoveryError(
      `返工范围包含已发布章节（公开边界第${published}章），必须由用户明确确认后才能生成或覆盖正文`,
      'PUBLISHED_REWRITE_CONFIRMATION_REQUIRED',
      409,
    );
  }
  return { intersectsPublished: intersects, publishedChapterCount: published };
}

export async function diagnoseRecommendationRecovery(bookId, {
  startChapter = 1,
  endChapter = 20,
  forceFresh = false,
  resumeRunId = null,
  onEvent,
  signal,
  runTaskImpl = runTask,
} = {}) {
  const book = store.books.get(bookId);
  if (!book) throw recoveryError('作品不存在', 'NOT_FOUND', 404);
  const start = Math.max(1, Number(startChapter) || 1);
  const end = Math.max(start, Number(endChapter) || 20);
  const chapters = completedScope(bookId, start, end);
  const profile = store.publicationProfiles.get(bookId) || store.publicationProfiles.upsert(bookId, {});
  const suspectedTurnChapter = profile.suspected_turn_chapter || 7;
  const feedback = buildPublicationFeedbackContext(bookId);
  const priorGlobalFailure = priorGlobalReviewFailure(bookId, start, end);
  // V0.100.15 rebuild 连败史：只注入诊断指令文本（参考信息），不进诊断指纹——执行史随
  // 每次执行变化，进指纹会让“执行一次→史变→下次必须重诊断”死循环；正文/反馈/总审
  // 变化才触发全新诊断（fail-closed）。
  const rebuildLossBackflow = repeatedRebuildLossContext(bookId);
  const batchSize = 5;
  const fingerprint = diagnosisFingerprint({
    book, chapters,
    feedback: priorGlobalFailure ? `${feedback}\n${priorGlobalFailure}` : feedback,
    suspectedTurnChapter,
  });
  // 用户显式钉选的进度（前端弹窗选择）：严格校验归属/状态/范围/指纹，任一不符显式拒绝，
  // 不悄悄退化为全新诊断——用户以为沿用了实际没有，是最隐蔽的烧费。
  let pinned = null;
  if (resumeRunId) {
    pinned = store.recommendationRecoveryRuns.get(resumeRunId);
    if (!pinned || pinned.book_id !== bookId) throw recoveryError('所选返工进度不存在', 'NOT_FOUND', 404);
    const plannedNeedsResynthesis = pinned.status === 'planned' && staleRecoveryPlan(pinned);
    if (!['failed', 'cancelled'].includes(pinned.status) && !plannedNeedsResynthesis) {
      throw recoveryError(`所选进度当前状态为 ${pinned.status}，只有失败/中断的运行可以沿用；用户明确取消的运行也可恢复`, 'RECOVERY_RESUME_STATE', 409);
    }
    if (Number(pinned.start_chapter) !== start || Number(pinned.end_chapter) !== end) {
      throw recoveryError(`所选进度范围是第 ${pinned.start_chapter}—${pinned.end_chapter} 章，与当前诊断范围不一致`, 'RECOVERY_RESUME_SCOPE', 409);
    }
    const storedFingerprint = pinned.result?.diagnosis_fingerprint;
    const canBindCurrentInput = !storedFingerprint && emptyDiagnosisCheckpoint(pinned);
    if (storedFingerprint !== fingerprint && !canBindCurrentInput) {
      throw recoveryError('正文或平台反馈已变化，所选进度不能沿用；请选择全部重新诊断', 'RECOVERY_RESUME_STALE', 409);
    }
    if (canBindCurrentInput) {
      pinned = store.recommendationRecoveryRuns.update(pinned.id, {
        result: {
          ...(pinned.result || {}),
          diagnosis_fingerprint: fingerprint,
          completed_through: null,
          completed_batches: 0,
          segment_verdicts: [],
        },
      });
    }
  }
  // 诊断结论幂等：同范围同指纹且已跑完全部批次的运行（planned/failed），直接转回 planned
  // 交还工单，不为同一份结论重烧一遍；forceFresh（用户在弹窗选"全部重来"）才强制全新诊断。
  if (!forceFresh) {
    const diagnosed = pinned
      ? (() => {
        const curve = Array.isArray(pinned.quality_curve) ? pinned.quality_curve : [];
        const complete = curve.length === chapters.length
          && curve.every((item, index) => Number(item.chapter) === Number(chapters[index]?.idx));
        const synthesisComplete = chapters.length <= batchSize
          || diagnosisWorkOrders(curve).length === 0
          || hasCurrentRecoveryPlan(pinned);
        return complete && synthesisComplete ? pinned : null;
      })()
      : fullyDiagnosedRun(bookId, start, end, chapters, fingerprint);
    if (diagnosed) {
      const revived = store.recommendationRecoveryRuns.update(diagnosed.id, { status: 'planned', error: '' });
      store.publicationProfiles.upsert(bookId, { recoveryStatus: 'planned' });
      emitEvent(onEvent, 'recovery_started', {
        runId: revived.id, startChapter: start, endChapter: end, resumed: true,
      });
      emitEvent(onEvent, 'recovery_diagnosis_reused', {
        runId: revived.id, chapters: chapters.length, workOrders: revived.work_orders?.length || 0,
      });
      emitEvent(onEvent, 'recovery_plan_ready', {
        runId: revived.id, qualityCurve: revived.quality_curve, workOrders: revived.work_orders || [],
      });
      return revived;
    }
  }
  if (pinned && !diagnosisCheckpointShapeOk(pinned, chapters, batchSize)) {
    throw recoveryError('所选进度的诊断检查点不完整（半批或乱序），不能沿用；请选择全部重新诊断', 'RECOVERY_RESUME_INVALID', 409);
  }
  const resumable = forceFresh ? null
    : pinned || resumableDiagnosisRun(bookId, start, end, chapters, fingerprint, batchSize);
  const resumedVerdicts = Array.isArray(resumable?.result?.segment_verdicts)
    ? resumable.result.segment_verdicts
    : [];
  const checkpointResult = {
    ...(resumable?.result || {}),
    diagnosis_fingerprint: fingerprint,
    completed_through: resumable?.result?.completed_through ?? null,
    completed_batches: resumedVerdicts.length,
    segment_verdicts: resumedVerdicts,
  };
  const run = resumable
    ? store.recommendationRecoveryRuns.update(resumable.id, {
      status: 'diagnosing', error: '', result: checkpointResult,
    })
    : store.recommendationRecoveryRuns.create(bookId, {
      startChapter: start, endChapter: end, status: 'diagnosing', confirmedPublishedRewrite: false,
      // 指纹属于诊断输入版本，不属于首批输出；必须在第一次模型调用之前落库。
      result: {
        diagnosis_fingerprint: fingerprint,
        completed_through: null,
        completed_batches: 0,
        segment_verdicts: [],
      },
    });
  const qualityCurve = resumable ? [...resumable.quality_curve] : [];
  const segmentVerdicts = [...resumedVerdicts];
  const resumeOffset = qualityCurve.length;
  store.publicationProfiles.upsert(bookId, { recoveryStatus: 'diagnosing' });
  emitEvent(onEvent, 'recovery_started', {
    runId: run.id, startChapter: start, endChapter: end, resumed: !!resumable,
  });
  if (resumable) emitEvent(onEvent, 'recovery_resumed', {
    runId: run.id,
    completedThrough: resumeOffset ? chapters[resumeOffset - 1].idx : null,
    nextChapter: chapters[resumeOffset]?.idx ?? null,
    nextStage: resumeOffset >= chapters.length ? 'synthesizing' : 'diagnosing',
    completedBatches: segmentVerdicts.length,
    totalBatches: Math.ceil(chapters.length / batchSize),
  });
  try {
    for (let offset = resumeOffset; offset < chapters.length; offset += batchSize) {
      if (signal?.aborted) throw recoveryError('推荐返工诊断已取消', 'ABORTED');
      const batch = chapters.slice(offset, offset + batchSize);
      emitEvent(onEvent, 'recovery_diagnosing', {
        runId: run.id, from: batch[0].idx, to: batch.at(-1).idx,
        current: Math.floor(offset / batchSize) + 1, total: Math.ceil(chapters.length / batchSize),
      });
      const progress = {
        runId: run.id, stage: 'diagnosing', from: batch[0].idx, to: batch.at(-1).idx,
        current: Math.floor(offset / batchSize) + 1, total: Math.ceil(chapters.length / batchSize),
      };
      const baseInstruction = recommendationRecoveryDiagnosisInstruction({
        bookTitle: book.title, chapters: batch, publicationFeedback: feedback, suspectedTurnChapter,
        priorGlobalFailure,
        repeatedRebuildLosses: rebuildLossBackflow,
      });
      const { value: validated, recovered: evidenceRecovered } = await runStructuredWithOneCorrection({
        label: '推荐失败返工诊断',
        instruction: baseInstruction,
        correctionHint: '隔着叙述的两段对白必须拆成两个 evidence 数组元素。',
        maxCorrections: 2, // 诊断批次给两次纠正：打地鼠实证（修一条又踩一条）一轮不够
        runRequest: (content, { isCorrection = false } = {}) => runTaskImpl({
          task: isCorrection ? 'audit_repair' : 'mid_story_review', bookId, jsonMode: true, signal,
          onRetry: recoveryRetryHandler(onEvent, progress),
          messages: assembleReviewMessages(bookId, [{ role: 'user', content }]),
        }),
        validate: parsed => validateRecoveryDiagnosis(parsed, batch, { suspectedTurnChapter }),
        // 两次纠正仍把真实引文夹进错字/错归因时，不再让单条软证据杀死整批：只采用
        // 能回指正文的真实核心，并把该行降级为 keep。完整幻觉没有真实核心，仍会失败关闭。
        recoverFinalValidation: parsed => validateRecoveryDiagnosis(parsed, batch, {
          suspectedTurnChapter,
          allowPartialEvidence: true,
        }),
        onCorrection: (error, attempt) => emitEvent(onEvent, 'recovery_validation_retry', {
          ...progress, attempt: attempt + 1, reason: error.message,
        }),
      });
      if (evidenceRecovered && validated.validation_warnings?.length) {
        const isolatedChapters = [...new Set(validated.validation_warnings.map(item => Number(item.chapter)))]
          .filter(Number.isInteger);
        emitEvent(onEvent, 'recovery_evidence_isolated', {
          ...progress,
          chapters: isolatedChapters,
          count: validated.validation_warnings.length,
          message: `第 ${isolatedChapters.join('、')} 章近似引文已隔离：只保留可逐字回指的正文片段，相关章节本轮保持原稿；诊断继续`,
        });
      }
      qualityCurve.push(...validated.quality_curve);
      segmentVerdicts.push(validated.segment_verdict);
      const persistedResult = store.recommendationRecoveryRuns.get(run.id)?.result || {};
      const checkpointResult = {
        // 重新诊断可能是在执行中断的同一运行上补批次；候选仍是隔离审计资产，
        // 先保留，后续由诊断/工单/相邻章指纹决定能否复用，不能因补一个批次被抹掉。
        ...persistedResult,
        diagnosis_fingerprint: fingerprint,
        completed_through: batch.at(-1).idx,
        completed_batches: segmentVerdicts.length,
        segment_verdicts: segmentVerdicts,
      };
      store.recommendationRecoveryRuns.update(run.id, {
        qualityCurve, result: checkpointResult, error: '',
      });
      emitEvent(onEvent, 'recovery_checkpoint_saved', {
        runId: run.id,
        completedThrough: batch.at(-1).idx,
        completedBatches: segmentVerdicts.length,
        totalBatches: Math.ceil(chapters.length / batchSize),
      });
    }
    qualityCurve.sort((left, right) => left.chapter - right.chapter);
    const preliminaryOrders = diagnosisWorkOrders(qualityCurve);
    let repairPlan = null;
    let workOrders = preliminaryOrders;
    if (chapters.length > batchSize) {
      if (preliminaryOrders.length) {
        emitEvent(onEvent, 'recovery_synthesizing', {
          runId: run.id,
          chapters: chapters.length,
          workOrders: preliminaryOrders.length,
        });
        const synthesisInstruction = recommendationRecoverySynthesisInstruction({
          bookTitle: book.title,
          qualityCurve,
          segmentVerdicts,
          publicationFeedback: feedback,
          priorGlobalFailure,
          repeatedRebuildLosses: rebuildLossBackflow,
        });
        // 综合模型只负责提出跨章组织，绝不再为 JSON 漏行/坏依赖把整份高成本蓝图重答两次。
        // 无论模型返回完整、部分还是结构错误，本地编译器都以已验证逐章曲线为权威补齐并净化；
        // 只有用户主动“全部重新诊断”才会再次调用综合模型。
        let modelPlan = {};
        let compiledLocally = false;
        try {
          const response = await runTaskImpl({
            task: 'mid_story_review', bookId, jsonMode: true, signal,
            onRetry: recoveryRetryHandler(onEvent, { runId: run.id, stage: 'synthesizing' }),
            messages: assembleReviewMessages(bookId, [{ role: 'user', content: synthesisInstruction }]),
          });
          modelPlan = parseStructuredResponse(response, '推荐返工全范围综合规划');
        } catch (error) {
          if (isRecoveryCancellation(error, signal)) throw error;
          compiledLocally = true;
          emitEvent(onEvent, 'recovery_plan_compiled_locally', {
            runId: run.id,
            reason: `综合模型输出不可直接采用，已由本地编译器根据已验证逐章取证生成完整计划：${error.message}`,
          });
        }
        try {
          repairPlan = compileRecoveryPlan(modelPlan, chapters, qualityCurve, { bookId });
        } catch (error) {
          // 模型结构即便可解析，也可能存在重叠弧等组合缺陷；完全丢弃模型组织后确定性重编。
          repairPlan = compileRecoveryPlan({}, chapters, qualityCurve, { bookId });
          compiledLocally = true;
          emitEvent(onEvent, 'recovery_plan_compiled_locally', {
            runId: run.id,
            reason: `综合计划存在不可安全沿用的组合缺陷，已按逐章取证确定性重编：${error.message}`,
          });
        }
        workOrders = repairPlan.chapter_orders;
        if (compiledLocally) emitEvent(onEvent, 'recovery_checkpoint_saved', {
          runId: run.id,
          completedThrough: chapters.at(-1).idx,
          message: '全范围计划已本地补齐并保存；后续执行不会再次重跑因果蓝图',
        });
      } else {
        repairPlan = { arcs: [], chapter_orders: [] };
        workOrders = [];
      }
    }
    const persistedResult = store.recommendationRecoveryRuns.get(run.id)?.result || {};
    const persistedCandidates = Array.isArray(persistedResult.candidates)
      ? persistedResult.candidates
      : [];
    const result = {
      diagnosis_fingerprint: fingerprint,
      completed_through: chapters.at(-1).idx,
      completed_batches: segmentVerdicts.length,
      segment_verdicts: segmentVerdicts,
      deterioration_found: segmentVerdicts.some(item => item.deterioration_found),
      suspected_turn_chapter: suspectedTurnChapter,
      ...(repairPlan ? {
        repair_plan: repairPlan,
        repair_plan_contract_version: RECOVERY_PLAN_CONTRACT_VERSION,
      } : {}),
      // 只保留隔离候选检查点，不保留旧 completion/globalReview 等执行终态；新工单若变化，
      // 执行侧的完整 provenance 指纹会让不匹配候选重生。
      ...(persistedCandidates.length ? {
        candidates: persistedCandidates,
        candidateStatsByValidation: candidateStatsByValidation(persistedCandidates),
      } : {}),
    };
    const updated = store.recommendationRecoveryRuns.update(run.id, {
      status: 'planned', qualityCurve, workOrders, result,
    });
    store.publicationProfiles.upsert(bookId, { recoveryStatus: 'planned' });
    emitEvent(onEvent, 'recovery_plan_ready', { runId: run.id, qualityCurve, workOrders });
    return updated;
  } catch (error) {
    if (isRecoveryCancellation(error, signal)) {
      throw persistRecoveryCancellation(bookId, run.id, { error, onEvent });
    }
    const persisted = store.recommendationRecoveryRuns.get(run.id);
    store.recommendationRecoveryRuns.update(run.id, {
      status: 'failed', error: error.message,
      result: { ...(persisted?.result || {}), failure_code: error.code || 'ERROR' },
    });
    store.publicationProfiles.upsert(bookId, { recoveryStatus: 'failed' });
    emitEvent(onEvent, 'recovery_failed', { runId: run.id, code: error.code || 'ERROR', error: error.message });
    throw error;
  }
}

export async function executeRecommendationRecovery(bookId, runId, {
  confirmedPublishedRewrite = false,
  reusePriorCandidates = true,
  onEvent,
  signal,
  runTaskImpl = runTask,
  narrativeRevisionImpl = prepareAndCommitNarrativeRevision,
  projectionImpl = null,
  globalReviewSegmentChars = GLOBAL_REVIEW_SEGMENT_CHARS,
} = {}) {
  const book = store.books.get(bookId);
  const run = store.recommendationRecoveryRuns.get(runId);
  if (!book || !run || run.book_id !== bookId) throw recoveryError('返工计划不存在', 'NOT_FOUND', 404);
  const persistedWorkOrders = Array.isArray(run.work_orders) ? run.work_orders : [];
  // V0.100.1：执行阶段失败的运行（failed 但工单已验证生成）允许直接重新执行——
  // 诊断结论仍然有效，不应逼用户为同一份工单再从第一章烧一遍诊断费用。
  const canExecute = run.status === 'planned'
    || (['failed', 'cancelled'].includes(run.status) && persistedWorkOrders.length > 0);
  if (!canExecute) throw recoveryError(`返工计划当前状态为 ${run.status}，不能执行`, 'RECOVERY_STATE_CONFLICT', 409);
  const planRequired = wholeRangePlanRequired(run, persistedWorkOrders);
  if (planRequired && !hasCurrentRecoveryPlan(run, persistedWorkOrders)) {
    throw recoveryError(
      '旧版全范围返工计划不能继续执行；已验证逐章取证会保留，请选择“继续诊断”只重做一次综合规划后再返工',
      'RECOVERY_PLAN_STALE',
      409,
    );
  }
  // V0.100.7：执行策略属于运行本身，不属于某一次 HTTP 请求。刷新/重连后旧前端仍可能
  // 发送 reusePriorCandidates=true；请求只能收紧已持久化策略，绝不能把用户选择的 fresh
  // 运行重新放宽为跨运行复用。旧库的空策略安全降级为 same_run，只续本运行检查点。
  const persistedPolicy = normalizeRecoveryPolicy(run.execution_policy);
  const requestedPolicy = reusePriorCandidates === false
    ? { candidateReuse: 'none', rejectionHistory: 'none' }
    : { candidateReuse: 'exact_cross_run', rejectionHistory: 'compatible' };
  const executionPolicy = resolveRecoveryPolicy(persistedPolicy, requestedPolicy);
  const profile = store.publicationProfiles.get(bookId) || store.publicationProfiles.upsert(bookId, {});
  assertPublishedRewritePermission({
    publishedChapterCount: profile.published_chapter_count,
    startChapter: run.start_chapter,
    endChapter: run.end_chapter,
    confirmedPublishedRewrite,
  });
  const lastArchive = store.archives.last(bookId);
  if (lastArchive && run.start_chapter <= lastArchive.range_end) {
    throw recoveryError(`返工范围包含已归档章节（归档至第${lastArchive.range_end}章），为避免正文与归档记忆分裂已停止`, 'RECOVERY_ARCHIVED_SCOPE', 409);
  }
  const chapters = completedScope(bookId, run.start_chapter, run.end_chapter);
  const chapterMap = new Map(chapters.map(chapter => [chapter.idx, chapter]));
  // 保存过的 V0.100.13 计划不失效、不重跑综合模型：执行前直接用同一份逐章取证
  // 在本地补齐/净化。计划合同版本保持不变；只有实际工单内容有变化时才覆盖存档。
  const curveChapters = new Set((run.quality_curve || []).map(item => Number(item.chapter)));
  const canCompilePersistedPlan = persistedWorkOrders.every(order => curveChapters.has(Number(order.chapter)));
  let executionPlan = run.result?.repair_plan || { arcs: [], chapter_orders: persistedWorkOrders };
  let normalizedPersistedOrders = persistedWorkOrders;
  if (canCompilePersistedPlan) {
    executionPlan = compileRecoveryPlan({
      ...(run.result?.repair_plan || {}),
      chapter_orders: persistedWorkOrders,
    }, chapters, run.quality_curve || [], { bookId });
    normalizedPersistedOrders = executionPlan.chapter_orders;
    const planChanged = JSON.stringify(executionPlan) !== JSON.stringify(run.result?.repair_plan || null)
      || JSON.stringify(normalizedPersistedOrders) !== JSON.stringify(persistedWorkOrders);
    if (planChanged) {
      store.recommendationRecoveryRuns.update(runId, {
        workOrders: normalizedPersistedOrders,
        result: {
          ...(run.result || {}),
          repair_plan: executionPlan,
          // 本地规范化不是新的模型合同，不得借版本号逼用户再跑一次综合蓝图。
          repair_plan_contract_version: RECOVERY_PLAN_CONTRACT_VERSION,
          plan_normalized_locally_at: Date.now(),
        },
      });
      emitEvent(onEvent, 'recovery_plan_normalized_locally', {
        runId,
        workOrders: normalizedPersistedOrders.length,
        message: '已保存计划已在本地补齐并净化；未调用综合规划模型',
      });
    }
  }
  const repairArcs = new Map((executionPlan.arcs || []).map(arc => [String(arc.id), arc]));
  const workOrders = orderedRecoveryWorkOrders(normalizedPersistedOrders).map(order => ({
    ...order,
    plan_arc: repairArcs.get(String(order.plan_arc_id || '')) || null,
  }));
  const continuityMap = new Map(store.chapters.list(bookId).map(chapter => [chapter.idx, {
    ...chapter, text: store.chapters.fullText(chapter.id),
  }]));
  // 返工全过程的内存稿视图：局部通过的候选立即替换对应章，后续章节据此读取相邻接口；
  // 数据库正文仍保持不动，直到整段复核与影子投影全部通过后才原子切换。
  const prospectiveContinuityMap = new Map(
    [...continuityMap].map(([idx, chapter]) => [idx, { ...chapter }]),
  );
  if (!workOrders.length) throw recoveryError('返工计划没有需要修改的章节；请先复核诊断结果', 'RECOVERY_NO_WORKORDERS', 409);
  for (const order of workOrders) {
    if (!chapterMap.has(Number(order.chapter)) || !['tune', 'rebuild'].includes(String(order.action))) {
      throw recoveryError(`第${order.chapter || '?'}章返工工单无效`);
    }
  }

  // 新版诊断指纹是执行前的乐观并发门禁。旧库里没有 64 位合同指纹的历史运行保持兼容；
  // 新版运行只要正文、平台反馈或上轮整段否决结论变化，就必须重新诊断。
  const storedDiagnosisFingerprint = run.result?.diagnosis_fingerprint;
  if (isCurrentDiagnosisFingerprint(storedDiagnosisFingerprint)) {
    const currentFeedback = buildPublicationFeedbackContext(bookId);
    const priorGlobalFailure = priorGlobalReviewFailure(bookId, run.start_chapter, run.end_chapter);
    const currentFingerprint = diagnosisFingerprint({
      book,
      chapters,
      feedback: priorGlobalFailure ? `${currentFeedback}\n${priorGlobalFailure}` : currentFeedback,
      suspectedTurnChapter: profile.suspected_turn_chapter || 7,
    });
    if (storedDiagnosisFingerprint !== currentFingerprint) {
      throw recoveryError(
        '正文、平台反馈或整段复核结论已变化，当前返工工单基于旧版本；请重新诊断后再执行',
        'RECOVERY_PLAN_STALE',
        409,
      );
    }
  }

  // 用户确认和运行状态均已验证后，才创建恢复点；任何候选仍在内存隔离区，不直接改稿。
  const snapshotData = store.snapshotBook(bookId);
  const existingSnapshot = run.snapshot_id ? store.snapshots.get(run.snapshot_id) : null;
  const canReuseSnapshot = existingSnapshot?.book_id === bookId
    && existingSnapshot.source === 'recommendation_recovery'
    && JSON.stringify(existingSnapshot.data) === JSON.stringify(snapshotData);
  const snapshot = canReuseSnapshot ? existingSnapshot : store.snapshots.add(bookId, {
    label: `推荐失败返工前快照（第${run.start_chapter}—${run.end_chapter}章）`,
    source: 'recommendation_recovery',
    data: snapshotData,
  });
  store.recommendationRecoveryRuns.update(runId, {
    status: 'rewriting', confirmedPublishedRewrite: true, snapshotId: snapshot.id, error: '',
    executionPolicy,
  });
  store.publicationProfiles.upsert(bookId, { recoveryStatus: 'rewriting' });
  emitEvent(onEvent, canReuseSnapshot ? 'recovery_snapshot_reused' : 'recovery_snapshot_created', {
    runId, snapshotId: snapshot.id, label: snapshot.label,
  });

  const feedback = buildPublicationFeedbackContext(bookId);
  const settings = store.books.settings(bookId);
  const styleRules = styleRulesText(settings.styleProfile, settings.styleSample, {
    isHistory: book.genre === '历史', compact: true,
  });
  const candidates = [];
  const candidateAudits = [];
  const rejected = [];

  // V0.100.1 执行断点续跑：失败/中断运行里已通过全部校验的候选按旧稿指纹复用——
  // 只对当前正文逐字一致的章复用，且复用前重过本地硬校验与盲审结论复核
  // （缓存只是优化不是权威）；指纹变化或校验失败的自动回退重新生成。
  // 复用来源由运行级策略决定：same_run 只续本运行检查点；只有显式持久化为
  // exact_cross_run 的运行才会查看同书既往运行。none 完全不读取候选检查点。
  // V0.100.6 及更早候选没有 provenance，且可能已被旧逻辑跨运行复制进当前运行；无法证明
  // 来源诊断和整体方案时一律隔离重生。只有新合同产生的本运行 local_passed/global_passed，
  // 或完整匹配合同/诊断/工单/正文/邻章的跨运行 global_passed 才能复用。
  const reusableByChapter = new Map();
  const orderByChapter = new Map(workOrders.map(order => [Number(order.chapter), order]));
  const candidateSources = [];
  if (executionPolicy.candidateReuse !== 'none') candidateSources.push(run);
  if (executionPolicy.candidateReuse === 'exact_cross_run') {
    for (const prior of store.recommendationRecoveryRuns.list(bookId)) {
      if (prior.id !== runId) candidateSources.push(prior);
    }
  }
  for (const source of candidateSources) {
    const persistedCandidates = Array.isArray(source.result?.candidates) ? source.result.candidates : [];
    for (const item of persistedCandidates) {
      if (item?.status !== 'accepted') continue;
      const chapter = chapterMap.get(Number(item.chapter));
      if (!chapter || reusableByChapter.has(chapter.idx)) continue;
      const order = orderByChapter.get(chapter.idx);
      if (!order || String(item.order?.action || '') !== String(order.action)) continue;
      const sameRun = source.id === runId;
      const provenance = normalizeCandidateProvenance(item.provenance || {});
      const validationState = provenance.validationState;
      // 局部盲审只证明单章候选胜过旧稿：它只能续本运行检查点；整段明确否决的候选
      // 连本运行也不能原样再投。跨运行必须是同合同下整段已通过、且全部输入指纹精确一致。
      if (validationState === 'global_rejected') continue;
      if (sameRun) {
        if (!hasCompleteCandidateProvenance(item.provenance)
          || !['local_passed', 'global_passed'].includes(validationState)) continue;
        if (provenance.checkpointRunId !== String(runId)) continue;
        if (provenance.sourceDiagnosisFingerprint !== String(run.result?.diagnosis_fingerprint || '')) continue;
        if (provenance.sourceWorkOrderFingerprint !== recoveryWorkOrderFingerprint(order)) continue;
      } else {
        if (!hasCompleteCandidateProvenance(item.provenance)) continue;
        if (source.result?.globalReview?.verdict === 'fail') continue;
        if (validationState !== 'global_passed') continue;
        if (provenance.contractVersion !== RECOVERY_CONTRACT_VERSION) continue;
        if (provenance.sourceDiagnosisFingerprint !== String(run.result?.diagnosis_fingerprint || '')) continue;
        if (provenance.sourceWorkOrderFingerprint !== recoveryWorkOrderFingerprint(order)) continue;
        if (provenance.sourceNeighborFingerprint !== candidateNeighborFingerprint(continuityMap, chapter.idx)) continue;
      }
      const beforeHash = candidateTextHash(item.before);
      if (beforeHash !== candidateTextHash(chapter.text)) continue;
      if (provenance.sourceBeforeHash !== beforeHash) continue;
      const comparisons = Array.isArray(item.comparisons) ? item.comparisons : [];
      // 接受判定与生成侧共用同一谓词：两轮明确胜出，或 tune 的位置镜像分裂 + 绝对质量线。
      if (!comparisonsAcceptCandidate(comparisons, { action: order.action })) continue;
      const safety = validateChapterRewrite({
        before: chapter.text, after: String(item.after || ''), chapterIdx: chapter.idx,
        ...chapterRewriteContext(bookId, chapter),
      });
      if (!safety.ok || safety.unchanged) continue;
      const proseBefore = item.patch?.kind === 'scene_window' ? String(item.patch.before || '') : chapter.text;
      const proseAfter = item.patch?.kind === 'scene_window' ? String(item.patch.after || '') : String(item.after || '');
      const prose = validateRecoveryProseImprovement(proseBefore, proseAfter, windowPatchRuleOptions(item.patch, chapter));
      if (!prose.ok) continue;
      reusableByChapter.set(chapter.idx, {
        chapter, before: chapter.text, after: String(item.after || ''), order,
        status: 'accepted', rejection: null, safety, prose, comparisons,
        provenance: normalizeCandidateProvenance({
          ...provenance,
          sourceRunId: provenance.sourceRunId || source.id,
          sourceDiagnosisFingerprint: provenance.sourceDiagnosisFingerprint || String(source.result?.diagnosis_fingerprint || ''),
          sourceWorkOrderFingerprint: provenance.sourceWorkOrderFingerprint || recoveryWorkOrderFingerprint(item.order || order),
          sourceBeforeHash: provenance.sourceBeforeHash || beforeHash,
          sourceNeighborFingerprint: provenance.sourceNeighborFingerprint || candidateNeighborFingerprint(continuityMap, chapter.idx),
          validationState,
        }, { checkpointRunId: runId }),
      });
    }
  }

  // V0.100.3 连败冻结账本：同一工单动作 + 同一份旧稿（before 指纹一致）被完整执行拒绝的
  // 累计轮数。两轮都证明"新候选不如旧稿"后继续掷骰子大概率纯烧钱（用户实证：ch9/ch17
  // 两个运行连败四连），默认跳过该章、零成本保留旧稿。动态冷却（用户追问"一直冻着怎么办"
  // 后定调）：只统计最近一次"有候选成功落盘"之后产生的拒收旧账——一旦本书有任何章成功
  // 改好，说明相邻正文与整段上下文已经变化，冻结的章自动解冻获得重新机会；只有全书长期
  // 无任何进展时才保持静默。此外旧稿改动/动作变化键失配即刻解冻；选"全部重新诊断"
  // rejectionHistory=none 不认任何旧账。
  const priorRejections = new Map();
  const priorRejectionsLifetime = new Map();
  if (executionPolicy.rejectionHistory === 'compatible') {
    const allBookRuns = store.recommendationRecoveryRuns.list(bookId);
    const rejectionSources = [run, ...allBookRuns.filter(item => item.id !== runId)];
    const lastAppliedRun = allBookRuns
      .find(item => item.status === 'completed' && Array.isArray(item.result?.applied) && item.result.applied.length > 0);
    const successWatermark = lastAppliedRun ? Number(lastAppliedRun.created_at) : Number.NEGATIVE_INFINITY;
    for (const source of rejectionSources) {
      // 双账本：recent 只记水印之后（动态冷却），lifetime 无视水印累计质量性败选
      // （慢性败选章的终身熔断）；工具误伤码不计入任何一本。
      const sourceIsRecent = source.id === runId || Number(source.created_at) > successWatermark;
      const audits = Array.isArray(source.result?.candidates) ? source.result.candidates : [];
      const countedRecent = new Set();
      const countedLifetime = new Set();
      for (const item of audits) {
        if (item?.status !== 'rejected' || !item?.rejection?.code) continue;
        if (!QUALITY_LOSS_CODES.has(item.rejection.code)) continue;
        const chapterIdx = Number(item.chapter?.idx ?? item.chapter);
        // 候选审计里的 order 带完整 plan_arc；持久化工单列只有 arc id/交接字段。
        // 失败账本必须优先使用完整血缘，否则弧内容变化后仍会被旧冻结记录误拦。
        const sourceOrder = item.order
          || (source.work_orders || []).find(order => Number(order.chapter) === chapterIdx)
          || {};
        const key = recoveryFailureLedgerKey(sourceOrder, item.before);
        // 同一运行行断点续跑时审计原位覆盖，同章只计一次，防中断重跑虚增计数。
        if (sourceIsRecent && !countedRecent.has(`${source.id}:${key}`)) {
          countedRecent.add(`${source.id}:${key}`);
          priorRejections.set(key, (priorRejections.get(key) || 0) + 1);
        }
        if (!countedLifetime.has(`${source.id}:${key}`)) {
          countedLifetime.add(`${source.id}:${key}`);
          priorRejectionsLifetime.set(key, (priorRejectionsLifetime.get(key) || 0) + 1);
        }
      }
    }
  }

  // 关键 rebuild 是整批落盘的必备项。若它已达到冻结线，继续生成其他章也不可能提交，
  // 更不可能靠“其他章先成功落盘”改变上下文自动解冻；必须在任何模型调用前要求重做方案。
  const blockedRebuilds = workOrders.map((order) => {
    if (order.action !== 'rebuild') return null;
    const chapter = chapterMap.get(Number(order.chapter));
    const key = recoveryFailureLedgerKey(order, chapter?.text || '');
    const recentFails = priorRejections.get(key) || 0;
    const lifetimeFails = priorRejectionsLifetime.get(key) || 0;
    return recentFails >= FROZEN_REJECTION_THRESHOLD || lifetimeFails >= FROZEN_LIFETIME_THRESHOLD
      ? { order, chapter, recentFails, lifetimeFails }
      : null;
  }).filter(Boolean);
  if (blockedRebuilds.length) {
    const blockedChapters = blockedRebuilds.map(item => item.chapter.idx);
    const reason = `关键重构章（第${blockedChapters.join('、')}章）在当前完整工单与旧稿基准下已连续失败；该章又是整批落盘必备项，继续执行会形成无法提交的死锁。请重新诊断并调整整段方案后再返工`;
    const failure = {
      chapter: blockedChapters[0] ?? null,
      chapters: blockedChapters,
      code: 'RECOVERY_REPLAN_REQUIRED',
      reason,
      frozenAttempts: Math.max(...blockedRebuilds.map(item => Math.max(item.recentFails, item.lifetimeFails))),
    };
    for (const item of blockedRebuilds) {
      candidateAudits.push({
        chapter: item.chapter, before: item.chapter.text, after: '', order: item.order,
        status: 'frozen', rejection: failure, comparisons: [],
        provenance: normalizeCandidateProvenance({
          sourceRunId: runId,
          checkpointRunId: runId,
          sourceDiagnosisFingerprint: String(run.result?.diagnosis_fingerprint || ''),
          sourceWorkOrderFingerprint: recoveryWorkOrderFingerprint(item.order),
          sourceBeforeHash: candidateTextHash(item.chapter.text),
          sourceNeighborFingerprint: candidateNeighborFingerprint(prospectiveContinuityMap, item.chapter.idx),
          contractVersion: RECOVERY_CONTRACT_VERSION,
          validationState: 'frozen',
        }),
      });
    }
    failRun(bookId, runId, { rejected: [failure], candidates: candidateAudits, reason });
    emitEvent(onEvent, 'recovery_failed', {
      runId, code: failure.code, error: reason, missingChapters: blockedChapters,
    });
    throw recoveryError(reason, failure.code, 409);
  }

  // 每章候选一通过就把完整审计落进运行记录——进程被杀也能从断点续跑，
  // 不再只靠 failRun 的终态快照兜底。必须与既有存档合并，禁止整体覆盖。
  const checkpointCandidates = () => {
    const current = store.recommendationRecoveryRuns.get(runId);
    store.recommendationRecoveryRuns.update(runId, {
      result: {
        ...(current?.result || {}),
        candidates: mergeCandidateAudits(
          current?.result?.candidates,
          serializeCandidateAudits(candidateAudits, { checkpointRunId: runId }),
        ),
      },
    });
  };

  /**
   * V0.100.14 单章有界闭包：证据场景窗口只生成一次 → 整章拼接硬校验 →
   * 两次换位盲审。盲审分裂/败选直接保留旧稿，不再重生整章、决胜轮或补救二扫。
   */
  const processChapterOrder = async (order, { current, total }) => {
    const chapter = chapterMap.get(Number(order.chapter));
    const before = chapter.text;
    // 范围边界章也要读取范围外相邻正文，否则重构 ch20 可能直接撞断已经存在的 ch21。
    const previous = prospectiveContinuityMap.get(chapter.idx - 1);
    const next = prospectiveContinuityMap.get(chapter.idx + 1);
    emitEvent(onEvent, 'recovery_rewriting', {
      runId, chapter: chapter.idx, current, total,
    });
    const rewriteContext = chapterRewriteContext(bookId, chapter);
    const rewriteWindow = buildRecoveryRewriteWindow(chapter, order);
    const baseInstruction = recommendationRecoveryRewriteInstruction({
      bookTitle: book.title, chapter, chapterText: before, workOrder: order,
      prevTail: previous?.text.slice(-500) || '', nextHead: next?.text.slice(0, 500) || '',
      publicationFeedback: feedback, styleRules, targetChars: rewriteWindow.targetChars,
      rewriteWindow,
    });
    let accepted = false;
    let finalFailure = null;
    const response = await runTaskImpl({
      task: 'revise', bookId, chapterId: chapter.id, signal,
      onRetry: recoveryRetryHandler(onEvent, {
        runId, stage: 'rewriting', chapter: chapter.idx, current, total,
      }),
      messages: assembleReviewMessages(bookId, [{ role: 'user', content: baseInstruction }]),
    });
    const afterWindow = String(response.content || '').trim();
    const windowSafety = validateRecoveryWindowRewrite(
      rewriteWindow, afterWindow, response.finishReason, order.action,
    );
    const after = rewriteWindow.assemble(afterWindow);
    const safety = windowSafety.ok
      ? validateChapterRewrite({
        before, after, finishReason: response.finishReason, chapterIdx: chapter.idx,
        ...rewriteContext,
      })
      : windowSafety;
    const prose = safety.ok && !safety.unchanged
      ? validateRecoveryProseImprovement(rewriteWindow.oldText, afterWindow, {
        scope: rewriteWindow.wholeChapter ? 'chapter' : 'window',
        endsAtChapterEnd: rewriteWindow.endsAtChapterEnd,
      })
      : null;
    const candidateAudit = {
      chapter, before, after, order,
      status: 'generated', rejection: null, safety, prose, comparisons: [],
      patch: {
        kind: 'scene_window', scene_indexes: rewriteWindow.sceneIndexes,
        before: rewriteWindow.oldText, after: afterWindow,
      },
      provenance: normalizeCandidateProvenance({
        sourceRunId: runId,
        checkpointRunId: runId,
        sourceDiagnosisFingerprint: String(run.result?.diagnosis_fingerprint || ''),
        sourceWorkOrderFingerprint: recoveryWorkOrderFingerprint(order),
        sourceBeforeHash: candidateTextHash(before),
        sourceNeighborFingerprint: candidateNeighborFingerprint(prospectiveContinuityMap, chapter.idx),
        contractVersion: RECOVERY_CONTRACT_VERSION,
        validationState: 'generated',
      }),
    };
    if (!safety.ok || safety.unchanged) {
      finalFailure = {
        chapter: chapter.idx, code: safety.code,
        reason: safety.unchanged ? '候选窗口与旧稿相同，没有形成可验证提升' : safety.message,
        metrics: safety.metrics,
      };
    } else if (prose && !prose.ok) {
      finalFailure = {
        chapter: chapter.idx, code: prose.code,
        reason: `确定性文风闸未通过（旧窗口 ${prose.beforeBlocking} 项，候选窗口 ${prose.afterBlocking} 项）；候选不得新增 AI 模板腔或动作母题`,
        prose,
      };
    } else {
      const compareBefore = [rewriteWindow.beforeContext, rewriteWindow.oldText, rewriteWindow.afterContext]
        .filter(Boolean).join('\n\n');
      const compareAfter = [rewriteWindow.beforeContext, afterWindow, rewriteWindow.afterContext]
        .filter(Boolean).join('\n\n');
      emitEvent(onEvent, 'recovery_comparing', { runId, chapter: chapter.idx, round: 1 });
      let first;
      let second;
      try {
        first = await compareCandidate(
          bookId, chapter, compareBefore, compareAfter, 1, runTaskImpl, signal,
          recoveryRetryHandler(onEvent, { runId, stage: 'comparing', chapter: chapter.idx, round: 1 }),
          onEvent,
        );
        candidateAudit.comparisons.push(first);
        emitEvent(onEvent, 'recovery_comparing', { runId, chapter: chapter.idx, round: 2 });
        second = await compareCandidate(
          bookId, chapter, compareBefore, compareAfter, 2, runTaskImpl, signal,
          recoveryRetryHandler(onEvent, { runId, stage: 'comparing', chapter: chapter.idx, round: 2 }),
          onEvent,
        );
        candidateAudit.comparisons.push(second);
      } catch (error) {
        if (!RECOVERABLE_DIAGNOSIS_CODES.has(error.code)) throw error;
        finalFailure = {
          chapter: chapter.idx, code: 'RECOVERY_COMPARE_INVALID',
          reason: `匿名盲审证据未通过本地校验；本章保留旧稿且不再重答审稿：${error.message}`,
        };
      }
      if (!finalFailure && comparisonsAcceptCandidate(candidateAudit.comparisons, { action: order.action })) {
        accepted = true;
        candidateAudit.status = 'accepted';
        setCandidateValidationState(candidateAudit, 'local_passed', runId);
      } else if (!finalFailure) {
        const positionSplit = first.winner === second.winner && ['A', 'B'].includes(first.winner);
        finalFailure = {
          chapter: chapter.idx, code: 'RECOVERY_NO_CLEAR_IMPROVEMENT',
          reason: positionSplit
            ? `两轮换位盲审都偏好 ${first.winner} 位置，结论受位置偏差影响，无法证明新稿更优；旧稿保留，不再重生候选`
            : `双向盲审未一致选择新稿（第1轮 ${first.winner}/${first.margin}，第2轮 ${second.winner}/${second.margin}）；旧稿保留，不再重生候选`,
          comparisons: candidateAudit.comparisons,
        };
        // V0.100.15 rebuild 镜像降级：位置镜像分裂 + 候选两轮绝对质量过线说明候选与旧稿
        // 整体相当（盲审对"质量相当的改写"无内容区分力，两轮同位置即镜像锚定）——
        // 降级为**放行候选**参与整段复核，由复核裁决跨段质量；不再让已证明的其余整改陪葬。
        // 真败选（方向性输）仍走整批止损。局部盲审只证明"无退化"，复核证明"整段有效"。
        if (positionMirroredSplit(first, second)
          && candidateAbsoluteQuality(first, 'B') && candidateAbsoluteQuality(second, 'A')) {
          accepted = true;
          candidateAudit.status = 'accepted';
          setCandidateValidationState(candidateAudit, 'local_passed', runId);
          finalFailure = null;
        }
      }
    }
    if (!accepted) {
      candidateAudit.status = 'rejected';
      candidateAudit.rejection = finalFailure;
      setCandidateValidationState(candidateAudit, 'rejected', runId);
    }
    const auditIdx = candidateAudits.findIndex(item => item.chapter.idx === chapter.idx);
    if (auditIdx >= 0) candidateAudits[auditIdx] = candidateAudit;
    else candidateAudits.push(candidateAudit);
    if (accepted) {
      candidates.push(candidateAudit);
      prospectiveContinuityMap.set(chapter.idx, {
        ...(prospectiveContinuityMap.get(chapter.idx) || chapter),
        text: candidateAudit.after,
      });
      emitEvent(onEvent, 'recovery_candidate_accepted', {
        runId, chapter: chapter.idx, comparisons: candidateAudit.comparisons,
      });
    } else {
      rejected.push(finalFailure);
      emitEvent(onEvent, 'recovery_candidate_rejected', { runId, ...finalFailure });
    }
    checkpointCandidates();
    return { accepted, failure: finalFailure, audit: candidateAudit };
  };

  try {
    const failedWorkOrders = new Set();
    for (let index = 0; index < workOrders.length; index++) {
      if (signal?.aborted) throw recoveryError('推荐返工已取消，旧稿未被覆盖', 'ABORTED');
      const order = workOrders[index];
      const chapter = chapterMap.get(Number(order.chapter));
      const reused = reusableByChapter.get(chapter.idx);
      if (reused) {
        candidateAudits.push(reused);
        candidates.push(reused);
        prospectiveContinuityMap.set(chapter.idx, {
          ...(prospectiveContinuityMap.get(chapter.idx) || chapter),
          text: reused.after,
        });
        emitEvent(onEvent, 'recovery_candidate_reused', {
          runId, chapter: chapter.idx, current: index + 1, total: workOrders.length,
          priorRunId: reused.provenance?.sourceRunId && reused.provenance.sourceRunId !== runId
            ? reused.provenance.sourceRunId : undefined,
        });
        checkpointCandidates();
        continue;
      }
      const ledgerKey = recoveryFailureLedgerKey(order, chapter.text);
      const recentFails = priorRejections.get(ledgerKey) || 0;
      const lifetimeFails = priorRejectionsLifetime.get(ledgerKey) || 0;
      if (recentFails >= FROZEN_REJECTION_THRESHOLD || lifetimeFails >= FROZEN_LIFETIME_THRESHOLD) {
        // 连败止损：不再为已证明"打不过旧稿"的章烧生成与盲审费用；旧稿原样保留。
        const lifetimeDriven = lifetimeFails >= FROZEN_LIFETIME_THRESHOLD && recentFails < FROZEN_REJECTION_THRESHOLD;
        const frozenFailure = {
          chapter: chapter.idx,
          code: RECOVERY_CHAPTER_FROZEN_CODE,
          reason: lifetimeDriven
            ? `第${chapter.idx}章在同一工单与同一份旧稿下累计 ${lifetimeFails} 轮执行均未证明更优，已熔断止损（零模型调用）；只有该章正文改写出新基准，或选择"全部重新诊断"，才会重试`
            : `第${chapter.idx}章在同一工单与同一份旧稿下已被完整执行拒绝 ${recentFails} 轮，未证明过更优，本轮自动跳过止损；下一次有章节成功落盘后会自动解冻再给机会（上下文变好重试胜率更高），也可随时选“全部重新诊断”立即重来`,
          frozenAttempts: Math.max(recentFails, lifetimeFails),
        };
        rejected.push(frozenFailure);
        candidateAudits.push({
          chapter, before: chapter.text, after: '', order,
          status: 'frozen', rejection: frozenFailure, comparisons: [],
          provenance: normalizeCandidateProvenance({
            sourceRunId: runId,
            checkpointRunId: runId,
            sourceDiagnosisFingerprint: String(run.result?.diagnosis_fingerprint || ''),
            sourceWorkOrderFingerprint: recoveryWorkOrderFingerprint(order),
            sourceBeforeHash: candidateTextHash(chapter.text),
            sourceNeighborFingerprint: candidateNeighborFingerprint(prospectiveContinuityMap, chapter.idx),
            contractVersion: RECOVERY_CONTRACT_VERSION,
            validationState: 'frozen',
          }),
        });
        emitEvent(onEvent, 'recovery_chapter_frozen', {
          runId, chapter: chapter.idx, current: index + 1, total: workOrders.length,
          attempts: Math.max(recentFails, lifetimeFails), lifetimeDriven,
        });
        checkpointCandidates();
        failedWorkOrders.add(chapter.idx);
        if (order.action === 'rebuild') {
          const reason = `关键重构章第${chapter.idx}章已在生成前熔断；继续处理其他章也无法整批落盘，已立即止损`;
          emitEvent(onEvent, 'recovery_failed', {
            runId, code: 'RECOVERY_REBUILD_GAP', error: reason, missingChapters: [chapter.idx],
          });
          return failRun(bookId, runId, { rejected, candidates: candidateAudits, reason });
        }
        continue;
      }
      // V0.100.15 依赖阻断只认 rebuild 前章：tune 前章败选=旧稿原样保留，后章读到的滚动
 // 预期与当前正文完全一致，照常生成没有信息损失（实测 ch27 三连小分差败选把 28/30
      // 全部拖死的实证）；rebuild 前章失败才是真正的因果断裂，必须阻断后章。
      const failedDependencies = (order.depends_on || []).map(Number)
        .filter(dependency => failedWorkOrders.has(dependency)
          && workOrders.some(prior => Number(prior.chapter) === dependency && prior.action === 'rebuild'));
      if (failedDependencies.length) {
        const dependencyFailure = {
          chapter: chapter.idx,
          code: 'RECOVERY_DEPENDENCY_GAP',
          reason: `前置关键重构章（第${failedDependencies.join('、')}章）未形成合格候选，本章不能脱离因果依赖继续生成`,
        };
        rejected.push(dependencyFailure);
        failedWorkOrders.add(chapter.idx);
        emitEvent(onEvent, 'recovery_candidate_rejected', { runId, ...dependencyFailure });
        if (order.action === 'rebuild') {
          const reason = `${dependencyFailure.reason}；该章又是关键重构项，整批已立即止损`;
          emitEvent(onEvent, 'recovery_failed', {
            runId, code: 'RECOVERY_REBUILD_GAP', error: reason, missingChapters: [chapter.idx],
          });
          return failRun(bookId, runId, { rejected, candidates: candidateAudits, reason });
        }
        continue;
      }
      let outcome = await processChapterOrder(order, { current: index + 1, total: workOrders.length });
      if (!outcome.accepted) {
        if (order.action === 'rebuild'
          && outcome.failure && TOOL_FAILURE_CODES.has(String(outcome.failure.code || ''))) {
          // rebuild 的工具闸失败（篇幅/形态/文风）是"这版废了"不是"这章不该改"：
          // 重新生成一次（有界），盲审败选不适用此路径。
          emitEvent(onEvent, 'recovery_rewriting', {
            runId, chapter: chapter.idx, current: index + 1, total: workOrders.length, attempt: 2,
          });
          rejected.pop();
          const retry = await processChapterOrder(order, { current: index + 1, total: workOrders.length });
          if (retry.accepted) {
            outcome = retry;
          } else {
            rejected.push(outcome.failure);
          }
        }
      }
      if (!outcome.accepted) {
        failedWorkOrders.add(chapter.idx);
        if (order.action === 'rebuild') {
          const reason = `关键重构章第${chapter.idx}章未形成合格候选；继续生成其余章节也无法整批提交，已立即止损，旧稿全部保留`;
          emitEvent(onEvent, 'recovery_failed', {
            runId, code: 'RECOVERY_REBUILD_GAP', error: reason, missingChapters: [chapter.idx],
          });
          return failRun(bookId, runId, { rejected, candidates: candidateAudits, reason });
        }
      }
    }

    if (!candidates.length) {
      const frozenInRun = rejected.filter(failure => failure.code === RECOVERY_CHAPTER_FROZEN_CODE).length;
      return failRun(bookId, runId, {
        rejected, candidates: candidateAudits,
        reason: `没有任何候选同时通过硬校验与双向盲审${frozenInRun ? `（另有 ${frozenInRun} 章连败已自动冻结跳过）` : ''}；旧稿全部保留`,
      });
    }

    const acceptedChapters = new Set(candidates.map(item => item.chapter.idx));
    const missingRebuilds = workOrders
      .filter(order => order.action === 'rebuild' && !acceptedChapters.has(Number(order.chapter)))
      .map(order => Number(order.chapter));
    if (missingRebuilds.length) {
      const reason = `关键重构章（第${missingRebuilds.join('、')}章）未形成合格候选；为避免半套整改，旧稿全部保留`;
      emitEvent(onEvent, 'recovery_failed', {
        runId, code: 'RECOVERY_REBUILD_GAP', error: reason, missingChapters: missingRebuilds,
      });
      return failRun(bookId, runId, { rejected, candidates: candidateAudits, reason });
    }

    store.recommendationRecoveryRuns.update(runId, {
      status: 'verifying', rejectedChapters: rejected,
      completedChapters: candidates.map(item => item.chapter.idx),
    });
    store.publicationProfiles.upsert(bookId, { recoveryStatus: 'verifying' });
    const candidateByChapter = new Map(candidates.map(item => [item.chapter.idx, item.after]));
    const prospective = chapters.map(chapter => ({
      ...chapter, text: candidateByChapter.get(chapter.idx) || chapter.text,
    }));
    const reviewSegments = planGlobalReviewSegments(prospective, { budgetChars: globalReviewSegmentChars });
    emitEvent(onEvent, 'recovery_global_review', {
      runId, chapters: prospective.length,
      from: prospective[0]?.idx, to: prospective.at(-1)?.idx,
      segments: reviewSegments.length,
    });
 // V0.100.8：整段复核按输入体量分段。全书候选动辄十余万字（本作 1—34 章实测
    // 149,366 字 ≈ 9.3 万输入 token），叠加 mid_story_review 的思考与 10000 输出预算，
    // 一次调用超窗或被掐断会把整批候选判 global_rejected 全部作废。分段后每段独立
    // 判定、后段带前段结论以保留跨段累积判断；任一段 fail 即整批不落盘。
    // V0.100.1：每段仍是"定生死"的调用，结构/证据失败带反馈重答一次，第二次仍错才失败关闭。
    // V0.100.12：每个已通过分段与跨段总复核都立即落检查点。指纹覆盖候选全文、旧诊断、
    // 全范围计划与分段边界；任一输入变化即从零复核，完全相同才从已验证前缀继续。
    const reviewFingerprint = globalReviewCheckpointFingerprint({
      bookTitle: book.title,
      prospective,
      qualityCurve: run.quality_curve || [],
      repairPlan: executionPlan,
      reviewSegments,
    });
    const storedReviewCheckpoint = store.recommendationRecoveryRuns.get(runId)
      ?.result?.global_review_checkpoint;
    const resumedReview = resumableGlobalReviewCheckpoint(
      storedReviewCheckpoint, reviewFingerprint, reviewSegments,
    );
    const segmentVerdicts = [...resumedReview.segments];
    let crossReviewCheckpoint = resumedReview.crossReview;
    let globalReview = passedGlobalReviewFromSegments(segmentVerdicts);
    const persistGlobalReviewCheckpoint = (crossReview = crossReviewCheckpoint) => {
      const current = store.recommendationRecoveryRuns.get(runId);
      store.recommendationRecoveryRuns.update(runId, {
        result: {
          ...(current?.result || {}),
          global_review_checkpoint: {
            contract: GLOBAL_REVIEW_CHECKPOINT_CONTRACT,
            fingerprint: reviewFingerprint,
            completed_segments: segmentVerdicts.length,
            total_segments: reviewSegments.length,
            segments: segmentVerdicts.map(item => ({ ...item })),
            cross_review: crossReview ? { ...crossReview } : null,
          },
        },
      });
    };
    // 零段也是合法前缀：必须在第一个昂贵复核请求前写入当前输入指纹，旧输入检查点不得滞留。
    persistGlobalReviewCheckpoint();
    if (segmentVerdicts.length || crossReviewCheckpoint) {
      emitEvent(onEvent, 'recovery_global_review_resumed', {
        runId,
        completedSegments: segmentVerdicts.length,
        totalSegments: reviewSegments.length,
        crossSegmentPassed: !!crossReviewCheckpoint,
      });
    }
    for (let index = segmentVerdicts.length; index < reviewSegments.length; index++) {
      const segment = reviewSegments[index];
      const priorConclusions = segmentVerdicts.map(item => `第${item.from}—${item.to}章：${item.verdict === 'pass' ? '通过' : '否决'}（${item.reason}）`);
      const precedingSegment = index > 0 ? reviewSegments[index - 1] : null;
      const precedingTail = precedingSegment
        ? String(precedingSegment.at(-1)?.text || '').slice(-500)
        : '';
      emitEvent(onEvent, 'recovery_global_review_segment', {
        runId, segment: index + 1, segments: reviewSegments.length,
        from: segment[0]?.idx, to: segment.at(-1)?.idx,
      });
      const { value: segmentReview } = await runStructuredWithOneCorrection({
        label: `推荐返工整段复核（第${index + 1}/${reviewSegments.length}段）`,
        instruction: recommendationRecoveryGlobalReviewInstruction({
          bookTitle: book.title, chapters: segment,
          // 旧诊断索引给全量（很小）：分段只裁剪正文，不裁剪整段图景。
          qualityCurve: run.quality_curve || [],
          segmentIndex: index + 1, segmentCount: reviewSegments.length,
          priorConclusions, precedingTail,
        }),
        runRequest: (content, { isCorrection = false } = {}) => runTaskImpl({
          task: isCorrection ? 'audit_repair' : 'mid_story_review', bookId, jsonMode: true, signal,
          onRetry: recoveryRetryHandler(onEvent, { runId, stage: 'global_review', segment: index + 1 }),
          messages: assembleReviewMessages(bookId, [{ role: 'user', content }]),
        }),
        validate: parsed => validateGlobalReview(parsed, segment),
        onCorrection: (error, attempt) => emitEvent(onEvent, 'recovery_validation_retry', {
          runId, stage: 'global_review', segment: index + 1, attempt: attempt + 1, reason: error.message,
        }),
      });
      const segmentVerdict = {
        segment: index + 1,
        from: segment[0]?.idx ?? null,
        to: segment.at(-1)?.idx ?? null,
        verdict: segmentReview.verdict,
        sustained_progression: segmentReview.sustained_progression,
        reason: segmentReview.reason,
        evidence: segmentReview.evidence,
        residual_risks: segmentReview.residual_risks,
      };
      segmentVerdicts.push(segmentVerdict);
      const failedSegment = segmentReview.verdict !== 'pass' || segmentReview.sustained_progression !== true;
      if (failedSegment) {
        globalReview = {
          // verdict 与 sustained_progression 是一份裁决的两个字段；模型若返回矛盾的
          // “pass + false”，领域层必须失败关闭并标 global_rejected，不能留下可续跑的
          // local_passed 候选。原始 verdict 另存供排障。
          verdict: 'fail',
          modelVerdict: segmentReview.verdict,
          sustained_progression: false,
          evidence: segmentReview.evidence,
          reason: segmentReview.reason,
          residual_risks: segmentReview.residual_risks,
          segments: [...segmentVerdicts],
          failedSegment: index + 1,
        };
        break;
      }
      globalReview = passedGlobalReviewFromSegments(segmentVerdicts);
      crossReviewCheckpoint = null;
      persistGlobalReviewCheckpoint(null);
      emitEvent(onEvent, 'recovery_global_review_checkpoint_saved', {
        runId,
        completedSegments: segmentVerdicts.length,
        totalSegments: reviewSegments.length,
      });
    }
    // 分段只解决输入超窗，不得把多个局部 pass 直接当作全局 pass。所有段各自通过后，
    // 再用“已定位证据 + 每段首尾边界 + 全范围 repair_plan”做一次小上下文总复核，
    // 专门拦截跨段角色状态、保护事实和因果交接断裂。
    if (reviewSegments.length > 1
      && globalReview?.verdict === 'pass'
      && globalReview?.sustained_progression === true) {
      if (crossReviewCheckpoint) {
        globalReview = { ...crossReviewCheckpoint, segments: [...segmentVerdicts] };
      } else {
        const crossSegmentInput = segmentVerdicts.map((verdict, index) => ({
          ...verdict,
          entry_excerpt: String(reviewSegments[index]?.[0]?.text || '').slice(0, 500),
          exit_excerpt: String(reviewSegments[index]?.at(-1)?.text || '').slice(-500),
        }));
        emitEvent(onEvent, 'recovery_global_review_cross_segment', {
          runId, segments: reviewSegments.length,
          from: prospective[0]?.idx, to: prospective.at(-1)?.idx,
        });
        const { value: crossReview } = await runStructuredWithOneCorrection({
          label: '推荐返工跨段总复核',
          instruction: recommendationRecoveryCrossSegmentReviewInstruction({
            bookTitle: book.title,
            segments: crossSegmentInput,
            repairPlan: executionPlan,
          }),
          runRequest: (content, { isCorrection = false } = {}) => runTaskImpl({
            task: isCorrection ? 'audit_repair' : 'mid_story_review', bookId, jsonMode: true, signal,
            onRetry: recoveryRetryHandler(onEvent, { runId, stage: 'cross_segment_review' }),
            messages: assembleReviewMessages(bookId, [{ role: 'user', content }]),
          }),
          validate: parsed => validateCrossSegmentReview(parsed, prospective),
          onCorrection: (error, attempt) => emitEvent(onEvent, 'recovery_validation_retry', {
            runId, stage: 'cross_segment_review', attempt: attempt + 1, reason: error.message,
          }),
        });
        const crossFailed = crossReview.verdict !== 'pass'
          || crossReview.sustained_progression !== true
          || crossReview.segment_consistency !== true;
        globalReview = {
          ...crossReview,
          verdict: crossFailed ? 'fail' : 'pass',
          sustained_progression: crossFailed ? false : true,
          segments: [...segmentVerdicts],
          ...(crossFailed ? { failedStage: 'cross_segment' } : {}),
        };
        if (!crossFailed) {
          crossReviewCheckpoint = { ...crossReview };
          persistGlobalReviewCheckpoint(crossReviewCheckpoint);
          emitEvent(onEvent, 'recovery_global_review_checkpoint_saved', {
            runId,
            completedSegments: segmentVerdicts.length,
            totalSegments: reviewSegments.length,
            crossSegmentPassed: true,
          });
        }
      }
    }
    if (globalReview.verdict !== 'pass' || globalReview.sustained_progression !== true) {
      const globalFailure = {
        chapter: null, code: 'RECOVERY_GLOBAL_REVIEW_FAILED', reason: globalReview.reason,
      };
      const failureLocation = globalReview.failedStage === 'cross_segment'
        ? '跨段总复核'
        : `第${globalReview.failedSegment}段`;
      return failRun(bookId, runId, {
        globalReview, rejected: [...rejected, globalFailure], candidates: candidateAudits,
        reason: `整段推进复核未通过（${failureLocation}）；全部候选保留在运行记录中，旧稿未覆盖`,
      });
    }

    // 整段通过是独立于单章盲审的第二道状态；先落检查点，再进行可能失败的影子投影。
    // 即使投影/原子提交随后出错，恢复时也能区分“局部通过”和“整段已通过”。
    for (const candidate of candidates) setCandidateValidationState(candidate, 'global_passed', runId);
    checkpointCandidates();

    // V0.100：不再逐章“换正文 + 旧状态改 hash”。所有候选先进入 shadow projection，
    // 全书摘要/事实/人物/时间线/伏笔/记忆/章纲均可回放后，才在单事务一起切换。
    // 原子提交一旦完成便不可再声称“取消且旧稿保留”，所以在进入该边界前最后检查一次。
    if (signal?.aborted) throw recoveryError('推荐返工已取消，旧稿未被覆盖', 'ABORTED');
    emitEvent(onEvent, 'recovery_state_rebuild', { runId, chapters: chapters.length });
    const rewrites = new Map(candidates.map(candidate => [candidate.chapter.id, candidate.after]));
    const narrativeRevision = await narrativeRevisionImpl(bookId, {
      rewrites,
      reason: `推荐评估失败返工 ${run.start_chapter}-${run.end_chapter} 章`,
      projectionImpl,
      signal,
      onEvent: event => emitEvent(onEvent, event.type || 'narrative_state', { runId, ...event }),
    });
    const lessons = activateRecoveryLessons(bookId, run, candidates, globalReview, narrativeRevision);
    const applied = candidates.map(candidate => ({
      chapter: candidate.chapter.idx, chapterId: candidate.chapter.id, title: candidate.chapter.title,
      before: candidate.before, after: store.chapters.fullText(candidate.chapter.id),
      prose: candidate.prose, comparisons: candidate.comparisons,
      ok: true, afterHash: createHash('sha256').update(store.chapters.fullText(candidate.chapter.id)).digest('hex'),
      narrativeRevisionId: narrativeRevision.revisionId,
    }));
    for (const candidate of candidates) {
      candidate.status = 'applied';
      setCandidateValidationState(candidate, 'applied', runId);
    }
    const serializedCandidates = serializeCandidateAudits(candidateAudits, { checkpointRunId: runId });
    const appliedChapters = new Set(applied.map(item => Number(item.chapter)));
    const unresolvedChapters = workOrders
      .map(order => Number(order.chapter))
      .filter((chapter, index, all) => !appliedChapters.has(chapter) && all.indexOf(chapter) === index)
      .sort((left, right) => left - right);
    const completion = unresolvedChapters.length ? 'partial' : 'complete';
    const result = {
      applied, rejected, globalReview, snapshotId: snapshot.id, narrativeRevision, lessons,
      completion,
      unresolvedChapters,
      candidateStatsByValidation: candidateStatsByValidation(serializedCandidates),
      candidates: serializedCandidates,
    };
    store.recommendationRecoveryRuns.update(runId, {
      status: 'completed', completedChapters: applied.map(item => item.chapter), rejectedChapters: rejected,
      result, error: '',
    });
    store.publicationProfiles.upsert(bookId, { recoveryStatus: 'completed' });
    emitEvent(onEvent, 'recovery_completed', {
      runId, applied: applied.map(item => item.chapter), rejected, globalReview,
      completion, unresolvedChapters,
    });
    return result;
  } catch (error) {
    if (isRecoveryCancellation(error, signal)) {
      throw persistRecoveryCancellation(bookId, runId, {
        error, onEvent, rejected, candidates: candidateAudits,
      });
    }
    failRun(bookId, runId, {
      rejected, candidates: candidateAudits, reason: error.message,
    });
    emitEvent(onEvent, 'recovery_failed', { runId, code: error.code || 'ERROR', error: error.message });
    throw error;
  }
}

// ---- 公开契约：转出搬入子模块的符号（共 19 个导出，名字不变）----
export {
  annotateRecoveryRunsResumability,
} from './recovery_checkpoint.js';
export {
  GLOBAL_REVIEW_SEGMENT_CHARS,
  mergeCandidateAudits,
  planGlobalReviewSegments,
  repeatedRebuildLossContext,
} from './recovery_global_review.js';
export {
  buildRecoveryRegenFeedback,
  buildRecoveryRewriteCorrection,
  buildRecoveryRewriteWindow,
  candidateClearlyWins,
  comparisonsAcceptCandidate,
  validateRecoveryProseImprovement,
} from './recovery_rewrite.js';
export {
  baselineRiskForChapter,
  compileRecoveryPlan,
  validateBlindComparison,
  validateRecoveryDiagnosis,
  validateRecoverySynthesis,
} from './recovery_validation.js';
