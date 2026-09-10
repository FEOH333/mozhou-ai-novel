import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildBookExport } from '../server/engine/export.js';
import { buildOpeningPublishPatch, composeOpeningAsset } from '../server/engine/opening_intervention.js';
import { openingFingerprint } from '../server/engine/opening_diagnosis.js';
import { checkOpeningAssets } from '../server/maintenance/doctor.js';

const book = { id: 'bk-export', title: '导出书' };
const volume = { id: 'v1', idx: 1, title: '第一卷' };
const chapter = { id: 'c1', idx: 1, title: '灯影', volume_id: 'v1' };
const input = { book, volumes: [volume], chapters: [chapter], fullTexts: new Map([[chapter.id, '第一章原文']]) };

test('V0.98 无 opening asset 时导出逐字节不变', () => {
  const oldResult = buildBookExport(input);
  const newResult = buildBookExport({ ...input, openingAsset: null });
  assert.equal(newResult.text, oldResult.text);
  assert.deepEqual(newResult.chapterList, oldResult.chapterList);
});

test('V0.98 prepend_chapter1 合成进第一章顶部，不创建第0章或小数章', () => {
  const asset = { placement: 'prepend_chapter1', content: '未来城头一瞬。' };
  const result = buildBookExport({ ...input, openingAsset: asset });
  assert.ok(result.text.indexOf('未来城头一瞬。') < result.text.indexOf('第一章原文'));
  assert.equal((result.text.match(/第1章/g) || []).length, 1);
  assert.doesNotMatch(result.text, /第0章|0\.5章|1\.5章/);
});

test('V0.98 before_chapter1 只输出普通标题“楔子”，章节编号仍从1开始', () => {
  const asset = { placement: 'before_chapter1', content: '独立前奏正文。' };
  const result = buildBookExport({ ...input, openingAsset: asset });
  assert.match(result.text, /楔子\n\n独立前奏正文/);
  assert.ok(result.text.indexOf('楔子') < result.text.indexOf('第1章'));
  assert.doesNotMatch(result.text, /第0章/);
});

test('V0.98 发布同步包保存完整 before/after 与可验证哈希', () => {
  const asset = { id: 'oa-1', placement: 'prepend_chapter1', content: '前置正文。' };
  const beforeText = '第一章原文';
  const afterText = composeOpeningAsset(asset, beforeText).firstChapterText;
  const patch = buildOpeningPublishPatch({ book, chapter, beforeText, afterText, asset });
  assert.equal(patch.book_id, book.id);
  assert.equal(patch.chapter_id, chapter.id);
  assert.equal(patch.mode, 'prepend_chapter1');
  assert.equal(patch.before_text, beforeText);
  assert.equal(patch.after_text, afterText);
  assert.equal(patch.before_hash.length, 64);
  assert.equal(patch.after_hash.length, 64);
  assert.notEqual(patch.before_hash, patch.after_hash);
});

