import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v099-release-http-'));
let port;
let base;
let child;
let bookA;
let bookB;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(error => error ? reject(error) : resolve(value));
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
}

async function request(method, pathname, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json', Origin: base };
    options.body = JSON.stringify(body);
  }
  return fetch(`${base}${pathname}`, options);
}

async function json(method, pathname, body) {
  const response = await request(method, pathname, body);
  const raw = await response.text();
  return { response, body: raw ? JSON.parse(raw) : null, raw };
}

async function readSse(pathname, body = {}) {
  const response = await request('POST', pathname, body);
  const raw = await response.text();
  const events = [...raw.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)\n\n/g)]
    .map(match => ({ event: match[1], data: JSON.parse(match[2]) }));
  return { response, raw, events, done: events.find(item => item.event === 'done')?.data };
}

async function createBook(title) {
  const result = await json('POST', '/api/books', { title, genre: '历史', platform: '番茄', blurb: '乱世里守住身边人' });
  assert.equal(result.response.status, 200, result.raw);
  return result.body;
}

function seedChapter(book, idx = 7) {
  const db = new DatabaseSync(path.join(dataDir, 'novel.db'));
  const volumeId = `vol-v099-${book.id}`;
  const chapterId = `ch-v099-${book.id}`;
  const sceneId = `sc-v099-${book.id}`;
  db.prepare(`INSERT INTO volumes (id,book_id,idx,title,goal,outline_json,status)
    VALUES (?,?,1,'第一卷','主角作出选择','{}','planned')`).run(volumeId, book.id);
  db.prepare(`INSERT INTO chapters (id,book_id,volume_id,idx,title,outline_json,status,word_count,created_at)
    VALUES (?,?,?,?,?,'{}','done',80,?)`).run(chapterId, book.id, volumeId, idx, `第${idx}章 空转`, Date.now());
  db.prepare(`INSERT INTO scenes
    (id,chapter_id,idx,pov,location,beat,content,target_words,status)
 VALUES (?,?,1,'主角','军营','必须作出选择',?,80,'done')`).run(
    sceneId, chapterId,
 '众人围着火盆反复商量，天色从黄昏拖到深夜。主角始终没有作出决定，局势仍停在原处。',
  );
  db.close();
}

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NOVEL_DATA_DIR: dataDir, NOVEL_PORT: String(port),
      NOVEL_NO_OPEN: '1', NOVEL_MOCK_LLM: '1', NOVEL_FAULT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  await waitForHealth();
  bookA = await createBook('甲推流书');
  bookB = await createBook('乙推流书');
  seedChapter(bookA, 7);
});

after(() => {
  if (child && child.exitCode === null) child.kill();
});

test('V0.99 HTTP：发布档案、审核历史与数据快照完整往返', async () => {
  let result = await json('GET', `/api/books/${bookA.id}/publication`);
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.body.profile, null);

  result = await json('PUT', `/api/books/${bookA.id}/publication`, {
    workUrl: 'https://evil.example/page/7673157174960327705', recommendationStage: 'failed', remainingAttempts: 2,
  });
  assert.equal(result.response.status, 400, result.raw);
  assert.match(result.body.error, /番茄作品链接/);

  result = await json('PUT', `/api/books/${bookA.id}/publication`, {
    workUrl: 'https://fanqienovel.com/page/7673157174960327705',
    recommendationStage: 'failed', remainingAttempts: 2,
    editorFeedback: '当前内容未达推荐标准，前20章不合格',
    authorDiagnosis: '前1—6章或勉强可用，第7—20章越来越水', suspectedTurnChapter: 7,
    publishedChapterCount: 7,
  });
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.body.profile.external_book_id, '7673157174960327705');
  assert.equal(result.body.profile.recommendation_stage, 'failed');

  result = await json('POST', `/api/books/${bookA.id}/publication/reviews`, {
    stage: 'failed', remainingAttempts: 2, feedback: '前20章整体质量不合格', source: 'platform_notice',
  });
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.body.review.stage, 'failed');

  result = await json('POST', `/api/books/${bookA.id}/publication/metrics`, {
    exposureStatus: 'not_exposed', impressions: 0, readers: 0, bookshelfAdds: 0, note: '推流前',
  });
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.body.metric.readers, 0);
  result = await json('POST', `/api/books/${bookA.id}/publication/metrics`, {
    exposureStatus: 'validation', readers: -1,
  });
  assert.equal(result.response.status, 400, result.raw);

  result = await json('GET', `/api/books/${bookA.id}/publication`);
  assert.equal(result.body.reviews.length, 1);
  assert.equal(result.body.metrics.length, 1);
  assert.equal(result.body.metrics[0].exposure_status, 'not_exposed');
});

test('V0.99 HTTP：推荐返工先诊断，运行资源不可跨作品访问', async () => {
  const diagnosed = await readSse(`/api/books/${bookA.id}/recommendation-recovery/diagnose`, {
    startChapter: 7, endChapter: 7,
  });
  assert.equal(diagnosed.response.status, 200, diagnosed.raw);
  assert.ok(diagnosed.events.some(item => item.event === 'recovery_diagnosing'));
  assert.equal(diagnosed.done?.run?.status, 'planned');
  assert.equal(diagnosed.done?.run?.quality_curve?.[0]?.chapter, 7);
  assert.equal(diagnosed.done?.run?.work_orders?.[0]?.action, 'rebuild');
  const runId = diagnosed.done.run.id;

  const executed = await readSse(`/api/books/${bookA.id}/recommendation-recovery/${runId}/execute`, {
    confirmedPublishedRewrite: true,
  });
  assert.equal(executed.response.status, 200, executed.raw);
  assert.ok(executed.events.some(item => item.event === 'recovery_comparing'));
  assert.equal(executed.done?.run?.status, 'completed');
  assert.deepEqual(executed.done?.result?.applied?.map(item => item.chapter), [7]);

  const dashboard = await json('GET', `/api/books/${bookA.id}/publication`);
  assert.deepEqual(dashboard.body.profile.pending_sync_chapters, [7]);

  const foreign = await readSse(`/api/books/${bookB.id}/recommendation-recovery/${runId}/execute`, {
    confirmedPublishedRewrite: true,
  });
  assert.equal(foreign.response.status, 404, foreign.raw);
});

test('V0.99 HTTP：同步与待同步确认错误可见，不伪造成功', async () => {
  let result = await json('POST', `/api/books/${bookB.id}/publication/sync`, {});
  assert.equal(result.response.status, 400, result.raw);
  assert.match(result.body.error, /先填写番茄作品链接/);

  result = await json('POST', `/api/books/${bookA.id}/publication/pending-sync/confirm`, { chapters: [7] });
  assert.equal(result.response.status, 200, result.raw);
  assert.deepEqual(result.body.profile.pending_sync_chapters, []);
});
