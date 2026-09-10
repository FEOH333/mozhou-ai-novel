// server/engine/pipeline.js —— 章节写作管线编排（细纲→正文→审校→质量债务处理→覆盖→结算）
'use strict';
import * as store from '../db/store.js';
import { generateChapterOutline } from './outline.js';
import { writeScene } from './write.js';
import { auditChapter, coverageCheck, reviseScene } from './audit.js';
import { settleChapter } from './settle.js';
import { recordChapterHealth, detectDrift } from './recovery.js';
import { checkArchiveNeed } from './archive.js';
import { registerHooksFromOutline, auditPleasure, schedulerCheck, buildPleasureContext, settleHookLedger } from './pleasure.js';
import { batchQualityScan } from './batch_scan.js'; // V0.95：三章一轮批次自检
import { getGlobal } from '../config.js';
import { attractionGate } from './attraction.js'; // V0.80 逐章吸引力质量门
import { attractionRevisionNote } from './prompts.js'; // V0.91 历史文阅读回报修订分流
import { captureChapterDraft, restoreChapterDraft, recoverInterruptedScenes } from './data_safety.js'; // V0.91 重规划失败保留旧稿
import { syncHistoricalProtagonistState } from './historical_state.js';
import { isCompletedChapter, hasExplicitCompletedStatus, transitionChapterStatus } from './chapter_status.js'; // V0.93.1：完成态单一真源 // V0.93.2：状态写入单一真源
import { checkChapterLength } from './rules.js'; // V0.93.2：短章下限确定性防线
import { fulfillOpeningReaderContract } from './opening_intervention.js';
import { ensureNarrativeStateReady } from './narrative_state.js';
import { stampOpeningTimelineProseFix, isImmediateReplanIssue } from './historical_guardrails.js';
import { markNarrativeLessonsUsed } from './narrative_lessons.js';

// V0.78 细纲根因类型：设定冲突/时间线/角色矛盾/事实编造/事实矛盾/大纲偏离——正文修订
// 解决不了（源于细纲设计与既定事实冲突），high 级时应 replan 重生成细纲而非 revise 正文。
// V0.82：史实错误（历史题材：事件提前/人物写错生死/可改史点越界/胜利无代价）同为细纲根因。
export const OUTLINE_ROOT_ISSUES = ['设定冲突', '时间线冲突', '角色矛盾', '事实编造', '事实矛盾', '大纲偏离', '史实错误'];

/** 正文中可精确定位、只需统一数字口径的事实矛盾不值得推倒整章。 */
export function isLocalizedNumericMismatch(issue) {
  if (issue?.type !== '事实矛盾' || issue?.severity !== 'high' || !String(issue.quote || '').trim()) return false;
  const diagnosis = `${issue.issue || ''} ${issue.fix || ''}`;
  const mentionsQuantity = /数量|数字|口径|[一二三四五六七八九十百两0-9]+(?:骑|人|名|匹|支|队|处|次|个)/.test(diagnosis);
  const givesLocalFix = /统一|改为|改成|删去|删除|更正|校正|替换/.test(String(issue.fix || ''));
  return mentionsQuantity && givesLocalFix;
}

/**
 * 已有草稿时，软细纲标签不得清场（V0.102.16）。
 * 立刻清场仅：硬根因（未登记/史实错误/重做细纲/遗体），或无正文时的细纲根因。
 */
export function shouldImmediateReplanWipe(audit, { hasDraft = false } = {}) {
  const issues = stampOpeningTimelineProseFix(audit?.issues || []);
  if (issues.some(isImmediateReplanIssue)) return true;
  if (!hasOutlineRootIssue({ ...audit, issues })) return false;
  if (!hasDraft) return true;
  return false;
}

/** 审校 fix 的处理路径：high 细纲根因重规划；medium/high 客观问题局部修订；软提示记债。 */
export function auditIssueRepairMode(audit) {
  const normalized = normalizeAuditForRepair({ ...audit, verdict: 'fix' });
  if (audit?.verdict !== 'fix') return 'none';
  if (hasOutlineRootIssue(normalized)) return 'replan';
  const actionable = (normalized?.issues || []).some(issue =>
    issue?.severity === 'high' || issue?.severity === 'medium');
  return actionable ? 'revise' : 'defer';
}

/**
 * 审校结果入管线前的单一入口：开篇/接续标记类时间线打 proseFix；
 * LLM 直接判 replan 但没有真正细纲根因时降为 fix，避免已写五场被清稿。
 */
export function normalizeAuditForRepair(audit) {
  if (!audit) return audit;
  const issues = stampOpeningTimelineProseFix(audit.issues || []);
  const next = { ...audit, issues };
  if (next.verdict === 'replan' && !hasOutlineRootIssue(next)) {
    return { ...next, verdict: 'fix' };
  }
  return next;
}

/** 修订预算耗尽后的收敛策略：medium 残差与正文可修 high 记债；真正的细纲硬伤继续拦截。 */
export function auditVerdictAfterBudget(audit) {
  if (audit?.verdict !== 'fix') return audit;
  const issues = stampOpeningTimelineProseFix(audit.issues || []);
  const hasBlockingHigh = issues.some(isImmediateReplanIssue);
  return hasBlockingHigh ? { ...audit, issues } : { ...audit, issues, verdict: 'defer' };
}

/**
 * 自动写完整一章（AI 本位：默认全自动，质量债务不阻断）。
 * 步骤：细纲（若缺，含五问自检）→ 逐场景正文（长度自愈）→ 审校（accept/fix/defer/replan）→
 *       fix 自动修订（≤maxReviseRounds）→ replan 重生成细纲 → 覆盖校验 → 结算。
 * 质量债务：defer/低严重度问题记入 conflicts 表（audit 已落库），继续流程，不暂停。
 * @param {string} bookId @param {string} chapterId
 * @param {object} [opts] { onEvent, signal, autoConfirm }
 */
