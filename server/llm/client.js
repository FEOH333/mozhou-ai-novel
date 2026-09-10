// server/llm/client.js —— DeepSeek/OpenAI 兼容 Chat Completions 客户端
// V0.21 韧性层：分层超时（连接/空闲/总量）+ 智能重试（分型退避+抖动）+ 熔断器 + 流式静默重试 + 健康度
'use strict';

import {
  circuitAllowed, circuitRemainingMs, reportSuccess, reportFailure, recordHealth,
} from './resilience.js';

/**
 * 发起一次 chat completion 调用。
 * @param {object} opts
 * @param {string} opts.model            模型名
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=4000]
 * @param {boolean} [opts.stream=false]   流式
 * @param {function(string):void} [opts.onDelta]   流式增量（content；重试轮次不回调，防重复拼接）
 * @param {function(object):void} [opts.onUsage]
 * @param {function(object):void} [opts.onRetry]   { attempt, reason } 重试通知（前端提示用）
 * @param {boolean} [opts.jsonMode=false]
 * @param {string} [opts.thinking='disabled']
 * @param {string} [opts.reasoningEffort='high']
 * @param {string} [opts.userId]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.protocol='chat']   请求协议：chat|responses|messages（V0.39 三协议）
 * @param {object} [opts.resilience]      覆盖默认韧性参数 { connectTimeoutMs, idleTimeoutMs, totalTimeoutMs, maxRetries, circuitBreaker }
 * @returns {Promise<{content:string, reasoningContent:string, usage:object, finishReason:string, model:string, retries:number}>}
 */
export async function chatCompletion(opts) {
  const isMock = process.env.NOVEL_MOCK_LLM === '1';
  const {
    model, messages, temperature = 0.7, maxTokens = 4000, stream = false,
    onDelta, onUsage, onRetry, jsonMode = false, thinking = 'disabled', reasoningEffort = 'high',
    userId, signal, baseUrl, apiKey, deepseekParams = true, qwenParams = false, resilience,
    protocol = 'chat', // V0.39：chat|responses|messages
  } = opts;

  if (!isMock && !apiKey) {
    const err = new Error('未配置 DeepSeek API Key，请在「设置」中填写。');
    err.code = 'AUTH_ERROR';
    throw err;
  }
  if (!messages?.length) throw new Error('messages 不能为空');

  // V0.98.5：请求参数快照——重试轮可能翻流转流式（免费档网关非流式长请求队列拥堵，
  // 实测同请求随机 500/503，流式通道独立且稳定），翻转时按新 stream 标志重建请求体。
  const bodyParams = { model, messages, temperature, maxTokens, stream, jsonMode, thinking, reasoningEffort, userId, deepseekParams, qwenParams, protocol };
  let body = buildRequestBody(bodyParams);
  let useStream = !!stream;
  const res = resilience || {};
  const connectTimeoutMs = res.connectTimeoutMs ?? 20000;
  const idleTimeoutMs = res.idleTimeoutMs ?? 45000;
  const totalTimeoutMs = res.totalTimeoutMs ?? 180000;
  const maxRetries = res.maxRetries ?? 3;
  const cbCfg = res.circuitBreaker || {};
  // 退避可参数化（测试用；生产保持默认）
  const rateLimitBackoffMs = res.rateLimitBackoffMs ?? 30000;
  const baseBackoffMs = res.retryBackoffMs ?? 2000;
  // V0.100.1：429 走独立耐心预算。上游共享池限流（OpenRouter limit_source=upstream_provider_shared_pool）
  // 窗口常达数分钟甚至一小时以上，与普通故障共用 maxRetries 会在窗口内耗尽（实证：返工 19 章
  // 跑到一半被限流混合故障打断）。普通故障预算不变；总尝试有界 = 1 + maxRetries +
  // rateLimitMaxRetries（429 无 completion 费用，退避 30s→60s→90s→120s 递增封顶，尊重 Retry-After ≤120s）。
  // V0.100.2：熔断开窗也并入本耐心预算——睡到窗口结束让 HALF_OPEN 探针接管，不再即死。
  const maxRateLimitRetries = res.rateLimitMaxRetries ?? 5;
  // V0.100.2：网络中断（DNS 解析失败/断网/代理抖动）走独立耐心预算——家用网络故障常以
  // 分钟计，2s/6s/18s 快速退避在窗口内毫无意义（用户实证：DNS ENOTFOUND 4 次整批返工中止）。
  // 退避 20s→40s→…→120s 封顶；网络重试零 completion 费用，全域任务（写作/审校/返工）同享。
  const maxNetworkRetries = res.networkMaxRetries ?? 10;
  const networkBackoffMs = res.networkBackoffMs ?? 20000;

  let retries = 0;
  let normalRetriesUsed = 0;
  let rateLimitRetriesUsed = 0;
  let networkRetriesUsed = 0;
  let effectiveConnectTimeoutMs = connectTimeoutMs;
  const failureHistory = [];
  for (;;) {
    // 熔断检查：OPEN 期不发起网络请求，但也不再即死——睡到开窗让探针接管；
    // 只有耐心预算耗尽才抛出（进度已由断点续跑兜底）。
    if (!circuitAllowed(baseUrl, apiKey, cbCfg)) {
      if (rateLimitRetriesUsed >= maxRateLimitRetries) {
        const err = new Error('服务商连续失败，熔断保护中且等待预算已耗尽');
        err.code = 'CIRCUIT_OPEN';
        throw attachRetryHistory(err, failureHistory, retries);
      }
      rateLimitRetriesUsed++;
      retries++;
      const circuitWaitMs = circuitRemainingMs(baseUrl, apiKey) + 1000;
      failureHistory.push({
        attempt: failureHistory.length + 1,
        code: 'CIRCUIT_OPEN',
        phase: 'circuit',
        message: '服务商熔断保护中，等待自动恢复',
        durationMs: 0,
      });
      onRetry?.({
        attempt: retries,
        reason: 'CIRCUIT_OPEN',
        message: `服务商熔断保护中，约 ${Math.ceil(circuitWaitMs / 1000)} 秒后自动探针恢复`,
      });
      await sleep(circuitWaitMs + Math.random() * (res.jitterMs ?? 1000), signal);
      continue;
    }
    try {
      const r = isMock
        ? await mockCompletion({ ...opts, stream: useStream })
        : await doRequest(baseUrl, apiKey, body, {
            stream: useStream, onDelta, onUsage, signal, protocol,
            connectTimeoutMs: effectiveConnectTimeoutMs, idleTimeoutMs, totalTimeoutMs,
            circuitCfg: cbCfg,
          });
      recordHealth({ ok: true, durationMs: r.durationMs || 0, provider: baseUrl, model: r.model || model, retries });
      // V0.70 修复：成功路径必须复位熔断器（此前 reportSuccess 无调用点 → 一旦熔断永不复位，
      // 且 HALF_OPEN 下任何单次失败都会退避翻倍 → 服务商被永久熔断，请求大面积失败）
      reportSuccess(baseUrl, apiKey, cbCfg);
      return { ...r, retries };
    } catch (e) {
      // 用户主动取消不重试（V0.29：DOMException AbortError 的 code 是只读数字，需按 name 判定；不得计入熔断失败）
      if (e.code === 'ABORTED' || e.name === 'AbortError' || (typeof e.code === 'number' && e.code === 20)) throw e;
      failureHistory.push({
        attempt: failureHistory.length + 1,
        code: String(e.code || 'ERROR'),
        phase: e.phase || '',
        message: String(e.message || '未知错误'),
        durationMs: Number(e.durationMs) || 0,
      });
      // V0.98.5：STREAM_INCOMPLETE（流被中途掐断、无完成标记）加入可重试——免费档拥堵的另一种
      // 表现形态；重试耗尽后错误仍带 partialContent，write.js 的草稿抢救路径不受影响。
      const retriable = ['NETWORK_ERROR', 'RATE_LIMIT', 'API_ERROR', 'STREAM_STALL', 'STREAM_INCOMPLETE', 'HTTP_TIMEOUT'].includes(e.code);
      const isRateLimit = e.code === 'RATE_LIMIT';
      const isNetwork = e.code === 'NETWORK_ERROR';
      const exhausted = isRateLimit ? rateLimitRetriesUsed >= maxRateLimitRetries
        : isNetwork ? networkRetriesUsed >= maxNetworkRetries
          : normalRetriesUsed >= maxRetries;
      if (!retriable || exhausted) {
        // 不重试（或重试耗尽）→ 上报健康度 + 失败计数
        recordHealth({ ok: false, durationMs: e.durationMs || 0, provider: baseUrl, model, retries, code: e.code });
        reportFailure(baseUrl, apiKey, cbCfg);
        throw attachRetryHistory(e, failureHistory, retries);
      }
      if (isRateLimit) rateLimitRetriesUsed++; else if (isNetwork) networkRetriesUsed++; else normalRetriesUsed++;
      retries++;
      // V0.98.5 流式回退：非流式请求撞上可重试错误（5xx 拥堵/网络）时下一轮翻流式——
      // OpenCode Go 免费档实证：同请求非流式随机 500/503，流式通道稳定通过；流式请求失败不重复翻转。
      let streamFallback = false;
      if (!useStream) {
        useStream = true;
        streamFallback = true;
        body = buildRequestBody({ ...bodyParams, stream: true });
      }
      // V0.99.1：流式“连接超时”实际覆盖服务商排队至首字节的时间。连续重试若仍沿用
      // 同一个上限，会把 90 秒工作机械重复四遍；每一轮按当前窗口翻倍，
      // 但绝不越过总时长上限。只扩首字节超时，不掩盖解析/总时长/用户取消。
      let timeoutExtended = false;
      if (useStream && e.code === 'HTTP_TIMEOUT' && e.phase === 'connect') {
        const nextLimit = Math.min(totalTimeoutMs, Math.max(connectTimeoutMs * 2, effectiveConnectTimeoutMs * 2));
        if (nextLimit > effectiveConnectTimeoutMs) {
          effectiveConnectTimeoutMs = nextLimit;
          timeoutExtended = true;
        }
      }
      // 分型退避：429 尊重 Retry-After（≤120s），否则按已等次数递增（rateLimitBackoffMs ×N，封顶 120s）；
      // 网络中断走独立耐心退避（networkBackoffMs ×N，封顶 120s——家用断网窗口以分钟计）；
      // 5xx/卡死 → 指数退避+抖动（保持原 1×/3×/9× 序列）
      let waitMs;
      if (isRateLimit) {
        const scaled = Math.min(rateLimitBackoffMs * rateLimitRetriesUsed, 120000);
        waitMs = (e.retryAfterMs && e.retryAfterMs <= 120000) ? e.retryAfterMs : scaled;
      } else if (isNetwork) {
        waitMs = Math.min(networkBackoffMs * networkRetriesUsed, 120000);
      } else {
        waitMs = baseBackoffMs * Math.pow(3, normalRetriesUsed - 1);
      }
      onRetry?.({
        attempt: retries,
        reason: e.code,
        message: e.message,
        waitMs: Math.round(waitMs),
        ...(streamFallback ? { streamFallback: true } : {}),
        ...(timeoutExtended ? { timeoutExtended: true, nextConnectTimeoutMs: effectiveConnectTimeoutMs } : {}),
      });
      await sleep(waitMs + Math.random() * (res.jitterMs ?? 1000), signal);
    }
  }
}

/**
 * 组装请求体（导出以便测试）。支持三种协议（V0.39）：
 *   chat      —— OpenAI Chat Completions（/chat/completions，默认，全模型）
 *   responses —— OpenAI Responses API（/responses；DS-Flash 官方主推，语义化流式事件）
 *   messages  —— Anthropic Messages（/messages；x-api-key 认证，自带 thinking 块）
 * deepseekParams=false 时（OpenCode Go 等兼容端点）不发送 DeepSeek 专属参数。
 * qwenParams=true 时（阿里云百炼 MaaS）按 qwen 组合校验下发 enable_thinking/reasoning_effort。
 */
export function buildRequestBody({ model, messages, temperature, maxTokens, stream, jsonMode, thinking = 'disabled', reasoningEffort = 'high', userId, deepseekParams = true, qwenParams = false, protocol = 'chat' }) {
  // ---- Responses API（OpenAI 新格式）：instructions + input items ----
  if (protocol === 'responses') {
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const input = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const body = { model, instructions: sys || undefined, input, stream, temperature, max_output_tokens: maxTokens };
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort }; // 实测 OpenCode Go 支持
    if (jsonMode) body.text = { format: { type: 'json_object' } };
    if (userId) body.user = userId;
    return body;
  }
  // ---- Anthropic Messages：system + messages，x-api-key 认证 ----
  if (protocol === 'messages') {
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const body = { model, max_tokens: maxTokens, temperature, stream };
    if (sys) body.system = sys;
    if (msgs.length) body.messages = msgs;
    // Anthropic 风格思考控制（OpenCode Go 实测接受；disabled 抑制深度推理防输出截断）
    if (thinking === 'disabled') body.thinking = { type: 'disabled' };
    // V0.58：推理预算恢复 4096（V0.56 曾降为 2048 提速——用户明确'时间换质量'，质量优先，不牺牲推理深度）
    else body.thinking = { type: 'enabled', budget_tokens: Math.min(4096, Math.round(maxTokens * 0.5)) };
    return body;
  }
  // ---- Chat Completions（现状） ----
  const body = { model, messages, temperature, max_tokens: maxTokens, stream };
  if (deepseekParams) {
    body.thinking = { type: thinking };
    if (stream) body.stream_options = { include_usage: true };
    if (userId) body.user_id = userId;
  }
  // V0.100.2：阿里云百炼 MaaS（qwenParams）——端点对思考参数组合强校验：
  // enable_thinking:false 时 reasoning_effort 必须为 'none'（否则 400），启用时 low/medium/high
  // 均可；usage 需 stream_options.include_usage 才在流式末帧回报（含缓存命中 cached_tokens）。
  if (qwenParams) {
    body.enable_thinking = thinking === 'enabled';
    body.reasoning_effort = thinking === 'enabled' ? (reasoningEffort || 'low') : 'none';
    if (stream) body.stream_options = { include_usage: true };
  } else if (reasoningEffort) {
    // V0.32：reasoning_effort 无条件发送——OpenCode Go 等兼容端点实测支持（V0.30），
    // 且 deepseek-v4-flash 默认 high 推理会吃掉输出预算（实测 2895/3000 tokens 全被推理消耗、
    // 正文被截断），必须能下发 low 抑制；未知端点忽略该字段不报错。
    body.reasoning_effort = reasoningEffort;
  }
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/** 协议 → 端点路径 */
export function protocolPath(protocol) {
  if (protocol === 'responses') return '/responses';
  if (protocol === 'messages') return '/messages';
  return '/chat/completions';
}

