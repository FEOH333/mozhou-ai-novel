// V0.100.7：推荐返工必须属于服务端任务，而不是某一条浏览器 SSE 连接。
'use strict';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearBookLeasesForTests, getActiveBookJob } from '../server/jobs/book-lease.js';
import { createRecoveryJobRegistry } from '../server/jobs/recovery-jobs.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    signal.addEventListener('abort', () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

afterEach(() => clearBookLeasesForTests());

test('V0.100.7 浏览器观察者断开只解除订阅，不得取消服务端返工', async () => {
  const registry = createRecoveryJobRegistry({ retentionMs: 1_000 });
  const releaseTask = deferred();
  let taskSignal;
  const started = registry.start({
    bookId: 'book-observer', taskKey: 'execute:run-1', type: 'recommendation-recovery-execute', runId: 'run-1',
    task: async ({ signal, emit }) => {
      taskSignal = signal;
      emit({ type: 'recovery_rewriting', chapter: 8 });
      await releaseTask.promise;
      return { result: { completion: 'complete', applied: [8] }, run: { id: 'run-1' } };
    },
  });

  const firstObserver = [];
  const detach = registry.subscribe(started.id, event => firstObserver.push(event));
  detach();
  assert.equal(taskSignal.aborted, false, '断开 SSE 观察者不能触发后台任务的 AbortController');
  assert.equal(registry.get(started.id).status, 'running');
  assert.equal(getActiveBookJob('book-observer')?.type, 'recommendation-recovery-execute');

  const reconnected = [];
  const detachReconnect = registry.subscribe(started.id, event => reconnected.push(event), { replay: true });
  assert.ok(reconnected.some(event => event.type === 'recovery_rewriting' && event.chapter === 8), '重连应回放断线前事件');
  releaseTask.resolve();
  const terminal = await registry.wait(started.id);
  detachReconnect();

  assert.equal(terminal.status, 'completed');
  assert.deepEqual(terminal.output.result.applied, [8]);
  assert.equal(taskSignal.aborted, false);
  assert.equal(getActiveBookJob('book-observer'), null, '任务完成后必须释放作品互斥租约');
});

test('V0.100.7 只有显式取消才中止后台任务并留下 cancelled 终态', async () => {
  const registry = createRecoveryJobRegistry({ retentionMs: 1_000 });
  const started = registry.start({
    bookId: 'book-cancel', taskKey: 'execute:run-2', type: 'recommendation-recovery-execute', runId: 'run-2',
    task: async ({ signal, emit }) => {
      emit({ type: 'recovery_rewriting', chapter: 18 });
      await waitForAbort(signal);
      return { impossible: true };
    },
  });

  const cancelling = registry.cancel(started.id, { bookId: 'book-cancel' });
  assert.equal(cancelling.status, 'cancelling');
  const terminal = await registry.wait(started.id);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.error?.code, 'RECOVERY_CANCELLED');
  assert.equal(getActiveBookJob('book-cancel'), null);
});

test('V0.100.7 原子提交已经成功返回时，迟到的取消信号不能把成功伪报为 cancelled', async () => {
  const registry = createRecoveryJobRegistry({ retentionMs: 1_000 });
  const irreversibleCommit = deferred();
  const started = registry.start({
    bookId: 'book-late-cancel', taskKey: 'execute:run-committed',
    type: 'recommendation-recovery-execute', runId: 'run-committed',
    task: async () => {
      // 模拟已经跨过原子提交边界：此时收到 abort 也不能撤回已提交事务，只能如实返回成功。
      await irreversibleCommit.promise;
      return { result: { completion: 'complete', applied: [20] }, run: { id: 'run-committed', status: 'completed' } };
    },
  });

  registry.cancel(started.id, { bookId: 'book-late-cancel' });
  irreversibleCommit.resolve();
  const terminal = await registry.wait(started.id);

  assert.equal(terminal.status, 'completed', 'fulfilled 的原子提交结果必须优先于迟到的 aborted 标志');
  assert.deepEqual(terminal.output.result.applied, [20]);
});

test('V0.100.7 同一运行重复提交必须幂等，同书不同运行必须互斥', async () => {
  const registry = createRecoveryJobRegistry({ retentionMs: 1_000 });
  const gate = deferred();
  let calls = 0;
  const first = registry.start({
    bookId: 'book-idempotent', taskKey: 'execute:run-3', type: 'recommendation-recovery-execute', runId: 'run-3',
    task: async () => { calls++; await gate.promise; return { result: { completion: 'complete' } }; },
  });
  const same = registry.start({
    bookId: 'book-idempotent', taskKey: 'execute:run-3', type: 'recommendation-recovery-execute', runId: 'run-3',
    task: async () => { calls++; return { duplicate: true }; },
  });
  assert.equal(same.id, first.id);
  assert.equal(same.reused, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, '同一运行只能启动一份底层任务');

  assert.throws(() => registry.start({
    bookId: 'book-idempotent', taskKey: 'execute:run-4', type: 'recommendation-recovery-execute', runId: 'run-4',
    task: async () => ({}),
  }), error => error?.code === 'BOOK_BUSY' && error?.statusCode === 409);

  gate.resolve();
  await registry.wait(first.id);
});

test('V0.100.7 任务失败要保留可重连的错误码与事件，不得退化为 fetch failed', async () => {
  const registry = createRecoveryJobRegistry({ retentionMs: 1_000 });
  const started = registry.start({
    bookId: 'book-failed', taskKey: 'diagnose:1-20', type: 'recommendation-recovery-diagnose',
    task: async ({ emit }) => {
      emit({ type: 'recovery_diagnosing', from: 1, to: 5 });
      const error = new Error('模型连续连接失败，检查点已保存');
      error.code = 'NETWORK_ERROR';
      throw error;
    },
  });
  const terminal = await registry.wait(started.id);
  const replay = [];
  registry.subscribe(started.id, event => replay.push(event), { replay: true })();
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error.code, 'NETWORK_ERROR');
  assert.match(terminal.error.message, /检查点已保存/);
  assert.ok(replay.some(event => event.type === 'recovery_job_failed' && event.code === 'NETWORK_ERROR'));
});
