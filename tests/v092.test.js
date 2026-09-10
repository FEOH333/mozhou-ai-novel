// V0.84 缓存命中率专项：变更检测不空操作重建 / 归档记忆尾置保前缀恒定 / 无缓存数据剔除 /
// 审校正文尾置提命中 / cast 落库后重建
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v092-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.84 缓存命中率专项', () => {
  test('①公共材料 PUT 内容未变化不重建前缀（H1）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '缓存书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'world', '世界观A');
    // 内容相同 → cacheRebuilt=false（不应触发 rebuild）
    const r1 = store.materials.set(b.id, 'world', '世界观A');
    assert.equal(r1.cacheRebuilt, false, '相同内容不应标记重建');
    // 内容变化 → cacheRebuilt=true
    const r2 = store.materials.set(b.id, 'world', '世界观B');
    assert.equal(r2.cacheRebuilt, true, '变化内容应标记重建');
    // index.js 的 PUT 路由应使用 cacheRebuilt 开关
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const putSeg = idx.slice(idx.indexOf("route('PUT', '/api/books/:id/public-materials'"), idx.indexOf("route('PUT', '/api/books/:id/public-materials'") + 700);
    assert.ok(putSeg.includes('if (r.cacheRebuilt)'), 'PUT 路由应仅在内容变化时 rebuild');
  });

  test('②PATCH 作品信息：值未变化不重建前缀（H1）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '缓存书2', genre: '玄幻', blurb: 'x' });
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const patchSeg = idx.slice(idx.indexOf("route('PATCH', '/api/books/:id'"), idx.indexOf("route('PATCH', '/api/books/:id'") + 900);
    // 应有"值实际变化"判定（String(body[k]) !== String(before[k])）
    assert.ok(patchSeg.includes('body[k] !== undefined && before && String(body[k]) !== String(before[k] ?? \'\')'), 'PATCH 应有变更检测');
    assert.ok(patchSeg.includes('const changed ='), 'PATCH 应只对变化字段重建');
  });

  test('③归档记忆尾置：公共材料前缀跨归档批次恒定（H3）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const cache = await import(pathToFileURL(path.join(ROOT, 'server/llm/cache.js')));
    const b = store.books.create({ title: '归档前缀书', genre: '玄幻', blurb: 'x' });
    // 构造历史堆：system + 公共材料 + 一条正文
    store.materials.set(b.id, 'system', '你是作家');
    store.materials.set(b.id, 'world', '世界观恒定内容');
    const { rebuildHistory } = await import(pathToFileURL(path.join(ROOT, 'server/engine/outline.js')));
    rebuildHistory(b.id);
    store.history.append(b.id, 'assistant', '场景正文第一条');
    // 添加两个归档批次
    store.archives.add(b.id, { batch: 1, rangeStart: 1, rangeEnd: 10, summaryJson: { rolling: { story_state: '批1主线', key_facts: ['事实1', '事实2', '事实3', '事实4', '事实5', '事实6'] } }, tokensSaved: 100 });
    store.archives.add(b.id, { batch: 2, rangeStart: 11, rangeEnd: 20, summaryJson: { rolling: { story_state: '批2主线', key_facts: ['事实A'] } }, tokensSaved: 100 });
    const msg1 = cache.assembleMessages(b.id, [{ role: 'user', content: '任务1' }]);
    // 关键断言：公共材料（history[1]）不得含归档文本——归档记忆在尾条 user
    const fixedContent = msg1.find(m => m.role === 'user')?.content || '';
    // 尾条 user = 任务+归档（archiveText 在任务之后）
    const lastUser = msg1[msg1.length - 1];
    assert.ok(lastUser.role === 'user', '末条应为 user');
    assert.ok(lastUser.content.includes('归档记忆'), '归档记忆在末条 user');
    assert.ok(lastUser.content.includes('任务1'), '任务内容在归档记忆之前');
    // history[1] 公共材料不含归档文本（前缀恒定关键）
    const hist = store.history.list(b.id);
    const pub = hist.find(h => h.role === 'user')?.content || '';
    assert.ok(!pub.includes('归档记忆'), '公共材料不应含归档记忆（前缀恒定）');
    assert.ok(!pub.includes('批1主线'), '公共材料不应含归档内容');
    // 多个归档批次合并注入（最近3批）
    assert.ok(lastUser.content.includes('批1主线') && lastUser.content.includes('批2主线'), '最近多批归档合并注入');
  });

  test('④审校正文尾置：固定规则段在草稿之前（H4 提命中）', async () => {
    const { auditInstruction, coverageInstruction, attractionGateInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const a = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: '【草稿正文XYZ】', factsText: '事实', foreshadowsText: '', characterStates: '', contract: '' });
    // 草稿段应在"核查边界"之后（固定规则进入命中前缀）
    assert.ok(a.indexOf('【核查边界') < a.indexOf('【草稿正文XYZ】'), '审校固定规则在草稿之前');
    const c = coverageInstruction({ bookTitle: 'X', chapterTitle: 'C', checkpoints: ['要点1'], chapterText: '【覆盖正文】' });
    assert.ok(c.indexOf('判定规则') < c.indexOf('【覆盖正文】'), '覆盖固定规则在正文之前');
    const at = attractionGateInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterIdx: 1, chapterText: '【吸引正文】', localIssues: [] });
    assert.ok(at.indexOf('判定标准') < at.indexOf('【吸引正文】'), '吸引力固定规则在正文之前');
    // 草稿仍完整保留（不影响审校质量）
    assert.ok(a.includes('【草稿正文XYZ】') && c.includes('【覆盖正文】') && at.includes('【吸引正文】'), '正文完整提供');
  });

  test('⑤无缓存数据端点标记：_noCacheData + 统计侧剔除（H2）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    // 模拟三协议 normalizeUsage：chat 端点未上报任何缓存字段
    const client = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    // normalizeUsage 未导出——通过 parseChatResponse 间接验证（响应含 usage 但无缓存字段）
    const parsed = client.parseChatResponse({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }, {}, 'chat');
    assert.ok(parsed.usage, '解析出 usage');
    // 统计侧剔除逻辑：usage_logs 的 extra 存 noCacheData
    const router = fs.readFileSync(path.join(ROOT, 'server/llm/router.js'), 'utf8');
    assert.ok(router.includes('noCacheData'), 'router 记录 noCacheData 标记');
    const storeSrc = fs.readFileSync(path.join(ROOT, 'server/db/store.js'), 'utf8');
    assert.ok(storeSrc.includes("json_extract(extra,'$.noCacheData')"), '统计侧剔除 noCacheData 行');
    assert.ok(storeSrc.includes('estimated=0'), '统计侧剔除估算行');
    // 实际落库+聚合验证
    const b = store.books.create({ title: '无缓存书', genre: '玄幻', blurb: 'x' });
    // 一条正常（hit 80 miss 20）
    store.usageLogs.add({ bookId: b.id, task: 'write', model: 'm', promptHit: 80, promptMiss: 20, completion: 10, cost: 1, costIfMiss: 2 });
    // 一条无缓存数据（应被剔除）
    store.usageLogs.add({ bookId: b.id, task: 'audit', model: 'm', promptHit: 0, promptMiss: 0, completion: 10, cost: 1, costIfMiss: 2, extra: { noCacheData: true } });
    // 一条估算（应被剔除）
    store.usageLogs.add({ bookId: b.id, task: 'write', model: 'm', promptHit: 0, promptMiss: 0, completion: 10, cost: 1, costIfMiss: 2, estimated: 1 });
    const agg = store.usageLogs.aggregate({ bookId: b.id });
    assert.equal(agg.totalHit, 80, '只统计有缓存数据的行');
    assert.equal(agg.totalMiss, 20, '剔除无缓存/估算行');
    assert.ok(Math.abs(agg.hitRatio - 0.8) < 0.001, '命中率应为 80% 而非被归零');
  });

  test('⑥cast 落库后再 rebuild（M1）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/outline.js'), 'utf8');
    const fnStart = src.indexOf('export async function generateBookOutline');
    const fnEnd = src.indexOf('export async function generateVolumeOutline');
    const fnBody = src.slice(fnStart, fnEnd);
    const castIdx = fnBody.indexOf("'cast'");
    const rebuildIdx = fnBody.indexOf('rebuildHistory(bookId)');
    assert.ok(castIdx !== -1 && rebuildIdx !== -1, 'cast 落库与 rebuild 均存在');
    assert.ok(castIdx < rebuildIdx, 'cast 落库应早于 rebuildHistory');
  });
});
