// V0.96 锁定：① 角色性格单源（card.traits 退役）② usage 终帧补推与口径 ③ 审校用量透传
// ④ 前端统计条全路径（自动创作+一键写本章）⑤ 前端可视化补齐（健康/搜索/引擎/契约/快感审计）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './helper.js';
import * as store from '../server/db/store.js';
import { syncCastCharacters } from '../server/engine/roster.js';
import { characterRollCallText, characterCardsText } from '../server/engine/characters.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- ① 角色性格单源 ----------

test('V0.96 角色卡 vs 角色库去重：syncCastCharacters 建卡不再双写 traits（card_json 只留 role）', () => {
  const book = store.books.create({ title: '性格单源测试', genre: '玄幻' });
  syncCastCharacters(book.id, [
    '人物表：',
    '- 林岸｜散修｜谨慎多疑，怕欠人情｜找到属于自己的道｜身世成谜｜游历四方提升修为｜与苏晚亦敌亦友',
  ].join('\n'));
  const chars = store.characters.list(book.id);
  const c = chars.find(x => x.name === '林岸');
  assert.ok(c, '人物表同步应建卡');
  const card = JSON.parse(c.card_json || '{}');
  assert.equal(card.traits, undefined, 'card.traits 已退役——性格唯一真源是 personality 列');
  assert.equal(card.role, '散修', '身份留在 card.role');
  assert.ok(c.personality.includes('谨慎多疑'), '性格写入 personality 列');
});

test('V0.96 性格不再进点名册（characterCardsText 六维卡才是性格唯一注入位）', () => {
  const book = store.books.create({ title: '注入单源测试', genre: '玄幻' });
  syncCastCharacters(book.id, [
    '人物表：',
    '- 陆沉｜剑修｜沉默寡言，重诺｜为师报仇｜剑心有裂痕｜隐忍十年磨一剑｜师从断水崖',
  ].join('\n'));
  const rollCall = characterRollCallText(book.id);
  assert.ok(!/性格[:：]/.test(rollCall), '点名册不应再输出性格（双源分歧根因：rollCall 读 traits、cardText 读 personality）');
  // 人物卡（按场景过滤的 3 人卡）应含身份与性格——单一注入位完整
  const cards = characterCardsText(book.id, { names: ['陆沉'] });
  assert.ok(cards.includes('身份：剑修'), '人物卡应含身份（card.role 此前只在点名册出现）');
  assert.ok(cards.includes('性格：'), '人物卡应含性格（personality 列单源）');
});

// ---------- ② usage 终帧补推与口径 ----------

test('V0.96 router 终帧补推：非流式/无 usage 帧端点流结束补推一次（_streamed 防重）', () => {
  const router = read('server/llm/router.js');
  assert.ok(router.includes('!u._streamed && streamCb?.onUsage'), '流中未推送过 usage 应补推终帧');
  assert.ok(router.includes('streamCb.onUsage({ ...u })'), '补推应复制对象（不打 _streamed 标记污染原 usage）');
  const client = read('server/llm/client.js');
  assert.ok(client.includes('finalUsage._streamed = true'), '流式终帧 usage 应打 _streamed 标记');
  assert.ok(/mockU\._streamed = true/.test(client), 'mock 流式路径同款标记（防终帧补推重复累加）');
});

test('V0.96 tokens 口径：promptTokens 已含 hit+miss，前端不得四项相加', () => {
  const ws = read('web/js/views/workshop.js');
  assert.ok(!ws.includes('runTokens += (u.promptTokens || 0) + (u.completionTokens || 0) + (u.promptCacheHitTokens || 0)'),
    '不得再把缓存 hit/miss 加进 tokens（重复计一次，显示约为实际两倍）');
});

// ---------- ③ 审校用量透传 ----------

test('V0.96 审校用量进本次运行统计：auditChapter 接受 streamCb 且 pipeline 透传', () => {
  const audit = read('server/engine/audit.js');
  assert.ok(/export async function auditChapter\(bookId, chapterId, \{ signal, streamCb \} = \{\}\)/.test(audit),
    'auditChapter 应接受 streamCb 参数');
  assert.ok(audit.includes('streamCb: { onUsage: streamCb?.onUsage, onUsageCost: streamCb?.onUsageCost }'),
    '审校 runTask 调用应透传 usage 回调');
  const pipeline = read('server/engine/pipeline.js');
  assert.ok(pipeline.includes("const usageCb = { onUsage: u => emit('usage', u), onUsageCost: c => emit('usage_cost', c) }"),
    'pipeline 审校环节应把 usage 事件发到 SSE 流（此前审校 tokens 前端完全看不到）');
});

// ---------- ④ 前端统计条全路径 ----------

