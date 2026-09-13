// V0.16 测试：上下文归档（防降智）+ 漂移检测与自动恢复 + 原文回灌
import './pipeline-helper.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import { getGlobal, saveGlobal } from '../server/config.js';
import { ensureSceneRows } from '../server/engine/pipeline/pipeline.js';
import { writeScene } from '../server/engine/pipeline/write.js';
import { settleChapter } from '../server/engine/pipeline/settle.js';
import { runArchive, checkArchiveNeed, archiveSearch, buildChapterCard } from '../server/engine/pipeline/archive.js';
import { recordChapterHealth, detectDrift, autoRecover } from '../server/engine/recovery/recovery.js';
import { assembleMessages, historyTokens } from '../server/llm/cache.js';

let savedCfg;

before(async () => {
  savedCfg = getGlobal();
});

after(() => {
  saveGlobal(savedCfg);
});

/** 造 n 章已完成（含结算）的书 */
async function makeBookWithDoneChapters(n, { title = '归档测试' } = {}) {
  const book = store.books.create({ title, genre: '玄幻' });
  for (let i = 1; i <= n; i++) {
    const ch = store.chapters.create(book.id, null, i, { title: `第${i}章`, status: 'planned' });
    const outline = {
      title: `第${i}章`, goal: 'g', conflict: 'c',
      scenes: [{ id: 's1', pov: '林晚', location: '青云城', beat: `第${i}章节拍：林晚继续寻找玉佩秘密`, target_words: 300 }],
      checkpoints: ['p'],
    };
    store.chapters.update(ch.id, { outline, status: 'outlined' });
    ensureSceneRows(ch.id, outline);
    await writeScene(book.id, ch.id, store.scenes.list(ch.id)[0].id, {});
    await settleChapter(book.id, ch.id);
    store.chapters.update(ch.id, { status: 'done' });
  }
  return book;
}

test('V0.16: 精炼卡构建——关键细节/事实/伏笔结构化保留', async () => {
  const book = await makeBookWithDoneChapters(2);
  // 造一条事实和一条伏笔
  store.facts.create(book.id, { subject: '林晚', predicate: '持有', object: '神秘玉佩', sourceChapter: 1 });
  const fs = store.foreshadows.create(book.id, { desc: '玉佩月圆夜发光之谜', plantedChapter: 1, payoffChapter: 10, status: 'planted' });
  // 给第 1 章场景补充含专名的正文（模拟真实长文）
  const ch = store.chapters.list(book.id)[0];
  const sc = store.scenes.list(ch.id)[0];
  store.scenes.update(sc.id, {
    content: sc.content + '\n林晚站在青云城城头，握紧了那枚温热的玉佩。\n"师父说过，月圆之夜，玉佩会醒。"\n远处的钟声响了三下。',
  });
  const card = buildChapterCard(book.id, ch);
  assert.ok(card.chapter === 1);
  assert.ok(card.key_details.some(d => d.text.includes('林晚')), '应提取含专名的关键细节');
  assert.ok(card.key_details.some(d => d.text.includes('师父说过')), '应提取关键对话');
  assert.ok(card.facts.some(f => f.includes('玉佩')), '事实应入卡');
  assert.ok(card.foreshadows.some(f => f.includes(fs.id)), '伏笔应入卡');
  assert.ok(card.ending_hook.length > 0, '应有结尾钩子');
});

test('V0.16: 上下文归档——触发/压缩/注入/防丢细节', async () => {
  // 调小预算使归档可触发（keepRecent 3 章）
  saveGlobal({
    contextBudgetTokens: 3000, archiveRatio: 0.7, keepRecentChapters: 3, archiveStrategy: 'auto',
  });
  const book = await makeBookWithDoneChapters(8);
  const beforeTokens = historyTokens(book.id);
  assert.ok(beforeTokens > 2100, `历史应超过归档线: ${beforeTokens}`);

  const need = checkArchiveNeed(book.id);
  assert.equal(need.needed, true);

  const r = await runArchive(book.id);
  assert.ok(r, '归档应执行');
  assert.ok(r.batch >= 1);
  assert.equal(r.range[0], 1);
  assert.ok(r.archived >= 4, `应归档早期章节: ${r.archived}`);
  assert.ok(r.tokensSaved > 500, `应节省 tokens: ${r.tokensSaved}`);

  // 历史堆被压缩（正文部分被归档，仅保留最近 3 章 + 前缀）
  const afterTokens = historyTokens(book.id);
  assert.ok(afterTokens < beforeTokens, `压缩后 tokens 应下降: ${afterTokens} vs ${beforeTokens}`);
  assert.ok(r.tokensSaved > 300, `应节省 tokens: ${r.tokensSaved}`);

  // 归档记忆注入（assembleMessages 自动带）
  const msgs = assembleMessages(book.id, [{ role: 'user', content: 'x' }]);
  const archiveMsg = msgs.find(m => m.content.includes('归档记忆'));
  assert.ok(archiveMsg, '应有归档记忆注入消息');
  assert.ok(archiveMsg.content.includes('未解伏笔'), '归档记忆应含必保的未解伏笔');
  assert.ok(archiveMsg.content.includes('关键事实'), '归档记忆应含关键事实');
  // V0.84：归档记忆从"并入公共材料"改为"追加到末条 user 指令末尾"——
  // 公共材料前缀跨归档批次恒定（归档变化只失效尾部指令段，命中率不掉）；archiveMsg 是末条
  assert.ok(msgs[msgs.length - 1] === archiveMsg, '归档记忆应追加到末条 user 指令');
  assert.ok(!msgs[1].content.includes('归档记忆'), '公共材料（第2条）不应含归档记忆（前缀恒定）');

  // 归档后不再触发
  const need2 = checkArchiveNeed(book.id);
  assert.equal(need2.needed, false);

  // 原文回灌检索
  const found = archiveSearch(book.id, '玉佩');
  assert.ok(found.length >= 1, '原文回灌应能检索到玉佩相关段落');
});