test('V0.98 doctor 报告陈旧、双 active、正文泄漏和未验证独立楔子', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, blurb TEXT, genre TEXT, platform TEXT, settings_json TEXT);
    CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT, idx INTEGER, outline_json TEXT);
    CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT, volume_id TEXT, idx INTEGER, title TEXT, status TEXT, word_count INTEGER, outline_json TEXT);
    CREATE TABLE scenes (id TEXT PRIMARY KEY, chapter_id TEXT, idx INTEGER, content TEXT);
    CREATE TABLE opening_assets (
      id TEXT PRIMARY KEY, book_id TEXT, kind TEXT, placement TEXT, title TEXT,
      anchor_scene_id TEXT, anchor_start INTEGER, anchor_end INTEGER,
      source_excerpt TEXT, source_hash TEXT, content TEXT, contract_json TEXT,
      audit_json TEXT, rank_json TEXT, creative_hypothesis TEXT, status TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE history (book_id TEXT, seq INTEGER, role TEXT, content TEXT);
    CREATE TABLE facts (book_id TEXT, subject TEXT, predicate TEXT, object TEXT, note TEXT);
    CREATE TABLE timeline (book_id TEXT, event TEXT, year INTEGER);
    CREATE TABLE rolling_summaries (book_id TEXT, content TEXT);
    CREATE TABLE vectors (book_id TEXT, kind TEXT, ref_id TEXT, chunk TEXT, embedding_json TEXT);
    CREATE TABLE public_materials (book_id TEXT, kind TEXT, content TEXT);
  `);
  const sourceText = '第一章当前正文，已经被作者改动。';
  const readerText = '这是一段只能存在于读者前置层的秘密正文，绝不能进入故事记忆。';
  const dbBook = { id: 'bk-doctor-opening', title: '体检书', blurb: '简介', genre: '历史', platform: '番茄' };
  const currentFingerprint = openingFingerprint(dbBook, [{ idx: 1, title: '第一章', text: sourceText }]);
  const settings = {
    storyPromiseProfile: { source_fingerprint: 'promise-current' },
    openingIntervention: { platformCompatibility: { frontMatter: 'verified', checkedAt: Date.now(), checks: { authorEditorAccepted: true } } },
  };
  db.prepare('INSERT INTO books VALUES (?,?,?,?,?,?)').run(dbBook.id, dbBook.title, dbBook.blurb, dbBook.genre, dbBook.platform, JSON.stringify(settings));
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?)').run('v1', dbBook.id, 1, JSON.stringify({ year: 1241, event_keys: [] }));
  db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)').run('c1', dbBook.id, 'v1', 1, '第一章', 'done', sourceText.length, JSON.stringify({ year: 1241 }));
  db.prepare('INSERT INTO scenes VALUES (?,?,?,?)').run('s1', 'c1', 1, sourceText);

  const insertAsset = db.prepare('INSERT INTO opening_assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insertAsset.run('oa-head', dbBook.id, 'head_rewrite', 'scene_patch', '', 's1', 0, 4,
    '已经不是这里', 'stale-source-hash', '新开头', '{}', '{}', JSON.stringify({
      source_fingerprint: 'old-source', promise_profile_fingerprint: 'promise-current', diagnosis_fingerprint: 'old-source',
    }), '', 'candidate', 1, 1);
  insertAsset.run('oa-prologue', dbBook.id, 'standalone_prologue', 'before_chapter1', '楔子', null, null, null,
    '', '', readerText, JSON.stringify({
      promise_key: 'opening:test', target_event_key: 'missing:event', target_year: 1259, target_volume_id: 'missing-volume', status: 'open',
    }), '{}', JSON.stringify({
      source_fingerprint: currentFingerprint, promise_profile_fingerprint: 'promise-current', diagnosis_fingerprint: 'old-source',
      application: { after_hash: 'stale-after-hash' },
    }), '', 'applied', 2, 2);
  insertAsset.run('oa-second', dbBook.id, 'chapter1_cold_open', 'prepend_chapter1', '', null, null, null,
    '', '', '另一个前置层正文。', '{}', '{}', '{}', '', 'selected', 3, 3);
  insertAsset.run('oa-invalid', dbBook.id, 'chapter1_cold_open', 'prepend_chapter1', '', null, null, null,
    '', '', '坏状态正文。', '{}', '{}', '{}', '', 'mystery', 4, 4);
  db.prepare('INSERT INTO history VALUES (?,?,?,?)').run(dbBook.id, 1, 'assistant', `意外泄漏：${readerText}`);
  db.prepare('INSERT INTO public_materials VALUES (?,?,?)').run(dbBook.id, 'opening_diagnosis', JSON.stringify({
    version: 3, source_fingerprint: 'old-source', promise_profile_fingerprint: 'promise-current',
  }));

  const report = checkOpeningAssets(db, dbBook.id);
  const codes = new Set(report.issues.map(item => item.code));
  for (const code of [
    'OPENING_STATUS_INVALID', 'OPENING_ACTIVE_LAYER_CONFLICT', 'OPENING_SOURCE_STALE',
    'OPENING_MEMORY_LEAK', 'OPENING_CONTRACT_INVALID', 'OPENING_PLATFORM_UNVERIFIED',
    'OPENING_PUBLISH_PATCH_STALE', 'OPENING_DIAGNOSIS_STALE', 'OPENING_REVIEW_STALE',
  ]) assert.ok(codes.has(code), `应报告 ${code}`);
  db.close();
});

test('V0.98 doctor 与创作器同源识别通用史实语义锚', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, blurb TEXT, genre TEXT, platform TEXT, settings_json TEXT);
    CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT, idx INTEGER, outline_json TEXT);
    CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT, volume_id TEXT, idx INTEGER, title TEXT, status TEXT, word_count INTEGER, outline_json TEXT);
    CREATE TABLE scenes (id TEXT PRIMARY KEY, chapter_id TEXT, idx INTEGER, content TEXT);
    CREATE TABLE opening_assets (
      id TEXT PRIMARY KEY, book_id TEXT, kind TEXT, placement TEXT, title TEXT,
      anchor_scene_id TEXT, anchor_start INTEGER, anchor_end INTEGER,
      source_excerpt TEXT, source_hash TEXT, content TEXT, contract_json TEXT,
      audit_json TEXT, rank_json TEXT, creative_hypothesis TEXT, status TEXT,
      created_at INTEGER, updated_at INTEGER
    );
  `);
  const bookId = 'bk-semantic-anchor';
  const firstText = '九岁的孩子攥住母亲的衣角。';
  db.prepare('INSERT INTO books VALUES (?,?,?,?,?,?)').run(bookId, '换名历史书', '简介', '历史', '番茄', '{}');
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?)').run('v-opening', bookId, 1, JSON.stringify({ year: 1241 }));
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?)').run('v-target', bookId, 5,
    JSON.stringify({ start_year: 1259, end_year: 1260, historical_anchor: '1259年钓鱼城之战与蒙哥之死' }));
  db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)').run('c1', bookId, 'v-opening', 1, '第一章', 'done', firstText.length, JSON.stringify({ year: 1241 }));
  db.prepare('INSERT INTO scenes VALUES (?,?,?,?)').run('s1', 'c1', 1, firstText);
  const contract = {
    promise_key: 'opening:1259-diaoyucheng-question',
    target_event_key: 'historical:1259:diaoyucheng-mongke-death',
    target_year: 1259, target_volume_id: 'v-target', status: 'open',
  };
  const rank = { application: { after_hash: createHash('sha256').update(`城头风紧。\n\n${firstText}`).digest('hex') } };
  db.prepare('INSERT INTO opening_assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'oa-semantic', bookId, 'chapter1_cold_open', 'prepend_chapter1', '', null, null, null,
    '', '', '城头风紧。', JSON.stringify(contract), '{}', JSON.stringify(rank), '', 'applied', 1, 1,
  );

  const report = checkOpeningAssets(db, bookId);
  assert.ok(!report.issues.some(item => item.code === 'OPENING_CONTRACT_INVALID'));
  db.close();
});
