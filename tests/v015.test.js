// V0.15 新功能测试：AI 本位自动管线 / 长度自愈 / 滚动摘要 / 伏笔事件流水 / 规则升级 / pilot / polish
import './pipeline-helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { generateBookOutline, generateChapterOutline, generateBookContract } from '../server/engine/outline.js';
import { writeScene } from '../server/engine/write.js';
import { settleChapter } from '../server/engine/settle.js';
import { ensureSceneRows, runChapterFlow } from '../server/engine/pipeline.js';
import { runBookPilot } from '../server/engine/pilot.js';
import { runPolish } from '../server/engine/polish.js';
import { historyStats } from '../server/llm/cache.js';
import { runLocalRules } from '../server/engine/rules.js';

function makeBookWithChapter(genre = '玄幻', platform = '通用') {
  const book = store.books.create({ title: 'V015测试', genre, platform });
  store.materials.set(book.id, 'world', '青云大陆设定');
  return book;
}

test('V0.15: 书契约生成（mock）', async () => {
  const book = makeBookWithChapter();
  const c = await generateBookContract(book.id, { idea: '一个废柴剑子的逆袭' });
  assert.ok(c.target_readers);
  assert.ok(store.materials.get(book.id, 'contract')?.content.includes('书契约'));
});

test('V0.15: 长度自愈——字数不足自动续写', async () => {
  const book = makeBookWithChapter();
  const ch = store.chapters.create(book.id, null, 1, { title: '第一章', status: 'planned' });
  const outline = {
    title: '第一章', goal: 'g', conflict: 'c',
    scenes: [{ id: 's1', pov: 'A', location: 'L', beat: 'b1', target_words: 2000 }],
    checkpoints: ['p1'],
  };
  store.chapters.update(ch.id, { outline, status: 'outlined' });
  ensureSceneRows(ch.id, outline);
  const sc = store.scenes.list(ch.id)[0];
  const r = await writeScene(book.id, ch.id, sc.id, {});
  assert.equal(r.healed, true, '字数不足应触发自愈');
  assert.ok(r.content.length > 100, '内容应被续写扩充');
});

test('V0.15: 滚动摘要与伏笔事件流水（结算后）', async () => {
  const book = makeBookWithChapter();
  await generateBookOutline(book.id, {});
  const vol = store.volumes.list(book.id)[0];
  const ch = store.chapters.list(book.id)[0] || store.chapters.create(book.id, vol.id, 1, { title: '第一章', status: 'planned' });
  const outline = {
    title: '第一章', goal: 'g', conflict: 'c',
    scenes: [{ id: 's1', pov: '林晚', location: '青云城', beat: 'b1', target_words: 500 }],
    checkpoints: ['p1'],
  };
  store.chapters.update(ch.id, { outline, status: 'outlined' });
  ensureSceneRows(ch.id, outline);
  await writeScene(book.id, ch.id, store.scenes.list(ch.id)[0].id, {});
  const settled = await settleChapter(book.id, ch.id);
  // 滚动摘要（V0.95 两段式：content 存 JSON，统一经 rollingText 读取）
  const { rollingText } = await import('../server/engine/rolling.js');
  const rolling = rollingText(book.id);
  assert.ok(rolling.includes('第1章'), `滚动摘要应含章节标记: ${rolling}`);
  // 伏笔事件流水
  const fs = store.foreshadows.list(book.id).find(f => f.desc.includes('玉佩'));
  assert.ok(fs, '应自动登记伏笔');
  const events = JSON.parse(fs.events_json || '[]');
  assert.ok(events.length >= 1, '伏笔应有事件流水');
  assert.ok(events[0].chapter === 1);
});

test('V0.15: 规则库升级——不是X是Y/元话语/情感标签/破折号', async () => {
  const text = '他不是愤怒，而是某种更深层的东西。\n本章他感到恐惧。\n破折号——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试——测试。';
  const issues = runLocalRules(text);
  assert.ok(issues.some(i => i.issue.includes('不是X，而是Y')), '应检测不是X是Y');
  assert.ok(issues.some(i => i.issue.includes('元话语')), '应检测元话语"本章"');
  assert.ok(issues.some(i => i.issue.includes('情感标签')), '应检测情感标签');
  assert.ok(issues.some(i => i.issue.includes('破折号')), '应检测破折号超限');
});

