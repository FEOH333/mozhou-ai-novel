// tests/v025.test.js —— V0.25 深度升级回归：快照恢复 INSERT 分支 / 韧性配置持久化 / 事实过滤 / 版本一致性 / 灵感保真链路
import './helper.js';
process.env.NOVEL_MOCK_LLM = '1'; // 灵感链路用例走 mock LLM
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../server/db/store.js';
import { getGlobal, saveGlobal } from '../server/config.js';

test('V0.25: 快照恢复——删除章节后回滚不再崩溃（INSERT 分支）', () => {
  const bid = store.books.create({ title: '快照删章回归', genre: '玄幻', blurb: 'x' }).id;
  const ch1 = store.chapters.create(bid, null, 1, { title: '第一章' }).id;
  const ch2 = store.chapters.create(bid, null, 2, { title: '第二章' }).id;
  store.scenes.create(ch2, 1, { pov: '', location: '', beat: 'b', content: '第二章正文', targetWords: 500, status: 'done' });
  const snap = store.snapshotBook(bid);
  // 删除第二章：制造"快照有、库里没有"的场景，恢复时必走 INSERT 分支
  store.chapters.remove(ch2);
  assert.equal(store.chapters.list(bid).length, 1);
  // V0.22 及之前：此处 INSERT 引用不存在的 updated_at 列，抛 no such column
  store.restoreSnapshot(bid, snap);
  const after = store.chapters.list(bid);
  assert.equal(after.length, 2, '恢复后应回到两章');
  assert.equal(after[1].title, '第二章');
  assert.equal(store.scenes.list(after[1].id)[0].content, '第二章正文', '场景正文应还原');
});

test('V0.25: 韧性参数持久化——saveGlobal/getGlobal 完整往返', () => {
  const before = getGlobal().resilience;
  const custom = { ...before, maxRetries: 5, totalTimeoutMs: 240000 };
  saveGlobal({ resilience: custom });
  const after = getGlobal().resilience;
  assert.equal(after.maxRetries, 5);
  assert.equal(after.totalTimeoutMs, 240000);
  assert.equal(after.circuitBreaker.threshold, before.circuitBreaker.threshold, '未提交字段应保持');
  saveGlobal({ resilience: before }); // 还原，避免影响其他用例
});

test('V0.25: 事实库 status 过滤（store 层）', () => {
  const bid = store.books.create({ title: '事实过滤', genre: '都市', blurb: 'x' }).id;
  store.facts.create(bid, { subject: '甲', predicate: '持有', object: '剑' });
  const f2 = store.facts.create(bid, { subject: '乙', predicate: '失去', object: '盾' });
  store.facts.setStatus(f2.id, 'superseded');
  const all = store.facts.list(bid);
  const active = store.facts.list(bid, { status: 'active' });
  assert.equal(all.length, 2);
  assert.equal(active.length, 1);
  assert.equal(active[0].subject, '甲');
});

test('V0.25: 版本标识全局一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
  // V0.109.0：API 动态编排（双端点自动切换）+ 设置页双通道改版。
  assert.equal(pkg.version, '0.109.0');
  assert.equal(lock.version, '0.109.0');
  const idx = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
  const web = fs.readFileSync(path.join(process.cwd(), 'web/index.html'), 'utf8');
  const versionModule = fs.readFileSync(path.join(process.cwd(), 'server/version.js'), 'utf8');
  assert.ok(idx.includes('version: APP_VERSION'), 'health 端点应使用统一版本常量');
  assert.ok(versionModule.includes("'0.109.0'"), '统一版本常量应为 0.109.0');
  assert.ok(web.includes('brand-ver">V0.109.0</span>'), '网页版本标识应为 V0.109.0');
  assert.match(pkg.description, /有界创作上下文.*原子叙事版本重建.*自进化/);
  assert.ok(pkg.description.includes('V0.109.0'), '包描述应同步当前版本');
  assert.ok(!pkg.description.includes('灏'), 'package.json description 不应含乱码');
});

