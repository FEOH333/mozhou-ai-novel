// 由 recommendation_recovery.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import * as store from '../../db/store.js';
import { assembleReviewMessages } from '../../llm/cache.js';
import { runLocalRules } from '../quality/rules.js';
import { validateChapterRewrite } from '../quality/polish.js';
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
  BAD_FINISH_REASONS,
  SCORE_DIMENSIONS,
  compact,
  emitEvent,
  quoteLocated,
  recoveryError,
  runStructuredWithOneCorrection,
} from './recovery_shared.js';
import {
  validateBlindComparison,
} from './recovery_validation.js';

export function chapterRewriteContext(bookId, chapter) {
  return {
    targetChars: store.scenes.list(chapter.id).reduce((sum, scene) => sum + (Number(scene.target_words) || 0), 0),
    peerChapters: store.chapters.list(bookId)
      .filter(item => item.id !== chapter.id)
      .map(item => ({ idx: item.idx, text: store.chapters.fullText(item.id) })),
  };
}

/**
 * 将整章返工收窄到诊断证据所在的连续场景窗口。tune 只动命中场景；rebuild 额外带一个
 * 相邻场景用于兑现后果。未命中时才退回整章，确保工具永不凭模糊语义猜修改位置。
 */

/**
 * 将整章返工收窄到诊断证据所在的连续场景窗口。tune 只动命中场景；rebuild 额外带一个
 * 相邻场景用于兑现后果。未命中时才退回整章，确保工具永不凭模糊语义猜修改位置。
 */
export function buildRecoveryRewriteWindow(chapter, workOrder) {
  const scenes = store.scenes.list(chapter.id)
    .filter(scene => String(scene.content || '').trim())
    .sort((left, right) => Number(left.idx) - Number(right.idx));
  if (!scenes.length) {
    return {
      sceneIndexes: [], start: 0, end: 0, oldText: chapter.text,
      beforeContext: '', afterContext: '', targetChars: compact(chapter.text).length,
      wholeChapter: true, endsAtChapterEnd: true,
      assemble: replacement => String(replacement || '').trim(),
    };
  }
  const hitIndexes = [];
  for (const quote of Array.isArray(workOrder.evidence) ? workOrder.evidence : []) {
    const index = scenes.findIndex(scene => quoteLocated(scene.content, quote));
    if (index >= 0) hitIndexes.push(index);
  }
  if (!hitIndexes.length && scenes.length > 1) {
    throw recoveryError(
      `第${chapter.idx}章返工证据无法定位到具体场景；为避免退化成整章洗稿，已在生成前停止`,
      'RECOVERY_REWRITE_WINDOW_UNGROUNDED',
      409,
    );
  }
  // 工单可以带两条证据，第二条常是“问题在章末仍未兑现”的对照证据；把两条之间
  // 全部场景一并改写，会悄悄退化回整章洗稿。首条已验证证据是唯一主窗口锚点，
  // 其余证据只参与目标/盲审；rebuild 也最多额外扩一个相邻场景。
  let start = hitIndexes.length ? hitIndexes[0] : 0;
  let end = hitIndexes.length ? hitIndexes[0] : 0;
  if (workOrder.action === 'rebuild' && start === end && scenes.length > 1) {
    if (end + 1 < scenes.length) end++;
    else start--;
  }
  const selected = scenes.slice(start, end + 1);
  const prefix = scenes.slice(0, start).map(scene => String(scene.content || '').trim()).filter(Boolean);
  const suffix = scenes.slice(end + 1).map(scene => String(scene.content || '').trim()).filter(Boolean);
  const oldText = selected.map(scene => String(scene.content || '').trim()).filter(Boolean).join('\n\n');
  const prefixText = prefix.join('\n\n');
  const suffixText = suffix.join('\n\n');
  return {
    sceneIndexes: selected.map(scene => Number(scene.idx)),
    start,
    end,
    oldText,
    beforeContext: prefixText.slice(-420),
    afterContext: suffixText.slice(0, 420),
    targetChars: compact(oldText).length,
    wholeChapter: start === 0 && end === scenes.length - 1,
    endsAtChapterEnd: end === scenes.length - 1,
    assemble(replacement) {
      return [...prefix, String(replacement || '').trim(), ...suffix].filter(Boolean).join('\n\n');
    },
  };
}