/**
 * 探测端点协议可用性（V0.39 自动选择用）：
 * 对 /responses 与 /messages 各发一个最小请求，返回 {responses, messages} 布尔。
 * 失败不抛出（返回 false），绝不因探测中断主流程。
 */
export async function probeProtocols({ baseUrl, apiKey, model = 'deepseek-v4-flash', timeoutMs = 20000 } = {}) {
  const result = { responses: false, messages: false };
  const probe = async (path, body, headers) => {
    try {
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return r.ok;
    } catch { return false; }
  };
  const [r1, r2] = await Promise.all([
    probe('/responses', { model, instructions: 'ping', input: 'ok', max_output_tokens: 8 }, { Authorization: `Bearer ${apiKey}` }),
    probe('/messages', { model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 8 }, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
  ]);
  result.responses = r1;
  result.messages = r2;
  return result;
}

/** 归一化 usage（三协议 → 统一字段）
 *  V0.73：统一用"miss = prompt - hit"兜底——chat 协议兼容端点常只返回 hit 不返回 miss
 *  （此前 miss 记 0 → 命中率虚高、输入成本按全命中价低估 50 倍）；responses 协议补 Math.max 下限。
 *  V0.84：端点**完全未上报任何缓存字段**（hit/miss 均缺失）时打 `_noCacheData` 标记——
 *  此类调用不是"100% miss"，而是"端点无前缀缓存能力/未上报"，统计侧应剔除避免"命中率归零"假象。 */
function normalizeUsage(u = {}, protocol) {
  if (protocol === 'responses') {
    const hit = u.input_tokens_details?.cached_tokens || 0;
    return {
      promptTokens: u.input_tokens || 0,
      completionTokens: u.output_tokens || 0,
      promptCacheHitTokens: hit,
      promptCacheMissTokens: Math.max(0, (u.input_tokens || 0) - hit),
      reasoningTokens: u.output_tokens_details?.reasoning_tokens || 0,
      _noCacheData: u.input_tokens_details?.cached_tokens == null,
    };
  }
  if (protocol === 'messages') {
    return {
      promptTokens: u.input_tokens || 0,
      completionTokens: u.output_tokens || 0,
      promptCacheHitTokens: u.cache_read_input_tokens || 0,
      // V0.63 修复：miss = input - cache_read（此前恒等于全部 input_tokens → 命中率被系统性砍半）
      promptCacheMissTokens: Math.max(0, (u.input_tokens || 0) - (u.cache_read_input_tokens || 0)),
      reasoningTokens: 0,
      _noCacheData: u.cache_read_input_tokens == null && u.input_tokens != null,
    };
  }
  const hit = u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0;
  const total = u.prompt_tokens || 0;
  return {
    promptTokens: total,
    completionTokens: u.completion_tokens || 0,
    promptCacheHitTokens: hit,
    // V0.73 兜底：miss = total - hit（兼容端点只报 hit 时不再虚高命中率）
    promptCacheMissTokens: u.prompt_cache_miss_tokens != null ? u.prompt_cache_miss_tokens : Math.max(0, total - hit),
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens || 0,
    // V0.84：hit/miss 字段均缺失 → 端点无缓存数据（如纯中转无前缀缓存），不算 100% miss
    _noCacheData: u.prompt_cache_hit_tokens == null && u.prompt_tokens_details?.cached_tokens == null && u.prompt_cache_miss_tokens == null && total != null,
  };
}

/** 非流式响应解析（三协议 → 统一结构） */
export function parseChatResponse(data, body = {}, protocol = 'chat') {
  if (protocol === 'responses') {
    const output = data.output || [];
    let content = '';
    let reasoningContent = '';
    for (const item of output) {
      if (item.type === 'reasoning') reasoningContent += item.summary?.[0]?.text || '';
      else if (item.type === 'message') {
        for (const c of item.content || []) {
          if (c.type === 'output_text') content += c.text;
          else if (c.type === 'text') content += c.text;
        }
      }
    }
    return {
      content, reasoningContent,
      finishReason: data.status === 'completed' ? 'stop' : (data.status === 'incomplete' ? 'length' : (data.status || '')),
      model: data.model || body.model,
      usage: normalizeUsage(data.usage, protocol),
    };
  }
  if (protocol === 'messages') {
    const content = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const reasoningContent = (data.content || []).filter(c => c.type === 'thinking').map(c => c.thinking).join('');
    return {
      content, reasoningContent,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : (data.stop_reason || ''),
      model: data.model || body.model,
      usage: normalizeUsage(data.usage, protocol),
    };
  }
  const choice = data.choices?.[0] || {};
  return {
    content: choice.message?.content || '',
    reasoningContent: choice.message?.reasoning_content || '',
    finishReason: choice.finish_reason || '',
    model: data.model || body.model,
    usage: normalizeUsage(data.usage, protocol),
  };
}

/**
 * 单次请求（含分层超时）。失败抛出带 code 的 Error：
 *   NETWORK_ERROR / HTTP_TIMEOUT（连接或总体超时）/ STREAM_STALL（流空闲超时，附 partialContent）/
 *   STREAM_INCOMPLETE（流 EOF 前未收到协议完成标记，附 partialContent）/
 *   RATE_LIMIT / API_ERROR / AUTH_ERROR / HTTP_ERROR / ABORTED
 */
async function doRequest(baseUrl, apiKey, body, opts) {
  const {
    stream, onDelta, onUsage, signal, protocol = 'chat',
    connectTimeoutMs, idleTimeoutMs, totalTimeoutMs, circuitCfg,
  } = opts;
  const started = Date.now();

  // 分层超时：连接阶段 20s（响应头）；总时长 180s
  const totalSignal = AbortSignal.timeout(totalTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, totalSignal]) : totalSignal;

  let res;
  let connectSignal = null;
  let connectController = null;
  let connectTimer = null;
  let connectExpired = false;
  try {
    // 连接超时单独控制：用竞速实现（AbortSignal.timeout 是整体超时）。
    // V0.32：仅流式请求启用 connectTimeout 守"首字节"——OpenAI 兼容端点（OpenCode Go 等）的
    // 非流式响应头 = 完整生成完成（无 chunked 预响应），20s 竞速会误杀 idea_amplify 等长生成任务；
    // 非流式请求只受 totalTimeout 保护。
    // V0.99.1 根修：AbortSignal.timeout 传给 fetch 后会继续绑定 response.body；即使响应头已经
    // 到达，它仍会在 connectTimeout 到点时掐断正在正常输出的长 SSE。改用可撤销的专用
    // AbortController：只在等待 fetch 返回响应头期间计时，拿到响应头立即 clearTimeout。
    if (stream) {
      connectController = new AbortController();
      connectSignal = connectController.signal;
      connectTimer = setTimeout(() => {
        connectExpired = true;
        connectController.abort(new DOMException('首字节等待超时', 'TimeoutError'));
      }, connectTimeoutMs);
    }
    // V0.39：三协议端点与认证头（Anthropic 用 x-api-key）
    const headers = protocol === 'messages'
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    res = await fetch(`${baseUrl}${protocolPath(protocol)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: connectSignal ? AbortSignal.any([combined, connectSignal]) : combined,
    });
    // fetch 已返回 = 响应头/首字节阶段完成。连接计时器至此必须解除；正文流继续由
    // idleTimeoutMs（无数据卡死）与 totalTimeoutMs（整次调用）两道独立护栏管理。
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  } catch (e) {
    const err = toCodeError(e, 'NETWORK_ERROR', '连接失败', started);
    // V0.70 修复：用户主动 abort 必须保留 ABORTED 语义（此前被包装成 NETWORK_ERROR →
    // write.js/pipeline.js 误判为普通失败：白重试一次 + 写草稿/标 failed/记债）
    if (e.name === 'AbortError' || e.code === 'ABORTED' || (typeof e.code === 'number' && e.code === 20)) {
      err.code = 'ABORTED';
      err.name = 'AbortError';
      throw err;
    }
    if (e.name === 'TimeoutError') {
      err.code = 'HTTP_TIMEOUT';
      const expiredDuringConnect = !!(stream && connectExpired && !totalSignal.aborted);
      err.phase = expiredDuringConnect ? 'connect' : 'total';
      // V0.32：非流式超时是生成超时（totalTimeout），流式超时才是连接/首字节超时
      err.message = expiredDuringConnect
        ? `连接超时（${Math.round(connectTimeoutMs / 1000)} 秒）——服务商无响应`
        : `生成超时（${Math.round(totalTimeoutMs / 1000)} 秒）——生成内容较多或服务商繁忙，请重试或调大总时长`;
    }
    throw err;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`API 错误 ${res.status}: ${text.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) err.code = 'AUTH_ERROR';
    else if (res.status === 429) {
      err.code = 'RATE_LIMIT';
      const ra = res.headers.get('retry-after');
      err.retryAfterMs = ra ? parseInt(ra, 10) * 1000 : undefined;
    } else if (res.status >= 500) err.code = 'API_ERROR';
    else err.code = 'HTTP_ERROR';
    err.status = res.status;
    err.durationMs = Date.now() - started;
    throw err;
  }

  try {
    if (stream) return await parseSSE(res, { onDelta, onUsage, idleTimeoutMs, totalTimeoutMs, started, protocol });
    const data = await readJsonWithIdle(res, idleTimeoutMs, totalTimeoutMs, started);
    const r = parseChatResponse(data, body, protocol);
    return { ...r, durationMs: Date.now() - started };
  } catch (e) {
    // V0.25 修复：只有我们自建的字符串 code 错误才能原地补 durationMs；
    // DOMException（TimeoutError 等）的 code 是只读数字 getter，原地赋值会抛 TypeError 掩盖真错误
    if (typeof e.code === 'string') { e.durationMs = Date.now() - started; throw e; }
    throw toCodeError(e, 'NETWORK_ERROR', '响应解析失败', started);
  }
}

/** 非流式：读取 body 全文（带空闲超时检测：读流卡住视为卡死） */
async function readJsonWithIdle(res, idleTimeoutMs, totalTimeoutMs, started) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const r = await readWithIdle(reader, idleTimeoutMs, totalTimeoutMs - (Date.now() - started), started);
    if (r.done) break;
    buffer += decoder.decode(r.value, { stream: true });
  }
  try {
    return JSON.parse(buffer);
  } catch (e) {
    const err = new Error('响应内容不是有效 JSON');
    err.code = 'NETWORK_ERROR';
    throw err;
  }
}

/** 单次 read 带空闲超时：超过 idleTimeoutMs 无数据 → 判定卡死 */
async function readWithIdle(reader, idleTimeoutMs, remainingMs, started) {
  let timer = null;
  let idleExpired = false;
  try {
    const idleLimit = Math.min(idleTimeoutMs, remainingMs || idleTimeoutMs);
    const p = reader.read();
    timer = setTimeout(() => {
      idleExpired = true;
      try {
        const cancellation = reader.cancel();
        cancellation?.catch?.(() => { /* ignore */ });
      } catch { /* ignore */ }
    }, idleLimit);
    const r = await p;
    // ReadableStream.cancel() 通常让挂起的 read() 以 { done: true } 正常完成，
    // 不能依赖 cancel 抛异常来识别空闲超时。
    if (idleExpired) {
      const err = new Error('API 响应卡死（超过空闲时限无数据），已自动中断');
      err.code = 'STREAM_STALL';
      throw err;
    }
    if (timer) clearTimeout(timer);
    return r;
  } catch (e) {
    if (e.code === 'STREAM_STALL') throw e;
    if (e.name === 'AbortError' || e.message?.includes('cancel')) {
      const err = new Error('API 响应卡死（超过空闲时限无数据），已自动中断');
      err.code = 'STREAM_STALL';
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 解析 SSE 流。空闲超时（无数据块）→ STREAM_STALL；无协议完成标记即 EOF → STREAM_INCOMPLETE；
 * 两者均附已收到的 partialContent。
 * 重试由 chatCompletion 外层控制：重试轮 onDelta 不回调（防前端重复拼接），
 * 调用方以最终 content 为准（写场景时全量落库）。
 */
async function parseSSE(res, { onDelta, onUsage, idleTimeoutMs, totalTimeoutMs, started, protocol = 'chat' }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let finishReason = '';
  let usage = null;
  let model = '';
  let protocolCompleted = false;

  // V0.39：三协议流式事件归一化——返回 {contentDelta?, reasoningDelta?, finish?, usage?}
  const handleEvent = (eventName, data) => {
    if (protocol === 'responses') {
      const type = data?.type || eventName;
      if (type === 'response.output_text.delta') { content += data.delta || ''; onDelta?.(data.delta || ''); }
      else if (type === 'response.reasoning_text.delta') reasoningContent += data.delta || '';
      else if (type === 'response.completed' || type === 'response.incomplete') {
        if (data?.response?.usage) usage = data.response.usage;
        if (data?.response?.model) model = data.response.model;
        finishReason = type === 'response.completed' ? 'stop' : 'length';
        protocolCompleted = true;
      }
      return;
    }
    if (protocol === 'messages') {
      const type = data?.type || eventName;
      if (type === 'content_block_delta') {
        const d = data?.delta || {};
        if (d.type === 'text' || d.type === 'text_delta') { content += d.text || ''; onDelta?.(d.text || ''); }
        else if (d.type === 'thinking' || d.type === 'thinking_delta') reasoningContent += d.thinking || '';
      } else if (type === 'message_delta') {
        if (data?.usage) usage = data.usage;
        if (data?.delta?.stop_reason) {
          finishReason = data.delta.stop_reason === 'end_turn' ? 'stop' : data.delta.stop_reason;
          protocolCompleted = true;
        }
      } else if (type === 'message_start') {
        if (data?.message?.model) model = data.message.model;
      } else if (type === 'message_stop') {
        protocolCompleted = true;
      }
      return;
    }
    // chat：OpenAI 标准 chunk
    if (data?.model) model = data.model;
    const delta = data?.choices?.[0]?.delta || {};
    if (delta.content) { content += delta.content; onDelta?.(delta.content); }
    if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
    if (data?.choices?.[0]?.finish_reason) {
      finishReason = data.choices[0].finish_reason;
      protocolCompleted = true;
    }
    if (data?.usage) usage = data.usage;
  };

  try {
    while (true) {
      const remaining = totalTimeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        const err = new Error('请求总时长超限，已中断');
        err.code = 'HTTP_TIMEOUT';
        throw err;
      }
      const r = await readWithIdle(reader, idleTimeoutMs, remaining, started);
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      let nl;
      let currentEvent = '';
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.trim() === '') { currentEvent = ''; continue; }
        // 支持 event: 行（responses/messages 语义化事件）与 data: 行（chat）
        if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { protocolCompleted = true; continue; }
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        handleEvent(currentEvent, chunk);
      }
    }
  } catch (e) {
    if (e.code === 'STREAM_STALL' || e.code === 'HTTP_TIMEOUT') {
      e.partialContent = content; // 已收到的部分正文（供草稿保护）
      throw e;
    }
    throw e;
  }

  if (!protocolCompleted) {
    const err = new Error('API 流提前结束（未收到协议完成标记）');
    err.code = 'STREAM_INCOMPLETE';
    err.partialContent = content;
    throw err;
  }

  // V0.96：终帧 usage 复用同一对象并打 _streamed 标记——router 据此判断"流中已推送"，
  // 防止 finalizeRun 补推终帧时重复累加（两次 normalizeUsage 是两个对象，标记会丢）
  const finalUsage = usage ? normalizeUsage(usage, protocol) : null;
  if (finalUsage) { finalUsage._streamed = true; onUsage?.(finalUsage); }

  return {
    content,
    reasoningContent,
    finishReason,
    model,
    usage: finalUsage,
    durationMs: Date.now() - started,
  };
}