export async function runChapterFlow(bookId, chapterId, opts = {}) {
  const { onEvent, signal, autoConfirm: autoConfirmArg, resilience } = opts;
  const g = getGlobal();
  const bookSettings = store.books.settings(bookId);
  // AI 本位：默认自动确认（V0.15 起）
  const autoConfirm = autoConfirmArg ?? bookSettings.autoConfirmOutline ?? g.autoConfirmOutline ?? true;
  const maxRevise = bookSettings.maxReviseRounds ?? g.maxReviseRounds ?? 2;

  const emit = (type, data) => onEvent?.({ type, ...data });

  // 完成章正文若已换版，旧摘要/角色/伏笔/时间线不能继续喂给下一章。
  // 失配/陈旧/覆盖缺口由自动创作就地重建，不得把 need_human 当终态。
  await ensureNarrativeStateReady(bookId, {
    signal,
    onEvent: event => emit(event.type || 'stage', event),
  });

  // 章纲的 year/era_year/protagonist_age 是历史长篇权威坐标。先同步人物投影，
  // 避免审校把“第9章12岁”和上一阶段残留的“9岁”互判为角色矛盾并整章重写。
  syncHistoricalProtagonistState(bookId, chapterId);

  // 用户暂停或进程退出可能把场景留在 writing；续跑前只归位状态，不清空任何正文。
  const interrupted = recoverInterruptedScenes(chapterId);
  if (interrupted.recovered) {
    emit('stage', { stage: 'recovery', message: `已恢复 ${interrupted.recovered} 个暂停中的场景，将从安全断点续写` });
  }

  // V0.78 修复：旧章已完成保护——章节全部 done/revised 场景有定稿正文且已有摘要或结算指纹时，
  // 说明是历史遗留的"已写但状态异常（如 planned/revised）"章节（如数据修复后 ch1）。
  // 这类章节不应被自动创作当"待写新章"重跑审校/结算，否则会反复审校第一章、
  // 且其正文与当前上下文严重脱节导致质量门永远不过 → 死循环卡住。
  // 依据：有摘要或 settlement 说明曾被结算过；场景全完成说明正文完整。
  // V0.93.1：判定收敛到 chapter_status.isCompletedChapter 单一真源（语义等价，
  // 并额外要求每场景正文非空，防止 done 空场景被误判为完整）。
  const chapterRow = store.chapters.get(chapterId);
  if (isCompletedChapter(chapterRow)) {
    // 状态归位为 done（不重跑审校/结算/抽取，避免重复消费），直接放行
    if (!hasExplicitCompletedStatus(chapterRow)) {
      transitionChapterStatus(bookId, chapterId, 'done', { reason: '旧章归位放行' });
    }
    return { status: 'done', skipped: true, outline: store.chapters.outline(chapterId) };
  }

  // 1) 细纲（含写前五问自检，未通过自动重生成）
  let outline = store.chapters.outline(chapterId);
  const outlineState = outline?._narrative_revision?.state;
  if (!outline?.scenes?.length || outlineState === 'stale') {
    emit('stage', {
      stage: 'outline',
      message: outlineState === 'stale'
        ? '前文已换版，重新生成本章细纲并对齐最新叙事状态…'
        : '生成章细纲（含套路自检）…',
    });
    outline = await generateChapterOutline(bookId, chapterId, { onEvent, signal });
    syncHistoricalProtagonistState(bookId, chapterId);
    emit('outline_done', { outline });
    if (!autoConfirm) {
      emit('need_confirm', { message: '细纲已生成，等待确认', outline });
      return { status: 'awaiting_confirm', outline };
    }
  }

  // 2) 确保场景行存在 + 登记期待账本（new_hooks/ending_hook → pleasure_hooks）
  ensureSceneRows(chapterId, outline);
  const registeredHooks = registerHooksFromOutline(bookId, outline, store.chapters.get(chapterId).idx);
  if (registeredHooks.length) emit('hooks_registered', { hooks: registeredHooks });

  // 3) 逐场景正文（修订后需重写被重置的后续场景）
  const failedScenes = [];
  const writePendingScenes = async (label) => {
    const scs = store.scenes.list(chapterId);
    for (const scene of scs) {
      if (signal?.aborted) throw abortError();
      if (scene.status === 'done' || scene.status === 'revised') continue;
      emit('stage', { stage: 'write', message: `${label}：写作场景 ${scene.idx}/${scs.length}…` });
      try {
        const r = await writeScene(bookId, chapterId, scene.id, {
          onDelta: d => emit('delta', { sceneId: scene.id, delta: d }),
          onUsage: u => emit('usage', { ...u, sceneId: scene.id }),
      onUsageCost: c => emit('usage_cost', c),
          onProgress: p => emit('progress', p),
          onRetry: info => emit('api_retry', { sceneId: scene.id, attempt: info.attempt, reason: info.reason, message: info.message }),
          resilience,
          signal,
        });
        // V0.21：携带最终全文，前端在流式重试后全量替换场景框（防 delta 错位）
        emit('scene_done', { sceneId: scene.id, wordCount: r.content.length, content: r.content, healed: !!r.healed });
      } catch (e) {
        // V0.21 场景级降级：单场景失败不中断整章——标记失败、继续写后续场景，
        // 重跑 runChapterFlow 时 failed/draft 场景自动补写（writeScene 已记债/存草稿）
        // V0.29：失败后自动重试一次（草稿续写路径），仍失败才跳过
        if (e.code === 'ABORTED') throw e;
        if (failedScenes.length === 0 && !e._retried) {
          e._retried = true; // V0.73：显式标记已重试（此前从未赋值，靠 failedScenes 巧合控制）
          emit('stage', { stage: 'write', message: `场景 ${scene.idx} 生成中断（${e.message.slice(0, 50)}），自动重试一次…` });
          try {
            const r2 = await writeScene(bookId, chapterId, scene.id, {
              onDelta: d => emit('delta', { sceneId: scene.id, delta: d }),
              onUsage: u => emit('usage', { ...u, sceneId: scene.id }),
      onUsageCost: c => emit('usage_cost', c),
              onProgress: p => emit('progress', p),
              onRetry: info => emit('api_retry', { sceneId: scene.id, attempt: info.attempt, reason: info.reason, message: info.message }),
              resilience,
              signal,
            });
            emit('scene_done', { sceneId: scene.id, wordCount: r2.content.length, content: r2.content, healed: !!r2.healed });
            // 重试成功只结束当前场景的失败处理，不能退出整个写作循环。
            // 否则后续场景会保持 planned，却仍继续审校、结算并把章节标成 done。
            continue;
          } catch (e2) {
            if (e2.code === 'ABORTED') throw e2;
            e = e2;
          }
        }
        failedScenes.push(scene.idx);
        emit('scene_failed', { sceneId: scene.id, idx: scene.idx, error: e.message });
        if (failedScenes.length <= 3) emit('stage', { stage: 'write', message: `场景 ${scene.idx} 生成失败（${e.message.slice(0, 60)}），已跳过，继续后续场景…` });
      }
    }
  };
  await writePendingScenes('开始写作');

  // 正文完整性是审校与结算的前置条件。允许继续写后续场景以保住已生成内容，
  // 但只要仍有 failed/draft/planned 场景，就绝不能抽取事实或把章节伪装成完成。
  const incompleteScenes = store.scenes.list(chapterId)
    .filter(scene => scene.status !== 'done' && scene.status !== 'revised');
  if (incompleteScenes.length) {
    const incompleteIndexes = [...new Set(incompleteScenes.map(scene => scene.idx))].sort((a, b) => a - b);
    transitionChapterStatus(bookId, chapterId, 'partial', { reason: '场景未完成，禁止伪装完成' });
    recordChapterHealth(bookId, chapterId, {
      verdict: 'error',
      issues: [],
      failed: true,
      note: `本章 ${incompleteIndexes.length} 个场景未完成，尚未审校与结算`,
      wordCount: store.chapters.get(chapterId)?.word_count || 0,
    });
    emit('chapter_partial', {
      failedScenes: incompleteIndexes,
      message: `本章有 ${incompleteIndexes.length} 个场景生成失败，已保留其余正文；自动续跑将只补缺失场景，补齐前不会审校或结算。`,
    });
    return {
      status: 'partial',
      registeredHooks,
      failedScenes: incompleteIndexes,
    };
  }

  // 4) 审校（多档判定）
  emit('stage', { stage: 'audit', message: '一致性审校…' });
  // V0.96：审校用量透传（本次运行统计条不再只算正文写作）
  const usageCb = { onUsage: u => emit('usage', u), onUsageCost: c => emit('usage_cost', c) };
  let audit = normalizeAuditForRepair(await auditChapter(bookId, chapterId, { signal, streamCb: usageCb }));
  emit('audit_done', { issues: audit.issues, verdict: audit.verdict, grade: audit.grade });

  // 5) 质量债务处理循环
  let reviseRound = 0;
  let replanRound = 0; // V0.62：replan 也受轮数限制（此前不计数 → 无限 replan 死循环隐患）
  let preReplanDraft = null; // V0.91：首次重规划前的完整基线；所有候选均未过门时恢复它
  // medium 客观问题通常是局部遗漏/前后措辞冲突（实书 ch2 刀具归属、ch3 护身符遗漏），
  // 应修正文而非 0 轮跳出；high 细纲根因仍由上面的 replan 分支处理。
  const locallyRepairable = i =>
    (i.severity === 'high' || i.severity === 'medium')
    && (i.proseFix // V0.95.7：本地形态问题（跨年开篇/场景尾复述）可修订解决
      || !(i.severity === 'high' && OUTLINE_ROOT_ISSUES.includes(i.type) && !isLocalizedNumericMismatch(i)));
  const normQuote = (q) => String(q || '').replace(/\s/g, '').slice(0, 20);
  // V0.62 修订有效性：上轮修过的 quote 本轮再出现同款 high → 修订无效，升级 replan
  let lastFixedQuotes = new Set();
  // V0.78 修复：修订不收敛——审校模型对同一问题每轮 quote 措辞不同（引用正文不同片段），
  // 仅靠 quote 前 20 字符匹配会漏判，导致"事实编造/设定冲突"这类细纲根因问题反复修订无效、
  // 死循环卡住（实测 ch119：细纲要求写未登记角色"老幺"，正文修订删了它审校又报 → 无限循环）。
  // 升级为"问题类型"级跟踪：同一类型 high 问题连续 ≥2 轮出现 → 判定正文修订无效 → replan。
  const issueTypeKey = (i) => `${i.type || '未知'}|${i.severity || 'low'}`;
  let prevHighTypes = new Set(); // 上一轮的 high 问题类型
  let prevSceneHigh = new Map(); // type|sceneIdx → 出现轮数
  const sceneIdxOf = (issue, scenes) => {
    const q = normQuote(issue.quote);
    const scene = scenes.find(s => normQuote(s.content).includes(q));
    return scene ? scene.idx : (issue._sceneIdx || 0);
  };
  while (reviseRound < maxRevise) {
    // replan：细纲与事实冲突严重 → 重生成细纲并重写本章
    if (audit.verdict === 'replan') {
      replanRound++;
      if (replanRound >= Math.max(2, maxRevise)) {
        // V0.91：候选始终未通过，不得以失败候选覆盖基线正文。
        if (preReplanDraft?.hasContent) {
          restoreChapterDraft(preReplanDraft, { reason: `连续${replanRound}轮重规划未通过` });
          outline = store.chapters.outline(chapterId);
          emit('replan_rollback', { chapterId, message: `连续 ${replanRound} 轮重规划未通过，已恢复重规划前完整正文` });
        }
        emit('debt', { message: `本章 ${replanRound} 轮重规划仍未通过，已保留重规划前内容并记债（避免死循环和清稿）` });
        break;
      }
      emit('stage', { stage: 'revise', message: `细纲与前情冲突，重新规划本章（第 ${replanRound} 轮）…` });
      if (!preReplanDraft) preReplanDraft = captureChapterDraft(chapterId);
      // 先取旧场景最小 history_seq（必须在 clear 之前），重写历史
      const oldScenes = store.scenes.list(chapterId);
      const oldFirstSeq = oldScenes.map(s => s.history_seq).filter(Boolean).sort((a, b) => a - b)[0];
      // V0.78：把上次审校的冲突原因传给细纲生成，避免重规划又引入同一问题（如未登记角色"老幺"）
      const replanReason = (audit.issues || []).slice(0, 5)
        .map(i => `- [${i.type}] ${i.issue}（引用：${(i.quote || '').slice(0, 40)}）`)
        .join('\n');
      try {
        outline = await generateChapterOutline(bookId, chapterId, { onEvent, signal, replanReason });
        syncHistoricalProtagonistState(bookId, chapterId);
        store.scenes.clear(chapterId);
        ensureSceneRows(chapterId, outline);
        if (oldFirstSeq) store.history.truncateFrom(bookId, oldFirstSeq, '细纲重规划');
        emit('outline_done', { outline, replanned: true });
        const failuresBefore = failedScenes.length;
        await writePendingScenes('重新规划后写作');
        const incompleteAfterReplan = store.scenes.list(chapterId)
          .filter(scene => scene.status !== 'done' && scene.status !== 'revised');
        if (incompleteAfterReplan.length || failedScenes.length > failuresBefore) {
          const error = new Error(`重规划候选有 ${incompleteAfterReplan.length || failedScenes.length - failuresBefore} 个场景未完成`);
          error.code = 'REPLAN_CANDIDATE_INCOMPLETE';
          throw error;
        }
        audit = normalizeAuditForRepair(await auditChapter(bookId, chapterId, { signal, streamCb: usageCb }));
      } catch (error) {
        if (preReplanDraft?.hasContent) {
          restoreChapterDraft(preReplanDraft, { reason: `重规划候选失败：${error.message}` });
          outline = store.chapters.outline(chapterId);
          emit('replan_rollback', { chapterId, message: '重规划候选失败，已完整恢复旧正文与旧细纲' });
        }
        throw error;
      }
      emit('audit_done', { issues: audit.issues, verdict: audit.verdict, grade: audit.grade, round: reviseRound });
      // V0.78：重规划后是新细纲新正文，重置修订失效计数（避免旧问题类型误判）
      prevHighTypes = new Set();
      prevSceneHigh = new Map();
      continue;
    }
    // V0.78：细纲根因 high → replan。V0.102.15：已有草稿时，除未登记/重做细纲/遗体外先修订一轮。
    if (auditIssueRepairMode(audit) === 'replan') {
      const hasDraft = store.scenes.list(chapterId).some(s => String(s.content || '').trim());
      if (shouldImmediateReplanWipe(audit, { hasDraft, reviseRound })) {
        const sample = audit.issues.find(i => i.severity === 'high' && OUTLINE_ROOT_ISSUES.includes(i.type));
        emit('stage', { stage: 'revise', message: `细纲设计与既定事实冲突（${sample?.type}），重新规划本章…` });
        audit = { verdict: 'replan', issues: audit.issues };
        continue;
      }
      audit = {
        ...audit,
        issues: stampOpeningTimelineProseFix(audit.issues || []).map(issue => (
          issue?.severity === 'high' && OUTLINE_ROOT_ISSUES.includes(issue?.type)
            && !issue?.proseFix && !isImmediateReplanIssue(issue)
            ? { ...issue, proseFix: true }
            : issue
        )),
      };
    }
    // fix：自动修订文本级问题
    if (audit.verdict === 'fix') {
      const fixable = audit.issues.filter(locallyRepairable);
      const serious = audit.issues.filter(i => !locallyRepairable(i) && i.severity === 'high');
      if (!fixable.length) {
        // 只有 low 软提示时必须显式改成 defer；不能保留 fix 穿透到质量失败闸。
        emit('debt', { message: '本章只剩低严重度提示，已记债由后续章节/卷体检处理' });
        audit = { ...audit, verdict: 'defer' };
        break;
      }
      // V0.62 修订有效性：上轮修过的 high 问题（同 quote）本轮仍在 → 修订无效，升级 replan 重写
      const scenes = store.scenes.list(chapterId);
      const staleHighByQuote = audit.issues.filter(i => i.severity === 'high' && lastFixedQuotes.has(normQuote(i.quote)));
      // V0.78 修订有效性升级：同一类型 high 问题在连续多轮修订后仍未消除 → 判定正文修订无效
      // （可能根因在细纲设计，如要求写未登记角色"老幺"），升级 replan 重生成细纲。
      const staleInfo = isRevisionStale({
        audit,
        lastFixedQuotes,
        prevHighTypes,
        prevSceneHigh,
        scenes,
        quoteOf: normQuote,
      });
      const staleHigh = staleInfo.staleHigh;
      if (staleHigh.length || staleInfo.typeRepeatAndSceneRepeat) {
        const sample = staleHigh[0] || audit.issues.find(i => i.severity === 'high');
        emit('stage', { stage: 'revise', message: `第 ${reviseRound + 1} 轮修订后同类问题仍存在（${sample?.type || '未知'}），升级为重新规划本章…` });
        audit = { verdict: 'replan', issues: audit.issues };
        continue;
      }
      // V0.78 彻底修复：纯文本级问题（语句质量/文学性 = AI 味词高频，如 ch121 的"缓缓×5/微微×5"）
      // 修订 1 轮后仍无法消除（模型重写后 AI 味词又冒出来，3 轮死循环）→ 记债放行，不再死磕。
      // AI 味是可接受的小瑕疵，不该让整章卡死；细纲根因问题不受影响（走上面的 replan 分支）。
      const textOnly = fixable.length > 0 && serious.length === 0
        && fixable.every(i => i.type === '语句质量' || i.type === '文学性');
      if (textOnly && reviseRound >= 1 && fixable.length <= 5) {
        emit('debt', { message: `本章 ${fixable.length} 处 AI 味文本问题经 ${reviseRound} 轮修订仍存在，已记债由后续卷体检/打磨处理（不阻塞章节完成）` });
        audit = { ...audit, verdict: 'defer', issues: audit.issues };
        break;
      }
      reviseRound++;
      lastFixedQuotes = new Set(fixable.map(i => normQuote(i.quote)));
      // V0.78：记录本轮 high 类型（供下轮失效判定）
      prevHighTypes = new Set(staleInfo.currHighTypes);
      const nextSceneHigh = new Map();
      for (const i of audit.issues) {
        if (i.severity !== 'high') continue;
        const k = `${issueTypeKey(i)}@${sceneIdxOf(i, scenes)}`;
        nextSceneHigh.set(k, (prevSceneHigh.get(k) || 0) + 1);
      }
      prevSceneHigh = nextSceneHigh;
      const groups = groupIssuesByScene(scenes, fixable);
      emit('stage', { stage: 'revise', message: `第 ${reviseRound} 轮修订（${fixable.length} 处可修问题，涉及 ${groups.length} 个场景）…` });
      // 同轮问题按场景分别做最小修订。这里禁止级联清空后续场景：所有命中的场景都会独立修，
      // 再由统一复审检查跨场景一致性，避免“修场景1时抹掉刚修好的场景2”以及整章反复重写。
      for (const group of groups) {
        const live = resolveLiveScene(chapterId, group.scene);
        if (!live?.id) {
          emit('debt', { message: `修订跳过缺失场景（idx=${group.scene?.idx ?? '?'}），保留其余正文` });
          continue;
        }
        await reviseScene(bookId, chapterId, live.id, {
          issues: group.issues,
          extraNote: serious.length ? `另有必须注意的事实级问题（不修改正文，后续章节圆场）：${serious.map(s => s.issue).join('；')}` : '',
          signal,
          resetFollowing: false,
          sceneIdx: live.idx,
          streamCb: { onDelta: d => emit('delta', { sceneId: live.id, delta: d }), onUsage: u => emit('usage', u), onUsageCost: c => emit('usage_cost', c) },
        });
        emit('revise_done', { round: reviseRound, sceneId: live.id });
      }
      audit = normalizeAuditForRepair(await auditChapter(bookId, chapterId, { signal, streamCb: usageCb }));
      emit('audit_done', { issues: audit.issues, verdict: audit.verdict, grade: audit.grade, round: reviseRound });
      continue;
    }
    // accept / defer：通过（defer 问题已落 conflicts 表记债）
    break;
  }

  // medium 残差不应在预算耗尽后永久卡章；high 硬伤仍严格阻断。
  const convergedAudit = auditVerdictAfterBudget(audit);
  if (convergedAudit?.verdict === 'defer' && audit?.verdict === 'fix') {
    emit('debt', { message: `本章经 ${reviseRound} 轮修订后只剩可记债问题（中低或正文可修 high），已放行；无 proseFix 的 high 仍拦截` });
  }
  audit = convergedAudit;

  // 自动修订/重规划达到预算后仍未通过，绝不能继续结算并伪装成 done。
  if (!['accept', 'defer'].includes(audit.verdict)) {
    throw blockQualityGate(bookId, chapterId, {
      code: 'QUALITY_GATE_FAILED',
      message: `章节审校在 ${Math.max(reviseRound, replanRound)} 轮修复后仍为 ${audit.verdict}，已停在本章等待自动重试`,
      audit,
      emit,
    });
  }

  // 6) 覆盖校验（细纲要点未覆盖 → 补写）
  let coverage = await coverageCheck(bookId, chapterId, { signal, streamCb: usageCb });
  emit('coverage_done', { coverage });
  if (coverage.verdict === 'fix' && reviseRound < maxRevise) {
    reviseRound++;
    const lastScene = store.scenes.list(chapterId).slice(-1)[0];
    emit('stage', { stage: 'revise', message: '覆盖校验未通过，补写遗漏要点…' });
    await reviseScene(bookId, chapterId, lastScene.id, {
      issues: [{ type: '大纲偏离', severity: 'high', quote: '', issue: `细纲要点未覆盖：${coverage.missing.join('；')}`, fix: '在场景结尾自然补入这些要点' }],
      extraNote: '不要重复已写内容，仅在结尾自然补入遗漏要点',
      signal,
      streamCb: { onDelta: d => emit('delta', { sceneId: lastScene.id, delta: d }), onUsage: u => emit('usage', u), onUsageCost: c => emit('usage_cost', c) },
    });
    emit('revise_done', { round: reviseRound, sceneId: lastScene.id });
    // V0.62：覆盖补写后复审一次（此前补写完直接结算，遗漏要点可能仍缺失无反馈）
    audit = normalizeAuditForRepair(await auditChapter(bookId, chapterId, { signal, streamCb: usageCb }));
    emit('audit_done', { issues: audit.issues, verdict: audit.verdict, grade: audit.grade, round: reviseRound, coverage: true });
    coverage = await coverageCheck(bookId, chapterId, { signal, streamCb: usageCb });
    emit('coverage_done', { coverage, recheck: true });
  }
  // V0.85 收敛保护：补写后仍缺要点 → 记债放行（不再卡死整章——单条要点可能因"等价表达误判/要点笔误"永不过；
  // 卡章导致后续全部停写、且重规划要推倒整卷，代价远大于记一条债务）。遗漏要点记入 conflicts 供后续/卷体检处理。
  if (coverage.verdict === 'fix' && reviseRound >= maxRevise) {
    const missingList = (coverage.missing || []).join('；');
    emit('debt', { message: `覆盖要点仍缺（${missingList}），已记债放行——后续章节/卷体检处理` });
    try {
      store.conflicts.create(bookId, { chapterId, type: '大纲偏离', quote: '', issue: `覆盖要点未落实：${missingList}` });
    } catch { /* ignore */ }
    coverage = { verdict: 'pass', coverage: [], missing: [] };
  }

  if (!['accept', 'defer'].includes(audit.verdict) || coverage.verdict !== 'pass') {
    throw blockQualityGate(bookId, chapterId, {
      code: 'QUALITY_GATE_FAILED',
      message: coverage.verdict !== 'pass'
        ? `覆盖补写后仍缺少 ${coverage.missing.length} 个细纲要点，已停在本章等待自动重试`
        : `覆盖补写后的复审仍为 ${audit.verdict}，已停在本章等待自动重试`,
      audit,
      emit,
    });
  }

  // 6.5) V0.80 逐章吸引力质量门（番茄"快+爽"拦截）：平淡/无钩子/无爽点/主角被动 → 补强末场景再复审。
  //      与快感审计分工：本门 pre-settle 可拦截本章；auditPleasure 保留 post-settle 反哺未来。
  //      门失败一律软降级（pass），绝不 throw 卡死全书（与 V0.79 "AI味不阻塞成书"哲学一致）。
  try {
    const chapterIdx = store.chapters.get(chapterId).idx;
    let attraction = await attractionGate(bookId, chapterId, chapterIdx, { signal, streamCb: usageCb });
    if (attraction.verdict === 'unreviewed') {
      emit('stage', {
        stage: 'attraction_unreviewed',
        message: `吸引力门未完成：${attraction.reason || attraction.error || '模型结果不可验证'}；正文继续结算，但本章不记为“已通过”`,
      });
    }
    if (attraction.verdict === 'fix' && reviseRound < maxRevise) {
      reviseRound++;
      const lastScene = store.scenes.list(chapterId).slice(-1)[0];
      const isHistory = store.books.get(bookId)?.genre === '历史';
      const rewardMode = outline?.reward_mode || store.chapters.outline(chapterId)?.reward_mode || '';
      emit('stage', { stage: 'revise', message: isHistory ? '吸引力门：补强本章（章末钩子/阅读回报/主动选择）…' : '吸引力门：补强本章（章末钩子/当众爽点/主角主动）…' });
      if (lastScene) {
        await reviseScene(bookId, chapterId, lastScene.id, {
          issues: attraction.issues.filter(i => i.severity !== 'low'),
          extraNote: attractionRevisionNote({ isHistory, rewardMode }),
          signal, resetFollowing: false,
          streamCb: { onDelta: d => emit('delta', { sceneId: lastScene.id, delta: d }), onUsage: u => emit('usage', u), onUsageCost: c => emit('usage_cost', c) },
        });
        emit('revise_done', { round: reviseRound, sceneId: lastScene.id, gate: true });
        // 补强后复审一致性+覆盖+吸引力（一次通过才结算）
        audit = normalizeAuditForRepair(await auditChapter(bookId, chapterId, { signal, streamCb: usageCb }));
        coverage = await coverageCheck(bookId, chapterId, { signal, streamCb: usageCb });
        attraction = await attractionGate(bookId, chapterId, chapterIdx, { signal, streamCb: usageCb });
        if (attraction.verdict === 'unreviewed') {
          emit('stage', {
            stage: 'attraction_unreviewed',
            message: `吸引力门未完成：${attraction.reason || attraction.error || '模型结果不可验证'}；正文继续结算，但本章不记为“已通过”`,
          });
        }
      }
    }
    // 残差失败（预算耗尽仍 fix/replan）→ 记债 + constraints 反哺 + 继续 settle（不阻塞成书）
    if (attraction.verdict === 'fix' || attraction.verdict === 'replan') {
      const reasons = (attraction.issues || []).map(i => i.type).join('、') || attraction.verdict;
      emit('debt', { message: `本章吸引力问题（${reasons}）经修订仍未完全解决，已记债由后续章节/卷体检处理` });
      const currentIdx = Number(store.chapters.get(chapterId)?.idx) || 0;
      try { store.constraints.add(bookId, {
        content: `本章吸引力待补强：${reasons}——后续章节注意避免同类问题`,
        source: 'pleasure', key: `attraction:${reasons}`, scopeStart: currentIdx + 1, scopeEnd: currentIdx + 3,
      }); } catch { /* ignore */ }
    }
  } catch (e) {
    // 吸引力门异常不阻塞成书（软降级）
    try { store.chapterHealth.getByChapter(chapterId); } catch { /* ignore */ }
  }

  // 7) 完成态字数门必须先于结算。旧实现先写事实/摘要并标 done，随后只给后文记债，
  // 使残章永久混入事实链；这里失败关闭并完整保留正文供下一次扩写。
  const lengthIssue = chapterCompletionLengthIssue(bookId, chapterId);
  // 内置 mock 故意只回百余字来让数千个流程测试保持轻量；它不是创作服务。
  // 真模型/生产路径一律执行硬门，测试仍直接覆盖 chapterCompletionLengthIssue 的判定。
  const mockFixtureOnly = process.env.NOVEL_MOCK_LLM === '1' && process.env.NOVEL_ENFORCE_MOCK_LENGTH !== '1';
  if (lengthIssue && !mockFixtureOnly) {
    throw blockQualityGate(bookId, chapterId, {
      code: lengthIssue.code,
      message: lengthIssue.message,
      audit,
      emit,
    });
  }
  if (lengthIssue && mockFixtureOnly) emit('stage', { stage: 'mock_length_bypass', message: '内置 mock 短文本：仅测试环境跳过完成态字数门' });

  // 7.1) 结算（抽取事实/伏笔/滚动摘要）
  emit('stage', { stage: 'settle', message: '章结算（抽取事实/伏笔/滚动摘要）…' });
  const settled = await settleChapter(bookId, chapterId, {
    signal, streamCb: usageCb,
    // V0.100.1：结算反馈重答事件转 stage 推送（前端阶段消息区直接可见）
    onEvent: event => emit('stage', { stage: 'settle', message: event.message }),
  });
  transitionChapterStatus(bookId, chapterId, 'done', { reason: '管线结算完成' });
  // 因果骨架由 settleChapter 同事务写入 narrative_patterns，下一章近窗读刚写完的章。
  // V0.98：只在真实章节结算完成且最终审校 accept 后，按卷+年份+事件键精确兑现。
  fulfillOpeningReaderContract(bookId, chapterId, { auditPassed: audit.verdict === 'accept' });
  // 场景重试/正文修订已经成功时同步核销旧失败，不让历史错误继续污染体检和卡章闸门。
  store.conflicts.resolveRecoveredChapter(chapterId, store.chapters.fullText(chapterId));
  // 只有章节已通过结算并进入完成态，才计一次经验使用；中途失败不会制造虚假反馈。
  markNarrativeLessonsUsed(bookId, store.chapters.get(chapterId).idx);

  // 8) 健康快照（漂移检测数据源）+ 上下文预算提示
  recordChapterHealth(bookId, chapterId, {
    verdict: audit.verdict, issues: audit.issues, replanCount: 0,
    failed: failedScenes.length > 0,
    note: failedScenes.length ? `本章 ${failedScenes.length} 个场景生成失败（重跑自动补写）` : '',
    wordCount: store.chapters.get(chapterId).word_count,
  });

  // 8.5) V0.17 快感审计（情绪标签/钩子/兑现/代入感 → 约束反哺）+ 本地节奏规则
  try {
    emit('stage', { stage: 'pleasure', message: '快感审计（情绪节奏/钩子强度/期待兑现）…' });
    const chapterIdx = store.chapters.get(chapterId).idx;
    const pr = await auditPleasure(bookId, chapterId, chapterIdx, { onProgress: p => emit('progress', p), streamCb: usageCb });
    const rhythm = schedulerCheck(bookId, chapterIdx);
    for (const rule of rhythm) store.constraints.add(bookId, {
      content: `【快感节奏】${rule}`, source: 'pleasure', key: `pleasure-rhythm:${rule.slice(0, 48)}`,
      scopeStart: chapterIdx + 1, scopeEnd: chapterIdx + 3,
    });
    // V0.95 三章一轮批次自检：系统性纪律失守（每章只超一点的爬坡）单章检测拦不住，
    // 批次视角补位——约束反哺后续写作（novel-writing-framework 制度化）
    try {
      const batch = batchQualityScan(bookId, chapterIdx, 3);
      for (const c of batch.constraints) {
        store.constraints.add(bookId, {
          content: c, source: 'batch_scan', key: `batch-scan:${c.slice(0, 48)}`,
          scopeStart: chapterIdx + 1, scopeEnd: chapterIdx + 3,
        });
        emit('debt', { message: `三章一轮批次自检：${c.slice(0, 80)}…` });
      }
    } catch { /* 批次扫描失败不阻塞成章 */ }
    // V0.73 钩子积压治理：超期未兑现且低价值的钩子自动废弃（防 300+ 条超期期待无限累积）
    const ledger = settleHookLedger(bookId, chapterIdx);
    emit('pleasure_done', { ok: pr.ok, audit: pr.audit || null, paid: pr.paid || [], rhythm, ledger });
  } catch (e) {
    emit('pleasure_done', { ok: false, error: e.message });
  }

  const need = checkArchiveNeed(bookId);
  if (need.warnOnly) emit('archive_warn', { message: `历史堆 ${Math.round(need.usedTokens / 1000)}K tokens，接近预算，即将自动归档` });
  if (need.needed) emit('archive_need', { message: `历史堆 ${Math.round(need.usedTokens / 1000)}K tokens，触发上下文归档` });

  if (failedScenes.length) {
    emit('chapter_partial', {
      failedScenes,
      message: `本章完成，但有 ${failedScenes.length} 个场景生成失败（已保存草稿/标记，重跑「一键写本章」可自动补写）`,
    });
  }

  emit('done', { chapterId, settled, partial: failedScenes.length > 0, failedScenes, pleasure: { hooksRegistered: registeredHooks.length } });
  return { status: 'done', settled, audit, coverage, registeredHooks, failedScenes };
}

