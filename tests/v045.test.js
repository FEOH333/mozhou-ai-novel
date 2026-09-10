// V0.45 大纲对齐系统测试：三层检测器 + 修订器（mock）+ 幂等
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v045-'));

describe('V0.45 大纲对齐系统', () => {
  test('titleHitsText：中文窗口匹配（2-4 字）', async () => {
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    assert.equal(align.titleHitsText('第3章 药园风波', '李尘在药园里修垄，风波突起'), true, '整名应命中');
    assert.equal(align.titleHitsText('第3章 药园风波', '李尘白天修垄，夜晚风波突起'), true, '2 字窗口「风波」应命中');
    assert.equal(align.titleHitsText('第3章 药园风波', '范管事告知巡查队将至'), false, '无关内容不命中');
    assert.equal(align.titleHitsText('第3章', '任何内容'), null, '无有效标题返回 null');
    assert.equal(align.titleHitsText('卷3 宗门大比', '宗门大比盛况空前'), true, '卷名整名命中');
  });

  test('checkChapterAlignment：脱节检测（本地零成本）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    const b = store.books.create({ title: '对齐书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g' });
    const c1 = store.chapters.create(b.id, v.id, 1, { title: '第1章 药园风波', status: 'done' });
    const c2 = store.chapters.create(b.id, v.id, 2, { title: '第2章 大比开场', status: 'done' });
    store.summaries.set(c1.id, b.id, '李尘在药园修垄时风波突起');
    store.summaries.set(c2.id, b.id, '李尘白天修垄，范管事告知巡查队将至');
    assert.equal(align.checkChapterAlignment(b.id, c1.id).aligned, true, '章1 名字贴合内容');
    assert.equal(align.checkChapterAlignment(b.id, c2.id).aligned, false, '章2 大比开场 vs 修垄 → 脱节');
    // 无摘要不误报
    const c3 = store.chapters.create(b.id, v.id, 3, { title: '第3章 xxx', status: 'done' });
    assert.equal(align.checkChapterAlignment(b.id, c3.id).aligned, true, '无摘要不判断');
  });

  test('checkVolumeAlignment：卷名脱节 + goal_met 读取', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    const b = store.books.create({ title: '卷对齐书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: '宗门大比与秘境', goal: '大比夺魁' });
    const c1 = store.chapters.create(b.id, v.id, 1, { title: '第1章', status: 'done' });
    const c2 = store.chapters.create(b.id, v.id, 2, { title: '第2章', status: 'done' });
    store.summaries.set(c1.id, b.id, '李尘修垄，发现石缝记号');
    store.summaries.set(c2.id, b.id, '范管事警告巡查队将至');
    const r = align.checkVolumeAlignment(b.id, v.id);
    assert.equal(r.titleHits, false, '卷名宗门大比 vs 修垄内容 → 脱节');
    assert.equal(r.aligned, false, '卷级应判不对齐');
    // goal_met=false 时 aligned 也 false
    store.volumeReviews.upsert(b.id, v.idx, { grade: 'C', report: { goal_met: false } });
    const r2 = align.checkVolumeAlignment(b.id, v.id);
    assert.equal(r2.goalMet, false, 'goal_met 应读取');
    assert.equal(r2.aligned, false, 'goal_met=false 应判不对齐');
  });

  test('adjustChapterTitle / adjustVolumeTitle：mock 改名 + 日志', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    const b = store.books.create({ title: '改名书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g' });
    const c = store.chapters.create(b.id, v.id, 1, { title: '第1章 旧名', status: 'done' });
    store.summaries.set(c.id, b.id, '李尘在药园修垄');
    const r = await align.adjustChapterTitle(b.id, c.id, {});
    assert.ok(r, '应改名');
    assert.equal(r.oldTitle, '第1章 旧名');
    assert.ok(r.newTitle, '应有新名');
    assert.equal(store.chapters.get(c.id).title, r.newTitle, '章名已更新');
    // 卷改名
    const vr = await align.adjustVolumeTitle(b.id, v.id, {});
    assert.ok(vr, '卷应改名');
    assert.equal(store.volumes.get(v.id).title, vr.newTitle, '卷名已更新');
  });

  test('rewriteVolumeOutline：已写回填 + 未写重规划 + goal 更新（mock）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    const b = store.books.create({ title: '回填书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: '第一卷', goal: '旧目标', outline: { goal: '旧目标', arc: '旧arc', chapters: [] } });
    const c1 = store.chapters.create(b.id, v.id, 1, { title: '第1章', status: 'done', outline: { beat: '旧beat1' } });
    const c2 = store.chapters.create(b.id, v.id, 2, { title: '第2章', status: 'done', outline: { beat: '旧beat2' } });
    store.summaries.set(c1.id, b.id, '实际事件一：修垄发现石缝');
    store.summaries.set(c2.id, b.id, '实际事件二：巡查将至');
    const r = await align.rewriteVolumeOutline(b.id, v.id, {});
    assert.ok(r, '应重写');
    const vol = store.volumes.get(v.id);
    assert.equal(vol.goal, '实际达成的目标', 'goal 应更新为实际');
    const outline = JSON.parse(vol.outline_json || '{}');
    assert.ok(outline.chapters.length >= 2, '应有章节');
    const c1Now = store.chapters.get(c1.id);
    assert.ok((JSON.parse(c1Now.outline_json || '{}')).actual_beat, '已写章应回填 actual_beat');
  });

  test('rewriteBookOutline：书纲材料更新 + 未写卷名同步（mock）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    const b = store.books.create({ title: '书纲对齐书', genre: '玄幻', blurb: 'x' });
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g' });
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '第1章', status: 'done' });
    store.summaries.set(c1.id, b.id, '主角转生乞丐');
    const v2 = store.volumes.create(b.id, 2, { title: '第二卷', goal: 'g2', status: 'planned' });
    store.materials.set(b.id, 'outline', '【书级大纲】标题：书纲对齐书\n卷1：旧内容');
    store.materials.set(b.id, 'contract', '【书契约】核心卖点');
    const r = await align.rewriteBookOutline(b.id, {});
    assert.ok(r, '应对齐');
    const newText = store.materials.get(b.id, 'outline').content;
    assert.ok(newText.includes('第二卷'), '书纲应含卷规划');
    // 未写卷名同步（mock 返回第三卷——若 v2 在 mock 输出中则更新）
    const vols = store.volumes.list(b.id);
    assert.ok(vols.length >= 2, '卷数不变');
  });

  test('bookAlignDue：已写 >=3 卷且距上次对齐 >=3 才触发', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    const b = store.books.create({ title: '书级触发书', genre: '玄幻', blurb: 'x' });
    assert.equal(align.bookAlignDue(b.id), false, '无卷不触发');
    for (let i = 1; i <= 2; i++) {
      const v = store.volumes.create(b.id, i, { title: '卷' + i });
      const c = store.chapters.create(b.id, v.id, i, { title: '第' + i + '章', status: 'done' });
      store.summaries.set(c.id, b.id, '内容' + i);
    }
    assert.equal(align.bookAlignDue(b.id), false, '2 卷不触发');
    const v3 = store.volumes.create(b.id, 3, { title: '卷3' });
    const c3 = store.chapters.create(b.id, v3.id, 3, { title: '第3章', status: 'done' });
    store.summaries.set(c3.id, b.id, '内容3');
    assert.equal(align.bookAlignDue(b.id), true, '3 卷完成应触发');
  });
});
