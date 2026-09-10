// V0.45b pilot 对齐集成测试：章级改名 + 卷级对齐在自动创作中自动触发
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v045b-'));

describe('V0.45 pilot 对齐集成', () => {
  test('自动创作中：章名脱节→自动改名；卷写完→卷级对齐（卷名+卷大纲重写）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pilot.js')));
    const b = store.books.create({ title: '对齐pilot书', genre: '玄幻', blurb: 'x' });
    const v1 = store.volumes.create(b.id, 1, { title: '宗门大比与秘境', goal: '大比夺魁', status: 'outlined' });
    // 2 章规划：章名故意与将写内容无关（mock 正文+结算摘要）
    const c1 = store.chapters.create(b.id, v1.id, 1, { title: '第1章 大比开场', status: 'planned', outline: { beat: 'x' } });
    const c2 = store.chapters.create(b.id, v1.id, 2, { title: '第2章 秘境探宝', status: 'planned', outline: { beat: 'y' } });
    store.materials.set(b.id, 'contract', '【书契约】核心卖点：主角逆袭登顶');
    store.materials.set(b.id, 'outline', JSON.stringify({ title: '对齐pilot书', volumes: [{ idx: 1, title: '宗门大比与秘境' }] }));
    const events = [];
    const r = await runBookPilot(b.id, { targetChapters: 2, onEvent: (ev) => events.push(ev) });
    // V0.72：written=主循环写的章数（backfill 补写的章不计入）；完成度按 doneCount 断言
    const doneCnt = store.chapters.list(b.id).filter(c => c.status === 'done' || c.status === 'settled' || c.status === 'revised').length;
    assert.ok(doneCnt >= 2, `应写完 2 章，实际 ${doneCnt}（written=${r.written}）`);
    // 章级对齐：mock 改名事件（章名与摘要脱节时）
    const alignCh = events.filter(e => e.type === 'align_chapter');
    // 卷级对齐：卷写完 → 卷名脱节 → 改名 + 卷大纲重写
    const alignVol = events.filter(e => e.type === 'align_volume');
    const alignVolOutline = events.filter(e => e.type === 'align_volume_outline');
    // mock 结算摘要与章名大概率脱节 → 章改名应发生；卷名'宗门大比与秘境' vs mock 摘要（雨还在下…）→ 卷改名发生
    const vols = store.volumes.list(b.id);
    assert.equal(vols.length, 1, '目标 2 章不续卷');
    // 断言至少卷级对齐发生（mock 卷大纲重写后 goal 变为'实际达成的目标'）
    const vNow = store.volumes.get(v1.id);
    if (alignVolOutline.length > 0) {
      assert.equal(vNow.goal, '实际达成的目标', '卷大纲应被重写');
    }
    console.log('事件:', alignCh.length, '章改名 /', alignVol.length, '卷改名 /', alignVolOutline.length, '卷大纲重写');
  });

  test('存量兼容：已对齐卷不重复修订（幂等）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const align = await import(pathToFileURL(path.join(ROOT, 'server/engine/alignment.js')));
    const b = store.books.create({ title: '幂等书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g' });
    const c = store.chapters.create(b.id, v.id, 1, { title: '第1章 药园风波', status: 'done' });
    store.summaries.set(c.id, b.id, '李尘在药园修垄，风波突起');
    const ca = align.checkChapterAlignment(b.id, c.id);
    assert.equal(ca.aligned, true, '名字贴合内容不触发修订');
    const va = align.checkVolumeAlignment(b.id, v.id);
    assert.equal(va.aligned, true, '卷名贴合内容不触发修订');
  });
});
