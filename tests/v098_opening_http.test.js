import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v098-opening-http-'));
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

async function createBook(title) {
  const result = await json('POST', '/api/books', { title, genre: '历史', platform: '番茄', blurb: '孩子后来守住山河' });
  assert.equal(result.response.status, 200, result.raw);
  return result.body;
}

function seedOpening(book, suffix) {
  const db = new DatabaseSync(path.join(dataDir, 'novel.db'));
  const volumeId = `vol-v098-${suffix}`;
  const targetVolumeId = `vol-v098-target-${suffix}`;
  const chapterId = `ch-v098-${suffix}`;
  const sceneId = `sc-v098-${suffix}`;
  db.prepare(`INSERT INTO volumes (id,book_id,idx,title,goal,outline_json,status)
    VALUES (?,?,1,'第一卷','活下来','{}','planned')`).run(volumeId, book.id);
  db.prepare(`INSERT INTO volumes (id,book_id,idx,title,goal,outline_json,status)
    VALUES (?,?,2,'目标卷','兑现长期事件',?,'planned')`).run(targetVolumeId, book.id,
    JSON.stringify({ year: 1259, event_keys: ['historical:1259:test-event'] }));
  db.prepare(`INSERT INTO chapters (id,book_id,volume_id,idx,title,outline_json,status,word_count,created_at)
    VALUES (?,?,?,1,'灯影','{}','done',30,?)`).run(chapterId, book.id, volumeId, Date.now());
  db.prepare(`INSERT INTO scenes
    (id,chapter_id,idx,pov,location,beat,content,target_words,status)
 VALUES (?,?,1,'主角','庙会','军情逼近','天边压着一线暗红。主角先把弟弟护到身后。',1000,'done')`).run(sceneId, chapterId);
  db.close();
}

async function readSse(pathname, body = {}) {
  const response = await request('POST', pathname, body);
  const raw = await response.text();
  const events = [...raw.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)\n\n/g)]
    .map(match => ({ event: match[1], data: JSON.parse(match[2]) }));
  return { response, raw, events, done: events.find(item => item.event === 'done')?.data };
}

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NOVEL_DATA_DIR: dataDir, NOVEL_PORT: String(port), NOVEL_NO_OPEN: '1', NOVEL_MOCK_LLM: '1', NOVEL_FAULT: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  await waitForHealth();
  bookA = await createBook('甲开篇书');
  bookB = await createBook('乙开篇书');
  seedOpening(bookA, 'a');
  seedOpening(bookB, 'b');
});

after(async () => {
  if (child && child.exitCode === null) child.kill();
});

test('V0.98 真实 HTTP：创作宪章、锁与开篇诊断可往返', async () => {
  let result = await json('GET', `/api/books/${bookA.id}/story-promise`);
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.body.exists, false);
  result = await json('POST', `/api/books/${bookA.id}/story-promise/rebuild`, {});
  assert.equal(result.response.status, 200, result.raw);
  assert.ok(result.body.profile.primary_attraction_axis);
  result = await json('POST', `/api/books/${bookA.id}/story-promise/locks`, {
    locks: { 'texture.route': 'serious_immersive_history' },
  });
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.body.profile.texture.route, 'serious_immersive_history');
  result = await json('POST', `/api/books/${bookA.id}/opening-diagnosis/run`, {});
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.body.ok, true);
  result = await json('GET', `/api/books/${bookA.id}/opening-diagnosis`);
  assert.equal(result.body.exists, true);
  assert.equal(result.body.stale, false);
});

