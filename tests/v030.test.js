// V0.30 测试：thinking 序列化 / pendingEntities 自动确认 / smoothTransitions 接线 / 路由表收敛
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-'));
process.env.NOVEL_NO_OPEN = '1';

test('V0.30: thinking 参数序列化——官方端点对象形式、兼容端点不发', async () => {
  const { buildRequestBody } = await import('../server/llm/client.js');
  // deepseekParams=true（官方）：thinking 应为对象 {type}
  const b1 = buildRequestBody({ model: 'deepseek-v4-flash', messages: [], temperature: 0.7, maxTokens: 100, thinking: 'enabled', deepseekParams: true });
  assert.deepEqual(b1.thinking, { type: 'enabled' }, '官方端点 thinking 应为对象形式（OpenCode Go 实测字符串会 400）');
  // deepseekParams=false（OpenCode Go）：不发 thinking
  const b2 = buildRequestBody({ model: 'deepseek-v4-flash', messages: [], temperature: 0.7, maxTokens: 100, thinking: 'enabled', deepseekParams: false });
  assert.equal(b2.thinking, undefined, '兼容端点不应发 thinking');
});

test('V0.30: pendingEntities 自动确认——同名二次出现自动建角色卡', async () => {
  const store = await import('../server/db/store.js');
  const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x' });
  store.pendingEntities.add(b.id, { name: '神秘剑客', context: '第一章巷口出现的斗笠人', sourceChapter: 1 });
  assert.equal(store.pendingEntities.list(b.id).length, 1, '首次出现进待登记');
  // 同名再次出现 → V0.40：合并上下文 + 计数（强信号），建卡统一由 tidyPendingEntities 执行
  store.pendingEntities.add(b.id, { name: '神秘剑客', context: '第三章再次出现，自称姓萧', sourceChapter: 3 });
  const dup = store.pendingEntities.list(b.id).find(x => x.name === '神秘剑客');
  assert.ok(dup, '同名仍待登记（合并计数）');
  assert.equal(dup.dup_count, 2, '出现次数应为 2');
  assert.ok(dup.context.includes('自称姓萧'), '上下文应合并');
  assert.equal(store.characters.list(b.id).length, 0, 'tidy 前不建卡');
  // tidy 自动整理 → 推断为角色并建卡
  const { tidyPendingEntities } = await import('../server/engine/pending.js');
  const stats = tidyPendingEntities(b.id, { currentChapter: 5 });
  assert.equal(stats.confirmed, 1, '应自动建卡 1 项');
  assert.equal(store.pendingEntities.list(b.id).length, 0, '建卡后不再待登记');
  const c = store.characters.list(b.id).find(x => x.name === '神秘剑客');
  assert.ok(c, '应自动创建角色卡');
  const card = JSON.parse(c.card_json || '{}');
  assert.equal(card.autoConfirmed, true, '应标记 autoConfirmed');
});

test('V0.30: smoothTransitions 已接线到 pilot 打磨流程（静态断言）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/engine/pilot.js'), 'utf8');
  assert.ok(src.includes('smoothTransitions'), 'pilot 应导入 smoothTransitions');
  assert.ok(src.includes('衔接优化：重写'), '打磨后应执行衔接检查');
});

test('V0.30: 路由表 thinking 收敛——仅关闭/开启两档', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'web/js/views/settings.js'), 'utf8');
  // V0.83：thinking select 是独立的（disabled/enabled），reasoningEffort 是新增的独立下拉（low/medium/high）——
  // 断言精确定位 thinking select 段，不再被其后新增的 effort 下拉误伤
  const tStart = src.indexOf("value: 'disabled', text: '关闭'");
  const tEnd = src.indexOf("const effortSel = el('select'");
  const seg = src.slice(tStart, tEnd > tStart ? tEnd : tStart + 300);
  assert.ok(!seg.includes("value: 'low'"), 'thinking 不应有 low 档');
  assert.ok(!seg.includes("value: 'medium'"), 'thinking 不应有 medium 档');
  assert.ok(seg.includes("value: 'enabled'"), '应有 enabled 档');
  // V0.83：effort 控件存在（思考强度可调）
  assert.ok(src.includes('const effortSel'), '应有 reasoningEffort 控件');
});
