// 由 recommendation_recovery.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import {
  ACTIONS,
  SCORE_DIMENSIONS,
  WINNERS,
  compact,
  groundedEvidenceFragments,
  partiallyGroundedEvidenceFragments,
  quoteLocated,
  recoveryError,
  requireArray,
  requireText,
  score,
} from './recovery_shared.js';
import {
  repeatedRebuildLossChapterCount,
} from './recovery_global_review.js';

export const RECOVERABLE_DIAGNOSIS_CODES = new Set([
  'RECOMMENDATION_RECOVERY_INVALID',
  'RECOVERY_RESPONSE_INVALID',
  'RECOVERY_RESPONSE_TRUNCATED',
]);
// tune 只能重排/压缩/深化旧稿已有材料；靠“再来一个意外/险情/密信”制造张力，
// 会把局部润色工单变成无依据的剧情发明（实测 ch11-14/ch18 实证）。

// tune 只能重排/压缩/深化旧稿已有材料；靠“再来一个意外/险情/密信”制造张力，
// 会把局部润色工单变成无依据的剧情发明（实测 ch11-14/ch18 实证）。
const ARTIFICIAL_TUNE_EVENT_RE = /(?:增加|新增|加入|插入|安排|设置|制造|硬塞|引入|通过|借助|利用|需要|需|应当|以).{0,18}(?:微型)?(?:意外|险情|事故|突发(?:事件|危机|冲突|威胁)?|潜在威胁|威胁暗示|袭击|陌生人|密信)/;

const ARTIFICIAL_TUNE_EVENT_TERM_RE = /(?:微型)?(?:意外|险情|事故|突发危机|突发威胁|潜在威胁|威胁暗示|陌生人|密信|突发袭击)/g;
// V0.100.15 戏剧化处方词族：综合/诊断模型把返工目标写成“设置陷阱/心理施压/战术博弈”式
// 桥段处方时，作者模型会直译成“冷笑一声掏出麻线”的网文套路，被盲审以“金手指/OOC”否决
// （实测 ch27 实证：第1轮 A/35、第2轮 B/25 两轮大比例否决）。目标必须写“局势要发生的
// 可核验变化”，处方怎么开留给作者模型从旧稿人设与资源里长出来。

// V0.100.15 戏剧化处方词族：综合/诊断模型把返工目标写成“设置陷阱/心理施压/战术博弈”式
// 桥段处方时，作者模型会直译成“冷笑一声掏出麻线”的网文套路，被盲审以“金手指/OOC”否决
// （实测 ch27 实证：第1轮 A/35、第2轮 B/25 两轮大比例否决）。目标必须写“局势要发生的
// 可核验变化”，处方怎么开留给作者模型从旧稿人设与资源里长出来。
const DRAMATIC_PRESCRIPTION_RE = /(?:设置|布下|布置|安排|埋下).{0,4}(?:陷阱|圈套|诱饵|死局)|(?:陷阱|圈套|诱饵)(?:已|已经)?(?:布下|埋好|布好|设好)|心理施压|攻心为上|将计就计|请君入瓮|引蛇出洞|(?:战术|心理|智谋)博弈|打脸|反杀|扮猪吃虎|神机妙算|(?:迫使|逼得|逼其).{0,12}(?:做出|露出|采取|走向).{0,8}(?:激进|过激|掩饰|失态|冒险)/;
// V0.100.15 第二轮（实测 ch23 实证）：诊断模型学会避开处方词后，把加戏处方改写成
// “主动推动监控升级/带来更具冲击力的新证据/差点被撞见/造成实质性破坏”等软性扩写语义，
// 作者模型照做依然 OOC 败选。这些高置信扩写词族一律退回“压缩兑现”兜底——tune 的对症
// 药永远是删水词并让既有行动兑现后果，不是新增行动、证据或险情。

// V0.100.15 第二轮（实测 ch23 实证）：诊断模型学会避开处方词后，把加戏处方改写成
// “主动推动监控升级/带来更具冲击力的新证据/差点被撞见/造成实质性破坏”等软性扩写语义，
// 作者模型照做依然 OOC 败选。这些高置信扩写词族一律退回“压缩兑现”兜底——tune 的对症
// 药永远是删水词并让既有行动兑现后果，不是新增行动、证据或险情。
const SOFT_ESCALATION_RE = /(?:主动)?推动.{0,6}(?:升级|监控|调查|核查|进程)|(?:带来|引入|提供|拿出).{0,8}(?:新证据|更具冲击力|冲击力)|(?:差点|几乎)被.{0,8}撞见|造成实质性破坏|(?:损毁|毁坏).{0,8}(?:工具|设施|器械|测量)|迫使.{0,10}(?:立即|马上|当场)采取|升级为.{0,8}(?:直接冲突|重大失误)|(?:受伤|牺牲|伤亡).{0,8}(?:打破|代价来|来打破)/;
// 计入连败账本的"质量性败选"码：工具自身误伤（如曾经的预算硬闸误判）不得计入，
// 否则 bug 时代的牺牲品会被冻结挡在门外、永远拿不到修正后的公平重试。