function blockQualityGate(bookId, chapterId, { code, message, audit, emit }) {
  const chapter = store.chapters.get(chapterId);
  transitionChapterStatus(bookId, chapterId, 'quality_blocked', { reason: '质量门失败，保留正文待修' });
  recordChapterHealth(bookId, chapterId, {
    verdict: 'error',
    issues: audit?.issues || [],
    failed: true,
    note: message,
    wordCount: chapter?.word_count || 0,
  });
  const duplicate = store.conflicts.list(bookId).some(c =>
    c.chapter_id === chapterId && c.type === '质量门未通过' && c.issue === message && c.resolution === 'open');
  if (!duplicate) {
    store.conflicts.create(bookId, { chapterId, type: '质量门未通过', quote: '', issue: message });
  }
  emit?.('quality_blocked', { chapterId, message });
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 纯确定性完成门；返回 null 表示可结算。 */
export function chapterCompletionLengthIssue(bookId, chapterId) {
  const chapter = store.chapters.get(chapterId);
  if (!chapter || chapter.book_id !== bookId) {
    return { code: 'CHAPTER_MISSING', message: '章节不存在', hanChars: 0, floorChars: 0 };
  }
  const check = checkChapterLength(store.chapters.fullText(chapterId), {
    lengthProfile: store.books.settings(bookId)?.lengthProfile,
  });
  if (!check.belowFloor) return null;
  return {
    code: 'CHAPTER_LENGTH_BLOCKED',
    message: `第${chapter.idx}章仅 ${check.hanChars} 字，低于完成下限 ${check.floorChars} 字（目标 ${check.lengthProfile} 字）。正文已完整保留，但在补足有效事件、对手行动、人物选择与后果前不得结算或继续后文。`,
    ...check,
  };
}

/** 细纲 scenes → scenes 表行（幂等） */
export function ensureSceneRows(chapterId, outline) {
  const existing = store.scenes.list(chapterId);
  const existingIdx = new Set(existing.map(s => s.idx));
  outline.scenes.forEach((s, i) => {
    const idx = i + 1;
    if (!existingIdx.has(idx)) {
      store.scenes.create(chapterId, idx, {
        pov: s.pov || '', location: s.location || '', beat: s.beat || '',
        targetWords: s.target_words || 1000, status: 'planned',
        sceneType: s.scene_type || '', // V0.83：细纲 scene_type 持久化（技法/诗词按真实类型匹配）
        pacing: s.pacing || '', // V0.95：场景节奏标注持久化（写作按节奏注入句长纪律）
      });
    } else {
      // 细纲重生成后，尚未写正文的场景必须整体刷新；旧实现只更新 type/pacing，
      // 让 scenes 表继续拿旧 beat/location/target 写正文，形成“新章纲、旧任务单”双版本。
      const row = existing.find(x => x.idx === idx);
      if (row && !String(row.content || '').trim()) {
        store.scenes.update(row.id, {
          pov: s.pov || '', location: s.location || '', beat: s.beat || '',
          targetWords: s.target_words || 1000,
          sceneType: s.scene_type || '', pacing: s.pacing || '', status: 'planned',
        });
      }
    }
  });
  // V0.20 修复：细纲场景数减少时清理多余旧场景行（否则旧行会被 writePendingScenes 写入正文）
  const newIdx = new Set(outline.scenes.map((_, i) => i + 1));
  for (const s of existing) {
    if (!newIdx.has(s.idx)) store.scenes.remove(s.id);
  }
  return store.scenes.list(chapterId);
}

/** 修订前按 id 或 idx 对齐当前场景行，避免换版后旧 id 把整章打成失败。 */
export function resolveLiveScene(chapterId, ref) {
  const rows = store.scenes.list(chapterId);
  if (ref?.id) {
    const byId = rows.find(row => row.id === ref.id);
    if (byId) return byId;
  }
  if (ref?.idx != null) return rows.find(row => Number(row.idx) === Number(ref.idx)) || null;
  return null;
}
export function groupIssuesByScene(scenes, issues) {
  const orderedScenes = [...(scenes || [])].sort((a, b) => a.idx - b.idx);
  const groups = new Map();
  const normalize = value => String(value || '').replace(/\s+/g, '');
  for (const issue of issues || []) {
    const rawQuote = String(issue.quote || '');
    const quote = normalize(rawQuote);
    let targets = quote
      ? orderedScenes.filter(scene => normalize(scene.content).includes(quote))
      : [];
    // 审校常用“片段1……片段2”证明跨场景重复；完整 quote 不会落在任何单场景中，
    // 必须拆片段命中全部相关场景，不能兜底误修末场景。
    if (!targets.length && quote) {
      const fragments = rawQuote.split(/(?:…+|\.{3,})/).map(normalize).filter(part => part.length >= 4);
      if (fragments.length) {
        targets = orderedScenes.filter(scene => {
          const content = normalize(scene.content);
          return fragments.some(fragment => content.includes(fragment));
        });
      }
    }
    if (!targets.length && orderedScenes.length) targets = [orderedScenes[orderedScenes.length - 1]];
    for (const target of targets) {
      if (!groups.has(target.id)) groups.set(target.id, { scene: target, issues: [] });
      groups.get(target.id).issues.push(issue);
    }
  }
  return orderedScenes.filter(scene => groups.has(scene.id)).map(scene => groups.get(scene.id));
}

function abortError() {
  const e = new Error('已取消');
  e.code = 'ABORTED';
  return e;
}

/**
 * V0.78 纯函数：审校是否命中"细纲根因问题"（high 级设定冲突/时间线/角色矛盾/事实编造/
 * 事实矛盾/大纲偏离）→ 应 replan 而非 revise（正文修订永远解决不了，只会反复横跳）。
 */
export function hasOutlineRootIssue(audit) {
  const issues = stampOpeningTimelineProseFix(audit?.issues || []);
  return issues.some(i => i?.severity === 'high'
    && OUTLINE_ROOT_ISSUES.includes(i?.type)
    && !i?.proseFix // V0.95.7：本地确定性形态问题（跨年开篇缺失/场景尾复述）正文修订可解，不属细纲根因
    && !isLocalizedNumericMismatch(i));
}

/**
 * V0.78 修订失效判定（纯函数，可测）：判断本轮审校 high 问题是否"修订无效"（应升级 replan）。
 * 根因：审校模型对同一问题每轮 quote 措辞不同（引用正文不同片段），仅靠 quote 前 20 字符
 * 匹配会漏判，导致"事实编造/设定冲突"这类细纲根因问题反复修订无效、死循环卡住
 * （实测 ch119：细纲要求写未登记角色"老幺"，正文修订删了它审校又报 → 无限循环）。
 * 修复：①同 quote 匹配（原逻辑）；②同一类型 high 问题连续 ≥2 轮出现（类型级）；
 *        ③同一场景同一类型问题连续 2 轮出现（场景级）。
 * @returns {{staleHigh:Array, currHighTypes:Set, typeRepeatAndSceneRepeat:boolean}}
 */
export function isRevisionStale({ audit, lastFixedQuotes, prevHighTypes = new Set(), prevSceneHigh = new Map(), scenes = [], quoteOf }) {
  // V0.102.8：proseFix high（草稿用词/开庆时间线/元话语）修订不收敛也不能升级 replan，
  // 否则 102.7 预算闸永远走不到，已写五场会被 clear。老幺式无标记细纲硬伤仍计入。
  const issues = stampOpeningTimelineProseFix(audit?.issues || [])
    .filter(isImmediateReplanIssue);
  const staleHigh = issues.filter(i => (lastFixedQuotes || new Set()).has(quoteOf?.(i.quote)));
  const currHighTypes = new Set(issues.map(i => `${i.type || '未知'}|${i.severity || 'low'}`));
  const hasTypeRepeat = [...currHighTypes].some(t => prevHighTypes.has(t));
  // 场景归属：与 groupIssuesByScene 一致，用"完整正文包含完整引用"判断（同 quote 措辞命中）
  const normalize = v => String(v || '').replace(/\s+/g, '');
  let sceneRepeat = false;
  for (const i of issues) {
    const q = normalize(i.quote);
    const scene = scenes.find(s => q && normalize(s.content).includes(q));
    const k = `${i.type || '未知'}|${i.severity || 'low'}@${scene ? scene.idx : 0}`;
    const count = (prevSceneHigh.get(k) || 0) + 1;
    if (count >= 2) { sceneRepeat = true; break; }
  }
  return { staleHigh, currHighTypes, typeRepeatAndSceneRepeat: hasTypeRepeat && sceneRepeat };
}