export function validateRecoveryWindowRewrite(window, afterWindow, finishReason, action) {
  const finish = String(finishReason || '').toLowerCase();
  if (BAD_FINISH_REASONS.has(finish)) {
    return {
      ok: false, unchanged: false, code: 'REWRITE_TRUNCATED',
      message: '场景窗口输出被截断', metrics: {},
    };
  }
  const beforeChars = compact(window.oldText).length;
  const afterChars = compact(afterWindow).length;
  if (!afterChars) {
    return { ok: false, unchanged: false, code: 'REWRITE_EMPTY', message: '场景窗口输出为空', metrics: { beforeChars, afterChars } };
  }
  if (compact(window.oldText) === compact(afterWindow)) {
    return { ok: false, unchanged: true, code: 'REWRITE_UNCHANGED', message: '场景窗口没有形成实际修改', metrics: { beforeChars, afterChars } };
  }
  const minimumRatio = action === 'rebuild' ? RECOVERY_WINDOW_LENGTH_RATIOS.rebuildMin : RECOVERY_WINDOW_LENGTH_RATIOS.tuneMin;
  const maximumRatio = action === 'rebuild' ? RECOVERY_WINDOW_LENGTH_RATIOS.rebuildMax : RECOVERY_WINDOW_LENGTH_RATIOS.tuneMax;
  if (beforeChars >= 120 && afterChars < Math.ceil(beforeChars * minimumRatio)) {
    return {
      ok: false, unchanged: false, code: 'REWRITE_TOO_SHORT',
      message: `场景窗口明显缩水（${beforeChars}→${afterChars} 字）`, metrics: { beforeChars, afterChars },
    };
  }
  if (beforeChars >= 120 && afterChars > Math.ceil(beforeChars * maximumRatio)) {
    return {
      ok: false, unchanged: false, code: 'REWRITE_TOO_LONG',
      message: `场景窗口异常膨胀（${beforeChars}→${afterChars} 字）`, metrics: { beforeChars, afterChars },
    };
  }
  return { ok: true, unchanged: false, code: 'RECOVERY_WINDOW_OK', message: '', metrics: { beforeChars, afterChars } };
}

/**
 * 复用路径的文风闸必须与生成路径同粒度：存档的场景窗口补丁按记录的场景号推导
 * 是否整章/是否覆盖到章末，避免章级构成规则在窗口补丁上二次误杀。
 */

/**
 * 复用路径的文风闸必须与生成路径同粒度：存档的场景窗口补丁按记录的场景号推导
 * 是否整章/是否覆盖到章末，避免章级构成规则在窗口补丁上二次误杀。
 */
export function windowPatchRuleOptions(patch, chapter) {
  if (patch?.kind !== 'scene_window' || !Array.isArray(patch.scene_indexes) || !patch.scene_indexes.length) {
    return {};
  }
  const sceneIdx = store.scenes.list(chapter.id)
    .map(scene => Number(scene.idx)).sort((left, right) => left - right);
  if (!sceneIdx.length) return {};
  const indexes = patch.scene_indexes.map(Number).filter(Number.isInteger);
  if (!indexes.length) return {};
  return {
    scope: indexes.length >= sceneIdx.length ? 'chapter' : 'window',
    endsAtChapterEnd: Math.max(...indexes) === sceneIdx.at(-1),
  };
}

