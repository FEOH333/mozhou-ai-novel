// V0.22 借鉴升级测试：反 AI 味风格 / 题材包 / 审校等级 / 快照回滚 / 灵感反推
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v022-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_FAULT = '';

let store, packs, prompts, audit, polish, idea;
let bookId;

before(async () => {
  store = await import('../server/db/store.js');
  packs = await import('../server/data/creative_packs.js');
  prompts = await import('../server/engine/prompts.js');
  audit = await import('../server/engine/pipeline/audit.js');
  polish = await import('../server/engine/quality/polish.js');
  idea = await import('../server/engine/planning/idea.js');
  bookId = store.books.create({ title: 'V0.22测试', genre: '玄幻', blurb: 'x' }).id;
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } });

test('V0.22: 反 AI 味——禁用词表与风格画像数据完整', () => {
  assert.ok(packs.AI_CLICHE_WORDS.length >= 40, '禁用词表至少 40 条');
  assert.equal(Object.keys(packs.STYLE_PROFILES).length, 7); // V0.89：新增历史文画像（原 6 → 7）
  const text = packs.styleRulesText('fierce', '');
  assert.ok(text.includes('文风纪律'));
  assert.ok(text.includes('AI 味红线'));
  // V0.95 版权红线清偿：内置样本全部为本工具自撰示范句（不再含任何真实作品原文）
  assert.ok(text.includes('自撰'), '内置样本声明为自撰');
  assert.ok(!text.includes('斗破苍穹') && !text.includes('三十年河东'), '内置样本不得含真实作品原文/出处');
  const sample = packs.styleRulesText('grim', '巷口的灯灭了。他数到三，才听见自己的脚步声。');
  assert.ok(sample.includes('文风样本'));
  assert.ok(sample.includes('巷口的灯灭了'), '自定义样本应优先于内置');
  assert.ok(!sample.includes('凡人修仙传'), '有自定义时不再注入内置样本');
});

test('V0.22: 题材包——全部题材完整且注入文本可用', () => {
  // V0.81：新增历史题材（原 6 → 7），历史包须字段齐全（v075/v076 遍历依赖）
  assert.equal(Object.keys(packs.GENRE_PACKS).length, 7);
  const g = packs.genrePack('玄幻');
  assert.ok(g.worldview.length >= 3 && g.tropes.length >= 3 && g.forbidden.length >= 1);
  const text = packs.genrePackText('玄幻');
  assert.ok(text.includes('题材包') && text.includes('奖励节奏'));
  assert.equal(packs.genrePackText('不存在的题材'), '');
  // 历史题材包专项校验（V0.81）
  const hist = packs.genrePack('历史');
  assert.ok(hist, '历史题材包应存在');
  assert.ok(hist.growthSystem?.setbacks?.length >= 5, '历史 growthSystem 应含挫折节点');
  assert.ok(hist.growthSystem?.hiddenPowerMarks?.length >= 5, '历史 growthSystem 应含蛰伏藏拙词');
  assert.ok(hist.worldScale?.ladderKeywords?.length === 5, '历史 worldScale 应含 5 层阶梯');
  assert.ok(packs.genrePackText('历史').includes('史实'), '历史注入文本应含史实语义');
});

test('V0.22: 书契约指令注入题材包', () => {
  const inst = prompts.bookContractInstruction({
    genre: '玄幻', blurb: 'x', idea: 'y', platform: '番茄',
    genreText: packs.genrePackText('玄幻'),
  });
  assert.ok(inst.includes('【题材包】'), '契约指令应含题材包');
  assert.ok(inst.includes('奖励节奏'));
});

