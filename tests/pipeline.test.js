// 端到端管线测试（NOVEL_MOCK_LLM=1，不联网不花钱）：书纲→卷纲→细纲→正文→审校→覆盖→结算
import './pipeline-helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as store from '../server/db/store.js';
import { generateBookOutline, generateVolumeOutline, generateChapterOutline } from '../server/engine/outline.js';
import { writeScene } from '../server/engine/write.js';
import { auditChapter, coverageCheck } from '../server/engine/audit.js';
import { settleChapter } from '../server/engine/settle.js';
import { ensureSceneRows } from '../server/engine/pipeline.js';
import { historyStats, budgetCheck } from '../server/llm/cache.js';

test('端到端：mock 模式完整写一章（书纲→卷纲→细纲→正文→审校→覆盖→结算）', async () => {
  const book = store.books.create({ title: '端到端测试', genre: '玄幻' });
  const bookId = book.id;

  // 1) 书级大纲
  const outline = await generateBookOutline(bookId, {});
  assert.ok(outline.title, '书纲应有书名');
  assert.ok(outline.volumes?.length > 0);

  // 2) 卷大纲（自动建章）
  const vol = store.volumes.list(bookId)[0];
  const vout = await generateVolumeOutline(bookId, vol.id, { chapterCount: 2 });
  assert.ok(vout.chapters?.length >= 1);
  assert.equal(store.chapters.list(bookId).length, 2);
  assert.equal(store.volumes.get(vol.id).status, 'outlined');

  // 3) 章细纲
  const ch = store.chapters.list(bookId)[0];
  const chOutline = await generateChapterOutline(bookId, ch.id);
  assert.ok(chOutline.scenes.length >= 1, '细纲应有场景');
  assert.ok(chOutline.checkpoints.length >= 1);
  assert.equal(store.chapters.get(ch.id).status, 'outlined');

  // 4) 逐场景正文
  ensureSceneRows(ch.id, chOutline);
  let scenes = store.scenes.list(ch.id);
  assert.equal(scenes.length, chOutline.scenes.length);
  const r1 = await writeScene(bookId, ch.id, scenes[0].id, {});
  assert.ok(r1.content.length > 10);
  assert.equal(historyStats(bookId).messages, 3, '历史堆: system+user+场景1');
  assert.equal(store.scenes.get(scenes[0].id).history_seq, 3);

  scenes = store.scenes.list(ch.id);
  const r2 = await writeScene(bookId, ch.id, scenes[1].id, {});
  assert.ok(r2.content.length > 10);
  assert.equal(historyStats(bookId).messages, 4, '历史堆: +场景2');
  assert.equal(store.chapters.get(ch.id).status, 'drafted');

  // 5) 审校（mock 返回 accept + 本地规则可能提示）
  const audit = await auditChapter(bookId, ch.id);
  assert.equal(audit.verdict, 'accept');
  assert.equal(store.chapters.get(ch.id).status, 'drafted', '只读审校不得把未结算章节伪装成 revised 终态');

  // 6) 覆盖校验
  const cov = await coverageCheck(bookId, ch.id);
  assert.equal(cov.verdict, 'pass');

  // 7) 结算
  const settled = await settleChapter(bookId, ch.id);
  assert.ok(settled.facts.created >= 1, '应抽取事实');
  assert.ok(settled.summary.length > 0, '应有摘要');
  assert.ok(store.foreshadows.list(bookId).some(f => f.desc.includes('玉佩')), '伏笔自动登记');
  assert.ok(store.timeline.list(bookId).length >= 1, '时间线事件');
  assert.ok(store.characters.list(bookId).some(c => c.name === '林晚'), '角色状态更新');
  assert.equal(store.chapters.get(ch.id).status, 'settled');

  // 8) 缓存命中率（mock usage 模拟前缀命中）
  const agg = store.usageLogs.aggregate({ bookId });
  assert.ok(agg.calls >= 6, `应有多次调用，实际 ${agg.calls}`);
  assert.ok(agg.hitRatio > 0.5, `命中率应较高，实际 ${agg.hitRatio.toFixed(3)}`);
  assert.ok(agg.saving > 0, '应有节省金额');

  // 9) 预算检查
  const b = budgetCheck(bookId);
  assert.equal(b.over, false);
});

test('端到端：修订场景会重建历史（truncate+append）', async () => {
  const book = store.books.create({ title: '修订测试', genre: '都市' });
  const bookId = book.id;
  const ch = store.chapters.create(bookId, null, 1, { title: '第一章', status: 'planned' });
  const outline = {
    title: '第一章', goal: 'g', conflict: 'c',
    scenes: [{ id: 's1', pov: 'A', location: 'L', beat: 'b1', target_words: 300 }],
    checkpoints: ['p1'],
  };
  store.chapters.update(ch.id, { outline, status: 'outlined' });
  ensureSceneRows(ch.id, outline);
  const sc = store.scenes.list(ch.id)[0];
  await writeScene(bookId, ch.id, sc.id, {});
  const before = historyStats(bookId).messages; // 3

  const { reviseScene } = await import('../server/engine/audit.js');
  await reviseScene(bookId, ch.id, sc.id, { issues: [{ type: '语句质量', severity: 'low', quote: '', issue: '测试' }] });
  const after = historyStats(bookId).messages;
  assert.equal(before, after, '修订替换消息而非新增');
  assert.ok(store.scenes.get(sc.id).content.includes('修订版'));
  assert.equal(store.scenes.get(sc.id).status, 'revised');
});

