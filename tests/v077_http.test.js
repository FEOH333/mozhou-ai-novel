// V0.77 真实 HTTP 回归：密钥脱敏、同源写请求、设置契约与基础安全头
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-http-'));
const sentinel = 'sk-v077-SENTINEL-secret-value';
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  apiKey: sentinel,
  baseUrl: 'https://api.deepseek.com',
  protocol: 'chat',
}));

let port;
let base;
let child;

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
      // 让真实并发测试中的首个 pilot 稳定停留在租约内；测试结束会主动 abort。
      NOVEL_FAULT: 'stall:99',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await waitForHealth();
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
});

test('GET /api/settings 不包含原始 API Key', async () => {
  const response = await fetch(`${base}/api/settings`);
  const raw = await response.text();
  const body = JSON.parse(raw);

  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(body, 'apiKey'), false);
  assert.equal(raw.includes(sentinel), false);
  assert.equal(body.hasApiKey, true);
  assert.ok(body.apiKeyMasked.includes('****'));
});

test('protocol 设置可真实 PUT/GET 往返，非法枚举返回 400', async () => {
  const headers = { 'Content-Type': 'application/json', Origin: base };
  const saved = await fetch(`${base}/api/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ protocol: 'responses' }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).protocol, 'responses');
  assert.equal((await (await fetch(`${base}/api/settings`)).json()).protocol, 'responses');

  const invalid = await fetch(`${base}/api/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ protocol: 'made-up' }),
  });
  assert.equal(invalid.status, 400);
});

test('跨源 text/plain 不能触发 settings/test 外带已保存密钥', async () => {
  let leakedAuthorization = null;
  const attacker = http.createServer((req, res) => {
    leakedAuthorization = req.headers.authorization || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/models' ? JSON.stringify({ data: [{ id: 'model' }] }) : JSON.stringify({ choices: [] }));
  });
  await new Promise(resolve => attacker.listen(0, '127.0.0.1', resolve));
  const attackerUrl = `http://127.0.0.1:${attacker.address().port}`;
  try {
    const response = await fetch(`${base}/api/settings/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: JSON.stringify({ baseUrl: attackerUrl }),
    });
    assert.equal(response.status, 403);
    assert.equal(leakedAuthorization, null);
  } finally {
    await new Promise(resolve => attacker.close(resolve));
  }
});

test('API/静态响应有安全头，静态资源拒绝写方法', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(health.headers.get('content-security-policy'));

  const staticWrite = await fetch(`${base}/index.html`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: '{}',
  });
  assert.equal(staticWrite.status, 405);
});

test('同书第二个长任务通过真实 HTTP 得到 409 BOOK_BUSY', async () => {
  const headers = { 'Content-Type': 'application/json', Origin: base };
  const created = await fetch(`${base}/api/books`, {
    method: 'POST', headers, body: JSON.stringify({ title: '并发测试书', genre: '玄幻', blurb: '测试' }),
  });
  const book = await created.json();
  const controller = new AbortController();
  const first = await fetch(`${base}/api/books/${book.id}/pilot`, {
    method: 'POST', headers, body: JSON.stringify({ targetChapters: 1 }), signal: controller.signal,
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${base}/api/books/${book.id}/polish`, {
    method: 'POST', headers, body: JSON.stringify({}),
  });
  const body = await second.json();
  assert.equal(second.status, 409);
  assert.equal(body.code, 'BOOK_BUSY');
  controller.abort();
  await first.text().catch(() => '');
});