test('V0.16: 归档后继续写作不破坏管线（写入仍进历史堆）', async () => {
  saveGlobal({
    contextBudgetTokens: 3000, archiveRatio: 0.7, keepRecentChapters: 3, archiveStrategy: 'auto',
  });
  const book = await makeBookWithDoneChapters(8);
  await runArchive(book.id);
  const tokensAfterArchive = historyTokens(book.id);

  // 继续写一章
  const ch = store.chapters.create(book.id, null, 9, { title: '第9章', status: 'planned' });
  const outline = {
    title: '第9章', goal: 'g', conflict: 'c',
    scenes: [{ id: 's1', pov: '林晚', location: '青云城', beat: '玉佩之谜揭开一角', target_words: 300 }],
    checkpoints: ['p'],
  };
  store.chapters.update(ch.id, { outline, status: 'outlined' });
  ensureSceneRows(ch.id, outline);
  await writeScene(book.id, ch.id, store.scenes.list(ch.id)[0].id, {});
  assert.ok(historyTokens(book.id) > tokensAfterArchive, '新章应追加进历史堆');
  const msgs = assembleMessages(book.id, [{ role: 'user', content: 'x' }]);
  assert.ok(msgs.some(m => m.content.includes('归档记忆')), '归档记忆持续注入');
});

test('V0.16: 漂移检测——连续失败触发', async () => {
  const book = store.books.create({ title: '漂移测试', genre: '玄幻' });
  for (let i = 1; i <= 3; i++) {
    recordChapterHealth(book.id, null, { verdict: 'error', issues: [], failed: true });
  }
  const d = detectDrift(book.id);
  assert.equal(d.trigger, true);
  assert.ok(d.reason.includes('连续'), d.reason);

  // 正常健康不触发
  const book2 = store.books.create({ title: '健康测试', genre: '玄幻' });
  recordChapterHealth(book2.id, null, { verdict: 'accept', issues: [], failed: false });
  assert.equal(detectDrift(book2.id).trigger, false);
});

test('V0.16: 漂移检测——high 问题累积触发', async () => {
  const book = store.books.create({ title: '高问题测试', genre: '玄幻' });
  recordChapterHealth(book.id, null, { verdict: 'fix', issues: [{ severity: 'high' }, { severity: 'high' }], failed: false });
  recordChapterHealth(book.id, null, { verdict: 'fix', issues: [{ severity: 'high' }], failed: false });
  const d = detectDrift(book.id);
  assert.equal(d.trigger, true, JSON.stringify(d));
});

test('V0.16: autoRecover——诊断+修复动作执行（supersede/constraints）', async () => {
  const book = await makeBookWithDoneChapters(2, { title: '恢复测试' });
  // 造一条会被作废的事实
  store.facts.create(book.id, { subject: '林晚', predicate: '实力达到', object: '练气三层', sourceChapter: 1 });
  // 注入失败信号
  for (let i = 0; i < 2; i++) recordChapterHealth(book.id, null, { verdict: 'error', issues: [], failed: true });

  const r = await autoRecover(book.id);
  assert.equal(r.recovered, true);
  // supersede 动作应生效
  const facts = store.facts.list(book.id, { status: 'superseded' });
  assert.ok(facts.length >= 1, '冲突事实应被作废');
  // constraints 应注入
  const constraints = store.constraints.text(book.id);
  assert.ok(constraints.length > 0, '应有恢复约束注入');
  assert.ok(constraints.includes('恢复总纲'), '应含恢复总纲');
});

test('V0.16: 恢复后约束注入写作指令', async () => {
  const book = await makeBookWithDoneChapters(1, { title: '约束测试' });
  store.constraints.add(book.id, { content: '后续章节林晚必须保持练气三层', source: 'recovery' });
  // writeScene 的指令应包含约束
  const ch = store.chapters.list(book.id)[0];
  const { writeSceneInstruction } = await import('../server/engine/prompts.js');
  const outline = store.chapters.outline(ch.id);
  const instruction = writeSceneInstruction({
    bookTitle: '约束测试', chapterIdx: 1, chapterTitle: '第1章', scene: outline.scenes[0],
    scenesBefore: [], sceneAfter: null, prevTail: '', worldbookText: '', factsText: '', foreshadowsText: '',
    rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], constraints: '后续章节林晚必须保持练气三层',
  });
  assert.ok(instruction.includes('后续章节林晚必须保持练气三层'), '约束应注入写作指令');
});
