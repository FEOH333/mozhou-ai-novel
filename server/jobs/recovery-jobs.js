// server/jobs/recovery-jobs.js —— 推荐返工后台任务注册器：连接只是观察者，显式取消才中止。
'use strict';

import { randomUUID } from 'node:crypto';
import { acquireBookLease } from './book-lease.js';

const ACTIVE_STATUSES = new Set(['running', 'cancelling']);

function jobError(message, code, statusCode, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (detail) error.job = detail;
  return error;
}

function serializedError(error, fallbackCode = 'ERROR') {
  return {
    message: String(error?.message || error || '后台任务失败'),
    code: String(error?.code || fallbackCode),
  };
}

function isCancellation(error, signal) {
  return signal?.aborted === true
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'RECOVERY_CANCELLED';
}

/**
 * 创建一个进程内后台任务注册器。返工正文和检查点仍由数据库负责持久化；本注册器只负责：
 * - 一书一写任务互斥；
 * - 同一 active taskKey 幂等复用；
 * - 事件短期回放与观察者重连；
 * - 只有 cancel() 可以触发任务 AbortController。
 */
export function createRecoveryJobRegistry({
  acquireLeaseImpl = acquireBookLease,
  retentionMs = 6 * 60 * 60 * 1000,
  maxEvents = 1_000,
} = {}) {
  const jobs = new Map();
  const activeByBook = new Map();

  function prune(now = Date.now()) {
    for (const [id, job] of jobs) {
      if (ACTIVE_STATUSES.has(job.status)) continue;
      if (now - (job.finishedAt || job.updatedAt || job.startedAt) > retentionMs) jobs.delete(id);
    }
  }

  function publicJob(job, { reused = false } = {}) {
    if (!job) return null;
    return {
      id: job.id,
      bookId: job.bookId,
      taskKey: job.taskKey,
      type: job.type,
      runId: job.runId || null,
      status: job.status,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt || null,
      eventCount: job.events.length,
      lastEvent: job.events.at(-1) || null,
      output: job.output || null,
      error: job.error || null,
      reused,
    };
  }

  function requireJob(id, bookId = null) {
    prune();
    const job = jobs.get(String(id));
    if (!job || (bookId != null && String(job.bookId) !== String(bookId))) {
      throw jobError('返工后台任务不存在或已过期', 'RECOVERY_JOB_NOT_FOUND', 404);
    }
    return job;
  }

  function publish(job, event) {
    if (!event || typeof event !== 'object') return;
    if (event.runId && !job.runId) job.runId = String(event.runId);
    const record = Object.freeze({
      ...event,
      type: String(event.type || 'recovery_job_event'),
      jobId: job.id,
      sequence: ++job.sequence,
      emittedAt: Date.now(),
    });
    job.updatedAt = record.emittedAt;
    job.events.push(record);
    if (job.events.length > maxEvents) job.events.splice(0, job.events.length - maxEvents);
    for (const observer of [...job.observers]) {
      try { observer(record); } catch { /* 某个页面观察者异常不能伤害后台任务 */ }
    }
  }

  function finish(job, status, { output = null, error = null } = {}) {
    if (!ACTIVE_STATUSES.has(job.status)) return;
    job.status = status;
    job.output = output;
    job.error = error;
    job.finishedAt = Date.now();
    job.updatedAt = job.finishedAt;
    if (activeByBook.get(String(job.bookId)) === job.id) activeByBook.delete(String(job.bookId));
    try { job.lease.release(); } catch { /* 租约释放幂等 */ }

    if (status === 'completed') {
      publish(job, {
        type: 'recovery_job_completed',
        runId: job.runId,
        completion: output?.result?.completion || output?.completion || null,
      });
    } else if (status === 'cancelled') {
      publish(job, { type: 'recovery_job_cancelled', runId: job.runId, ...error });
    } else {
      publish(job, { type: 'recovery_job_failed', runId: job.runId, ...error });
    }
    job.resolveTerminal(publicJob(job));
  }

  function start({ bookId, taskKey, type, runId = null, task }) {
    if (!bookId) throw new TypeError('bookId is required');
    if (!taskKey) throw new TypeError('taskKey is required');
    if (typeof task !== 'function') throw new TypeError('task is required');
    prune();

    const bookKey = String(bookId);
    const activeId = activeByBook.get(bookKey);
    if (activeId) {
      const active = jobs.get(activeId);
      if (active && ACTIVE_STATUSES.has(active.status) && active.taskKey === String(taskKey)) {
        return publicJob(active, { reused: true });
      }
      if (active && ACTIVE_STATUSES.has(active.status)) {
        throw jobError(`本书已有 ${active.type} 任务在运行`, 'BOOK_BUSY', 409, publicJob(active));
      }
      activeByBook.delete(bookKey);
    }

    const lease = acquireLeaseImpl(bookId, type || 'recommendation-recovery');
    let resolveTerminal;
    const terminal = new Promise(resolve => { resolveTerminal = resolve; });
    const now = Date.now();
    const job = {
      id: randomUUID(), bookId, taskKey: String(taskKey), type: type || 'recommendation-recovery',
      runId: runId == null ? null : String(runId), status: 'running', startedAt: now, updatedAt: now,
      finishedAt: null, output: null, error: null, sequence: 0,
      controller: new AbortController(), lease, events: [], observers: new Set(), terminal, resolveTerminal,
    };
    jobs.set(job.id, job);
    activeByBook.set(bookKey, job.id);
    publish(job, { type: 'recovery_job_started', runId: job.runId, taskType: job.type });

    let taskPromise;
    try {
      // 立即调用，使任务在 start 返回前已经拥有独立 signal；它的 Promise 由注册器持有，
      // 不依赖任何 HTTP handler 或 SSE response 的生命周期。
      taskPromise = Promise.resolve(task({
        signal: job.controller.signal,
        emit: event => publish(job, event),
        jobId: job.id,
      }));
    } catch (error) {
      taskPromise = Promise.reject(error);
    }
    job.taskPromise = taskPromise;
    taskPromise.then(
      output => {
        // 任务 fulfilled 说明领域层已经越过自己的取消检查并成功完成；尤其正文原子事务
        // 提交后不可撤回。此时即使取消信号在最后瞬间到达，也必须如实记 completed，
        // 不能让 UI 声称“旧稿保留”而数据库实际已经换版。真正取消由 rejection 分支认定。
        finish(job, 'completed', { output });
      },
      error => {
        if (isCancellation(error, job.controller.signal)) {
          finish(job, 'cancelled', { error: { message: '用户已显式取消返工', code: 'RECOVERY_CANCELLED' } });
        } else {
          finish(job, 'failed', { error: serializedError(error) });
        }
      },
    );
    // 所有失败都已经转成任务终态，不向未观察的 Promise 泄漏 unhandled rejection。
    taskPromise.catch(() => {});
    return publicJob(job);
  }

  function subscribe(id, observer, { replay = true, bookId = null } = {}) {
    if (typeof observer !== 'function') throw new TypeError('observer is required');
    const job = requireJob(id, bookId);
    job.observers.add(observer);
    if (replay) {
      for (const event of job.events) {
        try { observer(event); } catch { /* 观察者自己负责展示异常 */ }
      }
    }
    let detached = false;
    return () => {
      if (detached) return false;
      detached = true;
      return job.observers.delete(observer);
    };
  }

  function cancel(id, { bookId = null } = {}) {
    const job = requireJob(id, bookId);
    if (!ACTIVE_STATUSES.has(job.status)) return publicJob(job);
    if (job.status !== 'cancelling') {
      job.status = 'cancelling';
      job.updatedAt = Date.now();
      publish(job, { type: 'recovery_job_cancelling', runId: job.runId });
      try { job.controller.abort(jobError('用户已显式取消返工', 'RECOVERY_CANCELLED', 499)); } catch { /* 幂等 */ }
    }
    return publicJob(job);
  }

  return Object.freeze({
    start,
    subscribe,
    cancel,
    wait(id, options = {}) { return requireJob(id, options.bookId || null).terminal; },
    get(id, options = {}) { return publicJob(requireJob(id, options.bookId || null)); },
    findActiveByBook(bookId) {
      prune();
      const id = activeByBook.get(String(bookId));
      const job = id ? jobs.get(id) : null;
      return job && ACTIVE_STATUSES.has(job.status) ? publicJob(job) : null;
    },
    listActive() {
      prune();
      return [...jobs.values()]
        .filter(job => ACTIVE_STATUSES.has(job.status))
        .map(job => publicJob(job));
    },
    clearForTests() {
      for (const job of jobs.values()) {
        if (ACTIVE_STATUSES.has(job.status)) {
          try { job.controller.abort(); } catch { /* ignore */ }
          try { job.lease.release(); } catch { /* ignore */ }
        }
      }
      activeByBook.clear();
      jobs.clear();
    },
  });
}

/** 服务器进程共享的推荐返工后台任务表。 */
export const recoveryJobs = createRecoveryJobRegistry();

/** 服务器进程共享的自动创作 / 全书打磨后台任务表（与返工同构：断线只断观察）。 */
export const writeJobs = createRecoveryJobRegistry();