// 计入连败账本的"质量性败选"码：工具自身误伤（如曾经的预算硬闸误判）不得计入，
// 否则 bug 时代的牺牲品会被冻结挡在门外、永远拿不到修正后的公平重试。
export const QUALITY_LOSS_CODES = new Set([
  'RECOVERY_NO_CLEAR_IMPROVEMENT', 'RECOVERY_COMPARE_INVALID', 'RECOVERY_PROSE_GATE_FAILED',
]);
// V0.100.15 rebuild 工具闸失败码：截断/缩水/膨胀/文风/错章与“该章是否该改”无关，只是
// 生成质量问题。盲审败选仍终局（V0.100.14 定调：败选不重生）；工具闸失败给一次
// 重新生成机会（新骰子、有界两次，不是同候选修正重答）。REWRITE_UNCHANGED 除外——
// 候选与当前正文逐字相同是确定性无提升信号（常见于正文已被前一运行落盘的新稿），重试无意义。

// V0.100.15 rebuild 工具闸失败码：截断/缩水/膨胀/文风/错章与“该章是否该改”无关，只是
// 生成质量问题。盲审败选仍终局（V0.100.14 定调：败选不重生）；工具闸失败给一次
// 重新生成机会（新骰子、有界两次，不是同候选修正重答）。REWRITE_UNCHANGED 除外——
// 候选与当前正文逐字相同是确定性无提升信号（常见于正文已被前一运行落盘的新稿），重试无意义。
export const TOOL_FAILURE_CODES = new Set([
  'REWRITE_TRUNCATED', 'REWRITE_EMPTY',
  'REWRITE_TOO_SHORT', 'REWRITE_TOO_LONG', 'REWRITE_WRONG_CHAPTER',
  'RECOVERY_PROSE_GATE_FAILED',
]);
// V0.100.3 连败冻结：同一工单动作 + 同一份旧稿下，被完整执行拒绝达到该次数的章默认跳过
// （旧稿任何改动、工单动作变化或用户选"全部重新诊断"都会自动解冻）。

// V0.100.3 连败冻结：同一工单动作 + 同一份旧稿下，被完整执行拒绝达到该次数的章默认跳过
// （旧稿任何改动、工单动作变化或用户选"全部重新诊断"都会自动解冻）。
export const FROZEN_REJECTION_THRESHOLD = 2;
// V0.100.5 慢性败选终身熔断：无视成功水印的累计败选上限——防止"别的章不断成功→
// 账本反复清零→慢性败选章永远每轮白烧八次调用"的设计漏洞（实测 ch17 实证）。

// V0.100.5 慢性败选终身熔断：无视成功水印的累计败选上限——防止"别的章不断成功→
// 账本反复清零→慢性败选章永远每轮白烧八次调用"的设计漏洞（实测 ch17 实证）。
export const FROZEN_LIFETIME_THRESHOLD = 4;

export const RECOVERY_CHAPTER_FROZEN_CODE = 'RECOVERY_CHAPTER_FROZEN';
// V0.100.8 整段复核单次调用的输入体量上限（字符）。本作第 1—34 章候选合计 149,366 字，
// 按工程内 1.6 字/token 估算约 9.3 万输入 token，再叠加 mid_story_review 的 thinking enabled
// + reasoningEffort high + maxTokens 10000：一次调用超窗或被掐断会把整批候选判
// global_rejected 全部作废。分段后每段独立判定，后段带前段结论以保留跨段累积判断。

/** tune 里的事故词只有在明确否定语境中才允许保留；其余一律视为无证据造冲突。 */
function unsafeTuneDirective(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (ARTIFICIAL_TUNE_EVENT_RE.test(text)) return true;
  for (const match of text.matchAll(ARTIFICIAL_TUNE_EVENT_TERM_RE)) {
    const prefix = text.slice(Math.max(0, match.index - 10), match.index);
    if (!/(?:不|不得|禁止|避免|无需|不能|勿|拒绝|并非|没有)\s*$/.test(prefix)) return true;
  }
  return false;
}

/** 工单指令字段的统一净化判定：事故词族（tune/rebuild 都不得靠造冲突出药方）或
 *  戏剧化处方词族（rebuild 目标写成桥段处方的头号败因）。只作用于编辑指令文本，
 *  永不触碰正文本身。 */

/** 工单指令字段的统一净化判定：事故词族（tune/rebuild 都不得靠造冲突出药方）或
 *  戏剧化处方词族（rebuild 目标写成桥段处方的头号败因）。只作用于编辑指令文本，
 *  永不触碰正文本身。 */
function unsafeRecoveryDirective(value) {
  const text = String(value || '');
  return unsafeTuneDirective(value) || DRAMATIC_PRESCRIPTION_RE.test(text) || SOFT_ESCALATION_RE.test(text);
}

/**
 * 按字符预算把候选整段切成连续分段：段内章号连续、不漏章、不重复；
 * 单章本身超过预算时自成分段（不得为了凑预算拆断一章或漏章）。
 */

export function baselineRiskForChapter(chapterIdx, suspectedTurnChapter = 7) {
  const chapter = Number(chapterIdx);
  const turn = Math.max(2, Number(suspectedTurnChapter) || 7);
  return chapter < turn
    ? { prior: 'suspected_baseline', note: '签约曾通过只提供弱先验，本章仍须原文证据验证' }
    : { prior: 'high_risk', note: '作者观察到此处后越来越水，提高审查强度但不预设结论' };
}