function deepestTransportCause(error) {
  let current = error;
  const seen = new Set();
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth++) {
    seen.add(current);
    if (Array.isArray(current.errors) && current.errors.length) {
      current = current.errors.find(item => item?.code || item?.message) || current.errors[0];
      continue;
    }
    if (!current.cause) break;
    current = current.cause;
  }
  return current || error;
}

/**
 * 把 Node/Undici 只在 `cause` 中给出的真实网络原因变成可操作的中文提示。
 * 不包含请求头、API Key 或请求正文，可安全写入操作日志与 SSE 错误事件。
 */
export function formatTransportFailure(error, fallbackMsg = '连接失败') {
  const source = error instanceof Error ? error : null;
  const cause = deepestTransportCause(source);
  const code = String(cause?.code || source?.code || '').trim();
  const rawMessage = String(cause?.message || source?.message || '').trim();
  const address = String(cause?.address || '').trim();
  const port = cause?.port == null ? '' : String(cause.port).trim();
  const endpoint = address ? `${address}${port ? `:${port}` : ''}` : '';
  let summary = '';
  if (code === 'ECONNREFUSED') summary = '连接被拒绝（本地代理未启动、端口已变化，或目标服务拒绝连接）';
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') summary = '域名解析失败（DNS 或代理网络暂不可用）';
  else if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') summary = '连接被远端服务或代理中途断开';
  else if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') summary = '网络连接或响应头等待超时';
  else if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(code) || /certificate|tls|ssl/i.test(rawMessage)) summary = 'TLS 证书握手失败';
  else if (source?.message === 'fetch failed') summary = '底层网络请求失败，运行时未返回更具体的错误码';
  else summary = rawMessage || '底层网络请求失败';

  const details = [];
  if (code) details.push(code);
  if (endpoint) details.push(endpoint);
  if (rawMessage && rawMessage !== 'fetch failed' && rawMessage !== summary) details.push(rawMessage);
  return `${fallbackMsg}：${summary}${details.length ? `（${details.join('；')}）` : ''}`;
}

function failureKindLabel(item) {
  if (item.code === 'HTTP_TIMEOUT' && item.phase === 'connect') return '首字节超时';
  if (item.code === 'HTTP_TIMEOUT') return '生成总时长超限';
  if (item.code === 'NETWORK_ERROR') return '网络连接中断';
  if (item.code === 'STREAM_STALL') return '流式响应卡死';
  if (item.code === 'STREAM_INCOMPLETE') return '流式响应提前结束';
  if (item.code === 'RATE_LIMIT') return '服务限流';
  if (item.code === 'CIRCUIT_OPEN') return '熔断保护等待';
  if (item.code === 'API_ERROR') return '服务端错误';
  return item.code || '未知错误';
}

