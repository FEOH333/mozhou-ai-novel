// V0.77 真实 HTTP 回归：书级嵌套资源必须校验归属，静态 HEAD 不发送实体正文
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-owned-'));
let port;
let base;
let child;
let bookA;
let bookB;
let volumeB;
let chapterA;
let chapterB;
let sceneB;
let snapshotB;
let characterB;
let locationB;
let foreshadowB;
let hookB;
let arcB;
let worldbookB;
let factB;
let pendingBId;
let conflictBId;

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
    } catch { /* server is still starting */ }
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

async function create(pathname, body) {
  const result = await json('POST', pathname, body);
  assert.equal(result.response.status, 200, `${pathname}: ${result.raw}`);
  return result.body;
}

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NOVEL_DATA_DIR: dataDir,
      NOVEL_PORT: String(port),
      NOVEL_NO_OPEN: '1',
      NOVEL_MOCK_LLM: '1',
      NOVEL_FAULT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await waitForHealth();

  bookA = await create('/api/books', { title: '甲书', genre: '玄幻' });
  bookB = await create('/api/books', { title: '乙书', genre: '玄幻' });
  volumeB = await create(`/api/books/${bookB.id}/volumes`, { title: '乙卷' });
  chapterA = await create(`/api/books/${bookA.id}/chapters`, { title: '甲章' });
  chapterB = await create(`/api/books/${bookB.id}/chapters`, { title: '乙章', volumeId: volumeB.id });
  const db = new DatabaseSync(path.join(dataDir, 'novel.db'));
  db.prepare(`INSERT INTO scenes
    (id, chapter_id, idx, pov, location, beat, content, target_words, status)
    VALUES (?, ?, 1, '', '', '', '乙正文', 1000, 'done')`).run('sc-v077-owned-b', chapterB.id);
  const pending = db.prepare(`INSERT INTO pending_entities
    (book_id, name, context, source_chapter, status, dup_count, created_at)
    VALUES (?, '乙待登记', '', ?, 'pending', 1, ?)`).run(bookB.id, chapterB.id, Date.now());
  pendingBId = String(pending.lastInsertRowid);
  conflictBId = 'cfl-v077-owned-b';
  db.prepare(`INSERT INTO conflicts
    (id, book_id, chapter_id, type, quote, issue, resolution, created_at)
    VALUES (?, ?, ?, '设定冲突', '', '乙冲突', 'open', ?)`).run(conflictBId, bookB.id, chapterB.id, Date.now());
  db.close();
  const chapterDetail = await json('GET', `/api/books/${bookB.id}/chapters/${chapterB.id}`);
  sceneB = chapterDetail.body.scenes[0];
  assert.ok(sceneB?.id, 'mock outline should create at least one scene');

  snapshotB = await create(`/api/books/${bookB.id}/snapshots`, { label: '乙快照' });
  characterB = await create(`/api/books/${bookB.id}/characters`, { name: '乙角色' });
  locationB = await create(`/api/books/${bookB.id}/locations`, { name: '乙地点' });
  foreshadowB = await create(`/api/books/${bookB.id}/foreshadows`, { desc: '乙伏笔' });
  hookB = await create(`/api/books/${bookB.id}/hooks`, { desc: '乙钩子', plantedChapter: 1 });
  arcB = await create(`/api/books/${bookB.id}/arcs`, { name: '乙弧线', openedChapter: 1 });
  worldbookB = await create(`/api/books/${bookB.id}/worldbook`, { keywords: ['乙'], content: '乙词条' });
  factB = await create(`/api/books/${bookB.id}/facts`, {
    subject: '乙主角', predicate: '状态', object: '正常', sourceChapter: chapterB.id,
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('跨书 volume/chapter/scene 读写删除与 SSE 生成均返回 404，原数据不变', async () => {
  const attacks = [
    ['PATCH', `/api/books/${bookA.id}/volumes/${volumeB.id}`, { title: '被篡改卷' }],
    ['POST', `/api/books/${bookA.id}/volumes/${volumeB.id}/generate`, {}],
    ['GET', `/api/books/${bookA.id}/chapters/${chapterB.id}`],
    ['PATCH', `/api/books/${bookA.id}/chapters/${chapterB.id}`, { title: '被篡改章' }],
    ['POST', `/api/books/${bookA.id}/chapters/${chapterB.id}/outline`, {}],
    ['PATCH', `/api/books/${bookA.id}/scenes/${sceneB.id}`, { content: '被篡改正文' }],
    ['POST', `/api/books/${bookA.id}/pleasure/audit`, { chapterId: chapterB.id }],
  ];
  for (const [method, pathname, body] of attacks) {
    const result = await request(method, pathname, body);
    assert.equal(result.status, 404, `${method} ${pathname}`);
    await result.text();
  }

  const foreignVolumeCreate = await request('POST', `/api/books/${bookA.id}/chapters`, {
    title: '错误归卷', volumeId: volumeB.id,
  });
  assert.equal(foreignVolumeCreate.status, 404);

  const foreignSceneWrite = await request('POST', `/api/books/${bookA.id}/chapters/${chapterA.id}/write`, {
    sceneId: sceneB.id,
  });
  assert.equal(foreignSceneWrite.status, 404);
  await foreignSceneWrite.text();

  const volume = (await json('GET', `/api/books/${bookB.id}/volumes`)).body.find(v => v.id === volumeB.id);
  const chapter = (await json('GET', `/api/books/${bookB.id}/chapters/${chapterB.id}`)).body;
  assert.equal(volume.title, '乙卷');
  assert.equal(chapter.title, '乙章');
  assert.notEqual(chapter.scenes.find(s => s.id === sceneB.id).content, '被篡改正文');

  for (const [method, pathname] of [
    ['DELETE', `/api/books/${bookA.id}/volumes/${volumeB.id}`],
    ['DELETE', `/api/books/${bookA.id}/chapters/${chapterB.id}`],
  ]) {
    const result = await request(method, pathname);
    assert.equal(result.status, 404, `${method} ${pathname}`);
  }
  assert.ok((await json('GET', `/api/books/${bookB.id}/volumes`)).body.some(v => v.id === volumeB.id));
  assert.equal((await json('GET', `/api/books/${bookB.id}/chapters/${chapterB.id}`)).response.status, 200);
});

test('跨书事实/待登记/冲突状态变更返回 404 且源记录不变', async () => {
  for (const [pathname, body] of [
    [`/api/books/${bookA.id}/facts/${factB.id}/resolve`, { status: 'superseded' }],
    [`/api/books/${bookA.id}/pending/${pendingBId}/resolve`, { status: 'archived' }],
    [`/api/books/${bookA.id}/conflicts/${conflictBId}/resolve`, { resolution: 'accepted' }],
  ]) {
    const response = await request('POST', pathname, body);
    assert.equal(response.status, 404, pathname);
  }

  const book = (await json('GET', `/api/books/${bookB.id}`)).body;
  assert.ok(book.facts.some(row => row.id === factB.id && row.status === 'active'));
  assert.ok(book.pending.some(row => String(row.id) === pendingBId && row.status === 'pending'));
  assert.ok(book.conflicts.some(row => row.id === conflictBId && row.resolution === 'open'));
});

test('跨书 snapshot restore/delete 返回 404，不覆盖目标书也不删除源快照', async () => {
  const beforeA = (await json('GET', `/api/books/${bookA.id}`)).body.chapters.map(c => [c.id, c.title, c.status]);
  for (const [method, pathname, body] of [
    ['POST', `/api/books/${bookA.id}/snapshots/${snapshotB.id}/restore`, {}],
    ['DELETE', `/api/books/${bookA.id}/snapshots/${snapshotB.id}`],
  ]) {
    const result = await request(method, pathname, body);
    assert.equal(result.status, 404, `${method} ${pathname}`);
  }
  const afterA = (await json('GET', `/api/books/${bookA.id}`)).body.chapters.map(c => [c.id, c.title, c.status]);
  assert.deepEqual(afterA, beforeA);
  assert.ok((await json('GET', `/api/books/${bookB.id}/snapshots`)).body.some(s => s.id === snapshotB.id));
});

test('跨书角色/地点/伏笔/钩子/弧线/世界书修改删除均返回 404 且源记录保留', async () => {
  const resources = [
    ['characters', characterB.id, { name: '被篡改角色' }],
    ['locations', locationB.id, { name: '被篡改地点' }],
    ['foreshadows', foreshadowB.id, { desc: '被篡改伏笔' }],
    ['hooks', hookB.id, { desc: '被篡改钩子' }],
    ['arcs', arcB.id, { name: '被篡改弧线' }],
    ['worldbook', worldbookB.id, { content: '被篡改词条' }],
  ];
  for (const [kind, id, patch] of resources) {
    let response = await request('PATCH', `/api/books/${bookA.id}/${kind}/${id}`, patch);
    assert.equal(response.status, 404, `PATCH ${kind}`);
    response = await request('DELETE', `/api/books/${bookA.id}/${kind}/${id}`);
    assert.equal(response.status, 404, `DELETE ${kind}`);
  }

  assert.ok((await json('GET', `/api/books/${bookB.id}/characters`)).body.some(x => x.id === characterB.id && x.name === '乙角色'));
  assert.ok((await json('GET', `/api/books/${bookB.id}/locations`)).body.some(x => x.id === locationB.id && x.name === '乙地点'));
  assert.ok((await json('GET', `/api/books/${bookB.id}/foreshadows`)).body.some(x => x.id === foreshadowB.id && x.desc === '乙伏笔'));
  const pleasure = (await json('GET', `/api/books/${bookB.id}/pleasure`)).body;
  assert.ok(pleasure.hooks.list.some(x => x.id === hookB.id && x.desc === '乙钩子'));
  assert.ok(pleasure.arcs.list.some(x => x.id === arcB.id && x.name === '乙弧线'));
  assert.ok((await json('GET', `/api/books/${bookB.id}/worldbook`)).body.some(x => x.id === worldbookB.id && x.content === '乙词条'));
});

test('物品与势力 CRUD 有书级归属校验', async () => {
  const itemB = await create(`/api/books/${bookB.id}/items`, { name: '乙法宝' });
  const factionB = await create(`/api/books/${bookB.id}/factions`, { name: '乙宗门' });
  for (const [kind, id] of [['items', itemB.id], ['factions', factionB.id]]) {
    let response = await request('PATCH', `/api/books/${bookA.id}/${kind}/${id}`, { name: '被篡改' });
    assert.equal(response.status, 404);
    response = await request('DELETE', `/api/books/${bookA.id}/${kind}/${id}`);
    assert.equal(response.status, 404);
    const source = await json('GET', `/api/books/${bookB.id}/${kind}`);
    assert.ok(source.body.some(x => x.id === id && x.name.startsWith('乙')));
  }
});

test('静态 HEAD 返回 GET 元数据但不发送正文', async () => {
  const getResponse = await fetch(`${base}/index.html`);
  const getBody = await getResponse.arrayBuffer();
  const headResponse = await fetch(`${base}/index.html`, { method: 'HEAD' });
  const headBody = await headResponse.arrayBuffer();

  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-type'), getResponse.headers.get('content-type'));
  assert.equal(Number(headResponse.headers.get('content-length')), getBody.byteLength);
  assert.equal(headBody.byteLength, 0);
});
