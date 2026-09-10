// V0.26 交互修复回归测试：书纲后按大纲取名 / 手填书名保护 / 导航上下文（前端逻辑静态校验）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v026-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_FAULT = '';

let store, outline, idea;

before(async () => {
  store = await import('../server/db/store.js');
  outline = await import('../server/engine/outline.js');
  idea = await import('../server/engine/idea.js');
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } });

test('V0.26: 书纲生成后按大纲回填书名（未命名 → 大纲标题）', async () => {
  const b = store.books.create({ title: '未命名', genre: '玄幻', blurb: '被废的剑宗弟子捡到玉佩' }).id;
  const o = await outline.generateBookOutline(b, {});
  assert.ok(o.title, '大纲应有标题');
  const after = store.books.get(b);
  assert.notEqual(after.title, '未命名', '书纲后应回填书名');
  assert.equal(after.title, o.title.slice(0, 30), '书名=大纲标题');
});

test('V0.26: 用户手填书名不被大纲覆盖', async () => {
  const b = store.books.create({ title: '我的自定书名', genre: '玄幻', blurb: 'x' }).id;
  await outline.generateBookOutline(b, {});
  const after = store.books.get(b);
  assert.equal(after.title, '我的自定书名', '手填书名应保留');
});

test('V0.26: 契约生成后的起名兜底保留（未命名 → 契约后起名）', async () => {
  const b = store.books.create({ title: '未命名', genre: '玄幻', blurb: '测试灵感' }).id;
  await outline.generateBookContract(b, { idea: '测试灵感' });
  const after = store.books.get(b);
  assert.notEqual(after.title, '未命名', '契约生成后应回填书名');
  assert.ok(after.title.length >= 2);
});

test('V0.26: 创建时留空书名 AI 起名仍可用（不回归）', async () => {
  const r = await idea.generateBookTitle(null, { idea: '一个被废的剑宗弟子捡到会说话的玉佩' });
  assert.equal(r.ok, true);
  assert.ok(r.title && r.title.length >= 2);
});

test('V0.26: 前端导航上下文——route() 先定 book 再 renderNav（静态断言）', () => {
  const app = fs.readFileSync('web/js/app.js', 'utf8');
  // 限定在 route() 函数体内
  const fnStart = app.indexOf('async function route()');
  const fnEnd = app.indexOf('function renderNav');
  const seg = app.slice(fnStart, fnEnd);
  const renderNavIdx = seg.indexOf('renderNav(r)');
  const bookNullIdx = seg.indexOf('state.book = null');
  const bookGetIdx = seg.indexOf('state.book = await get');
  assert.ok(renderNavIdx > bookNullIdx, 'renderNav 应在 state.book=null 之后');
  assert.ok(renderNavIdx > bookGetIdx, 'renderNav 应在 state.book=get 之后');
  // 7 个书内页头部带书名
  for (const f of ['workshop', 'outline', 'world', 'foreshadows', 'pleasure', 'facts', 'costs']) {
    const src = fs.readFileSync(`web/js/views/${f}.js`, 'utf8');
    assert.ok(src.includes('book.title'), `${f} 头部应显示书名`);
  }
});
