// V0.44 续卷测试：generateNextVolume 冒烟 + pilot 自动续卷集成（追加到 v044）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v044b-'));

describe('V0.44 自动续卷', () => {
  test('generateNextVolume：建新卷+全局 idx 连续+承接上下文', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const cont = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/continuation.js')));
    const b = store.books.create({ title: '续卷书', genre: '玄幻', blurb: 'x' });
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g', status: 'outlined' });
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '第1章', status: 'done' });
    const c2 = store.chapters.create(b.id, v1.id, 2, { title: '第2章', status: 'done' });
    store.scenes.create(c1.id, 1, { content: '正文一'.repeat(500), status: 'done' });
    store.scenes.create(c2.id, 1, { content: '正文二'.repeat(500), status: 'done' });
    store.summaries.set(c2.id, b.id, '主角突破，留下新悬念');
    store.materials.set(b.id, 'contract', '【书契约】核心卖点：主角逆袭登顶');
    store.materials.set(b.id, 'world', '世界观：青云大陆');
    store.foreshadows.create(b.id, { desc: '玉佩的秘密', status: 'planted' });
    const nv = await cont.generateNextVolume(b.id, {});
    assert.ok(nv.idx >= 2, '新卷 idx 应递增');
    assert.ok(nv.title, '应有卷名');
    assert.ok(nv.chapterCount >= 6 && nv.chapterCount <= 15, '章数应在 6-15 区间');
    const vols = store.volumes.list(b.id);
    assert.equal(vols.length, 2, '应有 2 卷');
    const chs = store.chapters.list(b.id);
    const idxs = chs.map(c => c.idx);
    const sorted = [...idxs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i], sorted[i - 1] + 1, `idx 连续: ${sorted.join(',')}`);
    // 续卷卷大纲应承接上下文（mock 卷大纲正常生成）
    const v2Chs = store.chapters.listByVolume(vols[1].id);
    assert.ok(v2Chs.length > 0, '新卷应有章节');
  });

  test('pilot 自动续卷集成：写完规划→判定未完→续卷→继续写直到目标章数', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pilot.js')));
    const b = store.books.create({ title: 'pilot续卷书', genre: '玄幻', blurb: 'x' });
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g', status: 'outlined' });
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '第1章', status: 'planned', outline: { beat: 'x' } });
    store.materials.set(b.id, 'contract', '【书契约】核心卖点：主角逆袭登顶');
    store.materials.set(b.id, 'outline', JSON.stringify({ title: 'pilot续卷书', volumes: [{ idx: 1 }] }));
    // 目标 6 章：写完 1 章 → 续卷（mock 未完本）→ 卷2 2 章 → 续卷 → 卷3 2 章 → 达 6 章停
    const events = [];
    const r = await runBookPilot(b.id, { targetChapters: 6, onEvent: (ev) => events.push(ev) });
    // V0.72：written=主循环写的章数（backfill 补写的章不计入）；完成度按 doneCount 断言
    const doneCnt = store.chapters.list(b.id).filter(c => c.status === 'done' || c.status === 'settled' || c.status === 'revised').length;
    const eventTail = events.slice(-20).map(event => ({
      type: event.type,
      stage: event.stage,
      idx: event.idx,
      message: event.message,
      error: event.error,
    }));
    assert.ok(doneCnt >= 6, `应完成目标 6 章，实际 ${doneCnt}（written=${r.written}）；事件尾迹=${JSON.stringify(eventTail)}`);
    const chs = store.chapters.list(b.id);
    assert.ok(chs.length >= 6, `总章数应 ≥6，实际 ${chs.length}`);
    const vols = store.volumes.list(b.id);
    assert.ok(vols.length >= 2, `应发生续卷（≥2 卷），实际 ${vols.length}`);
    const contEvents = events.filter(e => e.type === 'continuation');
    assert.ok(contEvents.length >= 1, '应发出 continuation 事件');
    const recoveryEvents = events.filter(e => e.type === 'recovery_done_all');
    for (let i = 1; i < recoveryEvents.length; i++) {
      assert.ok(
        recoveryEvents[i].atChapter - recoveryEvents[i - 1].atChapter >= 3,
        `两次恢复之间应至少观察 3 个新章节：${JSON.stringify(recoveryEvents)}`,
      );
    }
    const doneEv = events.filter(e => e.type === 'done').at(-1);
    assert.ok(doneEv, '应有 done 事件');
    assert.equal(doneEv.total, 6, '进度总数必须保留用户目标，不能把提前停止的 5/6 缩成 5/5');
    assert.equal(doneEv.reachedTarget, true);
  });

  test('pilot 完本路径：AI 判定完本→不续卷', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pilot.js')));
    const b = store.books.create({ title: '完本pilot书', genre: '玄幻', blurb: 'x' });
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g', status: 'outlined' });
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '第1章', status: 'done' });
    // 造 20 万字以上（本地规则字数门槛），才能走到 AI 完本评估
    for (let i = 0; i < 100; i++) store.scenes.create(c1.id, i + 1, { content: 'a'.repeat(2000), status: 'done' });
    // 契约含 mock 完本关键词
    store.materials.set(b.id, 'contract', '【书契约】主角已达成核心目标，故事收束');
    store.materials.set(b.id, 'outline', JSON.stringify({ title: '完本pilot书', volumes: [{ idx: 1 }] }));
    const events = [];
    await runBookPilot(b.id, { onEvent: (ev) => events.push(ev) });
    const doneEv = events.find(e => e.type === 'book_done');
    assert.ok(doneEv, '应发出 book_done（AI 判定完本）');
    const vols = store.volumes.list(b.id);
    assert.equal(vols.length, 1, '完本判定后不应续卷');
  });
});
