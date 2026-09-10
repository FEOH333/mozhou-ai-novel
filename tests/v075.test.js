// V0.75 通用化主角成长引擎 + 成长线偏离检测与补救桥段测试
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v075-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.75 通用化成长引擎与补救', () => {
  test('①growthSystemFor：各题材包有成长体系，未知题材返回兜底', async () => {
    const { growthSystemFor, DEFAULT_GROWTH_SYSTEM, GENRE_PACKS } = await import(pathToFileURL(path.join(ROOT, 'server/data/creative_packs.js')));
    for (const genre of Object.keys(GENRE_PACKS)) {
      const gs = growthSystemFor(genre);
      assert.ok(gs.dimension, `${genre} 应有成长维度`);
      assert.ok(Array.isArray(gs.ladder) && gs.ladder.length >= 2, `${genre} 应有阶梯`);
      assert.ok(Array.isArray(gs.progressVerbs) && gs.progressVerbs.length, `${genre} 应有进展动词`);
      assert.ok(Array.isArray(gs.stallMarks) && gs.stallMarks.length, `${genre} 应有停滞标记`);
      assert.ok(Array.isArray(gs.keyFields) && gs.keyFields.length, `${genre} 应有字段名`);
    }
    assert.deepEqual(growthSystemFor('不存在类型'), DEFAULT_GROWTH_SYSTEM, '未知题材应返回兜底');
    assert.ok(growthSystemFor('玄幻').ladder.includes('练气'), '玄幻阶梯应含练气');
  });

  test('②growthStatus：题材感知（玄幻/都市/言情不同维度，不出现修仙词）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { growthStatus } = await import(pathToFileURL(path.join(ROOT, 'server/engine/characters.js')));
    const x = store.books.create({ title: '玄幻书', genre: '玄幻', blurb: 'x' });
    store.characters.create(x.id, { name: '主角', tier: 'protagonist', state: { 境界: '练气一层' }, abilities: '[]' });
    const gx = growthStatus(x.id);
    assert.equal(gx.dimension, '境界');
    assert.equal(gx.stageIndex, 0, '练气一层应命中阶梯第0级');
    assert.ok(gx.text.includes('【主角成长状态】') && gx.text.includes('境界=练气一层'));
    const u = store.books.create({ title: '都市书', genre: '都市', blurb: 'x' });
    store.characters.create(u.id, { name: '主角', tier: 'protagonist', state: { 阶层: '底层' }, abilities: '[]' });
    const gu = growthStatus(u.id);
    assert.equal(gu.dimension, '阶层/实力');
    assert.ok(gu.text.includes('阶层=底层'));
    assert.ok(!gu.text.includes('修炼'), '都市书不应出现修仙词');
    const r = store.books.create({ title: '言情书', genre: '言情', blurb: 'x' });
    store.characters.create(r.id, { name: '主角', tier: 'protagonist', state: { 情感阶段: '暧昧' }, abilities: '[]' });
    const gr = growthStatus(r.id);
    assert.equal(gr.dimension, '情感阶段');
    assert.ok(gr.text.includes('情感阶段=暧昧'));
    const s = store.books.create({ title: '停滞书', genre: '玄幻', blurb: 'x' });
    store.characters.create(s.id, { name: '主角', tier: 'protagonist', state: { 丹田微流: '近干涸，仅剩蛛丝' }, abilities: '[]' });
    assert.equal(growthStatus(s.id).stagnant, true, '近干涸应判停滞');
    const p = store.books.create({ title: '进展书', genre: '玄幻', blurb: 'x' });
    store.characters.create(p.id, { name: '主角', tier: 'protagonist', state: { 实力: '突破至练气三层' }, abilities: '[]' });
    assert.equal(growthStatus(p.id).stagnant, false, '已突破不应判停滞');
  });

  test('③protagonistPowerStatus 兼容封装：结构不变', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { protagonistPowerStatus } = await import(pathToFileURL(path.join(ROOT, 'server/engine/characters.js')));
    const b = store.books.create({ title: '兼容书', genre: '玄幻', blurb: 'x' });
    store.characters.create(b.id, { name: '主角', tier: 'protagonist', state: { 境界: '练气二层' }, abilities: '[]' });
    const r = protagonistPowerStatus(b.id);
    assert.ok('realm' in r && 'powerLevel' in r && 'hasPower' in r && 'stagnant' in r, '应保持旧结构');
    assert.equal(r.realm, '练气二层');
  });

  test('④prompts 通用化：卷大纲含【成长规划】不含【修炼成长规划】', async () => {
    const { volumeOutlineInstruction, chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const v = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 1, volumeTitle: 'V', bookOutline: 'x', chapterCount: 6, growthDimension: '境界', growthExample: '练气→筑基', protagonistPower: '【主角成长状态】x' });
    assert.ok(v.includes('【成长规划】'), '应含【成长规划】');
    assert.ok(!v.includes('【修炼成长规划】'), '不应含旧【修炼成长规划】');
    assert.ok(v.includes('境界') && v.includes('练气→筑基'), '应含题材维度与示例');
    const c = chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1, powerStatus: '【主角成长状态】x', growthDimension: '境界', growthExample: '练气→筑基' });
    assert.ok(c.includes('【成长进展硬要求】'), '章细纲应含【成长进展硬要求】');
    assert.ok(!c.includes('【修炼进展硬要求】'), '章细纲不应含旧【修炼进展硬要求】');
    assert.ok(c.includes('境界'), '章细纲 goal 应含成长维度');
  });

  test('⑤parseGrowthPace：契约与题材包提取', async () => {
    const { parseGrowthPace } = await import(pathToFileURL(path.join(ROOT, 'server/engine/growth.js')));
    assert.deepEqual(parseGrowthPace('前10章必有打脸\n每10章至少一次境界突破或重大收获', '玄幻'), { everyChapters: 10, source: '契约' });
    assert.deepEqual(parseGrowthPace('每5章一次成长', '玄幻'), { everyChapters: 5, source: '契约' });
    // 玄幻题材包 rewardRhythm"每 5-8 章一次境界突破"→ 取 5（不应误取小爽点 1-2 章）
    assert.equal(parseGrowthPace('', '玄幻').everyChapters, 5, '题材包成长节奏应取突破而非小打脸');
    // 言情题材包 rewardRhythm"每 5-8 章一次关系里程碑"→ 取 5（里程碑在成长语义内）
    assert.deepEqual(parseGrowthPace('没有承诺', '言情'), { everyChapters: 5, source: '题材包' });
    // 都市题材包"每 6-8 章一次身份揭晓或大博弈"→ 不含突破/升级/成长/里程碑 → null（身份揭晓非成长维度）
    assert.equal(parseGrowthPace('没有承诺', '都市'), null);
  });

  test('⑥detectGrowthDeviation：117章停滞→severe；新书→不偏离；中期→非severe', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { detectGrowthDeviation } = await import(pathToFileURL(path.join(ROOT, 'server/engine/growth.js')));
    const nb = store.books.create({ title: '新书', genre: '玄幻', blurb: 'x' });
    const nv = store.volumes.create(nb.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 5; i++) store.chapters.create(nb.id, nv.id, i, { title: '第' + i + '章', status: 'done' });
    assert.equal(detectGrowthDeviation(nb.id).deviated, false, '新书不偏离');
    const b = store.books.create({ title: '长书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '每10章至少一次境界突破或重大收获');
    store.characters.create(b.id, { name: '主角', tier: 'protagonist', state: { 丹田微流: '近干涸' }, abilities: '[]' });
    const v2 = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 117; i++) store.chapters.create(b.id, v2.id, i, { title: '第' + i + '章', status: 'done' });
    const dev = detectGrowthDeviation(b.id);
    assert.equal(dev.deviated, true, '117章停滞应偏离');
    assert.equal(dev.severity, 'severe');
    assert.equal(dev.expectedStages, 11, '117章/10 = 11 次期望突破');
    assert.ok(dev.reason.includes('117 章'), 'reason 应含章数');
    const m = store.books.create({ title: '中期书', genre: '玄幻', blurb: 'x' });
    store.materials.set(m.id, 'contract', '每10章至少一次境界突破');
    store.characters.create(m.id, { name: '主角', tier: 'protagonist', state: { 境界: '练气三层' }, abilities: '[]' });
    const v3 = store.volumes.create(m.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 30; i++) store.chapters.create(m.id, v3.id, i, { title: '第' + i + '章', status: 'done' });
    assert.notEqual(detectGrowthDeviation(m.id).severity, 'severe', '30章且练气三层不应 severe');
  });

  test('⑦planRemedyBridge：mock 生成补救桥段并落库，幂等', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { planRemedyBridge, growthRemedyText } = await import(pathToFileURL(path.join(ROOT, 'server/engine/growth.js')));
    const b = store.books.create({ title: '补救书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '每10章至少一次境界突破');
    store.characters.create(b.id, { name: '主角', tier: 'protagonist', state: { 丹田微流: '近干涸' }, abilities: '[]' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 117; i++) store.chapters.create(b.id, v.id, i, { title: '第' + i + '章', status: 'done' });
    const rp = await planRemedyBridge(b.id, {});
    assert.equal(rp.planned, 1, '应生成补救桥段');
    const remedy = growthRemedyText(b.id);
    assert.ok(remedy, 'growth_remedy 材料应存在');
    assert.ok(remedy.includes('练气'), '补救桥段应含境界突破');
    assert.ok(remedy.includes('重新定义前文'), '应含重新定义前文');
    const rp2 = await planRemedyBridge(b.id, {});
    assert.equal(rp2.planned, 1);
    assert.ok(rp2.note.includes('跳过'), '第二次应跳过生成');
  });

  test('⑧compressProtagonistState：>30 键压缩，过时键删除', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { compressProtagonistState } = await import(pathToFileURL(path.join(ROOT, 'server/engine/growth.js')));
    const b = store.books.create({ title: '压缩书', genre: '玄幻', blurb: 'x' });
    const state = { 位置: '演武场', 境界: '练气一层', 心境: '坚定', 持有物: '钥匙' };
    for (let i = 0; i < 34; i++) state['过时键' + i] = '叙事';
    store.characters.create(b.id, { name: '主角', tier: 'protagonist', state, abilities: '[]' });
    const r = compressProtagonistState(b.id, {});
    assert.ok(r.dropped.length >= 30, `应删除过时键（实际 ${r.dropped.length}）`);
    const after = JSON.parse(store.characters.list(b.id).find(c => c.tier === 'protagonist').state_json);
    assert.ok(after['位置'] && after['境界'] && after['心境'], '应保留关键状态');
    assert.ok(!after['过时键0'], '应删除过时键');
  });

  test('⑨续卷注入：generateNextVolume 触发补救并注入 remedyText', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateNextVolume } = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));
    const { volumeOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const b = store.books.create({ title: '续卷补救书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '每10章至少一次境界突破');
    store.characters.create(b.id, { name: '主角', tier: 'protagonist', state: { 丹田微流: '近干涸' }, abilities: '[]' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g', status: 'outlined' });
    for (let i = 1; i <= 117; i++) {
      const ch = store.chapters.create(b.id, v.id, i, { title: '第' + i + '章', status: 'done' });
      store.summaries.set(ch.id, b.id, '剧情');
    }
    const events = [];
    const nv = await generateNextVolume(b.id, { onEvent: (ev) => events.push(ev.type) });
    assert.ok(nv.idx >= 2, '应续卷');
    assert.ok(events.includes('growth_remedy'), '应触发成长补救事件');
    const instr = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 2, volumeTitle: 'V2', bookOutline: 'x', chapterCount: 6, remedyText: '【成长补救桥段】枯井顿悟' });
    assert.ok(instr.includes('【成长补救桥段】'), '卷大纲指令应注入补救桥段');
  });

  test('⑩nextVolumeInstruction 支持 remedyText', async () => {
    const { nextVolumeInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const instr = nextVolumeInstruction({ bookTitle: 'T', contract: 'x', openForeshadows: [], worldview: 'w', lastVolume: '', lastTail: '', volumeCount: 1, chapterCount: 8, targetHint: '', bookVolumePlan: '', castText: '', socialEcology: '', prevReviewText: '', midReviewText: '', closurePlanText: '', remedyText: '【成长补救桥段】顿悟突破' });
    assert.ok(instr.includes('【成长补救桥段】'), '续卷指令应注入补救桥段');
    const empty = nextVolumeInstruction({ bookTitle: 'T', contract: 'x', openForeshadows: [], worldview: 'w', lastVolume: '', lastTail: '', volumeCount: 1, chapterCount: 8, targetHint: '', bookVolumePlan: '', castText: '', socialEcology: '', prevReviewText: '', midReviewText: '', closurePlanText: '', remedyText: '' });
    assert.ok(!empty.includes('【成长补救桥段】'), '空 remedyText 不注入');
  });
});