export async function compareCandidate(bookId, chapter, before, after, round, runTaskImpl, signal, onRetry, onEvent) {
  // 奇数轮候选居 B、偶数轮居 A；执行入口固定只做两轮换位，不再开第三轮决胜。
  const candidateA = round % 2 === 1 ? before : after;
  const candidateB = round % 2 === 1 ? after : before;
  // V0.100.14：审稿结构/证据失败只判本章候选无效，不为修审稿格式再烧一轮模型。
  const { value, response } = await runStructuredWithOneCorrection({
    label: `第${chapter.idx}章第${round}轮匿名对照审稿`,
    instruction: recommendationRecoveryCompareInstruction({ chapter, candidateA, candidateB, round, decisive: round >= 3 }),
    // 两次换位各只有一次裁决。证据幻觉说明该轮不可用，不能为“审稿格式”再烧一轮模型。
    maxCorrections: 0,
    correctionHint: 'evidence.A 与 evidence.B 必须是字符串数组；每条引用只能是正文里逐字连续的一段（8—30 字），禁止省略号拼接两处、禁止拼接说话人标签两侧。被拒绝的那条若确实没有逐字支撑，直接删掉并改引另一句你能逐字确认的原句（分析写进 reason）；绝不准凭记忆复述大意。',
    runRequest: (content, { isCorrection = false } = {}) => runTaskImpl({
      task: isCorrection ? 'audit_repair' : 'opening_candidate_compare', bookId, chapterId: chapter.id, jsonMode: true, signal,
      onRetry,
      messages: assembleReviewMessages(bookId, [{ role: 'user', content }]),
    }),
    validate: parsed => validateBlindComparison(parsed, { candidateA, candidateB }),
    onCorrection: onEvent
      ? (error, attempt) => emitEvent(onEvent, 'recovery_validation_retry', {
        stage: 'comparing', chapter: chapter.idx, round, attempt: attempt + 1, reason: error.message,
      })
      : undefined,
  });
  return {
    ...value,
    model: response.model || response.route?.model || '',
  };
}

export function candidateAbsoluteQuality(review, newLabel) {
  const values = SCORE_DIMENSIONS.map(dimension => Number(review?.scores?.[newLabel]?.[dimension]));
  if (values.some(value => !Number.isFinite(value))) return false;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  // “比旧稿稍好”不等于合格：四个核心轴不能有明显短板，综合也必须进入可用区。
  return values.every(value => value >= 60) && average >= 68;
}

export function candidateClearlyWins(first, second) {
  return first.winner === 'B' && second.winner === 'A'
    && first.margin >= 5 && second.margin >= 5
    && candidateAbsoluteQuality(first, 'B') && candidateAbsoluteQuality(second, 'A');
}

/**
 * V0.100.2 决胜轮资格：两轮方向一致（候选都胜出）但分差未达 ≥5 的近 miss 才值得第三轮；
 * 任何一轮旧稿胜出或 tie 都是真实质量信号，不补救（实测 ch16 tie/0 + B/3 = 旧稿仍被偏好）。
 */

/**
 * V0.100.2 决胜轮资格：两轮方向一致（候选都胜出）但分差未达 ≥5 的近 miss 才值得第三轮；
 * 任何一轮旧稿胜出或 tie 都是真实质量信号，不补救（实测 ch16 tie/0 + B/3 = 旧稿仍被偏好）。
 */
function tieBreakEligible(first, second) {
  return first.winner === 'B' && second.winner === 'A'
    && (first.margin < 5 || second.margin < 5)
    && candidateAbsoluteQuality(first, 'B') && candidateAbsoluteQuality(second, 'A');
}

/** 决胜轮接受条件：第三轮候选（居 B）胜出且分差 ≥5 且过绝对质量线。 */

/** 决胜轮接受条件：第三轮候选（居 B）胜出且分差 ≥5 且过绝对质量线。 */
function tieBreakWins(third) {
  return Boolean(third && third.winner === 'B' && third.margin >= 5 && candidateAbsoluteQuality(third, 'B'));
}

/**
 * V0.100.15 位置镜像分裂：两轮换位后裁判仍选同一个物理位置、且两轮分差接近——
 * 位置锚定压倒了内容判断，评审对“质量相当的压缩改写”失去内容区分力
 * （实测 ch23 铁证：两轮 A 位恒 340 分、B 位恒 280 分，评语夸的是两版共有的同一特征）。
 * 此时两轮结果互相抵消，不构成“候选更差”的证据。
 */

