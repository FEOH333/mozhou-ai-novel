// V0.85 卷大纲解析失败修复专项
// 覆盖：extractJSON 根对象强化（截断不静默返回错误结构）/ thinking 花括号干扰 / 残留检测 /
// 卷大纲容错重试（chapters 对象转数组）/ pilot 骨架卷纲软降级
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v093-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.85 卷大纲解析失败修复', () => {
  test('①extractJSON 截断 JSON 返回 null（不再静默返回错误结构）', async () => {
    const j = await import(pathToFileURL(path.join(ROOT, 'server/util/json.js')));
    // 第5章写到一半截断 → 根对象未闭合 → 必须 null（此前会解析出内层数组导致调用方误判）
    assert.equal(j.extractJSON('{"title":"卷1","goal":"g","chapters":[{"idx":1,"title":"一","beat":"b1"},{"idx":2,"title":"二","beat":"b2"},{"idx":3,"title":"三","beat":"b3"},{"idx":4,"title":"四","beat":"b4"},{"idx":5,"title":"五","beat":"b5'), null, '对象根截断应返回 null');
    // 数组闭合但外层未闭合
    assert.equal(j.extractJSON('{"title":"卷1","goal":"g","chapters":[{"idx":1,"title":"一","beat":"b1"},{"idx":2,"title":"二","beat":"b2"}'), null, '外层未闭合应返回 null');
  });

  test('②extractJSON thinking 花括号混入：取正确 content JSON（此前从 thinking 截取出垃圾对象）', async () => {
    const j = await import(pathToFileURL(path.join(ROOT, 'server/util/json.js')));
    const mixed = '思考过程：先规划结构{注意这里}再输出。\n{"title":"卷1","chapters":[{"idx":1,"title":"一","beat":"b1"}]}';
    const r = j.extractJSON(mixed);
    assert.ok(r && Array.isArray(r.chapters), '应解析出 content 的完整 JSON');
    assert.equal(r.title, '卷1', '取到的是 content 而非 thinking 垃圾');
  });

  test('③extractJSON thinking+截断混入：拒绝内层残缺对象（残留检测）', async () => {
    const j = await import(pathToFileURL(path.join(ROOT, 'server/util/json.js')));
    const mixedTruncated = '推理过程：这里有个{花括号}。{"title":"卷1","chapters":[{"idx":1,"title":"一","beat":"b1"},{"idx":2,"title":"二","beat":"b2"';
    assert.equal(j.extractJSON(mixedTruncated), null, 'thinking混入+截断应返回 null（残缺）');
  });

  test('④extractJSON 正常路径不受影响：整体/围栏/数组根', async () => {
    const j = await import(pathToFileURL(path.join(ROOT, 'server/util/json.js')));
    const ok = j.extractJSON('{"title":"卷1","chapters":[{"idx":1,"title":"一","beat":"b1"}]}');
    assert.equal(ok.title, '卷1');
    const fence = j.extractJSON('```json\n{"a":1}\n```');
    assert.equal(fence.a, 1, '代码围栏');
    const arr = j.extractJSON('[1,2,3]');
    assert.deepEqual(arr, [1, 2, 3], '数组根');
    const expectObj = j.extractJSON('{"a":1}', { expect: 'object' });
    assert.equal(expectObj.a, 1, 'expect=object 通过');
    const expectArr = j.extractJSON('[1]', { expect: 'array' });
    assert.deepEqual(expectArr, [1], 'expect=array 通过');
    // expect=object 时数组应拒绝
    assert.equal(j.extractJSON('[1]', { expect: 'object' }), null, 'expect=object 拒绝数组');
  });

  test('⑤generateVolumeOutline 容错：chapters 是对象转数组；坏 JSON 自动重试', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateVolumeOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '卷纲容错书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '契约');
    const v = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g' });
    // mock 环境正常生成
    const r = await generateVolumeOutline(b.id, v.id, { chapterCount: 6 });
    assert.ok(r.chapters?.length >= 1, '正常生成');
    // 源码含重试逻辑
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes('for (let attempt = 0; attempt < 3'), '卷大纲 3 次重试');
    assert.ok(src.includes('Object.values(chapters)'), 'chapters 对象转数组');
  });

  test('⑥pilot 骨架卷纲段软降级：卷大纲失败建空章不崩自动创作', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    const skeletonStart = src.indexOf('if (!volumes.length)');
    const skeletonEnd = src.indexOf('V0.43：自动创作前自动快照');
    const seg = src.slice(skeletonStart, skeletonEnd);
    assert.ok(seg.includes('已建空卷结构'), '首卷失败建空章结构');
    assert.ok(seg.includes('失败（${String(e?.message || e).slice(0, 50)}'), '失败 emit 提示不抛');
    assert.ok(seg.includes('将按序续写时重试'), 'eager 卷失败软降级');
  });
});