test('端到端：修订中间场景会清空后续场景，管线自动重写', async () => {
  const book = store.books.create({ title: '修订中间测试', genre: '玄幻' });
  const bookId = book.id;
  const ch = store.chapters.create(bookId, null, 1, { title: '第一章', status: 'planned' });
  const outline = {
    title: '第一章', goal: 'g', conflict: 'c',
    scenes: [
      { id: 's1', pov: 'A', location: 'L', beat: 'b1', target_words: 300 },
      { id: 's2', pov: 'B', location: 'L2', beat: 'b2', target_words: 300 },
    ],
    checkpoints: ['p1'],
  };
  store.chapters.update(ch.id, { outline, status: 'outlined' });
  ensureSceneRows(ch.id, outline);
  const scenes = store.scenes.list(ch.id);
  await writeScene(bookId, ch.id, scenes[0].id, {});
  await writeScene(bookId, ch.id, scenes[1].id, {});
  assert.equal(historyStats(bookId).messages, 4);
  assert.ok(store.scenes.get(scenes[1].id).content.length > 0, '场景2已有内容');

  // 修订场景1 → 场景2 应被清空重置（V0.63：历史改为原地 replace，消息数不变——前缀保持命中缓存）
  const { reviseScene } = await import('../server/engine/audit.js');
  await reviseScene(bookId, ch.id, scenes[0].id, { issues: [{ type: '语句质量', severity: 'low', quote: '', issue: 'x' }] });
  assert.equal(store.scenes.get(scenes[1].id).status, 'planned', '场景2应被重置为 planned');
  assert.equal(store.scenes.get(scenes[1].id).content, '', '场景2内容应清空');
  assert.equal(historyStats(bookId).messages, 4, 'V0.63：修订为原地 replace 同 seq（不截断），消息数不变');

  // 管线重写逻辑：writePendingScenes 应把场景2重写
  await writeScene(bookId, ch.id, scenes[1].id, {});
  assert.equal(store.scenes.get(scenes[1].id).status, 'done');
  assert.ok(store.scenes.get(scenes[1].id).content.length > 0);
  assert.equal(historyStats(bookId).messages, 4, '历史堆保持 4 条（场景2 replace 自己的 seq）');
});

test('端到端：修订已结算场景会废止旧投影并登记同版重建，且不清空后续定稿场景', async () => {
  const book = store.books.create({ title: '已结算修订安全测试', genre: '都市' });
  const chapter = store.chapters.create(book.id, null, 1, {
    title: '第一章', status: 'done', wordCount: 1200,
    outline: { title: '第一章', goal: '解决眼前问题', conflict: '时间不足' },
  });
  const first = store.scenes.create(chapter.id, 1, {
    beat: '第一场', content: '旧正文第一场。'.repeat(80), status: 'done', targetWords: 300,
  });
  const second = store.scenes.create(chapter.id, 2, {
    beat: '第二场', content: '旧正文第二场必须保留。'.repeat(80), status: 'done', targetWords: 300,
  });
  const before = store.chapters.fullText(chapter.id);
  store.summaries.set(chapter.id, book.id, '旧摘要');
  store.chapterSettlements.set(book.id, chapter.id, {
    contentHash: createHash('sha256').update(before).digest('hex'), result: { summary: '旧摘要' },
  });

  const { reviseScene } = await import('../server/engine/audit.js');
  const result = await reviseScene(book.id, chapter.id, first.id, {
    issues: [{ type: '语句质量', severity: 'low', quote: '', issue: '测试完成章修订' }],
  });

  assert.equal(result.requiresStateRebuild, true);
  assert.equal(store.scenes.get(second.id).content, '旧正文第二场必须保留。'.repeat(80));
  assert.equal(store.summaries.get(chapter.id), undefined);
  assert.equal(store.chapterSettlements.get(chapter.id), undefined);
  assert.deepEqual(store.narrativeRevisions.blocking(book.id)?.manifest?.changed_chapters, [1]);
});

test('端到端：重复写同一场景不残留旧正文（重写语义）', async () => {
  const book = store.books.create({ title: '重写测试', genre: '科幻' });
  const bookId = book.id;
  const ch = store.chapters.create(bookId, null, 1, { title: '第一章', status: 'planned' });
  const outline = {
    title: '第一章', goal: 'g', conflict: 'c',
    scenes: [{ id: 's1', pov: 'A', location: 'L', beat: 'b1', target_words: 300 }],
    checkpoints: ['p1'],
  };
  store.chapters.update(ch.id, { outline, status: 'outlined' });
  ensureSceneRows(ch.id, outline);
  const sc = store.scenes.list(ch.id)[0];
  await writeScene(bookId, ch.id, sc.id, {});
  const seq1 = store.scenes.get(sc.id).history_seq;
  await writeScene(bookId, ch.id, sc.id, {}); // 重写
  const seq2 = store.scenes.get(sc.id).history_seq;
  assert.equal(seq1, seq2, '重写应替换同一条历史消息（seq 不变）');
  const msgs = store.history.list(bookId);
  assert.equal(msgs.length, 3, '历史堆仍 3 条（system+user+场景）');
  assert.equal(msgs.filter(m => m.role === 'assistant').length, 1, '只有一条 assistant 消息');
});
