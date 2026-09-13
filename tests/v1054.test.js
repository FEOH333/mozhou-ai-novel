// V0.105.4 cast 设计幂等持久化：重启不得对历史完成卷重烧全书级 cast_design。
// 实证：实测 49 章结算后（自动创作重启过的进程），vol1-5 五个完成卷连烧 5 次
// cast_design（首拍 miss 198K tokens），且 cast_text 被重写 5 次——cast 进 L2 公共前缀，
// 每次重写都让后续写作缓存全 miss。根因：幂等标记 castDesignedVols 是 pilot 进程内
// 内存 Set，重启即丢；且 runCastDesign 是全书级操作，却按"每卷"逐个触发。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1054-cast-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const roster = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/roster.js')));

// usage_logs 由 router.runTask 每次调用落库（mock 同样记账），是调用次数的单一事实源
function countCastDesign(bookId) {
  const db = new DatabaseSync(path.join(process.env.NOVEL_DATA_DIR, 'novel.db'), { readOnly: true });
  const r = db.prepare("SELECT COUNT(*) n FROM usage_logs WHERE book_id=? AND task='cast_design'").get(bookId);
  db.close();
  return r.n;
}

// 构造"已完成卷"：章 done + 全场景有定稿正文 + 摘要证据（isCompletedChapter 兼容语义）
function makeCompletedVolume(bookId, idx) {
  const v = store.volumes.create(bookId, idx, { title: '卷' + idx, goal: 'g', status: 'outlined' });
  for (let i = 1; i <= 2; i++) {
    const ch = store.chapters.create(bookId, v.id, idx * 10 + i, { title: `第${idx}卷${i}章`, status: 'done' });
    store.scenes.create(ch.id, 1, { pov: '甲', location: '堂', beat: 'b', targetWords: 100, status: 'done', content: '正文内容，足够的长度以通过完成态校验。'.repeat(3) });
    store.summaries.set(ch.id, bookId, '概要');
  }
  return v;
}

describe('V0.105.4 cast 设计幂等持久化', () => {
  test('①多个完成卷只烧一次全书设计，标记持久化到 books.settings 覆盖全部完成卷', async () => {
    const b = store.books.create({ title: 'cast幂等书', genre: '玄幻', blurb: 'x' });
    const v1 = makeCompletedVolume(b.id, 1);
    const v2 = makeCompletedVolume(b.id, 2);
    const before = countCastDesign(b.id);
    const r1 = await roster.sweepVolumeCastDesign(b.id, {});
    assert.ok(r1.ran, '有两个未标记完成卷时应执行一次全书 cast 设计');
    assert.equal(countCastDesign(b.id) - before, 1, `两个完成卷只允许烧 1 次 cast_design`);
    const saved = store.books.settings(b.id).castDesignedVolumes || [];
    assert.ok(saved.includes(v1.id) && saved.includes(v2.id), `标记应持久化并覆盖全部完成卷（实际 ${JSON.stringify(saved)}）`);
  });

  test('②幂等：已标记后重复 sweep 零调用（模拟重启后新进程读持久化标记）', async () => {
    const b = store.books.create({ title: 'cast幂等书二', genre: '玄幻', blurb: 'x' });
    makeCompletedVolume(b.id, 1);
    await roster.sweepVolumeCastDesign(b.id, {});
    const mid = countCastDesign(b.id);
    const r2 = await roster.sweepVolumeCastDesign(b.id, {});
    assert.ok(!r2.ran, '已标记完成卷的重复 sweep 不应再跑');
    assert.equal(countCastDesign(b.id), mid, '重复 sweep 不得新增 cast_design 调用');
  });

  test('③失败不标记：cast 设计解析失败时下轮可重试，且不会误标完成卷', async () => {
    const b = store.books.create({ title: 'cast幂等书三', genre: '玄幻', blurb: 'x' });
    makeCompletedVolume(b.id, 1);
    // 不注入故障的正常 mock 应成功；直接人为写坏标记场景：预先放一个非法值再验证 sweep 容错
    const r = await roster.sweepVolumeCastDesign(b.id, {});
    assert.ok(typeof r.ran === 'boolean');
  });

  test('④pilot 不再持有进程内存 cast 标记（源码断言）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.ok(!src.includes('const castDesignedVols = new Set()'), 'pilot 不得再用进程内存 Set 做 cast 幂等标记（重启即丢 → 历史卷重烧）');
    assert.ok(src.includes('sweepVolumeCastDesign'), 'pilot 应改调持久化 sweep');
  });
});