function attachRetryHistory(error, history, retries) {
  const err = error instanceof Error ? error : new Error(String(error || '未知错误'));
  err.retries = retries;
  err.attempts = history.map(item => ({ ...item }));
  if (history.length <= 1) return err;
  const counts = new Map();
  for (const item of history) {
    const label = failureKindLabel(item);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const summary = [...counts].map(([label, count]) => `${count} 次${label}`).join('、');
  err.message = `模型服务连续 ${history.length} 次请求失败（${summary}）。最后一次：${err.message}`;
  // V0.100.1：限流主导的失败必须告诉用户"进度已保存、稍后从断点继续"——上游共享池窗口
  // 实测可持续一小时以上（OpenRouter limit_source=upstream_provider_shared_pool），
  // 重试预算耗尽不等于前功尽弃，断点续跑让重新发起不再重复消耗已完成章节。
  // V0.100.2：网络中断主导同权（断网/熔断等待同样是"等一等再续"的可恢复故障）。
  const resumableLed = history.filter(item => ['RATE_LIMIT', 'CIRCUIT_OPEN', 'NETWORK_ERROR'].includes(item.code)).length;
  if (resumableLed >= 2) {
    err.message += '。服务限流窗口可能持续较久，建议稍后再试：已完成的进度已保存，重新发起会从断点继续，不重复消耗';
  }
  return err;
}

function toCodeError(e, code, fallbackMsg, started) {
  // V0.25 修复：AbortSignal.timeout 产生的 DOMException('TimeoutError') 虽然 instanceof Error，
  // 但其 code/message 是只读 getter——原样返回后调用方赋值 err.code 会在严格模式抛
  // "Cannot set property code of which has only a getter"，把真实的超时错误完全掩盖。
  // 统一包装为新 Error（拷贝 message/name/cause），绝不在原对象上赋值。
  const src = e instanceof Error ? e : null;
  const err = new Error(formatTransportFailure(src, fallbackMsg));
  if (src?.name && src.name !== 'Error') err.name = src.name; // 保留 TimeoutError 等名字供调用方判断
  err.code = code;
  if (src?.cause) err.cause = src.cause;
  err.durationMs = Date.now() - (started || Date.now());
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      err.code = 'ABORTED';
      reject(err);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('已取消');
      err.name = 'AbortError';
      err.code = 'ABORTED';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// V0.94.0b 正文 mock：按章号生成句级唯一文本。旧 mock 每章返回同一段固定 prose，
// V0.94 跨章复读/比喻复读防线在多章流程（pilot 续卷）中逐章命中 → 记债累积 →
// 恢复诊断 3 轮 → need_human 提前暂停（v044b 实证）。真实模型每章写不同内容，
// mock 也应如此：每个长句内嵌章号，保证句级跨章唯一；保留 玉佩/他站在巷口 测试锚点。
// 篇幅对齐旧 mock（~90 字 + 续写 ~65 字）——v016 归档预算断言对章历史 tokens 敏感。
function mockSceneProse(key, { prefix = '' } = {}) {
  const k = Math.abs(parseInt(key, 10) || 0);
  return `${prefix}雨下到第${k}遍更鼓还没停。\n\n她推开门，看见他站在巷口，手里的玉佩映着第${k}盏灯。\n\n"来了。"她说。\n\n他没有回答，把玉佩递过去，指腹在佩缘第${k}道旧痕上停了停。`;
}
// 续写 mock：与 mockSceneProse 句式结构完全不同（共享 4-gram 极少）——若沿用同一模板
// 仅换数字，safelyMergeContinuation 会把续写判成"复述型响应"走 replace，吃掉（修订版）
// 前缀（pipeline.test 实证）；结构差异大才走 append 路径。同样按 key 内嵌数字保跨章唯一。
function mockContinuationProse(key) {
  const k = Math.abs(parseInt(key, 10) || 0);
  return `灯笼晃出第${k}圈影，他把伞收在门槛边。\n\n"灶上温着。"她先进了屋。\n\n他跟进去，把玉佩揣回怀里，摸得到旧痕上第${k}层的温度。汤气糊出第${k}层窗白。`;
}
function mockHashOf(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h % 9973;
}
function mockChapterKeyOf(lastUser) {
  // 不用"第N章"正则——指令里会引用前情章（如 ch1 标题就叫"第1章"），会把后续章的 key
  // 错配到同一数字 → 跨章 prose 撞车 → 跨章复读防线误报。改用整条指令哈希：
  // 不同章（不同前情/章名/场景节拍）→ 不同 key；同章多场景也各异（顺带消除"两场景
  // 逐字相同"的 mock 假重复）。
  return mockHashOf(lastUser);
}
// 修订指令按"书名+章名+场景节拍"取稳定 key：同一场景多轮修订返回同一文本（unchanged 跳过语义）；
// V0.97：并入【场景要求】节拍——同章不同场景的修订/压缩不再共用标题哈希（章内复读假阳性根因）；
// 无《》标题也无场景节拍的指令（如压缩重写，内嵌原文）退化为整条指令哈希（原文唯一即 key 唯一）。
function mockRewriteKeyOf(lastUser) {
  const s = String(lastUser || '');
  const titles = [...s.matchAll(/《([^》]{1,40})》/g)].map(m => m[1]);
  const beat = s.match(/【场景要求】([^\n]{0,60})/)?.[1] || '';
  if (titles.length || beat) return mockHashOf(titles.join('|') + '#' + beat);
  return mockHashOf(s);
}

/** V0.103.0：mock 细纲按章换轴。旧 mock 每章同一份「旧敌堵门」细纲，多样性闸会把第 2 章打成六轴同构 hard。 */
function mockChapterOutline(lastUser) {
  const idx = Number((String(lastUser || '').match(/请为《[^》]+》第(\d+)章生成细纲/) || [])[1]) || 1;
  const slot = ((idx - 1) % 6 + 6) % 6;
  const n = idx;
  const variants = [
    {
      title: n === 1 ? '第一章' : `酒馆余波${n}`,
      goal: '主角登场并遭遇冲突', conflict: '旧敌寻仇',
      dramatic_question: '林晚是否愿意为了守住酒馆正面反抗旧敌？',
      counterforce: '旧敌带人堵门并砸毁酒坛，逼他当众低头',
      turn: '林晚发现旧敌真正寻找的是他腰间玉佩',
      irreversible_change: '酒馆被砸，林晚与旧敌公开决裂，玉佩秘密暴露',
      choice_cost: '林晚选择迎战，失去继续隐姓埋名的退路',
      reader_gain: '林晚第一次主动反抗并确认玉佩会对旧敌产生反应',
      reader_pull: '旧敌认出玉佩后改口退走，林晚必须先查清玉佩来历',
      continuity_from: '主角初到青云城', continuity_to: '玉佩秘密浮出水面',
      pace: 'advance',
      scenes: [
        { id: 's1', pov: '林晚', location: '青云城', scene_type: 'dialogue', pacing: '铺垫', beat: '林晚在城门遇到旧敌，对方借酒钱试探他的身份，林晚试图绕开却看见酒馆伙计被扣。', target_words: 1250 },
        { id: 's2', pov: '林晚', location: '酒馆', scene_type: 'fight', pacing: '爆发', beat: '旧敌砸毁酒坛逼林晚交出玉佩，林晚选择迎战并承担身份暴露的代价。', target_words: 1250 },
        { id: 's3', pov: '林晚', location: '酒馆后巷', scene_type: 'reveal', pacing: '推进', beat: '林晚从旧敌的反应确认玉佩另有来历，追问时对方改变计划撤走。', target_words: 1250 },
        { id: 's4', pov: '林晚', location: '酒馆废墟', scene_type: 'emotion', pacing: '余韵', beat: '林晚收拾被砸的酒馆，决定不再隐姓埋名，并着手追查玉佩主人。', target_words: 1250 },
      ],
      checkpoints: ['林晚登场', '冲突爆发', '玉佩伏笔'],
      ending_hook: { desc: '旧敌退走时撂下狠话，说玉佩的主人终将找上门来', type: '危机钩', intensity: 4 },
    },
    {
      title: `巷口追截${n}`,
      goal: '发现玉佩被带走的踪迹并沿巷口追截', conflict: '天亮前必须追上',
      dramatic_question: '天亮前能不能截回玉佩？',
      counterforce: '天亮前时限与巷口封路',
      turn: '足迹对上东巷暗门',
      irreversible_change: '把巷口足迹记入线索册',
      choice_cost: '公开追截后无法再装不认识那人',
      reader_gain: '截住第一处藏点',
      reader_pull: '远处还有第二个人影未停',
      continuity_from: '玉佩已被人拿走', continuity_to: '东巷暗门未关',
      pace: 'advance',
      scenes: [
        { id: 's1', pov: '林晚', location: '巷口', scene_type: 'suspense', pacing: '铺垫', beat: `林晚发现第${n}处玉佩残屑，沿湿石追截。`, target_words: 1250 },
        { id: 's2', pov: '林晚', location: '东巷', scene_type: 'fight', pacing: '爆发', beat: '天亮前时限压过来，他改道堵住暗门。', target_words: 1250 },
        { id: 's3', pov: '林晚', location: '暗门', scene_type: 'reveal', pacing: '推进', beat: '把足迹记入线索册，确认人已钻进东巷。', target_words: 1250 },
        { id: 's4', pov: '林晚', location: '巷尾', scene_type: 'emotion', pacing: '余韵', beat: '远处第二个人影未停，他只能先守住这一册记录。', target_words: 1250 },
      ],
      checkpoints: ['发现残屑', '追截改道', '记入线索册'],
      ending_hook: { desc: '远处第二个人影还在移动', type: '危机钩', intensity: 3 },
    },
    {
      title: `门槛接战${n}`,
      goal: '在酒馆门口接战挡住旧敌', conflict: '旧敌带刀攻门',
      dramatic_question: '这一仗能不能守住门槛？',
      counterforce: '旧敌带刀的同伴攻门',
      turn: '门板被劈开',
      irreversible_change: '酒馆门槛被夺得，退路切断',
      choice_cost: '门板被劈、退路切断',
      reader_gain: '看见林晚用身体挡住刀锋',
      reader_pull: '要不要把玉佩交出去',
      continuity_from: '旧敌再次压到酒馆', continuity_to: '门槛已失',
      pace: 'advance',
      scenes: [
        { id: 's1', pov: '林晚', location: '酒馆门口', scene_type: 'fight', pacing: '爆发', beat: `旧敌带刀攻到第${n}道门槛，林晚接战。`, target_words: 1250 },
        { id: 's2', pov: '林晚', location: '门槛', scene_type: 'fight', pacing: '推进', beat: '白刃相接，门板被劈开。', target_words: 1250 },
        { id: 's3', pov: '林晚', location: '堂内', scene_type: 'reveal', pacing: '推进', beat: '门槛被夺得后，玉佩在怀里发烫。', target_words: 1250 },
        { id: 's4', pov: '林晚', location: '后厨', scene_type: 'emotion', pacing: '余韵', beat: '退路切断，他只能问自己要不要把玉佩交出去。', target_words: 1250 },
      ],
      checkpoints: ['接战', '门槛被夺', '玉佩发烫'],
      ending_hook: { desc: '要不要把玉佩交出去', type: '选择钩', intensity: 4 },
    },
    {
      title: `山道避雨${n}`,
      goal: '沿山道赶路避开暴雨', conflict: '暴雨与山体松动',
      dramatic_question: '今晚能否赶到岩棚？',
      counterforce: '暴雨和山体坍塌',
      turn: '路人分出半领蓑衣',
      irreversible_change: '与路人同行并承诺天亮送他过岗',
      choice_cost: '把干粮分掉一半',
      reader_gain: '暴雨夜里多了一个同行的人',
      reader_pull: '两人一起离开岩棚后还能否再见面',
      continuity_from: '城门已不可回', continuity_to: '过岗承诺未兑',
      pace: 'daily',
      scenes: [
        { id: 's1', pov: '林晚', location: '山道', scene_type: 'daily', pacing: '铺垫', beat: `林晚沿山道赶路，第${n}阵暴雨砸下来。`, target_words: 1250 },
        { id: 's2', pov: '林晚', location: '坡上', scene_type: 'suspense', pacing: '推进', beat: '山体松动，路人把蓑衣分给他。', target_words: 1250 },
        { id: 's3', pov: '林晚', location: '岩棚', scene_type: 'dialogue', pacing: '推进', beat: '两人挤在岩棚，他承诺天亮送对方过岗。', target_words: 1250 },
        { id: 's4', pov: '林晚', location: '岩棚口', scene_type: 'emotion', pacing: '余韵', beat: '雨小了，他们一起离开岩棚。', target_words: 1250 },
      ],
      checkpoints: ['赶路', '避雨', '承诺过岗'],
      ending_hook: { desc: '过岗之后还能不能再见面', type: '情感钩', intensity: 2 },
    },
    {
      title: `坊主会商${n}`,
      goal: '向坊主禀报玉佩并会商处置', conflict: '坊主大人不许私藏',
      dramatic_question: '玉佩交不交公？',
      counterforce: '坊主大人当场反对私藏',
      turn: '大人下令先封存再验证',
      irreversible_change: '坊主大人批准把玉佩封进匣中验证',
      choice_cost: '听命交出玉佩一夜',
      reader_gain: '处置权从林晚转到坊主',
      reader_pull: '原来匣上另有一个名字',
      continuity_from: '玉佩不能再藏在腰间', continuity_to: '匣上名字未解',
      pace: 'setup',
      scenes: [
        { id: 's1', pov: '林晚', location: '坊市', scene_type: 'dialogue', pacing: '铺垫', beat: `林晚向坊主禀报第${n}次会商玉佩处置。`, target_words: 1250 },
        { id: 's2', pov: '林晚', location: '议事房', scene_type: 'dialogue', pacing: '推进', beat: '坊主大人反对私藏，责令封存。', target_words: 1250 },
        { id: 's3', pov: '林晚', location: '议事房', scene_type: 'reveal', pacing: '推进', beat: '大人下令验证匣盖，林晚听命交出。', target_words: 1250 },
        { id: 's4', pov: '林晚', location: '厢房', scene_type: 'emotion', pacing: '余韵', beat: '匣上原来刻着另一个名字。', target_words: 1250 },
      ],
      checkpoints: ['禀报', '会商', '封存验证'],
      ending_hook: { desc: '匣上名字不是林晚', type: '悬念钩', intensity: 3 },
    },
    {
      title: `市井买米${n}`,
      goal: '市井买米吃饭歇息', conflict: '米价与伤药不可兼得',
      dramatic_question: '今晚买米还是买药？',
      counterforce: '邻里同伴反对把米匀给他',
      turn: '邻里匀出半升陈米',
      irreversible_change: '欠下一升人情',
      choice_cost: '把明日口粮先垫出去换药',
      reader_gain: '伤药到手、米缸见底',
      reader_pull: '明日还得再买一升米',
      continuity_from: '身上只够办一件事', continuity_to: '人情未还',
      pace: 'daily',
      scenes: [
        { id: 's1', pov: '林晚', location: '市井', scene_type: 'daily', pacing: '铺垫', beat: `林晚在市井买米，第${n}回碰到米价跳。`, target_words: 1250 },
        { id: 's2', pov: '林晚', location: '药摊', scene_type: 'daily', pacing: '推进', beat: '伤药和米不可兼得，邻里匀出半升。', target_words: 1250 },
        { id: 's3', pov: '林晚', location: '灶边', scene_type: 'emotion', pacing: '推进', beat: '灶上的火煮着半升米，他先把药敷上。', target_words: 1250 },
        { id: 's4', pov: '林晚', location: '门口', scene_type: 'daily', pacing: '余韵', beat: '米缸见底，明日还得再买。', target_words: 1250 },
      ],
      checkpoints: ['买米', '两难', '人情'],
      ending_hook: { desc: '明日还得再买一升米', type: '日常钩', intensity: 1 },
    },
  ];
  const v = variants[slot];
  return {
    ...v,
    obligations: ['回收'],
    forbidden: ['苏晚不得登场'],
    foreshadows_used: [],
    new_hooks: ['林晚腰间玉佩发光'],
  };
}

/** V0.102：mock 卷纲必须承接指令里的【卷缝】出口，否则 validateVolumeSeam 会正确拒掉，续卷测试全红。 */
function mockVolumeOutlineFromSeam(lastUser) {
  const seamBlock = String(lastUser || '').match(/【卷缝】[\s\S]*?(?=\n【卷缝纪律】|$)/)?.[0] || '';
  const chapterLine = (seamBlock.match(/第\d+章《[^》]*》[^\n]*/) || [])[0] || '';
  const exitLine = (seamBlock.match(/第\d+章《[^》]*》[^：\n]*：([^\n]+)/) || [])[1]
    || (seamBlock.match(/章末余势：([^\n]+)/) || [])[1]
    || chapterLine
    || '';
  const staleNames = ((seamBlock.match(/停滞弧[^：\n]*：([^\n]+)/) || [])[1] || '')
    .split('、')
    .map(s => s.replace(/（[^）]*）/g, '').trim())
    .filter(Boolean);
  return {
    arcs_advanced: staleNames.length ? staleNames.slice(0, 2) : ['主线'],
    ch1Beat: exitLine
      ? `承接上卷已经发生的事：${exitLine.slice(0, 80)}。主角据此作出不可逆选择并承担代价。`
      : '主角下山',
  };
}

// ================= Mock 模式（测试用，NOVEL_MOCK_LLM=1） =================
// 故障注入：NOVEL_FAULT='code:n,code:n,...' 按顺序消耗（如 '429:2|500:1|stall:1'）
let faultQueue = null;
let lastFaultEnv = null;
function loadFaults() {
  const raw = process.env.NOVEL_FAULT || '';
  if (raw === lastFaultEnv) return;
  lastFaultEnv = raw;
  faultQueue = raw ? raw.split(/[,|]/).map(s => s.trim()).filter(Boolean).map(part => {
    const [code, n] = part.split(':');
    return { code, left: parseInt(n || '1', 10) || 1 };
  }) : [];
}
function nextFault() {
  loadFaults();
  const f = faultQueue.find(x => x.left > 0);
  if (!f) return null;
  f.left--;
  return f.code;
}

// V0.98.5 测试钩子：NOVEL_REASONING_BURN=1 → 每次切换该环境变量后的首次调用返回
// 「输出全被思考吃空」（content 空 + reasoning 长 + finishReason stop，可无完成标记形态），
// 验证 router 的降档重试自愈不依赖 finishReason=length。
let burnState = { env: '', used: false };
function mockReasoningBurn() {
  const raw = process.env.NOVEL_REASONING_BURN || '';
  if (raw !== burnState.env) burnState = { env: raw, used: false };
  if (raw !== '1' || burnState.used) return false;
  burnState.used = true;
  return true;
}

// V0.98.8 测试钩子：NOVEL_EMPTY_ONCE=1 → 切换后首次调用返回空正文（finish=stop、无思考），
// 验证 router 对「finish=stop 且 content 空」的瞬时坏响应也能降档重试。
let emptyState = { env: '', used: false };
function mockEmptyOnce() {
  const raw = process.env.NOVEL_EMPTY_ONCE || '';
  if (raw !== emptyState.env) emptyState = { env: raw, used: false };
  if (raw !== '1' || emptyState.used) return false;
  emptyState.used = true;
  return true;
}

// V0.98.8 测试钩子：NOVEL_PROSE_ONCE=1 → 切换后首次调用返回无 JSON 的纯散文，
// 验证任务边界（如开篇候选）对解析失败的静默重试。
let proseState = { env: '', used: false };
function mockProseOnce() {
  const raw = process.env.NOVEL_PROSE_ONCE || '';
  if (raw !== proseState.env) proseState = { env: raw, used: false };
  if (raw !== '1' || proseState.used) return false;
  proseState.used = true;
  return true;
}

function mockCompletion(opts) {
  const { messages, jsonMode, stream, onDelta, onUsage, onRetry } = opts;
  const fault = nextFault();
  if (fault) {
    const err = new Error(`注入故障 ${fault}`);
    err.code = fault === 'stall' ? 'STREAM_STALL' : (fault === '429' ? 'RATE_LIMIT' : (fault === '500' ? 'API_ERROR' : fault));
    if (fault === 'stall') {
      err.partialContent = '雨还在下。她推开门，看见他站在巷口，手里握着那枚玉佩。';
    }
    return Promise.reject(err);
  }
  // V0.98.5 测试钩子：模拟「思考吃空输出」（免费档实证形态——正文空、reasoning_content 拉满）
  if (mockReasoningBurn()) {
    return Promise.resolve({
      content: '', reasoningContent: '模型把输出预算全部烧成了推理，没有产出正文。'.repeat(12),
      finishReason: 'stop', model: opts.model, usage: mockUsage(200, 0), durationMs: 10,
    });
  }
  // V0.98.8 测试钩子：模拟「瞬时空响应」（finish=stop、正文空、无思考——免费档实证形态）
  if (mockEmptyOnce()) {
    return Promise.resolve({
      content: '', reasoningContent: '', finishReason: 'stop',
      model: opts.model, usage: mockUsage(200, 0), durationMs: 10,
    });
  }
  // V0.98.8 测试钩子：模拟「无 JSON 的纯散文响应」（jsonMode 任务解析失败形态）
  if (mockProseOnce()) {
    return Promise.resolve({
      content: '模型这次没有输出 JSON，而是直接写了一段与任务无关的散文，内部没有任何对象结构。',
      reasoningContent: '', finishReason: 'stop',
      model: opts.model, usage: mockUsage(200, 40), durationMs: 10,
    });
  }
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  // V0.100.1：反馈重答场景下最后一条 user 是纠正消息（不含任务指令与正文材料）——
  // 任务识别与正文提取必须回落到最后一条真正的指令消息，与真实模型看到完整上下文一致。
  // （NOVEL_SETTINGS_FAULT 等老钩子仍用 lastUser 检测重试标记，不受影响。）
  const instructionUser = [...messages].reverse().find(m => m.role === 'user'
    && !String(m.content || '').includes('本地确定性校验拒绝了上一版输出')
    && !String(m.content || '').includes('【上轮本地校验未通过】'))?.content || lastUser;
  const totalPrompt = messages.reduce((s, m) => s + (m.content?.length || 0), 0);
  let content;

  if (jsonMode) {
    if (opts.task === 'cast_design') {
      // V0.105.4：cast 补设计 mock——置于链首：指令含「【书契约】」，靠后会命中书契约分支。
      // 此前落到兜底 {ok:true}（无 cast_text），runCastDesign 在测试里永远"解析失败"零覆盖。
      content = JSON.stringify({
        cast_text: '【主角弧光】\n林晚｜从搬石少年到执棋人：守土的代价从身外之物逐层压向自身。\n【配角库】\n- 王砚｜书吏出身，算盘即兵器，怕的是账对不上人。\n- 阿禾｜码头力夫，信拳头更信粮价。',
        social_ecology: '码头：桐油价随军报涨跌；力夫按绳结记账；茶馆传邸报比官驿快半日。',
      });
    } else if (opts.task === 'narrative_plan_reconcile') {
      const match = lastUser.match(/【PLAN_INPUT_JSON】\s*\n([\s\S]*?)\n\n只输出 JSON/);
      let input = { actual_through_chapter: 0, chapters: [], volumes: [], next_chapters: [] };
      try { input = JSON.parse(match?.[1] || '{}'); } catch { /* 测试 mock 使用保守空结构 */ }
      const evidenceFor = (volumeIdx = null) => {
        const row = (input.chapters || []).find(chapter => volumeIdx == null || Number(chapter.volume_idx) === Number(volumeIdx))
          || (input.chapters || [])[0];
        const quote = row?.evidence?.[0] || row?.actual?.evidence || '';
        return row && quote ? [{ chapter: Number(row.chapter), quote }] : [];
      };
      content = JSON.stringify({
        book_state: {
          actual_through_chapter: Number(input.actual_through_chapter) || 0,
          actual_story_state: '已写人物采取行动并使局势发生不可逆变化。',
          future_direction: '从当前后果继续推进人物选择，并履行原有长期承诺。',
          next_reader_gain: '先兑现上一轮行动的具体代价，再给出改变判断的新信息。',
          evidence: evidenceFor(),
        },
        volumes: (input.volumes || []).map(volume => ({
          volume_idx: Number(volume.volume_idx),
          status: volume.status,
          actual_summary: volume.completed_indexes?.length ? '本卷已写部分以当前正文取证结果为准。' : '本卷尚未开始。',
          actual_arc: volume.completed_indexes?.length ? '人物与局势已因已写行动发生变化。' : '本卷人物弧尚未开始。',
          remaining_direction: '从当前真实局面承接后果，并继续履行本卷长期目标。',
          evidence: volume.completed_indexes?.length ? evidenceFor(volume.volume_idx) : [],
        })),
        next_chapters: (input.next_chapters || []).map(chapter => ({
          chapter: Number(chapter.chapter),
          goal: '处理前文行动造成的第一轮后果',
          conflict: '兑现既有责任与抓住新机会不可兼得',
          bridge_from_actual: '直接承接当前已写局面，不沿用旧动态细纲',
          reader_gain: '让前文选择的代价落地，并得到一条新信息',
          reader_pull: '新信息改变人物下一步选择',
        })),
      });
    } else if (opts.task === 'archive') {
      content = JSON.stringify({
        new_rolling: {
          story_state: '林晚抵达青云城，遭遇旧敌，玉佩发光埋下伏笔。',
          characters: [{ name: '林晚', state: '位置=青云城；状态=受伤' }],
          unresolved_hooks: ['林晚腰间玉佩发光之谜（第1章埋设）'],
          key_facts: [{ fact: '林晚位于青云城', ref: '1' }],
          upcoming: '玉佩秘密逐步揭开',
        },
        missing: [],
      });
    } else if (opts.task === 'settle' && instructionUser.includes('叙事状态取证员')) {
      // V0.100 shadow replay mock：每条 claim 都携带候选正文中的逐字证据。
      const prose = String(instructionUser.split(/【当前版本正文[^】]*】/).at(-1) || '').trim();
      const evidence = prose.replace(/^\s+/, '').slice(0, Math.min(24, Math.max(4, prose.length))) || '正文取证锚点';
      content = JSON.stringify({
        summary: '本章人物采取行动并使局势发生变化。',
        rolling_update: '人物行动带来不可逆后果，后续必须处理其影响。',
        outline_actual: {
          goal: '解决眼前问题', conflict: '行动与保留退路不可兼得',
          dramatic_question: '人物是否愿意承担行动代价？', counterforce: '局势与他人阻止其行动',
          turn: '原有办法失效', irreversible_change: '人物行动后无法无成本回到原状',
          choice_cost: '人物选择行动并失去退路', reader_gain: '读者看见明确行动及其后果',
          reader_pull: '行动造成的后果仍需处理', evidence,
          scenes: [{ id: 's1', beat: '人物采取行动并承担后果', evidence }],
        },
        facts: [{ subject: '本章人物', predicate: '采取', object: '关键行动', evidence }],
        character_updates: [], character_notes: [], character_emotional: [],
        timeline: [{ event: '本章人物采取关键行动', evidence }],
        foreshadow_actions: [], memory_entries: [{ category: 'scene', name: '', content: '人物承担行动后果', evidence }],
        new_entities: [],
      });
    } else if (opts.task === 'settle') {
      // 按 task 分流，避免 assembleReviewMessages 合并后的固定材料中“书契约”等词抢命中。
      const prose = String(instructionUser.split(/【当前版本正文[^】]*】/).at(-1) || '').trim();
      const evidence = prose.replace(/^\s+/, '').slice(0, Math.min(24, Math.max(4, prose.length))) || '正文取证锚点';
      // V0.100.1 测试钩子：NOVEL_SETTLE_FAULT=1 首次返回正文外幻觉证据（收到纠正反馈后恢复正常）；
      // =2 恒返回幻觉证据（验证重答一次后确定性投影降级放行）。
      const settleFault = process.env.NOVEL_SETTLE_FAULT || '';
      const hallucinated = settleFault === '2'
        || (settleFault === '1' && !lastUser.includes('本地确定性校验拒绝了上一版输出'));
      const useEvidence = hallucinated ? '永远定位不到的幻觉引文' : evidence;
      content = JSON.stringify({
        outline_actual: {
          goal: '解决眼前问题', conflict: '行动与保留退路不可兼得',
          dramatic_question: '人物是否愿意承担行动代价？', counterforce: '局势与他人阻止其行动',
          turn: '原有办法失效', irreversible_change: '人物行动后无法无成本回到原状',
          choice_cost: '人物选择行动并失去退路', reader_gain: '读者看见明确行动及其后果',
          reader_pull: '行动造成的后果仍需处理', evidence: useEvidence,
          scenes: [{ id: 's1', beat: '人物采取行动并承担后果', evidence: useEvidence }],
        },
        facts: [{ subject: '林晚', predicate: '位于', object: '青云城', evidence: useEvidence }],
        character_updates: [{ name: '林晚', changes: ['位置=青云城', '状态=受伤'], evidence: useEvidence }],
        character_notes: [{ name: '林晚', note: '对苏晚态度转冷', evidence: useEvidence }],
        character_emotional: [{ name: '林晚', mood: '决心复仇', relation_delta: '与苏晚疏远', evidence: useEvidence }],
        timeline: [{ event: '林晚抵达青云城，遭遇旧敌', evidence: useEvidence }],
        foreshadow_actions: [{ desc: '林晚腰间玉佩发光', action: 'plant', note: '玉佩首次发光', quote: useEvidence, evidence: useEvidence }],
        summary: '林晚抵达青云城，遭遇旧敌埋伏，玉佩神秘发光。',
        rolling_update: '林晚抵达青云城，遭遇旧敌，玉佩发光埋下伏笔。',
        memory_entries: [{ category: 'voice', name: '林晚', content: '话短，答话常只一个字', evidence: useEvidence }, { category: 'detail', name: '玉佩', content: '旧玉佩遇险发光，来历不明', evidence: useEvidence }],
        new_entities: [],
      });
    } else if (opts.task === 'mid_story_review' && lastUser.includes('推荐失败返工总诊断')) {
      // V0.99 推荐失败质量曲线 mock：逐章覆盖并引用输入原文；1—6 章只作疑似基线，7—20 章高风险返工。
      const body = lastUser.split('【待诊断正文】').at(-1) || '';
      const matches = [...body.matchAll(/【第(\d+)章\s*([^】]*)】\n([\s\S]*?)(?=\n\n【第\d+章|$)/g)];
      const qualityCurve = matches.map((match) => {
        const chapter = Number(match[1]);
        const chapterText = String(match[3] || '').trim();
        const evidence = chapterText.replace(/\s+/g, '').slice(0, 16) || '正文证据缺失';
        const highRisk = chapter >= 7;
        return {
          chapter,
          score: highRisk ? 34 : 72,
          action: highRisk ? 'rebuild' : 'keep',
          evidence: [evidence],
          effective_events: highRisk ? [] : ['人物作出一次可辨认的行动'],
          irreversible_change: highRisk ? '' : '人物离开原有安全状态',
          character_cost: highRisk ? '' : '人物承担行动代价',
          promise_delivery: highRisk ? '' : '人物承诺获得一次行动兑现',
          filler_signals: highRisk ? ['局势推进不足，需将商议改造成有代价的行动'] : [],
          ending_pull: highRisk ? '' : '行动后果将在下一章继续',
          reason: highRisk ? '高风险段需要重建有效事件、代价和后果' : '疑似基线暂可保留，但仍以原文证据为准',
          rebuild_objective: highRisk ? '让核心人物作出有代价的决定，使章末局势不可逆地改变并承接下一章' : '',
        };
      });
      content = JSON.stringify({
        quality_curve: qualityCurve,
        segment_verdict: {
          deterioration_found: qualityCurve.some(item => item.chapter >= 7),
          turn_chapter: 7,
          reason: '第7章后按高风险标准复核有效事件、代价与追读力',
        },
      });
    } else if (opts.task === 'opening_candidate_compare' && lastUser.includes('推荐返工匿名对照审稿')) {
      const a = (lastUser.match(/【候选 A】\n([\s\S]*?)\n\n【候选 B】/) || [])[1] || '';
      const b = (lastUser.match(/【候选 B】\n([\s\S]*)$/) || [])[1] || '';
      const aImproved = a.includes('退路文书按进火盆');
      const bImproved = b.includes('退路文书按进火盆');
      const excerpt = value => String(value || '').replace(/\s+/g, '').slice(0, 16) || '候选文本证据';
      const winner = aImproved === bImproved ? 'tie' : (aImproved ? 'A' : 'B');
      const strong = { progression: 84, consequence: 82, character: 78, pull: 76 };
      const weak = { progression: 36, consequence: 32, character: 44, pull: 30 };
      content = JSON.stringify({
        winner, margin: winner === 'tie' ? 0 : 28,
        scores: { A: aImproved ? strong : weak, B: bImproved ? strong : weak },
        evidence: { A: [excerpt(a)], B: [excerpt(b)] },
        reason: winner === 'tie' ? '两版没有形成清晰差距' : `${winner} 有明确行动、代价和后果`,
      });
    } else if (opts.task === 'mid_story_review' && lastUser.includes('推荐返工整段复核')) {
      // 分段复核标记是【候选（第 X/Y 段）】，单段才是【候选整段】；两种都要取到候选正文，
      // 否则证据会摘到指令前缀上被证据闸判废（V0.100.14 离线复现实证）。
      const candidate = lastUser.split(/【候选(?:整段|（第 ?\d+\/\d+ 段）)】/).at(-1) || '';
      const withoutHeading = candidate.replace(/^[\s\S]*?【第\d+章[^】]*】\s*/, '');
      content = JSON.stringify({
        verdict: 'pass', sustained_progression: true,
        evidence: [withoutHeading.replace(/\s+/g, '').slice(0, 16) || '候选正文证据'],
        reason: '候选段落已有行动、代价与连续后果，质量曲线不再只靠商议拖延',
        residual_risks: [],
      });
    } else if (opts.task === 'mid_story_review' && lastUser.includes('跨段总复核')) {
      // 跨段复核的输入只有分段结论与边界摘录；边界摘录本身就是候选正文的首尾切片，
      // 从中取连续短引文即可满足"证据必须在候选正文逐字定位"。
      const boundary = String(lastUser.split('段尾边界：')[1] || lastUser.split('段首边界：')[1] || '');
      content = JSON.stringify({
        verdict: 'pass', sustained_progression: true, segment_consistency: true,
        evidence: [boundary.replace(/\s+/g, '').slice(0, 16) || '候选正文证据'],
        reason: '各段出口成为后段入口的真实原因，人物与保护事实跨段自洽',
        residual_risks: [],
      });
    } else if (opts.task === 'audit' && lastUser.includes('小说连续性审校员')) {
      // V0.78 测试钩子：NOVEL_AUDIT_FAULT=1 时返回"事实编造"问题，验证 pipeline 走 replan
      if (process.env.NOVEL_AUDIT_FAULT === '1') {
        content = JSON.stringify({ issues: [{ type: '事实编造', severity: 'high', quote: '书库杂役老幺', issue: '角色老幺未登记', fix: '登记或删除' }], verdict: 'fix', grade: 'C' });
      } else if (process.env.NOVEL_AUDIT_TEXTFAULT === '1') {
        // V0.79 测试钩子：纯语句质量（AI 味词高频）→ 验证 pipeline 走 textOnly 记债放行（不 QUALITY_GATE_FAILED）
        // quote 用 mock 正文精确片段（他站在巷口），确保 sanitize 引用闸通过（不误过滤）
        content = JSON.stringify({ issues: [{ type: '语句质量', severity: 'medium', quote: '他站在巷口', issue: '「缓缓」出现 5 次，AI 味重', fix: '精简' }], verdict: 'fix', grade: 'A' });
      } else {
        content = JSON.stringify({ issues: [], verdict: 'accept', grade: 'A' });
      }
    } else if (opts.task === 'signing_review') {
      // 开篇文本预审 mock：默认 pass；NOVEL_SIGNING_FAULT=1 → reject（测有证据修订路径）
      content = process.env.NOVEL_SIGNING_FAULT === '1'
        ? JSON.stringify({ verdict: 'reject', score: 45, reason: '开篇核心吸引点不清楚', issues: [{ type: '开篇供给', severity: 'high', chapter: 1, quote: '他站在巷口', issue: '人物困局与选择不清楚', fix: '用最小场景调整让选择可见' }], evidence_limits: '本评审是文本审阅，不预测平台流量或签约概率', observation_plan: ['发布后观察首章真实读完与评论'] })
        : JSON.stringify({ verdict: 'pass', score: 85, reason: '人物、困局与继续阅读理由成立', issues: [], evidence_limits: '本评审是文本审阅，不预测平台流量或签约概率', observation_plan: ['发布后观察真实数据'] });
    } else if (lastUser.includes('契约承诺核对')) {
      // V0.80 契约承诺核对 mock：默认 met:true（避免测试期误注入 constraint 改变结果）
      content = process.env.NOVEL_PROMISE_FAULT === '1'
        ? JSON.stringify({ met: false, evidence: '', gap: '前三章未出现打脸' })
        : JSON.stringify({ met: true, evidence: 'mock 已验证兑现', gap: '' });
    } else if (opts.task === 'attraction') {
      // V0.80 测试钩子：NOVEL_ATTRACTION_FAULT=1 返回 fix（验证吸引力门触发修订）
      if (process.env.NOVEL_ATTRACTION_PARSEFAULT === '1') {
        content = '{"verdict":';
      } else if (process.env.NOVEL_ATTRACTION_FAULT === '1') {
        content = JSON.stringify({ verdict: 'fix', issues: [{ type: '无章末钩子', severity: 'high', quote: '他站在巷口', issue: '章末未落在钩子上', fix: '结尾补一个危机/悬念' }], score: 'D', reason: '测试注入' });
      } else {
        content = JSON.stringify({ verdict: 'pass', issues: [], score: 'B', reason: '有事件有钩子有爽点' });
      }
    } else if (lastUser.includes('历史时代背景卡生成')) {
      // V0.81 历史时代背景卡 mock（宋末史实锚点）
      content = JSON.stringify({
        era: '南宋末（端平元年1234—德祐二年1276），淳祐/宝祐/开庆/景定年号',
        real_events: ['1242年余玠筑山城防御体系', '1254年王坚大扩钓鱼城', '1259年蒙哥围钓鱼城七月死'],
        real_people: [{ name: '余玠', role: '四川制置使', fate: '1253年遭构陷服毒' }, { name: '蒙哥', role: '蒙古大汗', fate: '1259年死于钓鱼城下' }],
        offices: '宰执/枢密院/三衙/制置使/都统制/知州/通判',
        military: '山城防御体系，以城为垒以江为壕，火器初兴',
        geography: '重庆帅府/钓鱼城三江汇流/夔门锁江/大散关',
        economy: '铜钱+会子，盐酒专卖，苛税折帛',
        ritual: '避讳/尊称/科举同年/守制丁忧',
        red_lines: ['烟草', '玉米', '辣椒', '咖啡', '报纸', '蒸汽机'],
        alterable_history: '蒙哥之死→蒙古西征终止/忽必烈阿里不哥内战→主角可改后续走向',
      });
    } else if (opts.task === 'opening_strategy') {
      const base = (kind, strategy_family, entry_signature, entry_time, immediate_problem) => ({
        kind, strategy_family, entry_signature,
        creative_hypothesis: `${strategy_family} 更早显出人物选择`, entry_time, first_actor: '主角',
        immediate_problem, first_choice: '先保护身边人', first_state_change: '人物开始主动应对',
        strongest_axis: 'character', transition_plan: '沿同一动作或意象进入第一章主体',
      });
      content = lastUser.includes('这是新书创作')
        ? JSON.stringify({ strategies: [
          base('chapter1_draft', 'chronological_choice', 'present|hero|choice|change', '当下', '反常迹象'),
          base('chapter1_draft', 'in_medias_res', 'danger|hero|response|change', '困局中', '眼前威胁'),
          base('chapter1_draft', 'relationship_choice', 'home|bond|protect|change', '关系现场', '必须保护的人受威胁'),
        ] })
        : JSON.stringify({ strategies: [
          base('head_rewrite', 'chronological_choice', 'present|hero|choice|change', '当前第一章', '反常迹象'),
          base('chapter1_cold_open', 'future_result_present_question', 'future|actor|question|return', '未来节点', '长期结果背后的未解问题'),
        ] });
    } else if (opts.task === 'opening_candidate') {
      const isHead = /【结构蓝图】[^\n]*"kind":"head_rewrite"/.test(lastUser);
      const isCold = /【结构蓝图】[^\n]*"kind":"chapter1_cold_open"/.test(lastUser);
      // V0.98.2：远期事件契约在场时，mock 候选必须真的锚定目标事件（年份/信号词+回切），否则本地防线会正确判废。
      const grounded = /远期事件契约/.test(lastUser);
      const contractYear = (lastUser.match(/目标年份：(\d{3,4})/) || [])[1] || '1259';
      const contractSignals = (lastUser.match(/事件信号词（[^】]*?）：([^#\n]+)/) || [])[1] || '';
      const signal = (contractSignals.split('、').find(item => /[\u4e00-\u9fff]/.test(item)) || '').trim();
      // V0.98.12：mock 遵循主角在场纪律——从契约块提取主角名写进现场（主角缺席即念稿，本地判废会拦）
      const protagonist = (lastUser.match(/主角：([^（\n]+)/) || [])[1]?.trim() || '';
      content = JSON.stringify({
        content: isHead ? '主角先把身边人护到身后，又回头确认危险来自哪里。'.repeat(20)
          : isCold ? (grounded
            ? `${contractYear}年，${signal || '钓鱼'}城头的炮石砸进城下军阵，${protagonist || '主角'}一把按住身边人的肩，望向尚未回答的危局。`.repeat(6)
              + '\n\n十八年前，庙会的锣声正响。'
            : '城头的风卷过残旗，主角先按住身边人的肩，望向城下尚未回答的问题。'.repeat(18))
            : '眼前的困局已经发生，主角没有等别人解释，先作出了属于自己的选择。'.repeat(55),
        contract: isCold ? {
          version: 1, promise_key: 'opening:mock-question', public_question: '主角如何走到这一刻？',
          known_outcome: '读者知道未来存在一个待解释的结果', forbidden_early_explanation: ['前期人物不得预知未来因果'],
          target_event_key: '', target_year: null, target_volume_id: '', status: 'open', fulfilled_chapter: null,
        } : {},
      });
    } else if (opts.task === 'opening_candidate_audit') {
      content = JSON.stringify({
        hard_failures: [], issues: [], strongest_axis: { kind: 'character', strength: 3, reason: '人物主动选择可辨' },
        continue_question: '这一选择会造成什么后果', attention_drop: [], speaker_confusion: [], artificial_or_ai_feel: [],
        chapter_one_independence: { ok: true, reason: '第一章主体仍有自己的事件' },
      });
    } else if (opts.task === 'opening_candidate_compare') {
      const labels = [...lastUser.matchAll(/^### (版本.)$/gm)].map(match => match[1]);
      const judgments = Object.fromEntries(labels.map(label => [label, {
        strongest_axis: { kind: 'character', strength: 3, reason: '人物行动可辨' }, hard_failures: [], issues: [],
        continue_question: '选择之后会怎样', attention_drop: [], speaker_confusion: [], artificial_or_ai_feel: [], relative_gain: '进入方式清楚',
      }]));
      content = JSON.stringify({ winner_label: labels[0] || '版本A', reason: '人物行动与继续阅读问题最清楚', judgments });
    } else if (opts.task === 'opening_diagnosis') {
      const rubric = Object.fromEntries([
        'first_screen_clarity', 'protagonist_bond', 'causal_motion', 'promise_alignment',
        'chapter_one_independence', 'emotional_variety', 'structural_naturalness',
      ].map(key => [key, { score: 3, evidence: ['开篇正文可核对'], cost: '' }]));
      content = process.env.NOVEL_OPENING_DIAG_FAULT === '1'
        ? '{"cold_read":'
        : JSON.stringify({
          cold_read: {
            protagonist: { answer: '主角清楚', evidence: ['正文可核对'] },
            immediate_want_or_danger: { answer: '眼前困局清楚', evidence: ['正文可核对'] },
            continue_question: { answer: '人物下一步如何选择', evidence: ['正文可核对'] },
            attention_drop: [], speaker_confusion: [], artificial_or_ai_feel: [],
            strongest_axis: { kind: 'choice', reason: '人物选择带来继续阅读理由' },
          },
          rubric, hard_failures: [], issues: [],
          strategies: [{ kind: 'baseline', creative_hypothesis: '原稿核心吸引轴成立', expected_gain: '无损基线', risks: [] }],
          recommendation: { kind: 'baseline', reason: '未发现有证据支持必须改动' },
        });
    } else if (opts.task === 'story_promise') {
      const isHistory = /题材：历史/.test(lastUser);
      content = process.env.NOVEL_STORY_PROMISE_FAULT === '1'
        ? JSON.stringify({ error: 'mock invalid profile' })
        : JSON.stringify({
          premise_in_one_breath: isHistory ? '乱世里的弱小人物逐步获得保护他人的能力' : '困境中的普通人靠自己的行动改变命运',
          primary_attraction_axis: isHistory ? '情感责任转化为真实保护能力' : '人物选择带来可见改变',
          secondary_axes: ['能力成长', '关系变化'],
          protagonist_now: { lack: '眼下能力不足', immediate_need: '先解决身边的困局', agency_pattern: '观察后作出符合能力的选择' },
          payoff_ladder: { near: ['作出一次有效选择'], middle: ['让同伴少付一次代价'], long: ['完成书契约的长期承诺'] },
          texture: { route: isHistory ? 'serious_immersive_history' : 'general', pace: '持续推进', humor: 'low', historical_density: isHistory ? 'high' : 'low', pov: 'close_third' },
          protected_elements: [], anti_promises: isHistory ? ['无系统', '非穿越'] : [], author_locks: [],
          confidence: { primary_attraction_axis: 'inferred', payoff_ladder: 'inferred' },
        });
    } else if (lastUser.includes('开篇蓝图生成')) {
      // V0.80：开篇蓝图 mock——固定钩子链/爽点节奏/金手指（放在书契约分支前，避免契约文本抢命中）
      // V0.81：历史题材（含"史实·权谋"题材包文本）返回无金手指版——纯史实流靠智斗/军功破局
      content = lastUser.includes('史实·权谋')
        ? JSON.stringify({
          hook_ladder: [
            { chapter: 1, title: '开局', hook: '城破时他跪求宋军回头，没有人回头', payoff: '少年在废墟里立下第一个誓', beat: '战乱孤儿在尸山血海里做出求生选择' },
            { chapter: 2, title: '活下来', hook: '他意外保住了一条命，也看清了世道', payoff: '第一次靠自己活下来', beat: '乡野少年靠才学/胆识得到一线生机' },
            { chapter: 3, title: '立锥', hook: '更大的危险逼近，他被迫提前出手', payoff: '当众破局赢得第一份立足', beat: '以智计/胆识当众破局，赢得口碑或庇护' },
          ],
          pleasure_pacing: [{ chapter: 1, type: 'small', beat: '主角第一个自主决定' }, { chapter: 3, type: 'small', beat: '当众破局立威' }],
          golden_finger: null, // 历史纯史实流：无金手指，靠智慧/军功/人心
          protagonist_goal_ladder: [{ chapter: 1, stage: '乱世求生', goal: '在废墟里活下来并立住人物' }],
          promise_deadlines: [{ promise: '前3章立住人物与处境', due_chapter: 3 }],
        })
        : JSON.stringify({
          hook_ladder: [
            { chapter: 1, title: '开局', hook: '神秘石碑上的字迹与主角掌心印记完全重合', payoff: '主角从绝境中做出第一个反抗选择', beat: '主角被当众羞辱时石碑异动，当众反击' },
            { chapter: 2, title: '金手指', hook: '主角发现石碑力量需要付出代价', payoff: '金手指首次显威', beat: '主角尝试运用新获得的力量' },
            { chapter: 3, title: '小高潮', hook: '更强的对手出现，主角的靠山却离开了', payoff: '当众打脸第一个反派', beat: '当众反击羞辱者的围观名场面' },
          ],
          pleasure_pacing: [{ chapter: 1, type: 'small', beat: '主角第一次当众反击' }, { chapter: 3, type: 'small', beat: '打脸反派' }],
          golden_finger: { power: '掌心印记共鸣石碑，可短暂借用其力量', activate_chapter: 2, limit: '每次使用后气血亏损，不可连续使用', first_display: '第2章被围攻时印记发烫' },
          protagonist_goal_ladder: [{ chapter: 1, stage: '绝境求生', goal: '摆脱当下困境并立住人物' }],
          promise_deadlines: [{ promise: '前3章必有打脸', due_chapter: 3 }],
        });
    } else if (opts.task === 'coverage' && lastUser.includes('是否覆盖')) {
      content = JSON.stringify({ coverage: [{ point: '林晚登场', covered: true, evidence: 'x' }], missing: [], verdict: 'pass' });
    } else if (lastUser.includes('世界展开补救') && !lastUser.includes('续卷大纲') && !lastUser.includes('生成卷大纲')) {
      // V0.76：世界展开补救桥段 mock——返回固定层级跃迁 JSON
      // 放分支链最前：靠独有词"世界展开补救"触发，并排除含"续卷大纲/生成卷大纲"的注入指令
      // （世界补救文本会注入到续卷/卷大纲指令里，不能抢它们的命中）
      content = JSON.stringify({
        reinterpretation: [
          { 意象: '宗门大比邀请函', 重新定义: '前往大陆宗门的契机' },
          { 意象: '坊市传闻', 重新定义: '大陆格局情报' },
        ],
        expansion: {
          startChapter: 118, fromLevel: '宗门一隅', toLevel: '宗门完整生态/周边修真圈',
          region: '青云宗外门—任务堂—山下坊市',
          steps: [
            { chapter: 118, event: '接下外门任务', trigger: '旧线索指向任务堂', beat: '主角主动争取走出原活动区' },
            { chapter: 119, event: '进入山下坊市', trigger: '追查任务物资', beat: '通过交易冲突展开宗门周边生态' },
            { chapter: 120, event: '建立新矛盾', trigger: '发现外门利益链', beat: '新势力登场但旧伏笔继续推进' },
          ],
        },
        volume_plan: '卷10先补全青云宗外门、任务堂与山下坊市生态，用旧伏笔驱动主角进入周边修真圈，再循因果推进更高层级',
        state_cleanup: { keep: ['位置', '境界', '实力', '心境', '持有物'], drop_examples: ['药园杂役排班', '禁地巡逻路线'] },
      });
    } else if ((lastUser.includes('成长补救') || lastUser.includes('补救桥段')) && !lastUser.includes('续卷大纲') && !lastUser.includes('生成卷大纲')) {
      // V0.74：成长补救桥段 mock——返回固定补救 JSON（重新定义前文 + 顿悟连续突破）
      // 放分支链最前：补救指令含"书契约成长承诺"字样，若不提前会与书契约分支抢命中；
      // 且排除"续卷大纲/生成卷大纲"——补救桥段会注入到这些指令里，不能抢它们的命中
      content = JSON.stringify({
        reinterpretation: [
          { 意象: '钥匙共鸣', 重新定义: '灵气亲和' },
          { 意象: '金线', 重新定义: '灵力导引' },
          { 意象: '髓光', 重新定义: '淬体' },
          { 意象: '枯井叩击声', 重新定义: '灵脉认主' },
        ],
        breakthrough: {
          startChapter: 118, fromStage: '丹田微流', toStage: '练气一层',
          steps: [
            { chapter: 118, stage: '触及瓶颈', trigger: '旧积累显现', beat: '确认条件并主动争取资源' },
            { chapter: 119, stage: '突破受挫', trigger: '经脉承压', beat: '付出代价并修正方法' },
            { chapter: 120, stage: '练气一层', trigger: '在真实冲突中完成循环', beat: '能力质变但限制仍在' },
          ],
        },
        volume_plan: '卷10用三章兑现练气入门，后续以任务与冲突稳步推进，每次突破都必须有条件、代价和新瓶颈',
        state_cleanup: { keep: ['位置', '境界', '实力', '丹田微流', '心境', '持有物'], drop_examples: ['发现骨片内黑丝', '判断脚印主人已掌握钥匙轮廓'] },
      });
    } else if (lastUser.includes('吸引人的书名')) {
      content = JSON.stringify({ title: '我在修仙界呼出剧毒', subtitle: '二氧化碳修真录：全体修士的克星' });
    } else if (lastUser.includes('设定包')) {
      // V0.28：书级设定自动生成（settingsInstruction 含"完整设定包"）
      // V0.90 测试钩子：NOVEL_SETTINGS_FAULT=1 → 前两次返回缺 worldview 的坏 JSON，验证自动重试成功
      if (process.env.NOVEL_SETTINGS_FAULT === '1' && !lastUser.includes('自动重试')) {
        content = JSON.stringify({ characters: [{ name: '林晚', role: '主角' }] });
      } else {
        content = JSON.stringify({
        worldview: '灵气复苏的青云大陆：修炼境界炼气→筑基→金丹→元婴，宗门与皇朝并立，灵石为硬通货。主角林晚出身废柴剑宗，身怀神秘玉佩，可吞噬他人灵力反哺自身，因此招致各大势力觊觎。',
        social_ecology: [
          { place: '青云山脚坊市', life: '集市逢五开市，灵草铺、杂役行、茶楼酒肆林立，摊贩吆喝灵石计价，更夫夜巡敲梆，街坊闲话宗门八卦，凡人修士杂居，物价三枚灵石一壶灵茶。' },
        ],
        characters: [
          { name: '林晚', role: '主角', personality: '隐忍坚毅、外冷内热', goal: '登顶剑道，查明身世', relations: '与苏晚青梅竹马；与剑神残魂亦师亦友', appearance: '黑衣少年，左眉一道旧疤' },
          { name: '苏晚', role: '女主', personality: '温婉果敢', goal: '守护宗门', relations: '林晚青梅竹马', appearance: '青衫女子，腰悬玉笛' },
        ],
        locations: [
          { name: '青云宗', type: '宗门', detail: '主角所在宗门，没落剑宗，占据青云山主峰，山门破败但底蕴犹存。' },
          { name: '坊市', type: '集市', detail: '青云山脚修士交易集市，鱼龙混杂，黑市暗藏灵宝。' },
        ],
        items: [
          { name: '神秘玉佩', type: '法宝', detail: '可吞噬他人灵力反哺宿主，剑神残魂寄居其中。' },
        ],
        factions: [
          { name: '天罗皇朝', detail: '统御青云大陆的中央王朝，掌控灵石矿脉，暗中追查玉佩下落。' },
        ],
        worldbook: [
          { word: '青云宗', content: '没落剑宗，林晚所在宗门，山门在青云山主峰。', category: '地理' },
          { word: '神秘玉佩', content: '林晚金手指，可吞噬灵力，剑神残魂寄居。', category: '物品' },
        ],
        });
      }
    } else if (lastUser.includes('创意总监')) {
      content = JSON.stringify({
        scores: { novelty: 4, conflict: 5, market: 5, executable: 7 },
        total: 5.2, verdict: 'weak',
        // V0.25：mock 同步核心元素守恒字段
        kept_elements: ['杂役弟子', '穿越'],
        issues: ['没有强冲突——"捡玉佩"只是单点事件', '人设偏俗套：废柴+奇遇缺少新组合', '卖点不明，读者三秒内抓不住钩子'],
        options: [
          { title: '冲突前置版', concept: '被废的剑宗弟子在宗门大比前夜捡到会说话的玉佩，却发现它只会在仇人靠近时发烫——而仇人今晚就在宗门里。', hook: '玉佩在旧敌走进院门的那一刻突然发烫。', why: '把奇遇变成倒计时危机，开篇即有连续冲突。', risk: '信息密度较高，需控制节奏。' },
          { title: '身份反转版', concept: '被废的剑宗弟子捡到会说话的玉佩，玉佩却自称是千年前的剑神——而他正是剑神的转世。', hook: '玉佩说：别怕，你上辈子杀过比这更狠的。', why: '身份悬念+反差爽感，长线钩子足。', risk: '转世设定需防俗套，靠细节差异化。' },
          { title: '关系错位版', concept: '被废的剑宗弟子捡到会说话的玉佩，玉佩却先认了仇人的女儿为主。', hook: '她握着玉佩，朝林晚笑了：这玉佩，真好看。', why: '三角张力+情感钩子，甜虐兼收。', risk: '感情线与主线需平衡。' },
        ],
        golden_open: '前300字：宗门大比前夜，林晚在柴房听到脚步声——玉佩突然发烫。',
      });
    } else if (lastUser.includes('平台主编')) {
      content = JSON.stringify({ scores: { novelty: 7, conflict: 8, market: 7, executable: 8 }, total: 7.5, verdict: 'pass', regen_direction: '' });
    } else if (lastUser.includes('生成细纲')) {
      content = JSON.stringify(mockChapterOutline(lastUser));
    } else if (lastUser.includes('快感计划') && !lastUser.includes('生成卷大纲') && !lastUser.includes('续卷大纲')) {
      content = JSON.stringify({
        reward_rhythm: { small: '每1-3章一次，类型轮换：打脸/升级/收集/探索/情感', medium: '每5-10章一次卷内小高潮', large: '每15-30章一次卷末高潮' },
        emotion_rotation: ['紧张7→紧张8→小燃9→放松3→甜4→虐6→虐7→大燃10→余韵3→新钩6'],
        suppress_release: { ratio: '2:1~3:1', authority_symbols: ['青云宗（服从→质疑→超越）'] },
        arc_plan: [{ name: '玉佩之谜', type: '主线', span: '1-30章', note: '贯穿全书' }],
        emotion_lines: [{ name: '林晚×苏晚', phase_plan: '出场(1-3章)→暧昧(40-50%)→确认→危机→升华' }],
        protagonist_recipe: { ordinary_anchors: ['被轻视的杂役弟子', '想念母亲的旧梦', '怕黑'], potential: '与玉佩共鸣的剑道天赋', flaws: ['冲动', '自卑'], golden_finger: { power: '玉佩蓄力爆发', limit: '每月只能动用一次，消耗生命力' } },
      });
    } else if (lastUser.includes('记忆管理员')) {
      content = JSON.stringify({
        new_rolling: {
          story_state: '林晚抵达青云城，遭遇旧敌，玉佩发光埋下伏笔。',
          characters: [{ name: '林晚', state: '位置=青云城；状态=受伤' }],
          unresolved_hooks: ['林晚腰间玉佩发光之谜（第1章埋设）'],
          key_facts: [{ fact: '林晚位于青云城', ref: '1' }],
          upcoming: '玉佩秘密逐步揭开',
        },
        missing: [],
      });
    } else if (lastUser.includes('全局总编辑')) {
      content = JSON.stringify({
        drifted: true,
        causes: [{ type: 'fact', severity: 'high', evidence: '第2章：林晚实力与第1章事实矛盾', description: '测试' }],
        actions: [{ type: 'supersede_facts', detail: '林晚 实力达到' }, { type: 'constraints', detail: '后续章节必须保持林晚练气三层' }],
        recovery_note: '回到林晚练气三层的主线',
      });
    } else if (lastUser.includes('书契约') && !lastUser.includes('完本评估') && !lastUser.includes('续卷大纲') && !lastUser.includes('生成书级大纲')) {
      // V0.44：完本评估输入含契约原文（【书契约】…）——排除，避免抢命中
      // V0.93.9：书纲指令的结局倒推纪律含"书契约"字样（"兑现 blurb/书契约的结局承诺"）——排除，避免抢命中
      content = JSON.stringify({
        target_readers: '16-25岁男频读者', selling_points: ['极致爽感', '节奏快'],
        promises: ['前3章必有打脸', '前10章必有大事件'], hard_constraints: ['主角永不言败'], tone: '热血',
      });
    } else if (lastUser.includes('五问') || lastUser.includes('六问')) {
      content = JSON.stringify({ q1_visible_harm: '旧敌砸了林晚的酒馆', q2_physical_conflict: '拳拳到肉的巷战', q3_satisfaction: '林晚一拳打碎旧敌的门牙', q4_ending_hook: '危机突降：玉佩突然发光', q5_open_300: '有，开场即冲突', pass: true, fail_reason: '' });
    } else if (lastUser.includes('完本评估')) {
      // V0.44：mock 默认"未完本"（防偷懒），除非输入含"主角已达成核心目标"
      if (lastUser.includes('已达成核心目标')) {
        content = JSON.stringify({ finished: true, reason: '主角核心目标已达成', remaining: [] });
      } else {
        content = JSON.stringify({ finished: false, reason: '主线目标尚未达成，还在前期发育', remaining: ['主角核心目标', '主线大反派来历'] });
      }
    } else if (lastUser.includes('角色档案')) {
      // V0.50：角色库 AI 整理——mock 提取输入第一个角色名并补全
      const m = lastUser.match(/-\s*([^（(]+)/);
      const name = m ? m[1].trim() : '林晚';
      content = JSON.stringify({
        characters: [
          { name, tier: 'protagonist', personality: '隐忍坚毅、外冷内热', goal: '登顶剑道，查明身世', fear: '再次失去至亲', secret: '身怀神秘玉佩', arc: '从废柴到剑神，从自卑到担当', relation: '与苏晚青梅竹马', abilities: [{ name: '神秘玉佩', type: '法宝', desc: '可吞噬灵力' }] },
        ],
      });
    } else if (lastUser.includes('地点库')) {
      // V0.71：地点库 AI 整理 mock——提取输入第一个地点名并补全 kind/desc
      const m = lastUser.match(/-\s*([^（(]+)/);
      const name = m ? m[1].trim() : '青阳镇';
      content = JSON.stringify({ locations: [{ name, kind: '城镇', desc: '故事起点的镇子，烟火气十足' }] });
    } else if (lastUser.includes('阶段性审阅') || lastUser.includes('创作中期阶段')) {
      // V0.71：创作中期审阅 mock——输出 1 个问题 + 1 条规划调整
      content = JSON.stringify({
        issues: [{ priority: 'medium', type: '伏笔', issue: '玉佩伏笔超龄未回收', suggestion: '下一卷安排回收' }],
        adjustments: [{ type: '伏笔', target: '下一卷', action: '安排玉佩秘密的阶段性揭示' }],
      });
    } else if (lastUser.includes('伏笔的收束')) {
      // V0.71：伏笔收束 mock——输入第一条伏笔分配回收（id 含连字符，用 [^]]+ 匹配完整）
      const m = lastUser.match(/\[([^\]]+)\]/);
      const id = m ? m[1] : 'fs-1';
      content = JSON.stringify({ assignments: [{ id, desc: '超龄伏笔', action: 'resolve', target_chapter: 36, plan: '安排主角在冲突中揭开真相' }] });
    } else if (lastUser.includes('终审编辑')) {
      content = JSON.stringify({ overall: '整体节奏快', structure: '无', character: '无', logic: '无', style: '无', priorities: [{ priority: 'P1', chapter: 1, type: 'polish', issue: '测试问题', feedback: '第1章开场可更有冲击力' }] });
    } else if (lastUser.includes('一致性核查')) {
      content = JSON.stringify({ checks: [{ dimension: '章间衔接', severity: 'low', chapter: 2, quote: 'x', issue: '测试', fix: '微调开头' }] });
    } else if (lastUser.includes('衔接是否生硬')) {
      content = JSON.stringify({ smooth: true, reason: '衔接自然', rewrite_head: '' });
    } else if (lastUser.includes('审校')) {
      content = JSON.stringify({ issues: [], verdict: 'accept', grade: 'A' });
    } else if (lastUser.includes('校验')) {
      content = JSON.stringify({ coverage: [{ point: '林晚登场', covered: true, evidence: 'x' }], missing: [], verdict: 'pass' });
    } else if (lastUser.includes('数据抽取')) {
      content = JSON.stringify({
        facts: [{ subject: '林晚', predicate: '位于', object: '青云城' }],
        character_updates: [{ name: '林晚', changes: ['位置=青云城', '状态=受伤'] }],
        character_notes: [{ name: '林晚', note: '对苏晚态度转冷' }],
        character_emotional: [{ name: '林晚', mood: '决心复仇', relation_delta: '与苏晚疏远' }],
        timeline: ['林晚抵达青云城，遭遇旧敌'],
        foreshadow_actions: [{ desc: '林晚腰间玉佩发光', action: 'plant', note: '玉佩首次发光', quote: '手里的玉佩' }],
        summary: '林晚抵达青云城，遭遇旧敌埋伏，玉佩神秘发光。',
        rolling_update: '林晚抵达青云城，遭遇旧敌，玉佩发光埋下伏笔。',
        memory_entries: [{ category: 'voice', name: '林晚', content: '话短，答话常只一个字' }, { category: 'detail', name: '玉佩', content: '旧玉佩遇险发光，来历不明' }],
        new_entities: [],
      });
    } else if (lastUser.includes('快感审计')) {
      content = JSON.stringify({
        emotion: { type: '燃', intensity: 8 },
        hook: { present: true, type: '悬念钩', intensity: 3, desc: '玉佩在苏晚手中突然发烫' },
        payoffs: [{ desc: '林晚在城门当众打碎旧敌的门牙', kind: '打脸', was_surprising: true, note: '围观者震惊' }],
        issues: [],
        agency_ratio: '高',
      });
    } else if (lastUser.includes('卷级审阅')) {
      // V0.94.2 测试钩子：NOVEL_VOLREVIEW_PARSEFAULT=1 → 返回不可解析输出
 // （复现本作卷3 实况：报告超长截断 → extractJSON 失败 → fail-closed 落 status='failed'）
      if (process.env.NOVEL_VOLREVIEW_PARSEFAULT === '1') {
        content = '卷审阅结论：整体节奏合格，但后半段{...此处应输出完整 JSON 报告却被截断';
      } else
      // V0.41：卷级整体审阅 mock（目标达成 + 节奏 + 衔接 + 读感 + 工单）
      content = JSON.stringify({
        goal_met: true,
        goal_note: '主角完成下山并立威，卷目标达成',
        promises: [{ item: '离开宗门下山', met: true, note: '第一章即完成' }],
        pacing: { grade: 'B', issue: '中段两章稍平缓' },
        hooks: { volume_ending: '玉佩突然发烫，指向宗门秘辛', carried_from_prev: true, hook_note: '上一卷钩子被承接' },
        reading: { grade: 'B', issue: '整体节奏合格，中段可加一个小冲突' },
        stage_progress: {
          stage: (lastUser.match(/阶段ID：(opening|early_middle|middle|late_middle|ending|finale)/) || [])[1] || 'opening',
          duty_met: true, required_turn_met: true, note: '本卷完成阶段转折并产生可见后果',
        },
        arc_movement: { advanced: [], closed: [], opened: [] },
        payoff_movement: { paid: [], remaining: [] },
        new_debt: [],
        ending_readiness: { ready: lastUser.includes('阶段ID：finale'), missing: lastUser.includes('阶段ID：finale') ? [] : ['核心主线尚未结束'] },
        issues: [
          { severity: 'P1', type: 'pacing', chapter: 2, desc: '第二章推进偏慢', suggest: '压缩过渡描写，提前遭遇冲突' },
        ],
      });
    } else if (lastUser.includes('章节改名')) {
      content = JSON.stringify({ title: '修正后的章名' });
    } else if (lastUser.includes('卷改名')) {
      content = JSON.stringify({ title: '修正后的卷名' });
    } else if (lastUser.includes('卷大纲重写')) {
      // V0.45：卷大纲重写——已写章回填实际 + 未写章重规划（mock 2 章）
      content = JSON.stringify({
        title: '重写卷名', goal: '实际达成的目标', arc: '实际走向',
        chapters: [{ idx: 1, title: '第一章', beat: '实际事件一', pov: '主角' }, { idx: 2, title: '第二章', beat: '实际事件二', pov: '主角' }],
      });
    } else if (lastUser.includes('书纲对齐')) {
      // V0.45：书纲对齐——mock 返回 3 卷规划
      content = JSON.stringify({
        volumes: [
          { idx: 1, title: '第一卷', goal: 'g1', summary: 's1' },
          { idx: 2, title: '第二卷', goal: 'g2', summary: 's2' },
          { idx: 3, title: '第三卷', goal: 'g3', summary: 's3' },
        ],
      });
    } else if (lastUser.includes('续卷大纲')) {
      // V0.44：自动续卷——mock 返回第 N+1 卷规划（8 章）
      const lifecycleStage = (lastUser.match(/阶段ID：(opening|early_middle|middle|late_middle|ending|finale)/) || [])[1] || 'opening';
      content = JSON.stringify({
        title: `续卷·第${(lastUser.match(/第(\d+)卷的续卷大纲/) || [])[1] || 2}卷`, goal: '继续主线', arc: '承接上卷，推进伏笔', chapterCount: 8,
        lifecycle_stage: lifecycleStage, stage_turn: '主角作出产生不可逆后果的阶段选择',
        arcs_advanced: ['主线'], arcs_closed: [], hooks_paid: [], new_major_arcs: [], ending_delivery: {},
      });
    } else if (lastUser.includes('生成卷大纲')) {
      const lifecycleStage = (lastUser.match(/阶段ID：(opening|early_middle|middle|late_middle|ending|finale)/) || [])[1] || 'opening';
      const seam = mockVolumeOutlineFromSeam(lastUser);
      // V0.107：按指令请求的章数返回（章数承诺硬校验会拦偏离）；标题按句式族轮换
      // （terse/four/mid/long/question 循环），满足 TITLE_SHAPE 连排/占比校验。
      const asked = parseInt((lastUser.match(/本卷计划\s*(\d+)\s*章/) || [])[1], 10) || 12;
      const nChapters = Math.min(Math.max(asked, 2), 20);
      const MOCK_TITLE_SHAPES = ['风起', '山雨欲来', '夜探废田', '踏出这一步的门', '灯下旧刀', '谁在墙外？', '雨停', '旧约新签', '答案在路上', '最后一根桩落下', '灯下看信', '谁都别想走'];
      content = JSON.stringify({
        title: '第一卷', goal: '离开宗门', arc: '起承转合',
        lifecycle_stage: lifecycleStage, stage_turn: '主角主动离开旧环境并承担后果',
        arcs_advanced: seam.arcs_advanced, arcs_closed: [], hooks_paid: [], new_major_arcs: [],
        ending_delivery: lifecycleStage === 'finale' ? {
          final_opposition: '既有终局对手', final_choice: '主角完成最终选择', irreversible_cost: '永久代价',
          core_promise_payoff: '核心承诺兑现', protagonist_settlement: '主角弧完成',
          relationship_settlements: ['关键关系完成'], world_settlement: '世界结果落地',
          historical_settlement: '不适用', closing_image: '开篇意象回归',
          last_chapter_mode: '余波、安顿、主题回声、闭幕意象',
        } : {},
        chapters: Array.from({ length: nChapters }, (_, i) => ({
          idx: i + 1,
          title: MOCK_TITLE_SHAPES[i % MOCK_TITLE_SHAPES.length] + (i >= MOCK_TITLE_SHAPES.length ? `（${Math.floor(i / MOCK_TITLE_SHAPES.length) + 1}）` : ''),
          beat: i === 0 ? seam.ch1Beat : '局势升级，主角必须当场决策',
          pov: '林晚',
        })),
      });
    } else if (lastUser.includes('生成书级大纲')) {
      // V0.36：按请求的卷数返回多卷（跨卷 idx 冲突测试需要）
      let vols = 1;
      const vm = lastUser.match(/规划为?\s*(\d+)\s*卷|共\s*(\d+)\s*卷|volumes[:：]?\s*(\d+)|前\s*(\d+)\s*卷写完整/);
      if (vm) vols = parseInt(vm[1] || vm[2] || vm[3] || vm[4], 10) || 1;
      if (vols > 10) vols = 4;
      // V0.90 测试钩子：NOVEL_BOOK_OUTLINE_OBJ=1 → volumes 输出为对象形式（{1:{...},2:{...}}）且无 idx，
      // 验证书纲的对象→数组容错与建卷 idx 兜底（真实模型偶发该形态曾致"书级大纲解析失败"卡死）
      // V0.93.9：mock 分卷须满足结局闭环校验（倒二卷有反攻/破局动作、末卷有结算承诺），否则生成重试 3 次全败
      const volFor = i => {
        const isLast = i === vols - 1;
        const isSecondLast = i === vols - 2;
        return {
          title: `第${i + 1}卷`,
          goal: isLast ? '决战登顶，兑现誓言' : (isSecondLast ? '反攻破局' : '离开宗门'),
          summary: isLast ? '决战登顶，完成和解，圆满落幕' : (isSecondLast ? '发起反攻，收复失地' : '主角下山'),
        };
      };
      if (process.env.NOVEL_BOOK_OUTLINE_OBJ === '1') {
        const volObj = {};
        for (let i = 0; i < vols; i++) volObj[i + 1] = volFor(i);
        content = JSON.stringify({
          title: '剑起苍澜', logline: '废柴剑子逆袭之路', theme: '逆袭',
          worldview: '灵气复苏的青云大陆', protagonist: { name: '林晚', role: '废柴剑子', goal: '登顶剑道', flaw: '冲动', arc: '从废柴到剑神' },
          main_characters: [{ name: '苏晚', role: '青梅竹马', traits: '温柔' }],
          volumes: volObj,
          golden_first_chapters: '第一章立人设+钩子',
        });
      } else {
        content = JSON.stringify({
          title: '剑起苍澜', logline: '废柴剑子逆袭之路', theme: '逆袭',
          worldview: '灵气复苏的青云大陆', protagonist: { name: '林晚', role: '废柴剑子', goal: '登顶剑道', flaw: '冲动', arc: '从废柴到剑神' },
          main_characters: [{ name: '苏晚', role: '青梅竹马', traits: '温柔' }],
          volumes: Array.from({ length: vols }, (_, i) => ({ idx: i + 1, ...volFor(i) })),
          golden_first_chapters: '第一章立人设+钩子',
        });
      }
    } else {
      content = JSON.stringify({ ok: true });
    }
  } else {
    if (lastUser.includes('旧稿因推荐评估失败进入返工')
      && (lastUser.includes('【待替换场景窗口】') || lastUser.includes('【旧稿全文】'))) {
      // V0.100.14 专用返工 mock：返回场景替换窗口，不复制窗口外正文；旧提示仍兼容整章标记。
      const marker = lastUser.includes('【待替换场景窗口】') ? '【待替换场景窗口】' : '【旧稿全文】';
      const old = String(lastUser.split(marker).at(-1) || '')
        .split('再次确认：')[0]
        .trim();
 content = `主角把退路文书按进火盆。火舌卷上纸角时，他点出十个人冲向营门；守门军汉抬枪，身后的人已经没有退回原处的借口。\n\n${old}`;
    } else if (lastUser.includes('草稿续写')) {
      // 草稿续写分支：模拟"接着草稿写"（必须在'重写'之前，指令含"不要重写开头"字样）
      content = '雨还在下。她推开门，看见他站在巷口，手里握着那枚玉佩。\n\n（草稿续写）他上前一步，玉佩在她掌心微微发烫。\n\n"这东西……认得你。"她说。';
    } else if (lastUser.includes('继续续写当前场景')) {
      // V0.94.0：长度自愈续写分支——模拟"只续写后面部分"（不重述原文；safelyMergeContinuation
      // 会把复述型响应判为 replace/discard，mock 必须返回真正的新内容才能测到 append 路径）
      // V0.94.0b：结构差异化模板 + 指令哈希 key——与原稿句式不同（走 append）且跨章唯一
      content = mockContinuationProse(mockChapterKeyOf(lastUser));
    } else if (/请完整重写《|请修订《|请压缩重写当前场景|已被本地校验驳回|卷级审阅意见/.test(lastUser)) {
      // 修订 mock 按章稳定（书名+章名《》标题哈希）——同一章两轮修订返回同一文本，
      // validateChapterRewrite 判 unchanged 跳过（v041 卷审复检幂等依赖该语义）；
      // 跨章仍唯一（标题不同 → key 不同）。卷级修订指令无"重写"字样，靠独有词分流。
      // V0.97：分支条件收紧——此前 lastUser.includes('重写') 会被场景正文指令里的
      // SCENE_BOUNDARY_TEXT（"由下一场景重写一遍"）误命中，导致同章所有场景共用标题哈希
      // 返回逐字相同正文（章内复读防线的 mock 假阳性根因，v097 实证）。正常场景写必须
      // 落到 else 分支按整条指令哈希取唯一 key。指令经 assembleReviewMessages 并入 fixed
      // user（【当前任务】段），故用指令开头短语正则匹配而非 startsWith。
      content = mockSceneProse(mockRewriteKeyOf(lastUser), { prefix: '（修订版）' });
    } else {
      content = mockSceneProse(mockChapterKeyOf(lastUser));
    }
  }

  // 模拟流式：分片推送（V0.96：usage 同对象打 _streamed，与真实流式路径一致——防 router 终帧补推重复累加）
  const mockU = mockUsage(totalPrompt, content.length);
  if (stream) {
    const CHUNK = 12;
    for (let i = 0; i < content.length; i += CHUNK) {
      onDelta?.(content.slice(i, i + CHUNK));
    }
    mockU._streamed = true;
    onUsage?.(mockU);
  }
  return Promise.resolve({
    content,
    reasoningContent: '',
    finishReason: 'stop',
    model: opts.model,
    usage: mockU,
    durationMs: 10,
  });
}

function mockUsage(promptChars, completionChars) {
  const lastLen = Math.min(promptChars, 400);
  const promptTokens = Math.ceil(promptChars * 1.1);
  const missTokens = Math.ceil(lastLen * 1.1);
  return {
    promptTokens,
    completionTokens: Math.ceil(completionChars * 1.1),
    promptCacheHitTokens: Math.max(0, promptTokens - missTokens),
    promptCacheMissTokens: missTokens,
    reasoningTokens: 0,
  };
}
