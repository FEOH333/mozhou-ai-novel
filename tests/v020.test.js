// V0.20 回归测试：全面 debug 修复点验证
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v020-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '1';

let store, pipeline, outline, write;
let bookId, chapterId;

before(async () => {
  store = await import('../server/db/store.js');
  pipeline = await import('../server/engine/pipeline/pipeline.js');
  outline = await import('../server/engine/planning/outline.js');
  write = await import('../server/engine/pipeline/write.js');
  bookId = store.books.create({ title: '回归测试', genre: '玄幻', blurb: '灵感' }).id;
  chapterId = store.chapters.create(bookId, null, 1, { title: '第一章' }).id;
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } });

test('V0.20: constraints 按内容去重（每章 flow 不再无限膨胀）', () => {
  const c1 = store.constraints.add(bookId, { content: '同一约束内容', source: 'pleasure' });
  const c2 = store.constraints.add(bookId, { content: '同一约束内容', source: 'pleasure' });
  assert.equal(c1, c2, '相同内容应返回同一条');
  const list = store.constraints.list(bookId).filter(c => c.content === '同一约束内容');
  assert.equal(list.length, 1);
});

test('V0.20: ensureSceneRows 清理多余场景行（细纲场景减少不残留）', () => {
  const ch = store.chapters.create(bookId, null, 2, { title: '二' }).id;
  for (let i = 1; i <= 3; i++) store.scenes.create(ch, i, { pov: '', location: '', beat: `s${i}`, targetWords: 800, status: 'planned' });
  const kept = pipeline.ensureSceneRows(ch, { scenes: [{ beat: 'a' }, { beat: 'b' }] });
  assert.equal(kept.length, 2, '应只剩 2 个场景');
  assert.equal(store.scenes.list(ch).length, 2);
});

test('V0.20: writeScene 重写中间场景——后续场景 history_seq 置空 + 历史截断', async () => {
  const ch = store.chapters.create(bookId, null, 3, { title: '三' }).id;
  store.chapters.update(ch, { outline: { title: '三', scenes: [
    { pov: '', location: '', beat: 'a', target_words: 800 },
    { pov: '', location: '', beat: 'b', target_words: 800 },
    { pov: '', location: '', beat: 'c', target_words: 800 },
  ] } });
  const s1 = store.scenes.create(ch, 1, { pov: '', location: '', beat: 'a', targetWords: 800, status: 'planned' });
  const s2 = store.scenes.create(ch, 2, { pov: '', location: '', beat: 'b', targetWords: 800, status: 'planned' });
  const s3 = store.scenes.create(ch, 3, { pov: '', location: '', beat: 'c', targetWords: 800, status: 'planned' });
  // 先写三幕
  await write.writeScene(bookId, ch, s1.id, {});
  await write.writeScene(bookId, ch, s2.id, {});
  await write.writeScene(bookId, ch, s3.id, {});
  const before = store.scenes.list(ch).map(s => ({ idx: s.idx, seq: s.history_seq }));
  assert.ok(before.every(s => s.seq), '三幕都应有 history_seq');
  // 重写第 1 幕 → 第 2/3 幕必须重置（history_seq 置空、正文清空、状态回 planned）
  await write.writeScene(bookId, ch, s1.id, {});
  const after = store.scenes.list(ch);
  const a1 = after.find(s => s.idx === 1);
  const a2 = after.find(s => s.idx === 2);
  const a3 = after.find(s => s.idx === 3);
  assert.ok(a1.history_seq, '重写后第 1 幕有新 seq');
  // V0.63：后续场景保留 history_seq（重写时 replace 同 seq，前缀保持命中缓存）；内容清空、状态 planned
  assert.ok(a2.history_seq, 'V0.63：第 2 幕保留 history_seq（供重写 replace）');
  assert.equal(a2.content, '');
  assert.equal(a2.status, 'planned');
  assert.ok(a3.history_seq, 'V0.63：第 3 幕保留 history_seq');
  assert.equal(a3.content, '');
  // 历史堆（V0.63：重写为原地 replace 同 seq——旧消息保留待后续场景重写时 replace，前缀保持命中缓存）
  const history = store.history.list(bookId);
  assert.equal(history.length, 5, 'V0.63：system+材料+3 场景消息全保留（s2/s3 重写时各自 replace）');
  // 重写 s2、s3 后消息数不变（replace 各自 seq）
  await write.writeScene(bookId, ch, s2.id, {});
  await write.writeScene(bookId, ch, s3.id, {});
  assert.equal(store.history.list(bookId).length, 5, '重写后仍 5 条（原地替换）');
});

test('V0.20: conflicts.create 返回完整对象（修复 this.get 崩溃）', () => {
  const c = store.conflicts.create(bookId, { chapterId, type: '设定冲突', quote: 'q', issue: 'i' });
  assert.ok(c.id);
  assert.equal(c.type, '设定冲突');
});

test('V0.20: 书纲生成后进入历史堆前缀（assembleMessages 含书纲）', async () => {
  const b = store.books.create({ title: '书纲回归', genre: '都市', blurb: '灵感x' }).id;
  await outline.generateBookOutline(b, {});
  // 书纲进公共材料 → history 第 2 条 user 含大纲内容
  const msgs = store.history.list(b).map(h => h.content).join('\n');
  assert.ok(msgs.includes('卷') || msgs.includes('volumes') || msgs.includes('梗概'), '书纲应进入公共材料');
  assert.ok(store.materials.get(b, 'outline')?.content, 'outline 材料应存在');
});

test('V0.20: 契约评分门顺序——评分前契约已落库', async () => {
  const b = store.books.create({ title: '评分门回归', genre: '玄幻', blurb: '灵感y' }).id;
  const contract = await outline.generateBookContract(b, { idea: '测试灵感' });
  assert.ok(contract.target_readers);
  assert.ok(store.materials.get(b, 'contract')?.content.includes('书契约'), '评分门应基于已落库契约');
});

test('V0.20: generateBookTitle 失败降级不抛异常', async () => {
  // 用无效 idea 也应返回 { ok:false } 而不是崩溃（mock 模式正常返回）
  const r = await (await import('../server/engine/planning/idea.js')).generateBookTitle(bookId, { idea: '' });
  assert.equal(typeof r.ok, 'boolean');
});