/**
 * V0.100.15 位置镜像分裂：两轮换位后裁判仍选同一个物理位置、且两轮分差接近——
 * 位置锚定压倒了内容判断，评审对“质量相当的压缩改写”失去内容区分力
 * （实测 ch23 铁证：两轮 A 位恒 340 分、B 位恒 280 分，评语夸的是两版共有的同一特征）。
 * 此时两轮结果互相抵消，不构成“候选更差”的证据。
 */
export function positionMirroredSplit(first, second) {
  return first.winner === second.winner
    && ['A', 'B'].includes(first.winner)
    && Math.abs(Number(first.margin) - Number(second.margin)) <= 8
    && Number(first.margin) <= 20 && Number(second.margin) <= 20;
}

/**
 * 候选接受单一判定（生成侧与存档复用侧共用，防两套写法漂移）：
 * 两轮明确胜出；或两轮近 miss + 决胜轮明确胜出（历史路径，执行入口已固定两轮）。
 * V0.100.15：tune 且位置镜像分裂且候选两轮都过绝对质量线时同样接受——压缩类改写的
 * 机械收益（水词下降、篇幅收敛）由本地文风闸与篇幅闸证明，盲审只须证明内容无退化；
 * rebuild 关键重构不适用，仍必须两轮方向性全胜。
 */

/**
 * 候选接受单一判定（生成侧与存档复用侧共用，防两套写法漂移）：
 * 两轮明确胜出；或两轮近 miss + 决胜轮明确胜出（历史路径，执行入口已固定两轮）。
 * V0.100.15：tune 且位置镜像分裂且候选两轮都过绝对质量线时同样接受——压缩类改写的
 * 机械收益（水词下降、篇幅收敛）由本地文风闸与篇幅闸证明，盲审只须证明内容无退化；
 * rebuild 关键重构不适用，仍必须两轮方向性全胜。
 */
export function comparisonsAcceptCandidate(comparisons, { action = '' } = {}) {
  const [first, second, third] = Array.isArray(comparisons) ? comparisons : [];
  if (!first || !second) return false;
  if (candidateClearlyWins(first, second)) return true;
  if (String(action) === 'tune' && positionMirroredSplit(first, second)
    && candidateAbsoluteQuality(first, 'B') && candidateAbsoluteQuality(second, 'A')) return true;
  return tieBreakEligible(first, second) && tieBreakWins(third);
}

function blockingProseIssues(text, ruleOptions = {}) {
  return runLocalRules(String(text || ''), ruleOptions)
    .filter(issue => ['medium', 'high'].includes(String(issue?.severity)))
    // V0.105：发稿占用轴是近窗软项，不是返工文风闸的 AI 模板腔/母题。
    // 把 travel_ending 等算进 blocking 会让旧稿多一项、候选同构不过闸（闸必须与改写单元同职责）。
    .filter(issue => !issue.axis)
    // V0.109.3：篇章级分布指标（句式同质化/段落均质/连接词密度/情感温度/事实锚点）同理排除。
    // 局部改写不会改变整章的句长分布与段落起伏——旧稿有一项、候选必然还有一项，
    // 算进闸就是批量误杀（同"闸必须与改写单元同职责"）。词句级 AI 腔不排除，仍参与闸。
    .filter(issue => !issue.statistical);
}

/**
 * 模型盲审之外的确定性文风闸：候选不能新增高危规则命中；旧稿已经有明确 AI 腔时，
 * 本轮至少要减少一项，避免“剧情稍有推进，但指腹/微微/模板句照旧泛滥”也被判合格。
 * ruleOptions 透传 runLocalRules 的作用域：场景窗口候选必须用窗口粒度规则，
 * 章级构成规则（对话占比/章末零钩）闸窗口会把局部改写判成死局（V0.100.14 实证）。
 */

