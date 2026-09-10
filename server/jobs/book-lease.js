// server/jobs/book-lease.js —— 本进程内按作品互斥长耗时写任务
'use strict';

import { randomUUID } from 'node:crypto';

const active = new Map();

export function getActiveBookJob(bookId) {
  return active.get(bookId) || null;
}

export function acquireBookLease(bookId, type) {
  if (!bookId) throw new TypeError('bookId is required');
  const current = active.get(bookId);
  if (current) {
    const error = new Error(`本书已有 ${current.type} 任务在运行`);
    error.code = 'BOOK_BUSY';
    error.statusCode = 409;
    error.job = current;
    throw error;
  }

  const job = Object.freeze({
    id: randomUUID(),
    bookId,
    type: type || 'write',
    startedAt: Date.now(),
  });
  active.set(bookId, job);
  let released = false;
  return {
    job,
    release() {
      if (released) return false;
      released = true;
      if (active.get(bookId)?.id !== job.id) return false;
      active.delete(bookId);
      return true;
    },
  };
}

/** 仅供隔离测试清理模块内状态。 */
export function clearBookLeasesForTests() {
  active.clear();
}