test('V0.98 真实 HTTP：生成、比较、选择、应用与发布差异形成闭环', async () => {
  const composed = await readSse(`/api/books/${bookA.id}/opening-compose`, { mode: 'repair' });
  assert.equal(composed.response.status, 200, composed.raw);
  assert.ok(composed.events.some(item => item.event === 'opening_stage'));
  assert.ok(composed.done?.candidates >= 2);
  let listed = await json('GET', `/api/books/${bookA.id}/opening-assets`);
  assert.equal(listed.response.status, 200, listed.raw);
  assert.ok(listed.body.assets.length >= 1, '至少生成一个前置层资产');
  assert.ok(listed.body.assets.some(item => item.kind === 'chapter1_cold_open'), '核心资产是远期高能楔子');
  assert.equal(listed.body.assets.some(item => item.kind === 'head_rewrite'), false, '健康开篇不做章内重写');
  const ids = listed.body.assets.map(item => item.id);
  const compared = await json('POST', `/api/books/${bookA.id}/opening-assets/compare`, { assetIds: ids });
  assert.equal(compared.response.status, 200, compared.raw);
  assert.match(compared.body.status, /winner|advisory/);
  const chosen = listed.body.assets.find(item => item.kind === 'chapter1_cold_open') || listed.body.assets[0];
  const audited = await json('POST', `/api/books/${bookA.id}/opening-assets/${chosen.id}/audit`, {});
  assert.equal(audited.response.status, 200, audited.raw);
  const selected = await json('POST', `/api/books/${bookA.id}/opening-assets/${chosen.id}/select`, {});
  assert.equal(selected.response.status, 200, selected.raw);
  const applied = await json('POST', `/api/books/${bookA.id}/opening-assets/${chosen.id}/apply`, {});
  assert.equal(applied.response.status, 200, applied.raw);
  assert.equal(applied.body.ok, true);
  const patch = await json('GET', `/api/books/${bookA.id}/opening-publish-patch`);
  assert.equal(patch.response.status, 200, patch.raw);
  assert.equal(patch.body.changed, true);
  assert.notEqual(patch.body.patch.before_hash, patch.body.patch.after_hash);
  const feedback = await json('POST', `/api/books/${bookA.id}/opening-feedback`, {
    metrics: [{ name: '首章读完', value: '后台所示数值', window: '修改后七天' }],
    comments: ['已去身份化：人物更容易辨认'], confounders: ['同期更换封面'],
  });
  assert.equal(feedback.response.status, 200, feedback.raw);
  assert.equal(feedback.body.event?.step, 'feedback_recorded');
  assert.equal(feedback.response.status, 200, feedback.raw);
  assert.equal(feedback.body.global_profile_changed, false);
  assert.ok(feedback.body.record.opening_version_hash);
});

test('V0.98 真实 HTTP：一个按钮可自动补齐宪章、诊断、候选与匿名比较', async () => {
  const result = await readSse(`/api/books/${bookB.id}/opening-compose`, {
    mode: 'repair', autoPrepare: true, autoCompare: true,
  });
  assert.equal(result.response.status, 200, result.raw);
  assert.ok(result.events.some(item => item.data.step === 'profiling'));
  assert.ok(result.events.some(item => item.data.step === 'diagnosing'));
  assert.ok(result.done?.comparison?.status);
  assert.ok(result.done?.candidates >= 2);
});

test('V0.98 真实 HTTP：尚未写第一章的新书也能一键生成并比较结构方案', async () => {
  const newBook = await createBook('丙新书开篇');
  const result = await readSse(`/api/books/${newBook.id}/opening-compose`, {
    mode: 'create', autoPrepare: true, autoCompare: true,
  });
  assert.equal(result.response.status, 200, result.raw);
  assert.ok(result.done?.candidates >= 3);
  assert.ok(result.done?.comparison?.status, '新书的临时候选也必须完成匿名比较');
});

test('V0.98 真实 HTTP：assetId 必须属于 URL 中的作品', async () => {
  await json('POST', `/api/books/${bookB.id}/story-promise/rebuild`, {});
  const composed = await readSse(`/api/books/${bookB.id}/opening-assets/generate`, { mode: 'repair' });
  assert.equal(composed.response.status, 200, composed.raw);
  const listed = await json('GET', `/api/books/${bookB.id}/opening-assets`);
  const foreign = listed.body.assets[0];
  assert.ok(foreign);
  for (const action of ['audit', 'select', 'apply', 'retire']) {
    const result = await json('POST', `/api/books/${bookA.id}/opening-assets/${foreign.id}/${action}`, {});
    assert.equal(result.response.status, 404, `${action}: ${result.raw}`);
    assert.equal(result.body.code, 'NOT_FOUND');
  }
});