/**
 * 模型盲审之外的确定性文风闸：候选不能新增高危规则命中；旧稿已经有明确 AI 腔时，
 * 本轮至少要减少一项，避免“剧情稍有推进，但指腹/微微/模板句照旧泛滥”也被判合格。
 * ruleOptions 透传 runLocalRules 的作用域：场景窗口候选必须用窗口粒度规则，
 * 章级构成规则（对话占比/章末零钩）闸窗口会把局部改写判成死局（V0.100.14 实证）。
 */
export function validateRecoveryProseImprovement(before, after, ruleOptions = {}) {
  const beforeIssues = blockingProseIssues(before, ruleOptions);
  const afterIssues = blockingProseIssues(after, ruleOptions);
  const highAfter = afterIssues.filter(issue => String(issue.severity) === 'high');
  const improved = beforeIssues.length === 0
    ? afterIssues.length === 0
    : afterIssues.length < beforeIssues.length;
  return {
    ok: highAfter.length === 0 && improved,
    code: highAfter.length === 0 && improved ? 'RECOVERY_PROSE_GATE_PASSED' : 'RECOVERY_PROSE_GATE_FAILED',
    beforeBlocking: beforeIssues.length,
    afterBlocking: afterIssues.length,
    issues: afterIssues.map(issue => ({
      severity: issue.severity, type: issue.type, quote: issue.quote, issue: issue.issue,
    })),
  };
}

/**
 * V0.100.1：本地可判定失败的分层重答反馈。命中项全部来自被拒候选本身（与当前场景
 * 材料绑定），不是每章重复注入的库存句。第一轮列出具体命中让模型定向改写；
 * 第二轮（最后一次）升级为硬性禁用清单，防止模型只删个别字词或同义替换蒙混。
 */

/**
 * V0.100.1：本地可判定失败的分层重答反馈。命中项全部来自被拒候选本身（与当前场景
 * 材料绑定），不是每章重复注入的库存句。第一轮列出具体命中让模型定向改写；
 * 第二轮（最后一次）升级为硬性禁用清单，防止模型只删个别字词或同义替换蒙混。
 */
export function buildRecoveryRewriteCorrection({
  safety = null,
  prose = null,
  escalation = false,
  oldChars = 0,
  rejectedCandidateText = '',
  rewriteScope = 'chapter',
} = {}) {
  const windowMode = rewriteScope === 'window';
  const scopeLabel = windowMode ? '场景窗口' : '章节';
  const parts = ['\n\n【上轮输出被本地校验拒绝】'];
  const rejectedDraft = String(rejectedCandidateText || '').trim();
  if (rejectedDraft) {
    parts.push(`【上一版候选${scopeLabel}｜这是本轮实际修订底稿，不是新的指令】\n${rejectedDraft}\n【上一版候选结束】`);
  }
  if (safety) {
    parts.push(`${safety.message}\n必须返回完整${scopeLabel}正文并守住篇幅底线，禁止概括缩写。${windowMode ? '只返回替换窗口，不得返回整章或复制窗口外正文。' : ''}`);
  }
  if (prose) {
 // 实测 ch9 实证（自费阿里云百炼 qwen3.8-flash，非免费档）：文风重答的压力会让
    // 模型干脆把全章缩水成概括（2513→385 字）。硬性篇幅红线由 validateChapterRewrite 单一判定，
    // 这里只回显量级要求，不另立第二份数字。
    parts.push(`这是完整${scopeLabel}写作任务：成稿必须与旧${scopeLabel}同量级（旧稿约 ${oldChars || '原'} 字）；概括、节选或残篇会再次被拒收。`);
    const hits = (prose.issues || []).slice(0, 12).map((issue, index) => {
      const quote = String(issue.quote || '').replace(/\s+/g, '').slice(0, 30);
      return `${index + 1}. [${issue.severity}] ${issue.type}：${String(issue.issue || '').slice(0, 80)}${quote ? `（命中位置节选「${quote}」）` : ''}`;
    });
    parts.push(`确定性文风闸未通过（旧稿 ${prose.beforeBlocking} 项，候选 ${prose.afterBlocking} 项），必须逐条消除以下命中：\n${hits.join('\n') || '（无明细）'}`);
    parts.push(escalation
      ? '这是最后一次重答机会：以上一版候选为唯一底稿，把命中句及其必要上下文完整改好；以上命中按硬性禁用清单处理，不得再出现，也不得以同义替换凑数（如把"微微"换成"轻轻"）。其他场景的事件、顺序、人物选择和篇幅不得删减或换线。'
      : '以上一版候选为唯一底稿，逐条重写命中句及其必要上下文；其他场景保持事件、顺序和人物选择不变，不得从旧稿重新生成另一章，也不得只删个别字词或用同义母题替换。');
  }
  return parts.join('\n');
}