test('V0.96 统计条工厂：自动创作与一键写本章共用（单章写作不再零统计）', () => {
  const ws = read('web/js/views/workshop.js');
  assert.ok(/function runStatsBar\(\)/.test(ws), '应存在 runStatsBar 模块级工厂');
  // runFlow（一键写本章）挂统计条 + usage 累计
  const runFlowStart = ws.indexOf("async function runFlow");
  const runFlowEnd = ws.indexOf('V0.78 修复：revised 也是已完成');
  const runFlowSrc = ws.slice(runFlowStart, runFlowEnd);
  assert.ok(runFlowSrc.includes('const stats = runStatsBar()'), 'runFlow 应创建统计条');
  assert.ok(runFlowSrc.includes('stats.onUsage(data)'), 'runFlow usage 事件应累计');
  assert.ok(runFlowSrc.includes('stats.onCost(data)'), 'runFlow 应处理 usage_cost 费用帧（此前恒 ¥0）');
  // runPilot（自动创作）同款
  assert.ok(ws.includes('const stats = runStatsBar();'), 'runPilot 应使用统计条工厂');
});

// ---------- ⑤ 前端可视化补齐 ----------

test('V0.96 前端可视化：健康体检/语义搜索/引擎概览进书务台', () => {
  const ws = read('web/js/views/workshop.js');
  assert.ok(ws.includes('`/api/books/${book.id}/health`'), '健康体检应调 /health 端点（此前零入口）');
  assert.ok(ws.includes('`/api/books/${book.id}/search?q='), '语义搜索应调 /search 端点（此前零入口）');
  assert.ok(ws.includes('`/api/books/${book.id}/recover`'), '一键恢复应调 /recover 端点');
  assert.ok(ws.includes('`/api/books/${book.id}/engine`'), '引擎概览应调 /engine 端点');
  const index = read('server/index.js');
  assert.ok(index.includes("route('GET', '/api/books/:id/engine'"), '后端应注册引擎概览端点');
  assert.ok(index.includes('batchQualityScan'), '引擎概览应聚合三章一轮批次自检结果');
});

test('V0.96 前端可视化：契约评分（outline）与快感深度审计（pleasure）补入口', () => {
  const outline = read('web/js/views/outline.js');
  assert.ok(outline.includes('/contract/score'), '大纲页应有签约评估入口（scoreContract 此前零入口）');
  assert.ok(outline.includes('书契约（对读者的承诺）'), '契约文本本身应可见（此前只存 materials 无展示）');
  const pleasure = read('web/js/views/pleasure.js');
  assert.ok(pleasure.includes('/pleasure/audit'), '快感页应有深度审计入口（auditPleasure 此前零入口）');
});

test('V0.96.1 签约评估渲染适配真实 schema：scores 是对象（novelty/conflict/market/executable），非数组', () => {
  // 用户实测"8 分 · pass nullnull"双根因：① scores 按数组渲染（真实 schema 是四维对象）
  // ② 原生 DOM append(null) 渲染字面 "null" 文本（el() 跳过 null，原生不跳过）
  const outline = read('web/js/views/outline.js');
  assert.ok(outline.includes('novelty'), '应含 novelty 维度标签映射（contractScoreInstruction schema）');
  assert.ok(outline.includes('Object.entries(r.scores)'), 'scores 应按对象遍历（Object.entries）');
  assert.ok(!/r\.scores\.map/.test(outline) && !/\.\.\.r\.scores/.test(outline), '不得再按数组 spread/map 渲染 scores（类型守卫 !Array.isArray 除外）');
  assert.ok(outline.includes("pass: '✅ 通过"), 'verdict pass 应中文化（此前裸英文枚举）');
});

test('V0.96.1 原生 append 不跳过 null：本轮四处条件子节点全部 filter(Boolean)', () => {
  const outline = read('web/js/views/outline.js');
  const ws = read('web/js/views/workshop.js');
  const pleasure = read('web/js/views/pleasure.js');
  for (const [name, src, min] of [['outline', outline, 1], ['workshop', ws, 2], ['pleasure', pleasure, 1]]) {
    const n = (src.match(/\.filter\(Boolean\)\)/g) || []).length;
    assert.ok(n >= min, `${name} 应有 ≥${min} 处 filter(Boolean)（原生 append(null) 渲染字面 "null" 的防线）`);
  }
  const pleasureSrc = pleasure;
  assert.ok(pleasureSrc.includes('a.hook?.intensity'), '快感审计钩子强度字段应为 intensity（schema 真源，非 strength）');
  assert.ok(pleasureSrc.includes('a.agency_ratio'), '主体性占比应展示（高|中|低枚举）');
});
