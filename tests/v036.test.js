// V0.36：跨卷章节 idx 冲突（UNIQUE constraint）修复——AI 卷大纲每卷 idx 从 1 开始，
// 直接插入与前面卷冲突导致 pilot 第二卷建章崩溃；改为全书全局连续 idx。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

describe('V0.36 跨卷章节 idx 全局连续', () => {
  test('生成两卷 → 第二卷章节 idx 从第一卷之后连续（不冲突）', async () => {
    process.env.NOVEL_MOCK_LLM = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v036-'));
    process.env.NOVEL_DATA_DIR = tmp;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '测试书', genre: '玄幻', blurb: 'x' });
    await outline.generateBookOutline(b.id, { volumeCount: 2 });
    const vols = store.volumes.list(b.id);
    // mock 书纲只返回 1 卷——手动补建卷2/卷3（真实场景书纲返回多卷）
    while (store.volumes.list(b.id).length < 3) {
      const n = store.volumes.list(b.id).length + 1;
      store.volumes.create(b.id, n, { title: `第${n}卷`, goal: '', outline: {}, status: 'planned' });
    }
    const volsAll = store.volumes.list(b.id);
    assert.ok(volsAll.length >= 3, `应有 3 卷，实际 ${volsAll.length}`);
    // 逐卷生成大纲（每卷 AI 输出 idx 从 1 开始——mock 的卷大纲数据）
    for (const v of store.volumes.list(b.id)) {
      await outline.generateVolumeOutline(b.id, v.id, { chapterCount: 4 });
    }
    const chs = store.chapters.list(b.id);
    const idxs = chs.map(c => c.idx);
    // idx 应严格连续且不重复
    const sorted = [...idxs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.equal(sorted[i], sorted[i - 1] + 1, `idx 应连续: ${sorted.join(',')}`);
    }
    assert.equal(new Set(idxs).size, idxs.length, 'idx 不应重复');
    assert.equal(idxs.length, 12, '3 卷 × 4 章（V0.107 mock 按请求章数返回）= 12 章');
    delete process.env.NOVEL_MOCK_LLM;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
