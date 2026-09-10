// server/llm/router.js —— 任务 → 模型/参数 路由（双模型路由核心 + V0.109 双端点动态编排）
'use strict';
import { resolveRoute as resolveBase, resolveProtocol, setProtocolProbe, getProtocolProbe, setUsedProtocol, providerInfo, capReasoningEffort, resolveBackupRoute } from '../config.js';
import { chatCompletion, probeProtocols } from './client.js';
import { getGlobal } from '../config.js';
import { computeCost } from './cost.js';
import * as store from '../db/store.js';
import { logLlm } from '../util/oplog.js';

// ---------- V0.109 备用通道动态编排（进程内状态；导出纯函数与状态复位供测试） ----------

/** 可切换到备用的错误码：熔断打开/网络/限流/5xx/超时/流中断——都是"端点故障"形态。
 *  AUTH_ERROR 不切（Key 错误换端点也一样错，直接报给用户去改 Key）；ABORTED 是用户主动取消。 */
const FALLBACK_CODES = new Set(['CIRCUIT_OPEN', 'NETWORK_ERROR', 'RATE_LIMIT', 'API_ERROR', 'HTTP_TIMEOUT', 'STREAM_STALL', 'STREAM_INCOMPLETE']);

export function shouldFallbackToBackup(err, g = getGlobal()) {
  const backup = g?.backup || {};
  if (!backup.enabled || !backup.apiKey) return false;
  if (backupFailureCount >= (Number(backup.failureThreshold) || 3)) return false; // 备用自身熔断
  return FALLBACK_CODES.has(String(err?.code || ''));
}

// 粘性切换状态（进程内；重启归零可接受——重启本身就是一次状态复位）
let stickyBackupUntil = 0;
let backupFailureCount = 0;
let lastProbeAt = 0;

export function backupOrchestrationState() {
  return {
    sticky: stickyBackupUntil > Date.now(),
    stickyUntil: stickyBackupUntil,
    backupFailures: backupFailureCount,
    lastProbeAt,
  };
}

/** 测试复位 */
export function resetBackupOrchestration() {
  stickyBackupUntil = 0;
  backupFailureCount = 0;
  lastProbeAt = 0;
}

/** 粘性窗口内？新请求直接走备用（主端点在故障中，别每请求都撞墙） */
export function isStickyBackup(g = getGlobal()) {
  if (stickyBackupUntil > Date.now()) return true;
  // 窗口已过 → 退出粘性（主端点按正常逻辑请求；若仍故障会再次触发切换续窗）
  if (stickyBackupUntil > 0) stickyBackupUntil = 0;
  return false;
}

/** 备用成功：置粘性窗口 + 复位备用失败计数 + 记切换事件（首个进入粘性的请求才记） */
function markBackupSuccess(task, g) {
  const wasSticky = stickyBackupUntil > Date.now();
  backupFailureCount = 0;
  stickyBackupUntil = Date.now() + (Number(g?.backup?.stickyMs) || 5 * 60 * 1000);
  if (!wasSticky) {
    logLlm({ task, model: '', ok: true, detail: `备用通道接管（${g?.backup?.provider || 'deepseek_official'}），粘性窗口 ${Math.round((Number(g?.backup?.stickyMs) || 300000) / 1000)}s` });
  }
}

/** 备用失败：计数 +1；达阈值记熔断事件（后续 shouldFallback 直接 false） */
function markBackupFailure(task, g, err) {
  backupFailureCount++;
  const threshold = Number(g?.backup?.failureThreshold) || 3;
  if (backupFailureCount === threshold) {
    logLlm({ task, model: '', ok: false, detail: `备用通道连续失败 ${threshold} 次，自身熔断（本轮不再绕备用，直抛主端点错误）` });
  }
  return err;
}

/** 回切探针（粘性窗口内节流调用）：单条 1-token 请求测主端点，成功则退出粘性。
 *  fire-and-forget——探针失败只是继续留在备用，不影响当前任务。 */
