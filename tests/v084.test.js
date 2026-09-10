// V0.80 前20章开篇蓝图 + 快感计划贯通
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v084-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.80 开篇蓝图 + 快感计划贯通', () => {
  test('①generateOpeningBlueprint 落 settings + materials，幂等', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateOpeningBlueprint } = await import(pathToFileURL(path.join(ROOT, 'server/engine/opening.js')));
    const { ensureStoryPromiseProfile } = await import(pathToFileURL(path.join(ROOT, 'server/engine/story_promise.js')));
    const b = store.books.create({ title: '蓝图书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '前3章必有打脸');
    store.materials.set(b.id, 'outline', '书纲');
    assert.equal((await ensureStoryPromiseProfile(b.id)).ok, true, '应先建立创作宪章');
    const r = await generateOpeningBlueprint(b.id, {});
    assert.equal(r.ok, true, '蓝图应生成成功');
    const book = store.books.get(b.id);
    const bp = JSON.parse(book.settings_json).openingBlueprint;
    assert.ok(bp && Array.isArray(bp.hook_ladder) && bp.hook_ladder.length > 0, '应含 hook_ladder');
    assert.ok(bp.golden_finger?.power, '应含金手指');
    assert.ok(store.materials.get(b.id, 'opening_blueprint')?.content, '应写 materials');
    // 幂等
    const r2 = await generateOpeningBlueprint(b.id, {});
    assert.equal(r2.skipped, true, '二次调用应跳过');
  });

  test('②openingBlueprintForChapter 返回本章槽位', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateOpeningBlueprint, openingBlueprintForChapter } = await import(pathToFileURL(path.join(ROOT, 'server/engine/opening.js')));
    const { ensureStoryPromiseProfile } = await import(pathToFileURL(path.join(ROOT, 'server/engine/story_promise.js')));
    const b = store.books.create({ title: '蓝图书2', genre: '玄幻', blurb: 'x' });
    assert.equal((await ensureStoryPromiseProfile(b.id)).ok, true, '应先建立创作宪章');
    await generateOpeningBlueprint(b.id, {});
    const slot = openingBlueprintForChapter(b.id, 2);
    assert.ok(slot, '第2章应有蓝图槽位');
    assert.ok(slot.goldenFingerMilestone, '第2章应为金手指上线章（mock 设定 activate_chapter=2）');
    assert.equal(slot.goldenFingerMilestone.power, '掌心印记共鸣石碑，可短暂借用其力量');
    assert.ok(slot.hook, '应有章末钩子');
    // 无蓝图章 → null
    const none = openingBlueprintForChapter(b.id, 99);
    assert.equal(none, null, '超范围章应返回 null');
  });

  test('③planBookPleasure 传真实契约 + 写 materials(pleasure) + arc_plan 播种', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { planBookPleasure } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
    const b = store.books.create({ title: '贯通书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '前3章必有打脸。主角靠自身努力成长。');
    const r = await planBookPleasure(b.id, {});
    assert.equal(r.ok, true);
    // materials('pleasure') 非空（激活 settings.js:56 死读）
    const mat = store.materials.get(b.id, 'pleasure')?.content || '';
    assert.ok(mat.length > 0, '应写 materials(pleasure)');
    assert.ok(!mat.includes('【快感计划】'), 'formatPleasurePlan 不应含"快感计划"字样（防 mock 串线）');
    // arc_plan 播种 story_arcs（mock 含"玉佩之谜"主线）
    const arcs = store.storyArcs.list(b.id);
    assert.ok(arcs.some(a => a.name.includes('玉佩') || a.name), '应播种 arc_plan 弧线');
  });

  test('④卷大纲 mock 不被注入的"快感"段串线', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { planBookPleasure } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
    const { generateVolumeOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/outline.js')));
    const b = store.books.create({ title: '串线书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    await planBookPleasure(b.id, {});
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const r = await generateVolumeOutline(b.id, v.id, { chapterCount: 6 });
    assert.ok(Array.isArray(r.chapters) && r.chapters.length > 0, '卷大纲应正常生成（不被快感 mock 串线）');
  });

  test('⑤pilot 骨架：设定后先建创作宪章再生成开篇蓝图，全流程走通', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pilot.js')));
    const b = store.books.create({ title: '骨架书', genre: '玄幻', blurb: '被废剑宗弟子捡玉佩' });
    const r = await runBookPilot(b.id, { targetChapters: 1 });
    assert.equal(r.written, 1, '应写完目标章');
    const book = store.books.get(b.id);
    const bp = JSON.parse(book.settings_json).openingBlueprint;
    assert.ok(bp?.hook_ladder?.length, 'pilot 后应有开篇蓝图');
    assert.ok(JSON.parse(book.settings_json).storyPromiseProfile, 'pilot 后应有创作宪章');
  });
});
