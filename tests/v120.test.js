// V0.93 卷对齐：只认定稿正文，不继承前期卷的错误结局字段
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v120-align-'));

const store = await import('../server/db/store.js');
const alignment = await import('../server/engine/alignment.js');

describe('V0.93 卷纲按实际正文对齐', () => {
  test('planned 章不进入 doneChapters，也不得写入 actual_beat', async () => {
 const book = store.books.create({ title: '示例历史长篇', genre: '历史' });
    const volume = store.volumes.create(book.id, 1, {
      title: '山城余火', goal: '筑城成长',
      outline: {
        lifecycle_stage: 'opening', goal: '旧目标', arc: '旧弧线',
        ending_delivery: { historical_settlement: '南宋虽灭，崖山以后余脉犹存' }, chapters: [],
      },
    });
    const done = store.chapters.create(book.id, volume.id, 1, {
      title: '灰烬生根', status: 'done', outline: { beat: '实际成长' },
    });
    const planned = store.chapters.create(book.id, volume.id, 2, {
      title: '城火长明', status: 'planned', outline: { beat: '尚未发生' },
    });
 store.summaries.set(done.id, book.id, '主角完成安葬并留营。');

    const result = await alignment.rewriteVolumeOutline(book.id, volume.id);

    assert.equal(result.doneChapters, 1);
    assert.ok(store.chapters.outline(done.id).actual_beat);
    assert.equal(Object.hasOwn(store.chapters.outline(planned.id), 'actual_beat'), false);
    assert.deepEqual(JSON.parse(store.volumes.get(volume.id).outline_json).ending_delivery, {});
  });

  test('revised 且正文完整的卷可被识别为已完成', () => {
    const book = store.books.create({ title: '修订卷', genre: '历史' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '修订章', status: 'revised' });
    store.scenes.create(chapter.id, 1, { content: '修订后的完整正文。', status: 'revised' });
    store.summaries.set(chapter.id, book.id, '修订章摘要');
    assert.equal(typeof alignment.isVolumeComplete, 'function');
    assert.equal(alignment.isVolumeComplete(volume), true);
  });

  test('自动创作显式导入对齐幂等函数，且对齐失败可在下次运行重试', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/engine/pilot.js'), 'utf8');
    assert.match(source, /volumeAlignedRecently/);
    assert.match(source, /checkVolumeAlignment[\s\S]{0,180}volumeAlignedRecently/);
    assert.match(source, /if \(volDone/);
    assert.match(source, /if \(!alreadyAligned\)[\s\S]{0,2400}rewriteVolumeOutline/);
  });
});
