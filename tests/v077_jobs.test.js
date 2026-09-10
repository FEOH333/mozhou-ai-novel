// V0.77 同书长任务互斥租约
import { test } from 'node:test';
import assert from 'node:assert/strict';

const jobs = await import('../server/jobs/book-lease.js');

test('同一本书同时只能持有一个写作租约', () => {
  jobs.clearBookLeasesForTests();
  const first = jobs.acquireBookLease('book-a', 'pilot');
  assert.equal(jobs.getActiveBookJob('book-a').type, 'pilot');

  assert.throws(
    () => jobs.acquireBookLease('book-a', 'flow'),
    error => error?.code === 'BOOK_BUSY' && error?.statusCode === 409 && error?.job?.type === 'pilot',
  );

  first.release();
  const next = jobs.acquireBookLease('book-a', 'flow');
  assert.equal(next.job.type, 'flow');
  next.release();
  assert.equal(jobs.getActiveBookJob('book-a'), null);
});

test('不同作品可以并行，release 幂等且旧租约不能释放新任务', () => {
  jobs.clearBookLeasesForTests();
  const a = jobs.acquireBookLease('book-a', 'pilot');
  const b = jobs.acquireBookLease('book-b', 'polish');
  assert.equal(jobs.getActiveBookJob('book-a').type, 'pilot');
  assert.equal(jobs.getActiveBookJob('book-b').type, 'polish');

  a.release();
  const a2 = jobs.acquireBookLease('book-a', 'flow');
  a.release();
  assert.equal(jobs.getActiveBookJob('book-a').id, a2.job.id);

  a2.release();
  b.release();
});
