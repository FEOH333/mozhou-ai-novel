// V0.76 世界观阶梯展开：worldScale 题材包 + 展开状态检测 + 停滞补救 + settle 登场记录
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v076-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

/** 造一本 N 章 done 的书（章 idx 全局连续） */
function makeBook(store, { title = '世界书', genre = '玄幻', chapters = 5, locations = [], factions = [] } = {}) {
  const b = store.books.create({ title, genre, blurb: 'x' });
  store.materials.set(b.id, 'contract', '【书契约】每10章至少一次境界突破');
  store.materials.set(b.id, 'outline', JSON.stringify({ title, volumes: [{ idx: 1 }] }));
  for (const l of locations) {
    const loc = store.locations.create(b.id, { name: l.name, card: { detail: l.detail || '' } });
    if (l.firstChapter != null) store.locations.update(loc.id, { firstChapter: l.firstChapter });
  }
  for (const f of factions) store.factions.create(b.id, { name: f.name, card: { detail: f.detail || '' } });
  const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g', status: 'outlined' });
  for (let i = 1; i <= chapters; i++) {
    const ch = store.chapters.create(b.id, v.id, i, { title: '第' + i + '章', status: 'done' });
    store.summaries.set(ch.id, b.id, '剧情');
  }
  return b;
}

