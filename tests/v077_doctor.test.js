// V0.77 只读数据医生：真实 SQLite 夹具覆盖结构、正文、账本与快照诊断
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-doctor-'));
const DB_PATH = path.join(TMP, 'fixture.db');
const BOOK_ID = 'book-doctor';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createFixture() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT, genre TEXT, settings_json TEXT
    );
    CREATE TABLE volumes (
      id TEXT PRIMARY KEY, book_id TEXT, idx INTEGER, title TEXT
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, book_id TEXT, volume_id TEXT, idx INTEGER,
      title TEXT, status TEXT, word_count INTEGER, outline_json TEXT
    );
    CREATE TABLE scenes (
      id TEXT PRIMARY KEY, chapter_id TEXT, idx INTEGER, content TEXT,
      target_words INTEGER, status TEXT
    );
    CREATE TABLE chapter_summaries (
      chapter_id TEXT PRIMARY KEY, book_id TEXT, summary TEXT, updated_at INTEGER
    );
    CREATE TABLE chapter_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT, chapter_id TEXT,
      idx INTEGER, verdict TEXT, word_count INTEGER, created_at INTEGER
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY, book_id TEXT, name TEXT, card_json TEXT,
      first_chapter INTEGER, last_chapter INTEGER
    );
    CREATE TABLE factions (
      id TEXT PRIMARY KEY, book_id TEXT, name TEXT, card_json TEXT,
      first_chapter INTEGER, last_chapter INTEGER
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, book_id TEXT, name TEXT, card_json TEXT,
      first_chapter INTEGER, last_chapter INTEGER
    );
    CREATE TABLE public_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT, kind TEXT,
      content TEXT, updated_at INTEGER
    );
    CREATE TABLE foreshadows (
      id TEXT PRIMARY KEY, book_id TEXT, desc TEXT, status TEXT,
      planted_chapter INTEGER, payoff_chapter INTEGER, note TEXT
    );
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY, book_id TEXT, label TEXT, source TEXT,
      data_json TEXT, created_at INTEGER
    );
  `);

  const repeated = '夜风穿过石门，我握紧骨片继续向前，始终没有回头。'.repeat(18);
  db.prepare('INSERT INTO books VALUES (?,?,?,?)')
    .run(BOOK_ID, '夹具小说', '玄幻', '{}');
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?)').run('v1', BOOK_ID, 1, '第一卷');

  const addChapter = db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)');
  addChapter.run('c1', BOOK_ID, 'v1', 1, '第一章', 'done', 999, '{}');
  addChapter.run('c2', BOOK_ID, null, 3, '孤章', 'done', 20, '{}');
  addChapter.run('c3', BOOK_ID, 'missing-volume', 3, '重号章', 'done', 20, '{}');
  addChapter.run('c4', BOOK_ID, 'v1', 4, '复制章', 'done', repeated.replace(/\s/g, '').length, '{}');

  const addScene = db.prepare('INSERT INTO scenes VALUES (?,?,?,?,?,?)');
  addScene.run('s1', 'c1', 1, repeated, 400, 'done');
  addScene.run('s2', 'c2', 1, '孤章正文很短。', 100, 'done');
  addScene.run('s3', 'c3', 1, '重复章号正文。', 100, 'done');
  addScene.run('s4', 'c4', 1, repeated, 400, 'done');

  db.prepare('INSERT INTO chapter_summaries VALUES (?,?,?,?)')
    .run('c1', BOOK_ID, '第一章已经取得地脉之髓并修复钥匙。', 1);
  const addHealth = db.prepare(
    'INSERT INTO chapter_health (book_id,chapter_id,idx,verdict,word_count,created_at) VALUES (?,?,?,?,?,?)',
  );
  addHealth.run(BOOK_ID, 'c1', 1, 'accept', 700, 1);
  addHealth.run(BOOK_ID, 'c1', 1, 'accept', 50, 2);

  db.prepare('INSERT INTO factions VALUES (?,?,?,?,?,?)')
    .run('f1', BOOK_ID, '青铜门', '{}', 1, 4);
  db.prepare('INSERT INTO locations VALUES (?,?,?,?,?,?)')
    .run('l1', BOOK_ID, '守碑人手札', '{}', 1, 4);
  db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?)')
    .run('i1', BOOK_ID, '三个守印人', '{}', 1, 4);

  db.prepare('INSERT INTO public_materials (book_id,kind,content,updated_at) VALUES (?,?,?,?)')
    .run(BOOK_ID, 'polish_feedback', '【创作中期审阅反馈】（第1章时生成，供后续使用）', 1);
  db.prepare('INSERT INTO public_materials (book_id,kind,content,updated_at) VALUES (?,?,?,?)')
    .run(BOOK_ID, 'foreshadow_plan', '[resolve] 地脉之髓的线索（目标第8章附近，计划：对峙灰衣人夺髓，修复钥匙并揭示封印核心。）', 2);
  db.prepare('INSERT INTO foreshadows VALUES (?,?,?,?,?,?,?)')
    .run('fs1', BOOK_ID, '地脉之髓的线索', 'advanced', 1, 8, '账本仍未回收');

  const snapshotText = `${repeated}${repeated}快照中的完整结尾。`;
  const snapshot = {
    chapters: [{
      id: 'c1', idx: 1, title: '第一章', status: 'done',
      word_count: snapshotText.replace(/\s/g, '').length,
      scenes: [{ idx: 1, content: snapshotText, status: 'done' }],
    }],
  };
  db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?,?)')
    .run('snap1', BOOK_ID, '受损前快照', 'auto', JSON.stringify(snapshot), 10);
  db.close();
}

before(createFixture);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('auditDatabase 汇总所有要求的异常并只报告快照恢复候选', async () => {
  const { auditDatabase } = await import('../server/maintenance/doctor.js');
  const beforeHash = sha256File(DB_PATH);
  const report = auditDatabase(DB_PATH, {
    staleMaterialAfterChapters: 2,
    similarityThreshold: 0.35,
  });
  const afterHash = sha256File(DB_PATH);

  assert.equal(afterHash, beforeHash, '医生不得修改 SQLite 文件');
  assert.equal(report.mode, 'read-only');
  assert.equal(report.database.integrityCheck, 'ok');
  assert.equal(report.books.length, 1);
  const book = report.books[0];

  assert.deepEqual(book.checks.chapterIndex.duplicates, [3]);
  assert.deepEqual(book.checks.chapterIndex.gaps, [2]);
  assert.equal(book.checks.volumeAssignments.unassigned[0].chapterId, 'c2');
  assert.equal(book.checks.volumeAssignments.missingVolumeRefs[0].chapterId, 'c3');
  assert.equal(book.checks.volumeExportOrder.ok, false);
  assert.ok(book.checks.volumeExportOrder.inversions.length > 0);
  assert.equal(book.checks.wordCounts.metric, 'han_characters');
  assert.ok(book.checks.wordCounts.mismatches.some(x => x.chapterId === 'c1'));
  assert.deepEqual(book.checks.summaries.missing.map(x => x.chapterId).sort(), ['c2', 'c3', 'c4']);
  assert.equal(book.checks.health.duplicateRecords[0].chapterId, 'c1');
  assert.equal(book.checks.health.staleRecords[0].chapterId, 'c1');
  assert.ok(book.checks.similarity.highSimilarity.some(x => x.leftIdx === 1 && x.rightIdx === 4));
  assert.ok(book.checks.similarity.exactSentenceRepeats.length > 0);
  assert.deepEqual(
    book.checks.entityTypes.suspicious.map(x => `${x.table}:${x.name}`).sort(),
    ['factions:青铜门', 'items:三个守印人', 'locations:守碑人手札'],
  );
  const stalePolish = book.checks.staleMaterials.findings.find(x => x.kind === 'polish_feedback');
  const staleForeshadow = book.checks.staleMaterials.findings.find(x => x.kind === 'foreshadow_plan');
  assert.ok(stalePolish);
  assert.deepEqual(stalePolish.targetChapters, [], '生成章不应误报为计划目标章');
  assert.ok(staleForeshadow);
  assert.deepEqual(staleForeshadow.targetChapters, [8]);
  assert.ok(staleForeshadow.reasons.includes('plan_likely_already_realized'));

  const candidate = book.recoveryCandidates.find(x => x.chapter.idx === 1);
  assert.ok(candidate);
  assert.deepEqual(Object.keys(candidate).sort(), ['chapter', 'current', 'snapshot'].sort());
  assert.deepEqual(Object.keys(candidate.chapter).sort(), ['id', 'idx'].sort());
  assert.deepEqual(Object.keys(candidate.current).sort(), ['hash', 'length'].sort());
  assert.deepEqual(Object.keys(candidate.snapshot).sort(), ['hash', 'id', 'label', 'length'].sort());
  assert.equal(candidate.current.hash.length, 64);
  assert.equal(candidate.snapshot.hash.length, 64);
  assert.ok(candidate.snapshot.length > candidate.current.length);
  assert.ok(!JSON.stringify(candidate).includes('快照中的完整结尾'), '候选不得泄露或应用快照正文');
});

test('CLI 接受 --db 并输出可解析 JSON，执行前后数据库哈希不变', () => {
  const beforeHash = sha256File(DB_PATH);
  const stdout = execFileSync(
    process.execPath,
    [path.join(ROOT, 'server/maintenance/doctor.js'), '--db', DB_PATH],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const afterHash = sha256File(DB_PATH);
  const report = JSON.parse(stdout);

  assert.equal(afterHash, beforeHash);
  assert.equal(report.mode, 'read-only');
  assert.equal(report.database.integrityCheck, 'ok');
  assert.equal(report.dbPath, path.resolve(DB_PATH));
  assert.equal(report.books[0].id, BOOK_ID);
});