test('V0.25: schema.sql 无编码乱码残留', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'server/db/schema.sql'), 'utf8');
  // GBK 被误读为 UTF-8 的典型残留字符
  assert.ok(!/[���]/.test(sql), 'schema.sql 不应含乱码字符');
  assert.ok(sql.includes('作品快照'), '快照表注释应为正常中文');
});

// ---------- 灵感保真链路（主人反馈：穿越元素被提级丢弃 + 下游不可见） ----------

test('V0.25: 提级指令含核心元素守恒硬规则且回显原灵感', async () => {
  const { ideaAmplifyInstruction } = await import('../server/engine/prompts.js');
  const p = ideaAmplifyInstruction({ idea: '主角穿越成玄幻世界的杂役弟子', genre: '玄幻', platform: '番茄' });
  assert.ok(p.includes('主角穿越成玄幻世界的杂役弟子'), 'prompt 应回显原灵感');
  assert.ok(p.includes('核心元素守恒'), 'prompt 应含守恒规则');
  assert.ok(p.includes('kept_elements'), 'prompt 应要求输出作者锚点');
  assert.ok(p.includes('严禁丢弃'), 'prompt 应明确禁止丢弃锚点');
});

test('V0.25: 契约/书纲指令将作者灵感核心设定标为硬约束', async () => {
  const { bookContractInstruction, bookOutlineInstruction } = await import('../server/engine/prompts.js');
  const c = bookContractInstruction({ genre: '玄幻', blurb: 'b', idea: '主角穿越成杂役弟子', platform: '通用' });
  assert.ok(c.includes('硬约束') && c.includes('不得丢弃'), '契约指令应含灵感守恒约束');
  const o = bookOutlineInstruction({ genre: '玄幻', blurb: '主角穿越成杂役弟子', volumes: 4 });
  assert.ok(o.includes('硬约束') && o.includes('不得丢弃'), '书纲指令应含灵感守恒约束');
});

test('V0.25: 提级返回作者锚点（mock）', async () => {
  const idea = await import('../server/engine/idea.js');
  const r = await idea.amplifyIdea(null, { idea: '主角穿越成玄幻世界的杂役弟子', genre: '玄幻', platform: '番茄' });
  assert.ok(r.ok);
  assert.ok(Array.isArray(r.keptElements), '应返回 keptElements 数组');
});

test('V0.25: 书纲生成后作者灵感不被 logline 覆盖', async () => {
  const { generateBookOutline } = await import('../server/engine/outline.js');
  const src = '主角穿越成玄幻世界的杂役弟子，扫地砍柴皆是上古传承';
  const bid = store.books.create({ title: '灵感保真', genre: '玄幻', blurb: src }).id;
  await generateBookOutline(bid, { volumeCount: 2 });
  const after = store.books.get(bid);
  assert.equal(after.blurb, src, '书纲生成后 blurb 应保持作者灵感原文');
});

test('V0.25: 连接超时正确报 HTTP_TIMEOUT（DOMException 只读 code 回归）', async () => {
  // 主人实测报障：超时后前端显示 "Cannot set property code of which has only a getter"——
  // AbortSignal.timeout 的 DOMException code/message 是只读 getter，旧代码原地赋值崩溃掩盖真错误。
  const prevMock = process.env.NOVEL_MOCK_LLM;
  delete process.env.NOVEL_MOCK_LLM; // 走真实 fetch（不可路由地址触发超时）
  try {
    const { chatCompletion } = await import('../server/llm/client.js');
    await assert.rejects(
      chatCompletion({
        model: 'm', messages: [{ role: 'user', content: 'x' }],
        baseUrl: 'http://10.255.255.1', apiKey: 'sk-test',
        resilience: { connectTimeoutMs: 300, idleTimeoutMs: 800, totalTimeoutMs: 5000, maxRetries: 0, circuitBreaker: { threshold: 99, openMs: 1, maxOpenMs: 1 } },
      }),
      (e) => {
        assert.equal(e.code, 'HTTP_TIMEOUT', `应标注 HTTP_TIMEOUT，实际: ${e.code || e.message}`);
        assert.ok(e.message.includes('超时'), '错误信息应为用户可读的超时提示');
        return true;
      },
    );
  } finally {
    if (prevMock) process.env.NOVEL_MOCK_LLM = prevMock;
  }
});