describe('V0.76 世界观阶梯展开', () => {
  test('①worldScaleFor：各题材有世界版图阶梯，未知题材返回兜底', async () => {
    const { worldScaleFor, DEFAULT_WORLD_SCALE, GENRE_PACKS } = await import(pathToFileURL(path.join(ROOT, 'server/data/creative_packs.js')));
    for (const genre of Object.keys(GENRE_PACKS)) {
      const ws = worldScaleFor(genre);
      assert.ok(ws.dimension, `${genre} 应有维度`);
      assert.ok(ws.ladder.length >= 5, `${genre} 应有 ≥5 层阶梯`);
      assert.equal(ws.ladderKeywords.length, ws.ladder.length, `${genre} 阶梯与关键词应一一对应`);
      assert.ok(ws.progressVerbs.length && ws.stallMarks.length && ws.progressMarks.length, `${genre} 应有动词/停滞/进展词`);
    }
    assert.deepEqual(worldScaleFor('不存在类型'), DEFAULT_WORLD_SCALE, '未知题材应返回兜底');
    assert.ok(worldScaleFor('玄幻').ladder.includes('宗门') && worldScaleFor('玄幻').ladder.includes('大陆三大宗门/皇朝'), '玄幻阶梯应含宗门与大陆');
  });

  test('②worldExpansionStatus：层级检测（低层级停滞→severe；高层级已展开→不停滞）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { worldExpansionStatus } = await import(pathToFileURL(path.join(ROOT, 'server/engine/world_expansion.js')));
    // 117 章 + 青阳镇(level0) + 青云宗(level1, 首现) → 停滞 severe
    const b1 = makeBook(store, { chapters: 117, locations: [{ name: '青阳镇', firstChapter: 1 }, { name: '青云宗', firstChapter: 2 }] });
    const s1 = worldExpansionStatus(b1.id);
    assert.equal(s1.currentLevel, 1, '当前应停在宗门级');
    assert.equal(s1.nextLabel, '大陆三大宗门/皇朝', '下一层应为大陆');
    assert.equal(s1.stagnant, true);
    assert.equal(s1.severity, 'severe');
    assert.ok(s1.text.includes('世界展开状态') && s1.text.includes('严重未展开'));
    // 高层级已登场（天罗皇朝 firstChapter=115）→ 不停滞
    const b2 = makeBook(store, { chapters: 117, locations: [{ name: '青阳镇', firstChapter: 1 }, { name: '青云宗', firstChapter: 2 }, { name: '天罗皇朝', firstChapter: 115 }] });
    const s2 = worldExpansionStatus(b2.id);
    assert.equal(s2.currentLevel, 2, '应推进到皇朝级');
    assert.equal(s2.stagnant, false, '已展开大陆级不应判停滞');
    // 新书（5 章）不判
    const b3 = makeBook(store, { chapters: 5 });
    const s3 = worldExpansionStatus(b3.id);
    assert.equal(s3.stagnant, false);
    assert.equal(s3.severity, 'none');
  });

  test('③worldExpansionStatus：题材感知（都市/言情不出现修仙词）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { worldExpansionStatus } = await import(pathToFileURL(path.join(ROOT, 'server/engine/world_expansion.js')));
    const b = makeBook(store, { genre: '都市', chapters: 60, locations: [{ name: '海州市', firstChapter: 1 }, { name: '云顶集团', firstChapter: 40 }] });
    const s = worldExpansionStatus(b.id);
    assert.equal(s.dimension, '世界版图');
    assert.ok(s.text.includes('都市') || !s.text.includes('修炼'), '都市书不应有修仙语境');
    assert.ok(s.ladder.includes('一线都市'), '都市阶梯应含一线都市');
  });

  test('④prompts 注入：卷大纲含【世界展开规划】硬约束', async () => {
    const { volumeOutlineInstruction, chapterOutlineInstruction, nextVolumeInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const v = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 1, volumeTitle: 'V', bookOutline: 'x', chapterCount: 6, worldExpansion: '【世界展开状态】当前宗门级' });
    assert.ok(v.includes('【世界展开规划】'), '卷大纲应含【世界展开规划】');
    assert.ok(v.includes('禁止整卷困在同一小地域'), '应含硬约束文案');
    const v2 = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 1, volumeTitle: 'V', bookOutline: 'x', chapterCount: 6 });
    assert.ok(!v2.includes('【世界展开规划】'), '无 worldExpansion 不注入');
    const c = chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1, worldExpansion: '【世界展开提示】当前宗门级' });
    assert.ok(c.includes('【世界展开提示】'), '章细纲应含世界展开提示');
    const n = nextVolumeInstruction({ bookTitle: 'T', contract: 'x', openForeshadows: [], worldview: 'w', lastVolume: '', lastTail: '', volumeCount: 1, chapterCount: 8, targetHint: '', bookVolumePlan: '', castText: '', socialEcology: '', prevReviewText: '', midReviewText: '', closurePlanText: '', worldRemedyText: '【世界展开补救桥段】跃迁' });
    assert.ok(n.includes('【世界展开补救桥段】'), '续卷应含世界补救桥段');
  });

  test('⑤detectWorldStagnation：<30 章不判；117 章停滞→true', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { detectWorldStagnation } = await import(pathToFileURL(path.join(ROOT, 'server/engine/world_expansion.js')));
    const nb = makeBook(store, { chapters: 20 });
    assert.equal(detectWorldStagnation(nb.id).stagnant, false, '20章不判停滞');
    const b = makeBook(store, { chapters: 117, locations: [{ name: '青阳镇', firstChapter: 1 }, { name: '青云宗', firstChapter: 2 }] });
    assert.equal(detectWorldStagnation(b.id).stagnant, true, '117章低层级应判停滞');
  });

  test('⑥planWorldExpansion：mock 生成补救并落库，幂等', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { planWorldExpansion, worldProgressText } = await import(pathToFileURL(path.join(ROOT, 'server/engine/world_expansion.js')));
    const b = makeBook(store, { chapters: 117, locations: [{ name: '青阳镇', firstChapter: 1 }, { name: '青云宗', firstChapter: 2 }] });
    const rp = await planWorldExpansion(b.id, {});
    assert.equal(rp.planned, 1, '应生成补救');
    const remedy = worldProgressText(b.id);
    assert.ok(remedy, 'world_progress 材料应存在');
    assert.ok(remedy.includes('相邻层级展开') && remedy.includes('宗门'), '补救应沿相邻层级自然展开');
    const rp2 = await planWorldExpansion(b.id, {});
    assert.equal(rp2.planned, 1);
    assert.ok(rp2.note.includes('跳过'), '第二次应跳过');
  });

  test('⑦generateNextVolume：117章停滞→触发 world_progress + 注入补救', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateNextVolume } = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));
    const { volumeOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const b = makeBook(store, { chapters: 117, locations: [{ name: '青阳镇', firstChapter: 1 }, { name: '青云宗', firstChapter: 2 }] });
    const events = [];
    const nv = await generateNextVolume(b.id, { onEvent: (ev) => events.push(ev.type) });
    assert.ok(nv.idx >= 2, '应续卷');
    assert.ok(events.includes('world_progress'), '应触发世界展开补救事件');
    const instr = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 2, volumeTitle: 'V2', bookOutline: 'x', chapterCount: 6, worldRemedyText: '【世界展开补救桥段】跃迁' });
    assert.ok(instr.includes('【世界展开补救桥段】'), '卷大纲指令应注入世界补救');
  });

  test('⑧settle touchEntities：记录地点/势力登场章节', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { settleChapter } = await import(pathToFileURL(path.join(ROOT, 'server/engine/settle.js')));
    const b = store.books.create({ title: '结算书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第1章', status: 'planned' });
    const loc = store.locations.create(b.id, { name: '青云宗', card: { detail: 'x' } });
    const scene = store.scenes.create(ch.id, 1, { content: '他走进青云宗的山门。', status: 'done' });
    store.scenes.update(scene.id, { content: '他走进青云宗的山门。' });
    store.chapters.update(ch.id, { outline: { scenes: [{ beat: 'x' }] } });
    // 直接调 settleChapter（用 mock data 注入）
    await settleChapter(b.id, ch.id, { data: { facts: [], character_updates: [], timeline: [], foreshadow_actions: [], new_entities: [], summary: 'x', rolling_update: 'x' } });
    const locAfter = store.locations.get(loc.id);
    assert.ok(locAfter.first_chapter != null, '地点应记录首现章节');
  });

  test('⑨ensureEntityChaptersBackfilled：存量书回填 first_chapter，幂等', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { ensureEntityChaptersBackfilled } = await import(pathToFileURL(path.join(ROOT, 'server/engine/world_expansion.js')));
    const b = store.books.create({ title: '存量书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch1 = store.chapters.create(b.id, v.id, 1, { title: '第1章', status: 'done' });
    const ch2 = store.chapters.create(b.id, v.id, 2, { title: '第2章', status: 'done' });
    store.scenes.create(ch1.id, 1, { content: '他来到青阳镇。', status: 'done' });
    store.scenes.create(ch2.id, 1, { content: '青云宗山门。', status: 'done' });
    const loc = store.locations.create(b.id, { name: '青阳镇', card: { detail: 'x' } });
    assert.equal(store.locations.get(loc.id).first_chapter, null, '初始无首现章节');
    const did = ensureEntityChaptersBackfilled(b.id);
    assert.equal(did, true, '应执行回填');
    assert.equal(store.locations.get(loc.id).first_chapter, 1, '应回填首现章节 1');
    const did2 = ensureEntityChaptersBackfilled(b.id);
    assert.equal(did2, false, '再次调用应幂等 no-op');
  });

  test('⑩书级大纲 worldScaleText 防新书困局', async () => {
    const { bookOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const instr = bookOutlineInstruction({ genre: '玄幻', blurb: 'x', hook: 'h', volumes: 4, genreText: '', worldScaleText: '出生小镇→宗门→大陆三大宗门/皇朝→秘境→异界/最终舞台' });
    assert.ok(instr.includes('世界版图随卷逐级展开'), '书级大纲应含世界展开要求');
    assert.ok(instr.includes('出生小镇→宗门'), '应含题材阶梯');
  });
});