export function validateRecoveryDiagnosis(payload, chapters, {
  suspectedTurnChapter = 7,
  allowPartialEvidence = false,
} = {}) {
  if (!payload || typeof payload !== 'object') throw recoveryError('返工诊断结构无效');
  const sourceChapters = Array.isArray(chapters) ? chapters : [];
  const expected = new Set(sourceChapters.map(chapter => Number(chapter.idx)));
  const rows = requireArray(payload.quality_curve, 'quality_curve');
  // V0.100.6：qwen 会把指令里提及的章节号一并编进曲线（实测：5 章输入返回 7 行甚至 34 行，
  // 已知假设/总审结论里的章节号都会被它当成任务范围）——先按输入范围确定性过滤掉超范围行，
  // 保留行仍逐章验证据（内容严格不变），漏章/重复才判废。
  const inScopeRows = rows.filter(row => expected.has(Number(row?.chapter)));
  if (inScopeRows.length !== expected.size) throw recoveryError('quality_curve 必须逐章覆盖输入正文，不能漏章或多章');
  const seen = new Set();
  // V0.100.6：行级错误聚合上报——逐条即抛时反馈只提第一条，模型修一条又踩一条
 // （实测：ch23 证据修好、ch21 目标字段又空，重答引入新缺陷整批照样死）。
  // 一次列全所有坏行，唯一一次重答才能整体修正；结构错误（缺曲线/缺段评）仍即抛。
  const rowErrors = [];
  const normalized = [];
  const validationWarnings = [];
  for (const row of inScopeRows) {
    try {
      const chapter = Number(row?.chapter);
      if (!Number.isInteger(chapter) || !expected.has(chapter) || seen.has(chapter)) {
        throw recoveryError('quality_curve 必须逐章覆盖输入正文，章节号不能重复或越界');
      }
      seen.add(chapter);
      const source = sourceChapters.find(item => Number(item.idx) === chapter);
      const action = String(row.action || '');
      if (!ACTIONS.has(action)) throw recoveryError(`第${chapter}章 action 无效`);
      const rowWarnings = [];
      const evidence = requireArray(row.evidence, `第${chapter}章 evidence`).flatMap((item, evidenceIndex) => {
        const raw = requireText(item, `第${chapter}章 evidence`);
        const grounded = groundedEvidenceFragments(source.text, raw);
        if (grounded.length) return grounded;
        if (allowPartialEvidence) {
          const partial = partiallyGroundedEvidenceFragments(source.text, raw);
          if (partial.length) {
            rowWarnings.push({ chapter, evidence_index: evidenceIndex, code: 'partial_evidence_isolated' });
            return partial;
          }
          // 一行有两条证据时，允许隔离其中一条完整坏证据；但本行至少仍须有一段真实核心。
          rowWarnings.push({ chapter, evidence_index: evidenceIndex, code: 'unlocatable_evidence_isolated' });
          return [];
        }
        throw recoveryError(`第${chapter}章证据“${raw}”无法在原文定位`);
      });
      if (!evidence.length) {
        const raw = requireArray(row.evidence, `第${chapter}章 evidence`).map(String).join(' / ');
        throw recoveryError(`第${chapter}章证据“${raw}”无法在原文定位`);
      }
      const effectiveEvents = requireArray(row.effective_events, `第${chapter}章 effective_events`).map(String);
      const fillerSignals = requireArray(row.filler_signals, `第${chapter}章 filler_signals`).map(String);
      const objective = requireText(row.rebuild_objective, `第${chapter}章 rebuild_objective`, { allowEmpty: action === 'keep' });
      const modelReason = requireText(row.reason, `第${chapter}章 reason`);
      const isolated = rowWarnings.length > 0;
      if (isolated) validationWarnings.push(...rowWarnings);
      normalized.push({
        chapter,
        score: score(row.score, `第${chapter}章 score`),
        // 近似引文的真实核心可以用于保存诊断进度，但其错误部分不得间接触发正文改写。
        action: isolated ? 'keep' : action,
        evidence,
        effective_events: isolated ? [] : effectiveEvents,
        irreversible_change: isolated ? '' : requireText(row.irreversible_change, `第${chapter}章 irreversible_change`, { allowEmpty: true }),
        character_cost: isolated ? '' : requireText(row.character_cost, `第${chapter}章 character_cost`, { allowEmpty: true }),
        promise_delivery: isolated ? '' : requireText(row.promise_delivery, `第${chapter}章 promise_delivery`, { allowEmpty: true }),
        filler_signals: isolated ? [] : fillerSignals,
        ending_pull: isolated ? '' : requireText(row.ending_pull, `第${chapter}章 ending_pull`, { allowEmpty: true }),
        reason: isolated ? '模型引文含无法逐字核验的部分，已隔离；本轮保持原稿。' : modelReason,
        rebuild_objective: isolated ? '' : objective,
        ...(isolated ? { validation_warnings: rowWarnings } : {}),
        ...baselineRiskForChapter(chapter, suspectedTurnChapter),
      });
    } catch (error) {
      rowErrors.push(error.message);
    }
  }
  if (rowErrors.length) throw recoveryError(rowErrors.join('；'));
  normalized.sort((left, right) => left.chapter - right.chapter);
  if (seen.size !== expected.size) throw recoveryError('quality_curve 必须逐章覆盖输入正文');
  const segment = payload.segment_verdict;
  if (!segment || typeof segment !== 'object' || typeof segment.deterioration_found !== 'boolean') {
    throw recoveryError('segment_verdict 必须说明是否发现质量下坠');
  }
  let deteriorationFound = segment.deterioration_found;
  let turnChapter = Number.isInteger(Number(segment.turn_chapter)) ? Number(segment.turn_chapter) : null;
  let segmentReason = requireText(segment.reason, 'segment_verdict.reason');
  if (validationWarnings.length) {
    const trustedOrders = normalized.filter(item => item.action !== 'keep');
    if (!trustedOrders.length) {
      deteriorationFound = false;
      turnChapter = null;
      segmentReason = '近似引文已隔离；本段没有可由逐字证据支持的返工工单。';
    } else if (!trustedOrders.some(item => item.chapter === turnChapter)) {
      turnChapter = trustedOrders[0].chapter;
      segmentReason = `${segmentReason}（无法核验的章节已隔离，不参与转折点判断）`;
    }
  }
  return {
    quality_curve: normalized,
    segment_verdict: {
      deterioration_found: deteriorationFound,
      turn_chapter: turnChapter,
      reason: segmentReason,
    },
    ...(validationWarnings.length ? { validation_warnings: validationWarnings } : {}),
  };
}