test('V0.22: 正文指令注入风格纪律（含 AI 味红线）', () => {
  const inst = prompts.writeSceneInstruction({
    bookTitle: 'T', chapterIdx: 1, chapterTitle: '一', goal: 'g', conflict: 'c',
    continuityFrom: '', scene: { id: 's1', pov: '林晚', location: '城', beat: 'b', target_words: 500 },
    scenesBefore: [], sceneAfter: null, prevTail: '', prevSceneSummary: '',
    worldbookText: '', factsText: '', foreshadowsText: '', rules: '',
    rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [],
    constraints: '', pleasureContext: '',
    styleRules: packs.styleRulesText('urban', ''),
  });
  assert.ok(inst.includes('【文风纪律（都市快节奏') || inst.includes('文风纪律'));
  assert.ok(inst.includes('AI 味红线'), '正文指令应含 AI 高频词红线');
  assert.ok(inst.includes('出现即拉低质量')); // V0.89：AI 词表统一措辞（同词一段最多一次）
});

test('V0.22: 审校五档等级——mock grade 解析', async () => {
  const ch = store.chapters.create(bookId, null, 1, { title: '一' }).id;
  store.scenes.create(ch, 1, { pov: '', location: '', beat: 'b', content: '雨还在下。', targetWords: 500, status: 'done' });
  const r = await audit.auditChapter(bookId, ch, { signal: undefined });
  assert.ok(['S', 'A', 'B', 'C', 'D'].includes(r.grade), `grade=${r.grade}`);
});

test('V0.22: 快照——创建/列表/恢复（打磨前自动快照可回滚）', async () => {
  const ch = store.chapters.create(bookId, null, 2, { title: '二' }).id;
  store.scenes.create(ch, 1, { pov: '', location: '', beat: 'b', content: '原文内容A', targetWords: 500, status: 'done' });
  // 快照
  const snap = store.snapshots.add(bookId, { label: '测试快照', source: 'auto', data: store.snapshotBook(bookId) });
  assert.ok(snap.id);
  const listed = store.snapshots.list(bookId);
  assert.ok(listed.some(s => s.id === snap.id));
  // 修改正文
  const sc = store.scenes.list(ch)[0];
  store.scenes.update(sc.id, { content: '被改坏的正文B' });
  assert.equal(store.scenes.get(sc.id).content, '被改坏的正文B');
  // 恢复（恢复会重建场景行，用新 id 查询）
  store.restoreSnapshot(bookId, store.snapshots.get(snap.id).data);
  const restored = store.scenes.list(ch)[0];
  assert.equal(restored.content, '原文内容A', '恢复后正文还原');
});

test('V0.22: runPolish 自动创建打磨前快照', async () => {
  const b2 = store.books.create({ title: '打磨测试', genre: '都市', blurb: 'x' }).id;
  const ch = store.chapters.create(b2, null, 1, { title: '一' }).id;
  store.chapters.update(ch, { status: 'done', wordCount: 100 });
  const events = [];
  await polish.runPolish(b2, { onEvent: ev => events.push(ev), signal: undefined });
  const snaps = store.snapshots.list(b2);
  assert.ok(snaps.length >= 1, '打磨前应有自动快照');
  assert.ok(snaps[0].label.includes('打磨前'));
  assert.ok(events.some(e => e.type === 'snapshot_created'));
});

test('V0.22: 删除作品清理快照表', () => {
  const b3 = store.books.create({ title: '删除测试', genre: '玄幻', blurb: 'x' }).id;
  store.snapshots.add(b3, { label: 'x', data: {} });
  store.books.remove(b3);
  assert.equal(store.snapshots.list(b3).length, 0, '删除后快照应清空');
});

test('V0.22: 灵感反推——长文本片段输入可提级', async () => {
  const r = await idea.amplifyIdea(bookId, { idea: '雨夜，她推开门看见巷口站着一个人，手里握着玉佩。这是她第三次在这个路口遇见他了。', genre: '玄幻' });
  assert.equal(r.ok, true);
  assert.equal(r.options.length, 3);
  assert.ok('inferred' in r, '返回应含 inferred 字段（长文本反推）');
});