function probePrimaryForRecovery(g) {
  const now = Date.now();
  const interval = Number(g?.backup?.probeIntervalMs) || 60 * 1000;
  if (now - lastProbeAt < interval) return;
  lastProbeAt = now;
  chatCompletion({
    baseUrl: g.baseUrl, apiKey: g.apiKey,
    model: 'probe', messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 1, stream: false, resilience: { ...g.resilience, maxRetries: 0, rateLimitMaxRetries: 0, networkMaxRetries: 0 },
  }).then(() => {
    if (stickyBackupUntil > 0) {
      stickyBackupUntil = 0;
      logLlm({ task: 'backup_recover', model: '', ok: true, detail: '主端点探针成功，已自动回切主通道' });
    }
  }).catch(() => { /* 探针失败：继续留在备用，下个窗口再试 */ });
}

/** V0.109：备用通道执行（粘性直走/快切共用）——成功返回带 fallback 标记的结果，失败返回 null（计数已记）。 */
async function runOnBackup(task, base, route, g, bookSettings, bookId, useStream, capped) {
  const backupRoute = resolveBackupRoute(task, route.model, g, bookSettings);
  if (!backupRoute) return null;
  try {
    const r = await chatCompletion({
      ...base, model: backupRoute.model, temperature: route.temperature, maxTokens: route.maxTokens,
      stream: useStream, thinking: route.thinking ?? 'disabled',
      reasoningEffort: capped(route.reasoningEffort ?? 'high'), userId: bookId || undefined,
      baseUrl: backupRoute.baseUrl, apiKey: backupRoute.apiKey,
      deepseekParams: backupRoute.deepseekParams, qwenParams: backupRoute.qwenParams, protocol: backupRoute.protocol,
    });
    markBackupSuccess(task, g);
    return { result: r, backupModel: backupRoute.model };
  } catch (be) {
    if (be.code === 'ABORTED' || be.name === 'AbortError') throw be;
    markBackupFailure(task, g, be);
    return { error: be };
  }
}

/**
 * 执行一个"任务"（带路由、成本记录、可选流式）。
 * @param {object} opts
 * @param {string} opts.task      任务名（write/chapter_outline/audit/...）
 * @param {string} [opts.bookId]
 * @param {string} [opts.chapterId]
 * @param {Array} opts.messages   完整 messages（已由 cache.assembleMessages 组装）
 * @param {object} [opts.streamCb] { onDelta, onProgress } 流式回调
 * @param {boolean} [opts.jsonMode]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content:string, usage:object, model:string, cost:object, durationMs:number, finishReason:string}>}
 */
