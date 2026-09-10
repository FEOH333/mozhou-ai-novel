// server/llm/resilience.js —— V0.21 API 韧性层：熔断器（按服务商独立）+ 健康度监控
// 设计：连续失败达到阈值 → OPEN（快速失败，不发起网络请求，防止对故障服务商疯狂重试烧钱）；
//       OPEN 到期后 HALF_OPEN 放行一个探针请求，成功即恢复（CLOSED），失败则再次 OPEN 且退避翻倍。
'use strict';

// ---------- 熔断器 ----------
const breakers = new Map(); // key: `${baseUrl}|${apiKey}` → { state, failCount, openUntil, backoffMs }

function breakerKey(baseUrl, apiKey) {
  return `${baseUrl}|${apiKey || ''}`;
}

/**
 * 请求前检查熔断状态。
 * @returns {boolean} true=放行；false=熔断中（调用方应快速失败）
 */
export function circuitAllowed(baseUrl, apiKey, cfg = {}) {
  const b = breakers.get(breakerKey(baseUrl, apiKey));
  if (!b || b.state !== 'OPEN') return true;
  if (Date.now() >= b.openUntil) {
    // HALF_OPEN：到期放行一个探针请求
    b.state = 'HALF_OPEN';
    return true;
  }
  return false;
}

/** 熔断剩余毫秒（供状态展示）；无熔断返回 0 */
export function circuitRemainingMs(baseUrl, apiKey) {
  const b = breakers.get(breakerKey(baseUrl, apiKey));
  if (!b || b.state !== 'OPEN') return 0;
  return Math.max(0, b.openUntil - Date.now());
}

/** 请求成功：复位连续失败计数 */
export function reportSuccess(baseUrl, apiKey) {
  const k = breakerKey(baseUrl, apiKey);
  const b = breakers.get(k);
  if (b) { b.state = 'CLOSED'; b.failCount = 0; b.backoffMs = 0; }
}

/**
 * 请求失败：累计连续失败，达到阈值 → OPEN。
 * @returns {boolean} true=本次失败触发了熔断（调用方应提示）
 */
export function reportFailure(baseUrl, apiKey, cfg = {}) {
  const k = breakerKey(baseUrl, apiKey);
  const threshold = cfg.threshold ?? 3;
  const openMs = cfg.openMs ?? 60000;
  const maxOpenMs = cfg.maxOpenMs ?? 600000;
  let b = breakers.get(k);
  if (!b) {
    b = { state: 'CLOSED', failCount: 0, backoffMs: 0, openUntil: 0 };
    breakers.set(k, b);
  }
  b.failCount++;
  if (b.state === 'HALF_OPEN') {
    // 探针失败：立即再次熔断，退避翻倍
    b.backoffMs = Math.min(maxOpenMs, (b.backoffMs || openMs) * 2);
    b.openUntil = Date.now() + b.backoffMs;
    b.state = 'OPEN';
    return true;
  }
  if (b.failCount >= threshold) {
    b.backoffMs = b.backoffMs ? Math.min(maxOpenMs, b.backoffMs * 2) : openMs;
    b.openUntil = Date.now() + b.backoffMs;
    b.state = 'OPEN';
    return true;
  }
  return false;
}

/** 熔断器状态快照（前端展示） */
export function circuitSnapshot() {
  const out = [];
  for (const [k, b] of breakers) {
    if (b.state !== 'CLOSED' || b.failCount > 0) {
      const [baseUrl, apiKey] = k.split('|');
      out.push({
        provider: baseUrl.replace(/^https?:\/\//, '').split('.')[0],
        state: b.state,
        failCount: b.failCount,
        remainingMs: b.state === 'OPEN' ? Math.max(0, b.openUntil - Date.now()) : 0,
      });
    }
  }
  return out;
}

/** 仅供测试：重置全部熔断状态 */
export function resetCircuits() { breakers.clear(); }

// ---------- 健康度监控（内存环形缓冲，最近 200 条） ----------
const healthLog = [];
const HEALTH_MAX = 200;

/**
 * 记录一次 LLM 调用结果。
 * @param {object} rec { ok, code, durationMs, provider, model, retries }
 */
export function recordHealth(rec) {
  healthLog.push({ ts: Date.now(), ...rec });
  if (healthLog.length > HEALTH_MAX) healthLog.splice(0, healthLog.length - HEALTH_MAX);
}

/** 健康度统计快照：成功率 / 平均耗时 / 最近故障 / 当前熔断 */
export function healthSnapshot() {
  const n = healthLog.length;
  const ok = healthLog.filter(r => r.ok).length;
  const avg = n ? Math.round(healthLog.reduce((s, r) => s + (r.durationMs || 0), 0) / n) : 0;
  const lastErrors = [...healthLog].reverse().filter(r => !r.ok).slice(0, 5).map(r => ({
    ts: r.ts, code: r.code, provider: r.provider, model: r.model,
  }));
  const recent = healthLog.slice(-20);
  const recentAvg = recent.length ? Math.round(recent.reduce((s, r) => s + (r.durationMs || 0), 0) / recent.length) : 0;
  const recentOk = recent.filter(r => r.ok).length;
  return {
    total: n,
    ok,
    fail: n - ok,
    successRate: n ? Math.round((ok / n) * 1000) / 10 : null,
    avgDurationMs: avg,
    recentAvgDurationMs: recentAvg,
    recentSuccessRate: recent.length ? Math.round((recentOk / recent.length) * 1000) / 10 : null,
    lastErrors,
    circuits: circuitSnapshot(),
  };
}

/** 仅供测试：清空健康度 */
export function resetHealth() { healthLog.length = 0; }