export function validateRecoverySynthesis(payload, chapters, qualityCurve) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw recoveryError('全范围综合规划结构无效');
  }
  const chapterByIdx = new Map(chapters.map(chapter => [Number(chapter.idx), chapter]));
  const curveByIdx = new Map(qualityCurve.map(item => [Number(item.chapter), item]));
  const expectedOrders = qualityCurve.filter(item => item.action !== 'keep');
  const expectedChapters = new Set(expectedOrders.map(item => Number(item.chapter)));
  const rawArcs = requireArray(payload.arcs, 'repair_plan.arcs');
  const rawOrders = requireArray(payload.chapter_orders, 'repair_plan.chapter_orders');

  // V0.100.8：综合规划必须与诊断、盲审同口径——一次列全所有问题。
  // 19 章工单 + 弧覆盖/依赖/交接/证据回指多重约束下，遇到第一条即抛会让模型
  // "修一条又踩一条"，三次纠正必然耗尽、整批取证白烧（与 V0.100.6 已修的
  // 诊断行级聚合同源）。结构级错误（缺字段/非数组）仍即抛，因为无法继续解析。
  const errors = [];

  if (rawOrders.length !== expectedOrders.length) {
    errors.push(`repair_plan.chapter_orders 必须覆盖全部 ${expectedOrders.length} 个返工章，当前 ${rawOrders.length} 条`);
  }
  if (expectedOrders.length && !rawArcs.length) errors.push('存在返工章时 repair_plan.arcs 不得为空');

  const arcIds = new Set();
  const arcChapterOwner = new Map();
  const arcs = [];
  rawArcs.forEach((raw, index) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw recoveryError(`repair_plan.arcs[${index}] 结构无效`);
      const id = requireText(raw.id, `repair_plan.arcs[${index}].id`);
      if (arcIds.has(id)) throw recoveryError(`repair_plan arc id 重复：${id}`);
      arcIds.add(id);
      const arcChapters = requireArray(raw.chapters, `repair_plan.arcs[${index}].chapters`).map(Number);
      if (!arcChapters.length || arcChapters.some(idx => !Number.isInteger(idx) || !chapterByIdx.has(idx))) {
        throw recoveryError(`repair_plan arc ${id} 含范围外或无效章号`);
      }
      if (new Set(arcChapters).size !== arcChapters.length) throw recoveryError(`repair_plan arc ${id} 章号重复`);
      for (const chapterIdx of arcChapters) {
        if (arcChapterOwner.has(chapterIdx)) throw recoveryError(`第${chapterIdx}章同时属于多个 repair_plan arc`);
        arcChapterOwner.set(chapterIdx, id);
      }
      // 各字段互相独立：逐项收集而不是首个即抛，否则修好 A 才暴露 B，重答轮次被无谓消耗。
      const arcErrors = [];
      const collect = (fn) => { try { return fn(); } catch (error) { arcErrors.push(error.message); return null; } };
      const problem = collect(() => requireText(raw.problem, `repair_plan arc ${id}.problem`)) ?? '';
      const entryState = collect(() => requireText(raw.entry_state, `repair_plan arc ${id}.entry_state`)) ?? '';
      const exitState = collect(() => requireText(raw.exit_state, `repair_plan arc ${id}.exit_state`)) ?? '';
      if (entryState && exitState && compact(entryState) === compact(exitState)) {
        arcErrors.push(`repair_plan arc ${id} 的入口与出口状态不能相同`);
      }
      const seenSteps = new Set();
      const causalSteps = [];
      for (const step of collect(() => requireArray(raw.causal_steps, `repair_plan arc ${id}.causal_steps`)) || []) {
        collect(() => {
          const chapter = Number(step?.chapter);
          if (!Number.isInteger(chapter) || !arcChapters.includes(chapter)) {
            throw recoveryError(`repair_plan arc ${id} 的 causal_steps 引用了弧外章节`);
          }
          if (seenSteps.has(chapter)) throw recoveryError(`repair_plan arc ${id} 的第${chapter}章 causal_step 重复`);
          seenSteps.add(chapter);
          causalSteps.push({ chapter, required_change: requireText(step?.required_change, `第${chapter}章 required_change`) });
        });
      }
      const protectedFacts = [];
      let factIndex = 0;
      for (const fact of collect(() => requireArray(raw.protected_facts, `repair_plan arc ${id}.protected_facts`)) || []) {
        collect(() => protectedFacts.push(requireText(fact, `repair_plan arc ${id}.protected_facts[${factIndex}]`)));
        factIndex++;
      }
      if (arcErrors.length) throw recoveryError(arcErrors.join('；'));
      arcs.push({
        id,
        chapters: [...arcChapters].sort((left, right) => left - right),
        problem,
        entry_state: entryState,
        exit_state: exitState,
        causal_steps: causalSteps,
        protected_facts: protectedFacts,
      });
    } catch (error) {
      errors.push(error.message);
    }
  });

  const seenOrders = new Set();
  const orders = [];
  // 依赖图必须独立于“整条工单是否已完全合法”。否则一条工单若同时有证据/文案
  // 错误与跨章依赖环，会先因字段错误被排除，唯一一次纠正后才暴露环，白烧整批取证。
  const dependencyGraph = new Map();
  rawOrders.forEach((raw, index) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw recoveryError(`chapter_orders[${index}] 结构无效`);
      const chapter = Number(raw.chapter);
      if (!Number.isInteger(chapter) || !expectedChapters.has(chapter) || seenOrders.has(chapter)) {
        throw recoveryError(`chapter_orders 含缺失、重复或非返工章：第${raw.chapter ?? '?'}章`);
      }
      seenOrders.add(chapter);
      const source = curveByIdx.get(chapter);
      // 与弧相关的检查失败也不能吞掉其他字段的问题：逐项收集，一次反馈列全。
      const orderErrors = [];
      const collect = (fn) => { try { return fn(); } catch (error) { orderErrors.push(error.message); return null; } };
      const action = String(raw.action || '');
      if (!['tune', 'rebuild'].includes(action)) orderErrors.push(`第${chapter}章综合工单 action 无效`);
      // V0.100.15：连败史硬性降级的 rebuild 章（compileRecoveryPlan 本地判定后写入
      // order.original_rebuild 标记）豁免“不得降级”校验——该降级不是模型自由选择，
      // 而是多轮质量性败选后的本地收口。
      const lossDowngraded = Boolean(raw.loss_downgraded);
      if (source.action === 'rebuild' && action !== 'rebuild' && !lossDowngraded) {
        orderErrors.push(`第${chapter}章原诊断为 rebuild，不得在综合规划中降级`);
      }
      const evidence = (collect(() => requireArray(raw.evidence, `第${chapter}章综合工单 evidence`)
        .map(item => requireText(item, `第${chapter}章综合工单 evidence`))) || []);
      if (raw.evidence && (!evidence.length || evidence.length > 2)) {
        orderErrors.push(`第${chapter}章综合工单 evidence 必须为 1—2 条`);
      }
      const sourceEvidence = new Set((source.evidence || []).map(compact));
      for (const quote of evidence) {
        if (!sourceEvidence.has(compact(quote)) || !quoteLocated(chapterByIdx.get(chapter)?.text, quote)) {
          orderErrors.push(`第${chapter}章综合工单 evidence“${quote}”不是该章已验证取证（必须逐字复制该章取证里的原文，且能在正文中定位）`);
        }
      }
      const objective = collect(() => requireText(raw.objective, `第${chapter}章 objective`)) ?? '';
      const reason = collect(() => requireText(raw.reason, `第${chapter}章 reason`)) ?? '';
      const mustHandoff = collect(() => requireText(raw.must_handoff, `第${chapter}章 must_handoff`)) ?? '';
      const planArcId = collect(() => requireText(raw.plan_arc_id, `第${chapter}章 plan_arc_id`)) ?? '';
      const arc = arcs.find(item => item.id === planArcId);
      if (planArcId && (!arc || !arc.chapters.includes(chapter))) {
        orderErrors.push(`第${chapter}章未归入有效 repair_plan arc`);
      }
      if (arc && arc.chapters.includes(chapter) && !arc.causal_steps.some(step => step.chapter === chapter)) {
        orderErrors.push(`第${chapter}章缺少 arc causal_step`);
      }
      const causalRequirement = arc?.causal_steps
        ?.find(step => Number(step.chapter) === chapter)?.required_change || '';
      const tuneDirectiveFields = [
        objective, reason, mustHandoff, causalRequirement,
        arc?.problem, arc?.entry_state, arc?.exit_state,
        ...(arc?.protected_facts || []),
      ];
      if (action === 'tune' && tuneDirectiveFields.some(unsafeTuneDirective)) {
        orderErrors.push(
          `第${chapter}章 tune 工单不得靠新增意外、险情、事故、突发威胁或密信制造张力；`
          + '必须从旧稿已有的行动、信息差、人物选择和后果中压缩、重排或兑现，确需新增剧情则应有诊断证据并升级为 rebuild',
        );
      }
      const dependsOn = collect(() => requireArray(raw.depends_on, `第${chapter}章 depends_on`).map(Number)) || [];
      const dependencyInvalid = new Set(dependsOn).size !== dependsOn.length
        || dependsOn.some(dep => !Number.isInteger(dep) || dep === chapter || !expectedChapters.has(dep));
      if (raw.depends_on && dependencyInvalid) {
        orderErrors.push(`第${chapter}章 depends_on 含重复、自依赖或非返工章`);
      }
      if (Array.isArray(raw.depends_on) && !dependencyInvalid) {
        dependencyGraph.set(chapter, dependsOn);
      }
      if (orderErrors.length) throw recoveryError(orderErrors.join('；'));
      orders.push({
        chapter,
        action,
        objective,
        evidence,
        reason,
        old_score: source.score,
        prior: source.prior,
        plan_arc_id: planArcId,
        depends_on: dependsOn,
        must_handoff: mustHandoff,
      });
    } catch (error) {
      errors.push(error.message);
    }
  });
  if (seenOrders.size !== expectedChapters.size) {
    errors.push(`chapter_orders 未完整覆盖所有返工章（缺第${[...expectedChapters].filter(idx => !seenOrders.has(idx)).join('、')}章）`);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (chapter, trail = []) => {
    if (visiting.has(chapter)) {
      errors.push(`repair_plan depends_on 存在循环依赖：第${[...trail, chapter].join('→')}章`);
      return;
    }
    if (visited.has(chapter)) return;
    visiting.add(chapter);
    for (const dependency of dependencyGraph.get(chapter) || []) visit(dependency, [...trail, chapter]);
    visiting.delete(chapter);
    visited.add(chapter);
  };
  for (const chapter of dependencyGraph.keys()) visit(chapter);

  if (errors.length) throw recoveryError([...new Set(errors)].join('；'));

  return { arcs, chapter_orders: orders.sort((left, right) => left.chapter - right.chapter) };
}

