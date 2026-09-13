// V0.81 历史古代题材专项超级加强
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v089-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.81 历史题材专项', () => {
  test('①历史题材包完整：growthSystem官位 + worldScale五层 + 挫折/蛰伏词', async () => {
    const packs = await import(pathToFileURL(path.join(ROOT, 'server/data/creative_packs.js')));
    const g = packs.genrePack('历史');
    assert.ok(g, '历史题材包应存在');
    assert.equal(packs.growthSystemFor('历史').dimension, '官位/军功/统兵');
    assert.equal(packs.growthSystemFor('历史').ladder[0], '白身');
    assert.ok(packs.growthSystemFor('历史').setbacks.length >= 5, '应含挫折节点');
    assert.ok(packs.growthSystemFor('历史').hiddenPowerMarks.length >= 5, '应含蛰伏藏拙词');
    assert.ok(packs.growthSystemFor('历史').longStages.includes('白身'), '白身应为长期蛰伏阶段');
    assert.equal(packs.worldScaleFor('历史').ladder.length, 5, 'worldScale 5 层');
    assert.ok(packs.worldScaleFor('历史').ladder.includes('战区'), '应含战区层');
    assert.ok(packs.genrePackText('历史').includes('史实'), '注入文本含史实');
  });

  test('②历史考据数据完整：方法论/宋末种子/红线/诗词库', async () => {
    const d = await import(pathToFileURL(path.join(ROOT, 'server/data/history.js')));
    assert.ok(d.HISTORY_METHODOLOGY.includes('大框架符合历史'), '考据方法论');
    assert.ok(d.SONG_MO_SEED.realPeople.some(p => p.includes('余玠')), '宋末种子含余玠');
    assert.ok(d.SONG_MO_SEED.realPeople.some(p => p.includes('蒙哥')), '宋末种子含蒙哥');
    assert.ok(d.SONG_MO_SEED.alterableHistory.includes('蒙哥之死'), '含可改史点');
    assert.ok(d.RED_LINES.some(r => r.term === '烟草'), '红线含烟草');
    assert.ok(d.POETRY_LIB.some(p => p.author === '辛弃疾'), '诗词库含辛弃疾');
    assert.ok(d.POETRY_LIB.some(p => p.author === '文天祥'), '诗词库含文天祥');
    assert.ok(d.POETRY_DISCIPLINE.includes('不贴切宁可不用'), '诗词纪律防生硬');
    assert.ok(d.HISTORY_DEAI_TEXT.includes('杜绝现代思维穿越感'), '历史去AI味');
  });

  test('③诗词选择：城破场景命中亡国/沙场词', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/history.js')));
    const r = h.poetryForScene('城破之时，他跪在尸山血海里求人救自己的家', 'fight');
    assert.ok(r.poems.length > 0, '应选到诗词');
    assert.ok(r.text.includes('诗词融入纪律'), '应带纪律文本');
    assert.ok(r.poems[0].author === '陆游' || r.poems[0].author === '文天祥' || r.poems[0].author === '岳飞', '命中豪放/忠义诗人');
    // 日常场景低相关
    const r2 = h.poetryForScene('买菜砍价，挑了两把菜', 'daily');
    assert.ok(r2.poems.length <= 1, '日常场景不强行塞词');
  });

  test('④时代红线检测：咖啡/烟草/报纸命中，正常文本不命中', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/history.js')));
    const hits = h.eraRedLineCheck('他喝了杯咖啡，抽了袋烟草，批着文件，盘算着效率。');
    const terms = hits.map(r => r.term);
    assert.ok(terms.includes('咖啡'), '应命中咖啡');
    assert.ok(terms.includes('烟草'), '应命中烟草');
    assert.ok(terms.includes('文件'), '应命中文件（现代词）');
    assert.equal(h.eraRedLineCheck('他喝了碗粗茶，望着窗外的油灯。').length, 0, '正常文本不命中');
  });

  test('⑤ensureEraContext：历史书生成 era_context 材料（史实骨架/红线/可改史点）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/history.js')));
 const b = store.books.create({ title: '示例历史长篇', genre: '历史', blurb: '蜀中孤儿', platform: '番茄' });
    const r = await h.ensureEraContext(b.id, {});
    assert.equal(r.ok, true);
    const content = store.materials.get(b.id, 'era_context')?.content || '';
    assert.ok(content.includes('史实骨架'), '含史实骨架');
    assert.ok(content.includes('时代红线'), '含时代红线');
    assert.ok(content.includes('可改史点'), '含可改史点');
    // 幂等
    const r2 = await h.ensureEraContext(b.id, {});
    assert.equal(r2.skipped, true, '已存在应跳过');
    // 非历史书跳过
    const b2 = store.books.create({ title: '仙侠书', genre: '玄幻', blurb: 'x' });
    const r3 = await h.ensureEraContext(b2.id, {});
    assert.equal(r3.skipped, true, '非历史书应跳过');
  });

  test('⑥成长波动：历史书白身+藏拙蛰伏不判偏离；无藏拙才判', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { detectGrowthDeviation } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/growth.js')));
    // 120 章 done + 主角白身藏拙
    const b = store.books.create({ title: '蛰伏书', genre: '历史', blurb: 'x' });
    const vol = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 120; i++) store.chapters.create(b.id, vol.id, i, { title: `ch${i}`, status: 'done' });
    store.characters.create(b.id, { name: '主角', tier: 'protagonist', state: { 身份: '白身', 官位: '白身', 谋划: '韬光养晦藏拙' } });
    const r1 = detectGrowthDeviation(b.id);
    assert.equal(r1.deviated, false, '白身+藏拙蛰伏不应判偏离');
    // 无藏拙（真摆烂）
    const b2 = store.books.create({ title: '摆烂书', genre: '历史', blurb: 'x' });
    const vol2 = store.volumes.create(b2.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 120; i++) store.chapters.create(b2.id, vol2.id, i, { title: `ch${i}`, status: 'done' });
    store.characters.create(b2.id, { name: '主角', tier: 'protagonist', state: { 身份: '白身', 官位: '白身' } });
    const r2 = detectGrowthDeviation(b2.id);
    assert.equal(r2.deviated, true, '无藏拙真摆烂应判偏离');
  });

  test('⑦历史去AI味：现代词命中', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/history.js')));
    const issues = h.detectHistoryMarkers('他格局打开，提升效率，做好复盘，继续推进。');
    assert.ok(issues.length > 0, '现代词应命中');
    assert.equal(h.detectHistoryMarkers('他按了按腰间的刀，望向城外的烽烟。').length, 0, '正常文本不命中');
  });

  test('⑧历史考据要求注入设定指令', async () => {
    const settings = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/settings.js')));
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/history.js')));
    const text = settings.settingsInstruction({ bookTitle: 'X', genre: '历史', contract: '', outlineText: '', pleasureText: '', historyReq: h.historySettingsRequirements() });
    assert.ok(text.includes('历史考据要求'), '应注入历史考据要求');
    assert.ok(text.includes('官职'), '含官职');
    assert.ok(text.includes('时代红线'), '含时代红线');
    assert.ok(text.includes('era_context'), 'JSON 含 era_context 字段');
    // 非历史无历史段
    const t2 = settings.settingsInstruction({ bookTitle: 'X', genre: '玄幻', contract: '', outlineText: '', pleasureText: '', historyReq: '' });
    assert.ok(!t2.includes('历史考据要求'), '非历史不注入');
  });

  test('⑨史实锚定文本：大框架符合史实+主角改史', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/history.js')));
    const t = h.historyAnchorsText();
    assert.ok(t.includes('史实锚定'), '史实锚定段');
    assert.ok(t.includes('改'), '含主角改史语义');
    assert.ok(t.includes('后果'), '可改后果');
  });

  test('⑩历史书 pilot 全流程：era_context 生成、题材感知、开篇蓝图无金手指', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pilot.js')));
    const b = store.books.create({ title: '历史端到端', genre: '历史', platform: '番茄', blurb: '蜀中孤儿守钓鱼城' });
    const r = await runBookPilot(b.id, { targetChapters: 2 });
    assert.ok(r.written >= 1, '应写完至少 1 章');
    assert.ok(store.materials.get(b.id, 'era_context')?.content, '应生成时代背景卡');
    const bp = JSON.parse(store.books.get(b.id).settings_json).openingBlueprint;
    assert.ok(bp?.hook_ladder?.length, '应有开篇蓝图');
    // 历史蓝图金手指应为 null/无（纯史实流）
    assert.ok(!bp.golden_finger || bp.golden_finger === null, '历史书蓝图不应有金手指');
  });
});
