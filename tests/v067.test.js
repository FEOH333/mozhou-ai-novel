// V0.67 卷体检补检机制测试：补检候选 + 体检驱动续卷调整
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v067-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const { reviewDueVolumes } = await import(pathToFileURL(path.join(ROOT, 'server/engine/volumereview.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));

describe('V0.67 卷体检补检', () => {
  test('①补检候选：failed 卷 + 写完未检卷；已检 done 卷不重复', () => {
    const b = store.books.create({ title: '补检书', genre: '玄幻' });
    const v1 = store.volumes.create(b.id, 1, { title: 'V1' });
    const v2 = store.volumes.create(b.id, 2, { title: 'V2' });
    const v3 = store.volumes.create(b.id, 3, { title: 'V3' });
    // v1：写完 + 已检 done
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: 'C1', status: 'done' });
    store.summaries.set(c1.id, b.id, 'x');
    store.volumeReviews.upsert(b.id, 1, { grade: 'B', report: {}, issues: [], status: 'done' });
    // v2：写完 + failed（解析失败待重试）
    const c2 = store.chapters.create(b.id, v2.id, 2, { title: 'C2', status: 'done' });
    store.summaries.set(c2.id, b.id, 'y');
    store.volumeReviews.upsert(b.id, 2, { grade: 'C', report: { parse_failed: true }, issues: [], status: 'failed' });
    // v3：写完但从未体检
    const c3 = store.chapters.create(b.id, v3.id, 3, { title: 'C3', status: 'done' });
    store.summaries.set(c3.id, b.id, 'z');
    const due = reviewDueVolumes(b.id);
    const idxs = due.map(d => d.idx).sort();
    assert.deepEqual(idxs, [2, 3], '应补检 failed 卷2 与未检卷3（卷1 已检不重复）');
    const r2 = due.find(d => d.idx === 2);
    assert.ok(r2.reason.includes('失败'), '卷2 原因=解析失败重试');
  });

  test('②nextVolumeInstruction 含体检反馈段（节奏问题+遗留工单→要求改进）', () => {
    const t = prompts.nextVolumeInstruction({
      bookTitle: 'T', contract: '', openForeshadows: [], worldview: '', lastVolume: 'V1', lastTail: '',
      volumeCount: 1, chapterCount: 8, targetHint: '', bookVolumePlan: '',
      prevReviewText: '节奏：中段两章稍平缓\n遗留工单（1 条）：第二章推进偏慢',
    });
    assert.ok(t.includes('【上一卷体检反馈'), '应含体检反馈段');
    assert.ok(t.includes('节奏：中段两章稍平缓'), '应含节奏问题');
    assert.ok(t.includes('明确改进'), '应要求针对性改进');
    // 无反馈时不出现
    const t2 = prompts.nextVolumeInstruction({
      bookTitle: 'T', contract: '', openForeshadows: [], worldview: '', lastVolume: 'V1', lastTail: '',
      volumeCount: 1, chapterCount: 8, targetHint: '', bookVolumePlan: '', prevReviewText: '',
    });
    assert.ok(!t2.includes('【上一卷体检反馈'), '无反馈时不含该段');
  });

  test('③pilot 每章对齐块含补体检调用（reviewDueVolumes）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pilot.js'), 'utf8');
    assert.ok(src.includes('reviewDueVolumes(bookId)'), 'pilot 应调用补检候选');
    assert.ok(src.includes('补体检：第'), '应有补体检事件');
  });
});