function recoveryPlanText(value, fallback) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeTunePlanText(value, fallback) {
  const text = recoveryPlanText(value, '');
  return text && !unsafeTuneDirective(text) ? text : fallback;
}

/** V0.100.15 rebuild 指令字段的净化版：事故词与戏剧化处方都退回 fallback。
 *  综合模型的自由措辞不再直通作者模型；fallback 链把最后一站换成中性可验收表述。 */

/** V0.100.15 rebuild 指令字段的净化版：事故词与戏剧化处方都退回 fallback。
 *  综合模型的自由措辞不再直通作者模型；fallback 链把最后一站换成中性可验收表述。 */
function safeRecoveryPlanText(value, fallback) {
  const text = recoveryPlanText(value, '');
  return text && !unsafeRecoveryDirective(text) ? text : fallback;
}

/**
 * 把模型提供的“叙事建议”编译成完整、可执行的本地计划。
 * 模型只负责提出跨章组织；章覆盖、证据、动作、依赖闭环和 tune 安全边界都由本地确定。
 * 这样综合规划只需一次模型调用，缺行/坏依赖/危险措辞不会再触发整份 JSON 重答。
 */

/**
 * 把模型提供的“叙事建议”编译成完整、可执行的本地计划。
 * 模型只负责提出跨章组织；章覆盖、证据、动作、依赖闭环和 tune 安全边界都由本地确定。
 * 这样综合规划只需一次模型调用，缺行/坏依赖/危险措辞不会再触发整份 JSON 重答。
 */