test('V0.15: 写前五问自检（mock pass）', async () => {
  const book = makeBookWithChapter('玄幻', '番茄');
  const ch = store.chapters.create(book.id, null, 1, { title: '第一章', status: 'planned' });
  const outline = await generateChapterOutline(book.id, ch.id);
  assert.ok(outline.scenes.length >= 1);
  assert.equal(store.chapters.get(ch.id).status, 'outlined');
});

test('V0.15: runChapterFlow 全自动（自动确认 + 质量债务）', async () => {
  const book = makeBookWithChapter();
  const ch = store.chapters.create(book.id, null, 1, { title: '第一章', status: 'planned' });
  const events = [];
  const r = await runChapterFlow(book.id, ch.id, { onEvent: ev => events.push(ev.type) });
  assert.equal(r.status, 'done');
  assert.equal(store.chapters.get(ch.id).status, 'done');
  assert.ok(events.includes('done'));
  // 结算应产生滚动摘要
  assert.ok(store.rollingSummaries.get(book.id).length > 0);
});

test('V0.15: pilot 一键全书（骨架保障 + 逐章自动 + checkpoint）', async () => {
  const book = store.books.create({ title: 'Pilot测试', genre: '都市', platform: '番茄' });
  const events = [];
  const r = await runBookPilot(book.id, { targetChapters: 2, onEvent: ev => events.push(ev.type) });
  assert.ok(r.written >= 1);
  const chapters = store.chapters.list(book.id);
  assert.ok(chapters.length >= 1);
  assert.ok(chapters.every(c => c.status === 'done' || c.status === 'settled'), 'pilot 后章节应全部完成');
  assert.ok(store.rollingSummaries.get(book.id).length > 0, '滚动摘要应存在');
  assert.ok(events.includes('chapter_done'));
});

test('V0.15: pilot 断点续跑（已完成章节跳过）', async () => {
  const book = store.books.create({ title: '续跑测试', genre: '玄幻' });
  await runBookPilot(book.id, { targetChapters: 2 });
  const before = store.chapters.list(book.id);
  const countBefore = before.length;
  const events = [];
  await runBookPilot(book.id, { targetChapters: 2, onEvent: ev => events.push(ev.type) });
  const after = store.chapters.list(book.id);
  assert.equal(after.length, countBefore, '断点续跑不应新增章节');
  assert.ok(after.every(c => c.status === 'done'), '已有章节保持完成');
});

test('V0.15: polish 全书打磨（诊断→工单→执行→历史重建）', async () => {
  const book = store.books.create({ title: '打磨测试', genre: '玄幻' });
  const ch = store.chapters.create(book.id, null, 1, { title: '第一章', status: 'planned' });
  const outline = {
    title: '第一章', goal: 'g', conflict: 'c',
    scenes: [{ id: 's1', pov: 'A', location: 'L', beat: 'b1', target_words: 500 }],
    checkpoints: ['p1'],
  };
  store.chapters.update(ch.id, { outline, status: 'outlined' });
  ensureSceneRows(ch.id, outline);
  await writeScene(book.id, ch.id, store.scenes.list(ch.id)[0].id, {});
  await settleChapter(book.id, ch.id);
  store.chapters.update(ch.id, { status: 'done' });
  const historyBefore = historyStats(book.id).messages;

  const r = await runPolish(book.id);
  assert.ok(r.workorders >= 0, '应有工单统计');
  assert.ok(r.executed >= 0);
  // 历史重建：正文重新灌入，消息数不变结构（system+user+场景）
  const historyAfter = historyStats(book.id).messages;
  assert.equal(historyAfter, historyBefore, '历史重建后消息数不变');
  const scenes = store.scenes.list(ch.id);
  assert.ok(scenes[0].content.length > 0, '打磨后场景仍有内容');
  assert.equal(scenes[0].status, 'revised', '打磨后场景标记为修订');
});
