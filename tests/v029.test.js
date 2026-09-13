// V0.29 测试：缓存优化（裸调用修复/契约进前缀）/ 路由表 / 场景自动重试 / 归档策略
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v029-'));
process.env.NOVEL_NO_OPEN = '1';

test('V0.29: 契约进公共材料前缀——buildPublicMaterials 含书契约段', async () => {
  const prompts = await import('../server/engine/prompts.js');
  const t = prompts.buildPublicMaterials({ world: '世界观', characters: '', outline: '', contract: '【书契约】目标读者…' });
  assert.ok(t.includes('书契约'), '公共材料前缀应含书契约');
  assert.ok(t.includes('硬约束'), '应标注硬约束');
});

test('V0.29: 裸调用修复——pleasure_audit/contract_score 走 assembleMessages 复用历史堆', async () => {
  const store = await import('../server/db/store.js');
  const outline = await import('../server/engine/planning/outline.js');
  const pleasure = await import('../server/engine/quality/pleasure.js');
  const b = store.books.create({ title: 'T1', genre: '玄幻', platform: '番茄', blurb: 'x' });
  await outline.generateBookContract(b.id, { genre: '玄幻', blurb: 'x', platform: '番茄' });
  await outline.generateBookOutline(b.id, {});
  const vol = store.volumes.list(b.id)[0];
  const ch = store.chapters.create(b.id, vol.id, 1, { title: '第一章' });
  store.scenes.create(ch.id, 1, { beat: 'b', content: '林晚走进青云城。', status: 'done' });
  // 快感审计应携带历史堆（messages 长度 >1，含 system/公共材料）
  const audit = await pleasure.auditPleasure(b.id, ch.id, 1, {});
  assert.ok(audit.ok !== false || audit.ok === undefined, '快感审计可执行');
  // 静态验证：源码已走 assembleMessages
  const src = fs.readFileSync(path.join(process.cwd(), 'server/engine/quality/pleasure.js'), 'utf8');
  assert.ok(src.includes("assembleMessages(bookId"), 'pleasure_audit 应走 assembleMessages');
  const ideaSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/planning/idea.js'), 'utf8');
  assert.ok(ideaSrc.includes("assembleMessages(bookId"), 'contract_score/idea 应走 assembleMessages');
});

test('V0.29: 路由表——thinking 字段随 routes 保存并可回读', async () => {
  const store = await import('../server/db/store.js');
  const config = await import('../server/config.js');
  config.saveGlobal({ routes: { write: { model: 'deepseek-v4-pro', temperature: 0.8, maxTokens: 5000, thinking: 'enabled' } } });
  const g = config.getGlobal();
  assert.equal(g.routes.write.model, 'deepseek-v4-pro');
  assert.equal(g.routes.write.thinking, 'enabled');
  // 重置（deepMerge 用 undefined 清键）
  config.saveGlobal({ routes: undefined });
  assert.equal(config.getGlobal().routes, undefined);
});

test('V0.29: 场景失败自动重试——单次故障被 pipeline 自动救回', async () => {
  const store = await import('../server/db/store.js');
  const pipeline = await import('../server/engine/pipeline/pipeline.js');
  const outline = await import('../server/engine/planning/outline.js');
  const b = store.books.create({ title: 'T2', genre: '玄幻', blurb: 'x' });
  await outline.generateBookContract(b.id, { genre: '玄幻', blurb: 'x', platform: '番茄' });
  await outline.generateBookOutline(b.id, {});
  const vol = store.volumes.list(b.id)[0];
  const ch = store.chapters.create(b.id, vol.id, 1, { title: '第一章' });
  store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [
    { pov: '林晚', location: '青云城', beat: 'b1', target_words: 300 },
    { pov: '林晚', location: '青云城', beat: 'b2', target_words: 300 },
  ] } });
  store.scenes.create(ch.id, 1, { pov: '林晚', location: '青云城', beat: 'b1', targetWords: 300, status: 'planned' });
  store.scenes.create(ch.id, 2, { pov: '林晚', location: '青云城', beat: 'b2', targetWords: 300, status: 'planned' });
  // 2 个故障：场景1 第一次调用失败 → 自动重试成功（第 3 次调用）
  process.env.NOVEL_FAULT = '500:2';
  const events = [];
  const r = await pipeline.runChapterFlow(b.id, ch.id, {
    autoConfirm: true,
    onEvent: ev => events.push(ev),
    resilience: { maxRetries: 1, connectTimeoutMs: 50, idleTimeoutMs: 50, totalTimeoutMs: 2000, circuitBreaker: { threshold: 99, openMs: 100, maxOpenMs: 100 } },
  });
  assert.deepEqual(r.failedScenes || [], [], '自动重试应救回场景1');
  assert.ok(events.some(e => e.type === 'stage' && e.message.includes('自动重试')), '应发出自动重试提示');
  const scenes = store.scenes.list(ch.id);
  assert.equal(scenes.length, 2, '测试应保留两个场景');
  assert.ok(['done', 'revised'].includes(scenes[0].status), '场景1重试后应完成');
  assert.ok(['done', 'revised'].includes(scenes[1].status), '场景1重试成功后仍应继续写场景2');
  assert.ok(scenes[1].content, '场景2正文不得被静默跳过');
});

test('V0.29: 流式 usage 缺失时估算 completion tokens（OpenCode Go 兼容）', async () => {
  // 直接测估算逻辑：router 内联估算——通过 mock 流式（mock 返回 usage？）静态验证源码
  const src = fs.readFileSync(path.join(process.cwd(), 'server/llm/router.js'), 'utf8');
  assert.ok(src.includes('_estimated'), '应有估算标记');
  assert.ok(src.includes('.length / 1.6'), '应按文本长度估算 tokens');
});
