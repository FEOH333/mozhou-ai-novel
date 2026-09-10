// server/util/oplog.js —— V0.28 操作日志（API/LLM/流程三类自动记录 + 容量自动清理）
'use strict';
import * as store from '../db/store.js';

const DEFAULT_MAX = 2000;

/** 记录一条操作日志（自动清理超出上限的最旧记录） */
export function logOp({ category = 'api', level = 'info', op, detail = '', bookId, durationMs, result = 'ok', max = DEFAULT_MAX } = {}) {
  try {
    const now = Date.now();
    store.operationLogs.add({ ts: now, category, level, op, detail: String(detail).slice(0, 500), bookId: bookId || null, durationMs: durationMs ?? null, result });
    // 容量自动清理（保留最近 max 条）
    const total = store.operationLogs.count();
    if (total > max) {
      store.operationLogs.trimOldest(total - max);
    }
  } catch (e) {
    // 日志失败不影响主流程
    console.error('[oplog] 记录失败:', e.message);
  }
}

/** API 请求日志（index.js 请求级钩子用） */
export function logApi({ method, path, status, durationMs, bookId, detail = '' }) {
  const ok = status < 400;
  logOp({
    category: 'api',
    level: ok ? 'info' : (status >= 500 ? 'error' : 'warn'),
    op: `${method} ${path}`,
    detail,
    bookId,
    durationMs,
    result: ok ? 'ok' : `http_${status}`,
  });
}

/** LLM 调用日志（router.js 每次 runTask 用） */
export function logLlm({ task, model, durationMs, ok, retries = 0, bookId, detail = '' }) {
  logOp({
    category: 'llm',
    level: ok ? 'info' : 'error',
    op: task || 'llm_call',
    detail: detail || `model=${model || ''}${retries ? ` retries=${retries}` : ''}`,
    bookId,
    durationMs,
    result: ok ? 'ok' : 'error',
  });
}

/** 流程事件日志（pilot/pipeline/polish 关键点用） */
export function logFlow({ op, level = 'info', detail = '', bookId, durationMs, result = 'ok' }) {
  logOp({ category: 'flow', level, op, detail, bookId, durationMs, result });
}