/**
 * V0.100.2/100.3：盲审未明确胜出时的打回改进反馈——把各轮评审的真实比分与评语定向返给
 * 作者模型，并附上一版候选全文与结构化败因（V0.100.3，实测 ch9 实证：反馈里只有评审
 * 结论、没有上一版正文，模型只能对着工单+旧稿从零另写一章，被锚点检查整废）。定向
 * 维度取自真实评审分差，不是库存范例。
 */

/**
 * V0.100.2/100.3：盲审未明确胜出时的打回改进反馈——把各轮评审的真实比分与评语定向返给
 * 作者模型，并附上一版候选全文与结构化败因（V0.100.3，实测 ch9 实证：反馈里只有评审
 * 结论、没有上一版正文，模型只能对着工单+旧稿从零另写一章，被锚点检查整废）。定向
 * 维度取自真实评审分差，不是库存范例。
 */
export function buildRecoveryRegenFeedback(comparisons, lastCandidateText = '') {
  const reviews = Array.isArray(comparisons) ? comparisons : [];
  const verdicts = reviews
    .map((review, index) => `第${index + 1}轮 ${review.winner}/${review.margin}：${String(review.reason || '无评语')}`)
    .join('\n');
  // 轮次换位：奇数轮 A=旧稿、偶数轮 A=新稿。按同一口径归一新稿相对旧稿的分差，
  // 找出累计最弱的两维，作为本轮必须针对性补强的靶子。
  const DIMENSION_LABELS = [
    ['progression', '情节推进'], ['consequence', '后果代价'],
    ['character', '人物选择'], ['pull', '追读拉力'],
  ];
  const deltas = new Map(DIMENSION_LABELS.map(([key]) => [key, 0]));
  let scored = false;
  for (let index = 0; index < reviews.length; index++) {
    const scores = reviews[index]?.scores;
    const oldSide = index % 2 === 0 ? 'A' : 'B';
    const newSide = oldSide === 'A' ? 'B' : 'A';
    for (const [key] of DIMENSION_LABELS) {
      const oldValue = Number(scores?.[oldSide]?.[key]);
      const newValue = Number(scores?.[newSide]?.[key]);
      if (Number.isFinite(oldValue) && Number.isFinite(newValue)) {
        deltas.set(key, deltas.get(key) + newValue - oldValue);
        scored = true;
      }
    }
  }
  const weakest = scored
    ? [...deltas.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2)
      .filter(([, delta]) => delta < 0)
      .map(([key, delta]) => `${DIMENSION_LABELS.find(([dim]) => dim === key)?.[1] || key}（${delta} 分）`)
    : [];
  const lastDraftBlock = String(lastCandidateText || '').trim()
    ? `\n【上一版候选全文｜盲审已判定未明显优于旧稿；这是诊断与再创作底稿】\n${String(lastCandidateText).trim()}\n`
    : '';
  const weaknessBlock = weakest.length
    ? `\n分差显示新稿最弱的是：${weakest.join('、')}；本轮优先解决这两处。`
    : '';
  return `\n\n【上轮候选经匿名双审未证明明显优于旧稿】\n${verdicts || '无评审明细'}`
    + `${lastDraftBlock}${weaknessBlock}`
    + '\n本轮改写边界：以上一版候选为诊断起点，允许重写导致败选的完整场景及其必要衔接，改动范围由解决真实败因决定；'
    + '不得只换词，也不得靠随机事故、陌生人、密信或提前泄露后续情节制造假推进。已成立的剧情走向、人物身份、时间地点、相邻章接口与篇幅底线必须保持，'
    + '输出仍是完整章节全文。';
}