export async function runTask(opts) {
  const { task, bookId, chapterId, messages, streamCb, jsonMode = false, signal, onRetry, resilience, routeOverride } = opts;
  const g = getGlobal();
  const bookSettings = bookId ? store.books.settings(bookId) : {};
  const route = resolveTaskRoute(task, bookSettings, routeOverride);
  // V0.18：OpenCode Go 等 OpenAI 兼容端点关闭 DeepSeek 专属参数（thinking/user_id/stream_options）
  const deepseekParams = g.deepseekParams !== false;
  // V0.100.2：阿里云百炼 MaaS 按 qwen 组合校验下发思考参数（enable_thinking/reasoning_effort）
  const qwenParams = providerInfo().qwenParams === true;
  // V0.98.5：免费档等预设声明 preferStream 时，无 onDelta 的任务也直接走流式——
  // 实测该类端点非流式长请求随机 500/503，流式通道独立且稳定。
  const preferStream = providerInfo().preferStream === true;
  const useStream = !!(streamCb?.onDelta) || preferStream;
  // V0.39：协议懒探测（auto 模式首次调用时探测 /responses、/messages 可用性，成功后缓存）
  if (!getProtocolProbe() && g.protocol !== 'chat' && !process.env.NOVEL_MOCK_LLM) {
    probeProtocols({ baseUrl: g.baseUrl, apiKey: g.apiKey }).then(probe => {
      setProtocolProbe(probe);
      logLlm({ task: 'protocol_probe', model: route.model, durationMs: 0, ok: true, detail: `responses=${probe.responses} messages=${probe.messages}` });
    }).catch(() => { /* 探测失败不阻塞 */ });
  }
  const protocol = resolveProtocol(route.model);
  // V0.73：锁定本次实际使用的协议（auto 模式下防止后续请求中途漂移导致缓存前缀重建）
  setUsedProtocol(protocol);

  const base = {
    task, messages, jsonMode, signal, onRetry, streamCb,
    baseUrl: g.baseUrl || 'https://api.deepseek.com',
    apiKey: g.apiKey,
    resilience: resilience || g.resilience, // V0.21 韧性参数（超时/重试/熔断；可覆盖）
  };
  const started = Date.now();
  // V0.109 双端点动态编排：粘性窗口内新请求直接走备用（主端点故障中），并节流发探针尝试回切。
  // 探针是 fire-and-forget；当前任务不等待探针结果（探针成功后下一个任务回主通道）。
  const stickyNow = isStickyBackup(g);
  if (stickyNow && !process.env.NOVEL_MOCK_LLM) probePrimaryForRecovery(g);
  try {
    if (stickyNow) {
      // 粘性窗口内直走备用；备用失败则退出粘性、走主通道正常路径兜底（主通道可能已恢复）
      const bk = await runOnBackup(task, base, route, g, bookSettings, bookId, useStream, capped);
      if (bk?.result) {
        const out = finalizeRun(bk.result, opts, { ...route, model: bk.backupModel, _fallback: true }, started);
        out.fallback = true;
        out.primaryModel = route.model; // 观察面：记录主通道模型名
        return out;
      }
      if (bk?.error) stickyBackupUntil = 0;
    }
    // V0.83 修复：jsonMode 规划型任务截断（finishReason='length'）自动重试 1 次（maxTokens 提高 30%）——
    // 此前 book_outline/book_settings/卷纲/细纲等 JSON 任务截断被 extractJSON 的补括号容错
    // "修成"残缺对象静默接受（书纲少卷/设定缺人物），零重试零告警。
    // 判定型任务（audit/settle/attraction 等已有各自 fail-closed）不在此列，由引擎层处理。
    // V0.94.2 补入 volume_review：卷审阅输出整卷结构化报告（promises/pacing/arc_movement/issues），
    // thinking+6000 maxTokens 下报告长时截断 → extractJSON 失败 → 兜底 grade C 落 status=failed
 // （本作卷3 实证：8/14 两连败零重试）。同为 jsonMode 结构化输出，截断重试与书纲同权。
    const PLANNING_TASKS = new Set(['book_outline', 'book_settings', 'volume_outline', 'chapter_outline',
      'pleasure_plan', 'story_promise', 'opening_blueprint', 'opening_diagnosis', 'opening_strategy', 'opening_candidate',
      'opening_candidate_audit', 'opening_candidate_compare', 'era_context', 'next_volume', 'volume_outline_rewrite', 'book_outline_rewrite',
      'narrative_plan_reconcile', 'volume_review', 'audit']); // V0.100：返工后规划对账同属结构化规划，截断必须重试
  // V0.98.5：按服务商封顶 reasoning_effort——OpenCode Go 免费档（ox-alpha-free）实证只接受 low：
  // medium 直接 400、不发该参数则模型把输出预算全烧成思考且正文为空；low 完整出稿。
  const capped = (effort) => capReasoningEffort(effort, g);
  const first = await chatCompletion({ ...base, model: route.model, temperature: route.temperature, maxTokens: route.maxTokens, stream: useStream, thinking: route.thinking ?? 'disabled', reasoningEffort: capped(route.reasoningEffort ?? 'high'), userId: bookId || undefined, deepseekParams, qwenParams, protocol });
  // V0.95.3 结构级根修：正文型任务「预算全耗推理」自愈——finishReason=length 且 content 为空。
  // OpenCode Go 端点实证（ch27 连环卡章）：reasoning_effort≥medium 时 flash 把全部 completion
  // 预算烧成推理、正文为零（4000/8000 两档打满全空）。参数已全线回退 low，此处兜底任何
  // 端点/模型未来的同款异常：非 jsonMode 且空正文截断 → 重试 1 次（effort 强制 low + 预算×1.5）。
  // V0.98.5 扩展：输出被思考吃空不再依赖 finishReason——免费档流式端点可能无 finish/[DONE]
  // 标记（实证：reasoning_content 拉满、content 为空、流无完成标记），「正文空+思考在场」即降档重试。
  // V0.98.8 扩展：空输出一律重试——免费档实证存在「finish=stop、正文空、无思考」的瞬时坏响应，
  // 任何任务拿到空正文都不应直接失败（重试 1 次仍空才交还调用方 fail-closed）。
  const jsonTruncated = jsonMode && PLANNING_TASKS.has(task) && first.finishReason === 'length';
  const proseStarved = !jsonMode && first.finishReason === 'length' && !(first.content || '').trim();
  const reasoningBurn = !(first.content || '').trim() && !!(first.reasoningContent || '').trim();
  const emptyOutput = !(first.content || '').trim();
  if (!jsonTruncated && !emptyOutput) {
    return finalizeRun(first, opts, route, started);
  }
  // 截断 → 提高 maxTokens 重试一次（防 reasoning tokens 挤占输出预算；正文空转档 ×1.5 上限 24000）
  const downgrade = emptyOutput;
  const boosted = Math.min(jsonTruncated ? 16000 : 24000, Math.round((route.maxTokens || 8000) * (jsonTruncated ? 1.3 : 1.5)));
  logLlm({ task, model: route.model, ok: true, detail: jsonTruncated
    ? `jsonMode 截断(finishReason=length)，maxTokens ${route.maxTokens}→${boosted} 重试 1 次`
    : `正文空转(finishReason=length 且 content 空${first.finishReason !== 'length' ? `；本次 finishReason=${first.finishReason || '无完成标记'}` : ''}${reasoningBurn ? '，预算被思考吃空' : ''}，预算全耗推理)，maxTokens ${route.maxTokens}→${boosted} + effort low 重试 1 次` });
  const second = await chatCompletion({ ...base, model: route.model, temperature: route.temperature, maxTokens: boosted, stream: useStream, thinking: route.thinking ?? 'disabled', reasoningEffort: downgrade ? 'low' : capped(route.reasoningEffort ?? 'high'), userId: bookId || undefined, deepseekParams, qwenParams, protocol });
    const out = finalizeRun(second, opts, route, started);
    // 重试后仍截断 → 标记 truncated 供引擎层二次尝试/抛错（不再静默接受残缺对象）
    if (out.finishReason === 'length') out.truncated = true;
    return out;
  } catch (e) {
    logLlm({
      task, model: route.model,
      durationMs: Date.now() - started,
      ok: false, retries: e.retries || 0, bookId,
      detail: e.code ? `${e.code}: ${e.message}` : e.message,
    });
    // V0.109 请求内快切：主端点终态失败（熔断/网络/限流/5xx/超时）→ 立即用备用端点重发本次请求，
    // 不打断写作流程。AUTH_ERROR/ABORTED 不切；备用也失败 → 抛主端点原错误（附备用失败详情）。
    if (e.code !== 'ABORTED' && e.name !== 'AbortError' && shouldFallbackToBackup(e, g)) {
      const bk = await runOnBackup(task, base, route, g, bookSettings, bookId, useStream, capped);
      if (bk?.result) {
        const out = finalizeRun(bk.result, opts, { ...route, model: bk.backupModel, _fallback: true }, started);
        out.fallback = true;
        out.primaryModel = route.model;
        return out;
      }
      if (bk?.error) e.backupError = { code: bk.error.code, message: bk.error.message };
    }
    throw e;
  }
}

