// V0.80 逐章吸引力质量门（番茄"快+爽"拦截）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v086-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.80 逐章吸引力质量门', () => {
  test('①attractionLocalRules：词表缺席不下语义结论，客观排版异常仍可报告', async () => {
    const { attractionLocalRules } = await import(pathToFileURL(path.join(ROOT, 'server/engine/attraction.js')));
    const flat = attractionLocalRules('清晨的阳光透过窗棂洒进来，他慢慢睁开眼睛，想着今天该做些什么。他叹了口气，洗漱，吃早饭，出门散步。');
    assert.ok(!flat.some(i => i.type === '平淡开场'), '词表未命中不能推出平淡');
    assert.ok(!flat.some(i => i.type === '无章末钩子'), '词表未命中不能推出无钩子');
    assert.ok(!flat.some(i => i.type === '本章无爽点'), '词表未命中不能推出无回报');
    const repeated = `${'同一段具体文字反复出现，造成可核查的机械复读。'.repeat(8)}\n${'同一段具体文字反复出现，造成可核查的机械复读。'.repeat(8)}`;
    assert.ok(attractionLocalRules(repeated).some(i => i.type === '异常复读'), '完全相同长段仍应客观报告');
  });

  test('②parseAttractionResult：坏 JSON/未知判定显式 unreviewed，无 serious 问题才 pass', async () => {
    const { parseAttractionResult } = await import(pathToFileURL(path.join(ROOT, 'server/engine/attraction.js')));
    assert.equal(parseAttractionResult('not json').verdict, 'unreviewed', '坏 JSON 不能伪装成通过');
    assert.equal(parseAttractionResult('{"verdict":"maybe","issues":[]}').verdict, 'unreviewed', '未知判定不能伪装成通过');
    assert.equal(parseAttractionResult('{"verdict":"fix","issues":[]}').verdict, 'pass', '无 issue 应 pass');
    assert.equal(parseAttractionResult('{"verdict":"fix","issues":[{"severity":"low"}]}').verdict, 'pass', '只有 low 应 pass');
    assert.equal(parseAttractionResult('{"verdict":"fix","issues":[{"severity":"high","type":"无章末钩子"}]}').verdict, 'fix', '有 high 应 fix');
  });

  test('③番茄书 pipeline：NOVEL_ATTRACTION_FAULT 触发末场景补强，仍 done', async () => {
    process.env.NOVEL_ATTRACTION_FAULT = '1';
    try {
      const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
      const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
      const b = store.books.create({ title: '番茄书', genre: '玄幻', blurb: 'x', platform: '番茄' });
      store.materials.set(b.id, 'contract', 'x');
      const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
      const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
      store.chapters.update(ch.id, { outline: { title: '第一章', ending_hook: { desc: '门外脚步声', type: '危机钩', intensity: 3 }, scenes: [{ pov: '林晚', location: '巷口', beat: '事件', target_words: 300 }], checkpoints: ['x'] } });
      const events = [];
      const r = await runChapterFlow(b.id, ch.id, { onEvent: (ev) => events.push(ev.type) });
      assert.ok(['done', 'settled'].includes(r.status), `吸引力门补强后应完成，实际 ${r.status}`);
      // 门结果应记入 health notes
      const health = store.chapterHealth.getByChapter(ch.id);
      assert.ok(health?.notes, '应有 health notes');
      const notes = JSON.parse(health.notes || '{}');
      assert.ok(notes.gate, '应记录 gate 结果');
    } finally {
      delete process.env.NOVEL_ATTRACTION_FAULT;
    }
  });

  test('④普通平台（soft）：mock 返回 pass 时正常完成，不额外卡章', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
    const b = store.books.create({ title: '通用书', genre: '玄幻', blurb: 'x', platform: '通用' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
    store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [{ pov: '林晚', location: '镇', beat: '事件', target_words: 300 }], checkpoints: ['x'] } });
    const r = await runChapterFlow(b.id, ch.id, {});
    assert.ok(['done', 'settled'].includes(r.status), `通用平台应正常完成，实际 ${r.status}`);
  });

  test('⑤吸引力模型坏输出：正文继续结算，但事件与健康记录明确标为未审', async () => {
    process.env.NOVEL_ATTRACTION_PARSEFAULT = '1';
    try {
      const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
      const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
      const b = store.books.create({ title: '未审书', genre: '历史', blurb: 'x', platform: '番茄' });
      store.materials.set(b.id, 'contract', 'x');
      const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
      const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
      store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [{ pov: '林晚', location: '镇', beat: '事件', target_words: 300 }], checkpoints: ['x'] } });
      const events = [];
      const r = await runChapterFlow(b.id, ch.id, { onEvent: event => events.push(event) });
      assert.ok(['done', 'settled'].includes(r.status), '未审不应卡死自动创作');
      assert.ok(events.some(event => /吸引力门未完成/.test(event.message || '')), '事件流应显式显示未审');
      const notes = JSON.parse(store.chapterHealth.getByChapter(ch.id)?.notes || '{}');
      assert.equal(notes.gate?.reviewed, false, '健康记录必须区分未审与通过');
      assert.equal(notes.gate?.verdict, 'unreviewed');
    } finally {
      delete process.env.NOVEL_ATTRACTION_PARSEFAULT;
    }
  });
});
