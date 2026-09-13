// V0.19 灵感提级测试：种子生成/LLM 提级/应用方案/契约评分门/空灵感自动兜底
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v019-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '1';

let store, idea, outline;
let bookId;

before(async () => {
  store = await import('../server/db/store.js');
  idea = await import('../server/engine/planning/idea.js');
  outline = await import('../server/engine/planning/outline.js');
  bookId = store.books.create({ title: '创意测试', genre: '玄幻', platform: '番茄', blurb: '' }).id;
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } });

test('V0.19: 本地高概念种子——按题材生成、结构完整、零网络', () => {
  const seeds = idea.generateIdeaSeeds('玄幻', 5);
  assert.equal(seeds.length, 5);
  for (const s of seeds) {
    assert.ok(s.concept.length > 15, 'concept 应完整');
    assert.ok(s.why.length > 0);
  }
  // 都市题材应倾向都市元素
  const urban = idea.generateIdeaSeeds('都市', 8);
  const all = urban.map(s => s.concept).join('');
  assert.ok(/外卖|总裁|高考|程序员|骑手|保安/.test(all), '都市种子应含都市元素');
});

test('V0.19: LLM 灵感提级——诊断评分 + 3 个方案 + 黄金开场', async () => {
  const r = await idea.amplifyIdea(null, { idea: '一个被废的剑宗弟子捡到玉佩', genre: '玄幻', platform: '番茄' });
  assert.equal(r.ok, true);
  assert.ok(r.total >= 1 && r.total <= 10);
  assert.ok(r.issues.length >= 1, '应给出问题清单');
  assert.equal(r.options.length, 3);
  for (const o of r.options) {
    assert.ok(o.concept.length > 10);
    assert.ok(o.hook.length > 0);
  }
  assert.ok(r.goldenOpen.includes('300字') || r.goldenOpen.length > 0);
});

test('V0.19: 应用提级方案——写回 blurb 供契约生成使用', () => {
  const r = idea.applyIdeaOption(bookId, { concept: '高概念测试：玉佩只会在仇人靠近时发烫', hook: '旧敌进门那一刻，玉佩烫得他掌心发红', why: '冲突前置' });
  assert.equal(r.ok, true);
  const book = store.books.get(bookId);
  assert.ok(book.blurb.includes('高概念测试'));
  assert.ok(book.blurb.includes('钩子'));
});

test('V0.19: 契约评分门——mock pass 时不重生成、直接存契约', async () => {
  const contract = await outline.generateBookContract(bookId, { idea: '测试灵感：一个守墓人发现墓地夜里会多一座新坟' });
  assert.ok(contract.target_readers);
  const saved = store.materials.get(bookId, 'contract');
  assert.ok(saved.content.includes('target_readers') || saved.content.includes('目标读者'));
});

test('V0.19: 空灵感自动兜底——generateBookContract 自动取种子', async () => {
  const book2 = store.books.create({ title: '无灵感测试', genre: '科幻', blurb: '   ' }).id;
  const contract = await outline.generateBookContract(book2, {});
  assert.ok(contract.target_readers);
  // blurb 已被种子填充（不再为空）
  assert.ok(store.books.get(book2).blurb.trim().length >= 8, '空灵感应自动填入种子概念');
});

test('V0.19: scoreContract 直接调用——评分结构与 verdict', async () => {
  const r = await idea.scoreContract(bookId);
  assert.equal(r.ok, true);
  assert.ok(r.total >= 1 && r.total <= 10);
  assert.ok(['pass', 'regen'].includes(r.verdict));
});

test('V0.19: 删除作品——全部关联表无残留', async () => {
  // 造数据覆盖所有新老表
  const b = store.books.create({ title: '待删除', genre: '玄幻', blurb: '测试' });
  const ch = store.chapters.create(b.id, null, 1, { title: '第一章' });
  store.scenes.create(ch.id, 1, { content: '正文' });
  store.facts.create(b.id, { subject: 'A', predicate: 'B', object: 'C' });
  store.characters.create(b.id, { name: '甲' });
  store.foreshadows.create(b.id, { desc: '伏笔', plantedChapter: 1 });
  store.worldbook.create(b.id, { keywords: ['x'], content: 'y' });
  store.timeline.add(b.id, { event: '事件' });
  store.conflicts.create(b.id, { chapterId: ch.id, type: '设定冲突', quote: '引用', issue: '问题' });
  store.chapterHealth.add({ bookId: b.id, chapterId: ch.id, idx: 1 });
  store.archives.add(b.id, { batch: 1, rangeStart: 1, rangeEnd: 1, summaryJson: '{}', tokensSaved: 0 });
  store.constraints.add(b.id, { content: '约束', source: 'test' });
  store.pleasureHooks.create(b.id, { desc: '期待', kind: 'short', plantedChapter: 1 });
  store.storyArcs.create(b.id, { name: '弧线' });
  store.books.remove(b.id);
  // 全部表无残留
  for (const t of ['history', 'chapters', 'volumes', 'facts', 'characters', 'locations', 'items',
    'factions', 'foreshadows', 'worldbook', 'chapter_summaries', 'conflicts', 'timeline', 'usage_logs',
    'vectors', 'pending_entities', 'public_materials', 'chapter_health', 'book_archives', 'book_constraints',
    'pleasure_hooks', 'story_arcs']) {
    const n = store.db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE book_id = ?`).get(b.id).n;
    assert.equal(n, 0, `${t} 应无残留`);
  }
  const sceneLeft = store.db().prepare('SELECT COUNT(*) AS n FROM scenes WHERE chapter_id = ?').get(ch.id).n;
  assert.equal(sceneLeft, 0, 'scenes 应无残留');
  assert.equal(store.books.get(b.id), undefined, '书本身应删除');
});

test('V0.19: AI 起名——根据灵感生成书名，「未命名」自动修正', async () => {
  // 直接起名
  const r = await idea.generateBookTitle(bookId, { idea: '主角呼吸的二氧化碳对修士是剧毒' });
  assert.equal(r.ok, true);
  assert.ok(r.title.length >= 3 && r.title.length <= 30);
  assert.ok(r.subtitle.length > 0);
  // 创建'未命名'书 → 生成契约后自动修正书名
  const book3 = store.books.create({ title: '未命名', genre: '玄幻', blurb: '杂役弟子呼出二氧化碳毒倒长老' }).id;
  await outline.generateBookContract(book3, {});
  assert.notEqual(store.books.get(book3).title, '未命名', '契约生成后应自动起名');
});