export function compileRecoveryPlan(payload, chapters, qualityCurve, { bookId = '' } = {}) {
  const sourceChapters = Array.isArray(chapters) ? chapters : [];
  // V0.100.15 连败史硬性降级统计需要 bookId（chapters 未必带 book_id 字段）。
  const lossBookId = bookId || sourceChapters.find(chapter => chapter?.book_id)?.book_id || '';
  const sourceCurve = Array.isArray(qualityCurve) ? qualityCurve : [];
  const chapterByIdx = new Map(sourceChapters.map(chapter => [Number(chapter.idx), chapter]));
  const expected = sourceCurve
    .filter(item => ['tune', 'rebuild'].includes(String(item?.action)))
    .sort((left, right) => Number(left.chapter) - Number(right.chapter));
  if (!expected.length) return { arcs: [], chapter_orders: [] };

  const expectedChapters = new Set(expected.map(item => Number(item.chapter)));
  const rawPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawOrders = Array.isArray(rawPayload.chapter_orders) ? rawPayload.chapter_orders : [];
  const rawOrderByChapter = new Map();
  for (const order of rawOrders) {
    const chapter = Number(order?.chapter);
    if (expectedChapters.has(chapter) && !rawOrderByChapter.has(chapter)) rawOrderByChapter.set(chapter, order);
  }
  const rawArcs = Array.isArray(rawPayload.arcs) ? rawPayload.arcs : [];
  const rawArcById = new Map();
  for (const arc of rawArcs) {
    const id = String(arc?.id || '').trim();
    if (id && !rawArcById.has(id)) rawArcById.set(id, arc);
  }

  const orders = expected.map((source) => {
    const chapter = Number(source.chapter);
    const raw = rawOrderByChapter.get(chapter) || {};
    let action = String(source.action); // 综合层不得推翻已经逐章验证的动作等级。
    // V0.100.15 连败史硬性降级：该章按 rebuild 执行且质量性败选 ≥3 轮（本地确定性判定，
    // 不再交给模型决策——连败回流已提示"慎再开 rebuild"但模型仍会开，反复烧钱后由本地
    // 收口）。降为 tune + 压缩 objective：同义重复、循环观察可用压缩收敛，无需整窗重写。
    const lossHistory = repeatedRebuildLossChapterCount(chapter, lossBookId);
    const lossDowngraded = action === 'rebuild' && lossHistory >= 2;
    if (lossDowngraded) {
      action = 'tune';
    }
    const curveEvidence = (Array.isArray(source.evidence) ? source.evidence : [])
      .map(item => String(item || '').trim())
      .filter(quote => quote && quoteLocated(chapterByIdx.get(chapter)?.text, quote));
    // V0.100.1—V0.100.13 的部分已保存运行把逐字证据放在 work_orders，
    // quality_curve 只保存分数与动作。执行升级时仍应直接续跑：只在旧工单证据
    // 能重新定位到当前正文时把它提升为本地已验证证据，绝不为补字段重跑综合模型。
    const persistedEvidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map(item => String(item || '').trim())
      .filter(quote => quote && quoteLocated(chapterByIdx.get(chapter)?.text, quote));
    const sourceEvidence = curveEvidence.length ? curveEvidence : persistedEvidence;
    const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map(item => String(item || '').trim())
      .filter(quote => sourceEvidence.some(sourceQuote => compact(sourceQuote) === compact(quote)))
      .slice(0, 2);
    if (!evidence.length) evidence.push(...sourceEvidence.slice(0, 2));

    const groundedObjective = safeRecoveryPlanText(
      source.rebuild_objective,
      '围绕已验证证据压缩重复内容，让旧稿已有行动、信息差或人物选择形成直接后果',
    );
    const groundedReason = safeRecoveryPlanText(
      source.reason,
      '依据本章已验证取证，只处理旧稿已有的重复、行动与后果，不新增剧情事件',
    );
    // V0.100.15 终局收口：rebuild 的单章 objective/reason/must_handoff 不再放行任何模型
    // 自由文本（综合 raw.objective 与诊断行 rebuild_objective 的动词处方花样无穷——
    // “设置验证陷阱/心理施压/布局试探/引发反应”逐轮换马甲，作者模型照做必 OOC 败选，
 // 实测 ch27-23 两代实证）。模型的判断只通过弧结构、逐字证据与交接状态传递；
    // 单章“怎么改”一律中性化，手段由作者模型从旧稿人设与资源中长出来。
    const neutralRebuildObjective = '按已验证证据重构本章因果推进：主角用旧稿已有的身份、规则与资源作出有代价的选择，让局势发生可核验的实质变化';
    // V0.100.15 连败史降级章：rebuild 反复败选（多轮盲审证明重写打不过旧稿）后，按
    // 压缩收敛处理——只删重复、并循环、快推进，不整窗重写。
    const downgradedTuneObjective = '压缩重复描写与循环情节，让本章已有行动与信息差更快形成后果；不重写事件、不新增戏份';
    // V0.100.11 约束：诊断确定的 objective 必须保留在存档（执行失败不得覆盖修复计划）。
    // V0.100.15 治毒发生在执行注入侧（见 buildRecoveryRewriteInstructionForOrder），
    // 这里只对连败史降级章改写目标（该章目标本来就是毒，降级是本地确定性收口）。
    const objective = action === 'tune'
      ? (lossHistory >= 2 ? downgradedTuneObjective : groundedObjective)
      : recoveryPlanText(raw.objective, source.rebuild_objective || neutralRebuildObjective);
    const reason = action === 'tune'
      ? (lossHistory >= 2 ? `该章重构工单已多轮未能证明优于旧稿，本地降级为压缩收敛；${groundedReason}` : groundedReason)
      : recoveryPlanText(raw.reason, source.reason || '关键因果链需要重构');
    const mustHandoff = action === 'tune'
      ? '保留旧稿既有事实边界，让本章已有行动形成可由后文承接的明确结果'
      : safeRecoveryPlanText(raw.must_handoff, '本章重构结果形成可由后文承接的明确状态');
    const requestedArcId = String(raw.plan_arc_id || '').trim();
    const planArcId = requestedArcId && rawArcById.has(requestedArcId)
      ? requestedArcId
      : `arc-local-${chapter}`;
    const dependsOn = [...new Set((Array.isArray(raw.depends_on) ? raw.depends_on : [])
      .map(Number)
      // 叙事依赖只允许指向更早的返工章；该规则天然消除自依赖、后向环和不存在的章。
      .filter(dependency => Number.isInteger(dependency)
        && expectedChapters.has(dependency)
        && dependency < chapter))]
      .sort((left, right) => left - right);
    return {
      chapter, action, objective, evidence, reason,
      old_score: Number(source.score) || 0,
      prior: source.prior,
      plan_arc_id: planArcId,
      depends_on: dependsOn,
      must_handoff: mustHandoff,
      loss_downgraded: lossDowngraded,
    };
  });

  const orderGroups = new Map();
  for (const order of orders) {
    if (!orderGroups.has(order.plan_arc_id)) orderGroups.set(order.plan_arc_id, []);
    orderGroups.get(order.plan_arc_id).push(order);
  }
  const arcs = [];
  for (const [id, group] of orderGroups) {
    group.sort((left, right) => left.chapter - right.chapter);
    const rawArc = rawArcById.get(id) || {};
    const tuneOnly = group.every(order => order.action === 'tune');
    const first = group[0].chapter;
    const last = group.at(-1).chapter;
    const problemFallback = `第${first}${last === first ? '' : `—${last}`}章旧稿已有行动没有及时形成可承接结果`;
    const entryFallback = `进入第${first}章返工前，旧稿既有行动尚未形成明确交接`;
    const exitFallback = `完成第${last}章返工后，旧稿既有行动形成可由后文承接的明确结果`;
    const rawSteps = new Map((Array.isArray(rawArc.causal_steps) ? rawArc.causal_steps : [])
      .map(step => [Number(step?.chapter), String(step?.required_change || '').trim()]));
    const causalSteps = group.map((order) => ({
      chapter: order.chapter,
      // rebuild 的因果职责与 objective 同源中性化（V0.100.15 终局收口）；tune 沿用工单目标。
      required_change: order.action === 'tune'
        ? order.objective
        : '让本章已有证据与选择造成可核验的局势变化，并把新状态交给下一章',
    }));
    const protectedFacts = (Array.isArray(rawArc.protected_facts) ? rawArc.protected_facts : [])
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .filter(item => !tuneOnly || !unsafeTuneDirective(item));
    if (!protectedFacts.length) protectedFacts.push('不得改变旧稿已经成立的人物身份、时间、地点与事实边界');
    const problem = tuneOnly
      ? safeTunePlanText(rawArc.problem, problemFallback)
      : safeRecoveryPlanText(rawArc.problem, problemFallback);
    const entryState = tuneOnly
      ? safeTunePlanText(rawArc.entry_state, entryFallback)
      : safeRecoveryPlanText(rawArc.entry_state, entryFallback);
    let exitState = tuneOnly
      ? safeTunePlanText(rawArc.exit_state, exitFallback)
      : safeRecoveryPlanText(rawArc.exit_state, exitFallback);
    if (compact(exitState) === compact(entryState)) exitState = exitFallback;
    arcs.push({
      id,
      chapters: group.map(order => order.chapter),
      problem,
      entry_state: entryState,
      exit_state: exitState,
      causal_steps: causalSteps,
      protected_facts: protectedFacts,
    });
  }

  // 最后仍走原有严格验证器。旧检查点若只在工单保存了证据，先把已经重新定位成功的
  // 证据补进“验证视图”；这只影响本次本地校验，不改写原诊断曲线，更不触发模型调用。
  const validationCurve = sourceCurve.map((source) => {
    if (!['tune', 'rebuild'].includes(String(source?.action))) return source;
    const chapter = Number(source.chapter);
    const locatedCurveEvidence = (Array.isArray(source.evidence) ? source.evidence : [])
      .map(item => String(item || '').trim())
      .filter(quote => quote && quoteLocated(chapterByIdx.get(chapter)?.text, quote));
    if (locatedCurveEvidence.length) return { ...source, evidence: locatedCurveEvidence };
    const order = orders.find(item => item.chapter === chapter);
    return { ...source, evidence: order?.evidence || [] };
  });
  return validateRecoverySynthesis({ arcs, chapter_orders: orders }, sourceChapters, validationCurve);
}

