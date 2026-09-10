// V0.41：卷级整体审阅——卷体检引擎/幂等/补审适配/工单修订/pilot 接线
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 必须在任何 server 模块加载前设置（store.js 在模块加载时读取 NOVEL_DATA_DIR）
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v041-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();

async function makeBook() {
  const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
  const b = store.books.create({ title: '卷审书', genre: '玄幻', blurb: 'x' });
  return { store, b };
}

describe('V0.41 卷级整体审阅', () => {
  test('runVolumeReview：体检落库 + 工单自动修订 + 幂等', async () => {
    const { store, b } = await makeBook();
    const v = store.volumes.create(b.id, 1, { title: '第一卷', goal: '下山', status: 'outlined' });
    const c1 = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'done' });
    const c2 = store.chapters.create(b.id, v.id, 2, { title: '第二章', status: 'done' });
    store.summaries.set(c1.id, b.id, '主角下山遇敌');
    store.summaries.set(c2.id, b.id, '主角立威');
    store.scenes.create(c1.id, 1, { content: '第一章正文', status: 'done' });
    store.scenes.create(c2.id, 1, { content: '第二章正文', status: 'done' });
    const { runVolumeReview } = await import(pathToFileURL(path.join(ROOT, 'server/engine/volumereview.js')));
    const r = await runVolumeReview(b.id, v.id, {});
    assert.equal(r.grade, 'B', 'mock 应返回 B 级');
    assert.equal(r.issues.length, 1, 'mock 应带 1 条 P1 工单');
    const rec = store.volumeReviews.list(b.id);
    assert.equal(rec.length, 1, '审阅记录落库');
    assert.equal(rec[0].grade, 'B');
    assert.equal(rec[0].revised_count, 1, 'P1 工单应自动修订第 2 章');
    // 幂等：重审覆盖不重复
    await runVolumeReview(b.id, v.id, {});
    assert.equal(store.volumeReviews.list(b.id).length, 1, '重审不新增记录');
  });

  test('autoReviewVolumes：只审已完成卷 + 已审跳过 + 写一半适配', async () => {
    const { store, b } = await makeBook();
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', status: 'outlined' });
    const v2 = store.volumes.create(b.id, 2, { title: '第二卷', status: 'outlined' });
    // 卷1完成、卷2写一半
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '第一章', status: 'done' });
    store.summaries.set(c1.id, b.id, '第一卷内容');
    store.scenes.create(c1.id, 1, { content: '正文', status: 'done' });
    const c3 = store.chapters.create(b.id, v2.id, 2, { title: '第二章', status: 'done' });
    store.summaries.set(c3.id, b.id, '第二卷第一章');
    store.scenes.create(c3.id, 1, { content: '正文2', status: 'done' });
    const c4 = store.chapters.create(b.id, v2.id, 3, { title: '第三章', status: 'planned' }); // 未完成
    const { autoReviewVolumes } = await import(pathToFileURL(path.join(ROOT, 'server/engine/volumereview.js')));
    const results = await autoReviewVolumes(b.id, {});
    assert.equal(results.length, 1, '只审完成的卷1');
    assert.equal(results[0].volumeIdx, 1);
    // 再次调用：已审跳过（幂等）
    const again = await autoReviewVolumes(b.id, {});
    assert.equal(again.length, 0, '已审不重审');
    // 补全卷2 → 可审
    store.chapters.update(c4.id, { status: 'done' });
    store.summaries.set(c4.id, b.id, '卷2第三章');
    store.scenes.create(c4.id, 1, { content: '正文3', status: 'done' });
    const r2 = await autoReviewVolumes(b.id, {});
    assert.equal(r2.length, 1, '卷2补全后可补审');
    assert.equal(r2[0].volumeIdx, 2);
  });

  test('buildVolumeReviewContext：输入组装含章节摘要/伏笔/上一卷衔接', async () => {
    const { store, b } = await makeBook();
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', goal: '下山', status: 'outlined' });
    const v2 = store.volumes.create(b.id, 2, { title: '第二卷', goal: '入城', status: 'outlined' });
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '下山', status: 'done' });
    store.summaries.set(c1.id, b.id, '主角下山遇敌');
    store.scenes.create(c1.id, 1, { content: '第一章正文结尾的钩子内容', status: 'done' });
    const c2 = store.chapters.create(b.id, v2.id, 2, { title: '入城', status: 'done' });
    store.summaries.set(c2.id, b.id, '主角入城');
    store.scenes.create(c2.id, 1, { content: '第二章正文', status: 'done' });
    store.foreshadows.create(b.id, { desc: '玉佩的秘密', plantedChapter: 2 });
    const { buildVolumeReviewContext } = await import(pathToFileURL(path.join(ROOT, 'server/engine/volumereview.js')));
    const ctx = buildVolumeReviewContext(b.id, v2);
    assert.ok(ctx.chapterLines.includes('第2章《入城》'), '应含本卷章节摘要');
    assert.ok(ctx.foreshadowLines.includes('玉佩的秘密'), '应含本卷伏笔');
    assert.ok(ctx.prevVolumeTail.includes('下山'), '应含上一卷末章衔接');
    assert.ok(ctx.volumeGoal.includes('入城'), '应含卷目标');
  });

  test('pilot 接线静态断言（补审 + 卷末自动审阅）', () => {
    const p = fs.readFileSync(path.join(ROOT, 'server/engine/pilot.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const ol = fs.readFileSync(path.join(ROOT, 'web/js/views/outline.js'), 'utf8');
    assert.ok(p.includes('autoReviewVolumes'), 'pilot 应导入补审');
    assert.ok(p.includes("volumeReviews.byVolume"), 'pilot 应查卷审阅幂等');
    assert.ok(p.includes('volume_review_done'), 'pilot 应发卷审事件');
    assert.ok(idx.includes("'/api/books/:id/volume-reviews'"), '应有审阅查询 API');
    assert.ok(ol.includes('体检'), '前端应有体检徽章');
    assert.ok(ol.includes('补审已完成卷'), '前端应有补审按钮');
  });
});