/** 成本计算、落库、事件推送 */
function finalizeRun(result, opts, route, started) {
  const { task, bookId, chapterId, streamCb } = opts;
  // 成本计算与落库
  const u = result.usage || {};
  // V0.29：OpenCode Go 等端点流式响应不返回 usage 帧 → 用文本量估算（标注估算，避免费用全 0 误导）
  if (!u.promptTokens && !u.completionTokens && (result.content || result.reasoningContent)) {
    const est = Math.max(1, Math.ceil((result.content || '').length / 1.6) + Math.ceil((result.reasoningContent || '').length / 1.6));
    u.completionTokens = est;
    u.promptTokens = 0; // 无前缀数据，不计入成本估算
    u.promptCacheHitTokens = 0;
    u.promptCacheMissTokens = 0;
    u._estimated = true;
  }
  // V0.70 修复：计价用配置侧模型名（route.model）而非响应回显的 result.model——
  // 自定义/中转端点常改写模型名（如 deepseek-chat），回显名落到 UNKNOWN_PRICE 命中价虚高 50 倍
  const cost = computeCost(route.model, u.promptCacheHitTokens, u.promptCacheMissTokens, u.completionTokens);
  // V0.84：端点未上报缓存字段（_noCacheData）→ 记入 extra 供统计侧剔除，避免"命中率归零"假象
  const extra = {};
  if (u._noCacheData) extra.noCacheData = true;
  if (u._estimated) extra.estimated = true;
  // V0.109：备用通道请求标记（统计侧可区分主备流量）
  if (route._fallback) extra.fallback = true;
  store.usageLogs.add({
    bookId, chapterId, task,
    model: result.model || route.model,
    promptHit: u.promptCacheHitTokens || 0,
    promptMiss: u.promptCacheMissTokens || 0,
    completion: u.completionTokens || 0,
    cost: cost.cost,
    costIfMiss: cost.costIfMiss,
    durationMs: result.durationMs || (Date.now() - started),
    estimated: u._estimated ? 1 : 0,
    extra,
  });

  logLlm({
    task, model: result.model || route.model,
    durationMs: result.durationMs || (Date.now() - started),
    ok: true, retries: result.retries || 0, bookId,
    detail: `hit=${u.promptCacheHitTokens || 0} miss=${u.promptCacheMissTokens || 0} comp=${u.completionTokens || 0}`,
  });
  // V0.96：流中未推送过 usage（非流式请求 / OpenCode Go 等端点不回流式 usage 帧）→ 流结束补推一次终帧。
  // 此前 tokens/缓存命中只在流式帧到达时累加 → 这些端点下前端"本次运行 0 tokens · 缓存命中 —"恒零。
  // 防重：client 流式/mock 路径已推过的 usage 带 _streamed 标记（估算分支无流式帧也需补推）。
  try { if (!u._streamed && streamCb?.onUsage) streamCb.onUsage({ ...u }); } catch { /* ignore */ }
  // V0.72：流结束后推送实时费用事件（此前 usage 帧无 cost 字段 → 前端费用恒 ¥0.0000；
  // 单独走 onUsageCost 避免与 usage 帧 token 累加重复）
  try { streamCb?.onUsageCost?.({ cost: cost.cost, costIfMiss: cost.costIfMiss, model: route.model, task }); } catch { /* ignore */ }
  return { ...result, route, cost };
}

/** 调用级安全覆盖：保留任务/用户模型选择，只覆盖本次必须锁定的可靠性参数。 */
export function resolveTaskRoute(task, bookSettings = {}, routeOverride = {}) {
  return { ...resolveBase(task, bookSettings), ...(routeOverride || {}) };
}