export function validateBlindComparison(payload, { candidateA, candidateB } = {}) {
  if (!payload || typeof payload !== 'object') throw recoveryError('匿名对照审稿结构无效');
  const winner = String(payload.winner || '');
  if (!WINNERS.has(winner)) throw recoveryError('匿名对照审稿 winner 必须是 A、B 或 tie');
  const margin = Number(payload.margin);
  if (!Number.isFinite(margin) || margin < 0 || margin > 100) throw recoveryError('匿名对照审稿 margin 必须在 0—100');
  const scores = {};
  for (const label of ['A', 'B']) {
    if (!payload.scores?.[label] || typeof payload.scores[label] !== 'object') throw recoveryError(`${label} 缺少四维得分`);
    scores[label] = {};
    for (const dimension of SCORE_DIMENSIONS) scores[label][dimension] = score(payload.scores[label][dimension], `${label}.${dimension}`);
  }
  const evidence = {};
  for (const [label, text] of [['A', candidateA], ['B', candidateB]]) {
    // V0.100.1：免费端点常把单条引文写成裸字符串而非数组——包装形态做确定性归一，
    // 内容仍须逐字定位，幻觉引文照样判废（形态宽容、内容严格）。
    // V0.100.2：对象形态同权归一——{quote|text|evidence|content: "…"} 及其数组
 // （实测："A evidence必须是数组"在 ch4/ch9/ch12 反复烧掉重答轮次）。
    const normalizeEvidenceShape = (raw) => {
      const fromObject = (item) => {
        if (!item || typeof item !== 'object') return item;
        for (const key of ['quote', 'text', 'evidence', 'quote_text', 'content']) {
          if (typeof item[key] === 'string' && item[key].trim()) return item[key];
        }
        return item;
      };
      if (typeof raw === 'string') return [raw];
      if (Array.isArray(raw)) return raw.map(fromObject);
      if (raw && typeof raw === 'object') {
        const extracted = fromObject(raw);
        return typeof extracted === 'string' ? [extracted] : raw;
      }
      return raw;
    };
    evidence[label] = requireArray(normalizeEvidenceShape(payload.evidence?.[label]), `${label} evidence`)
      .map(item => requireText(item, `${label} evidence`));
    if (!evidence[label].length) throw recoveryError(`${label} 至少需要一条原文证据`);
    for (const quote of evidence[label]) {
      if (!quoteLocated(text, quote)) throw recoveryError(`${label} 证据“${quote}”无法在正文定位`);
    }
  }
  return { winner, margin, scores, evidence, reason: requireText(payload.reason, '匿名对照审稿 reason') };
}