/**
 * V0.100.2：整段复核模型常把分析前缀混进 evidence（"第7章布置、第8章兑现的因果接力：「引文」"），
 * 整串当然无法逐字定位——确定性剥出「…」/“…”内的真引文再校验；剥不出可定位引文才判废
 * （幻觉照旧 fail-closed，不开模糊匹配口子）。与"形态宽容、内容严格"同源。
 */

/**
 * V0.100.2：整段复核模型常把分析前缀混进 evidence（"第7章布置、第8章兑现的因果接力：「引文」"），
 * 整串当然无法逐字定位——确定性剥出「…」/“…”内的真引文再校验；剥不出可定位引文才判废
 * （幻觉照旧 fail-closed，不开模糊匹配口子）。与"形态宽容、内容严格"同源。
 */
export function salvageGlobalReviewEvidence(fullText, rawQuote) {
  if (quoteLocated(fullText, rawQuote)) return rawQuote;
  const segments = String(rawQuote || '').match(/「[^」]{4,}」|“[^”]{4,}”/g) || [];
  const candidates = segments
    .map(segment => segment.slice(1, -1).trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    if (quoteLocated(fullText, candidate)) return candidate;
  }
  return null;
}

export function orderedRecoveryWorkOrders(workOrders) {
  const byChapter = new Map();
  for (const order of workOrders) {
    const chapter = Number(order?.chapter);
    if (!Number.isInteger(chapter) || byChapter.has(chapter)) {
      throw recoveryError(`返工工单章号无效或重复：第${order?.chapter ?? '?'}章`, 'RECOVERY_PLAN_DEPENDENCY_INVALID', 409);
    }
    byChapter.set(chapter, order);
  }
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (chapter) => {
    if (visiting.has(chapter)) throw recoveryError('返工工单 depends_on 存在循环依赖', 'RECOVERY_PLAN_DEPENDENCY_INVALID', 409);
    if (visited.has(chapter)) return;
    const order = byChapter.get(chapter);
    if (!order) throw recoveryError(`返工工单依赖了不存在的第${chapter}章`, 'RECOVERY_PLAN_DEPENDENCY_INVALID', 409);
    visiting.add(chapter);
    const dependencies = Array.isArray(order.depends_on) ? order.depends_on.map(Number) : [];
    for (const dependency of [...new Set(dependencies)].sort((left, right) => left - right)) {
      if (!Number.isInteger(dependency) || dependency === chapter || !byChapter.has(dependency)) {
        throw recoveryError(`第${chapter}章 depends_on 含无效依赖`, 'RECOVERY_PLAN_DEPENDENCY_INVALID', 409);
      }
      visit(dependency);
    }
    visiting.delete(chapter);
    visited.add(chapter);
    ordered.push(order);
  };
  // 关键 rebuild 是整批能否落盘的硬前提：先执行每个 rebuild 及其依赖闭包，
  // 再处理与关键链无关的边缘 tune。这样关键章首败就能立刻止损，不会先烧十章微调。
  const rebuildChapters = [...byChapter.entries()]
    .filter(([, order]) => String(order.action) === 'rebuild')
    .map(([chapter]) => chapter)
    .sort((left, right) => left - right);
  for (const chapter of rebuildChapters) visit(chapter);
  for (const chapter of [...byChapter.keys()].sort((left, right) => left - right)) visit(chapter);
  return ordered;
}

/**
 * 只有同时满足三层证据的整改，才会成为后续创作经验：
 * 1) 原诊断能在旧稿定位；2) 新稿双向盲审明确胜出；3) 整段推进复核通过。
 * 经验只携带“下一阶段该做到什么”，不把旧稿坏句重新塞进创作提示。
 */
