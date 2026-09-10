import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 数据修复框架的 CLI 入口：与具体作品无关，manifest 由夹具现场生成。
const REPAIR_FILE = path.join(ROOT, 'tests', 'helpers', 'data-repair-cli.js');
const BOOK_ID = 'fixture-repair';
const RESTORE_IDXS = [6, 35, 40, 74, 88, 92, 94];

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hanCount(text) {
  let total = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) total++;
  }
  return total;
}

function fullText(db, chapterId) {
  return db.prepare('SELECT content FROM scenes WHERE chapter_id=? ORDER BY idx')
    .all(chapterId).map(row => row.content || '').join('\n');
}

function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params).map(row => ({ ...row }));
}

function domainState(db) {
  return JSON.stringify({
    volumes: rows(db, 'SELECT * FROM volumes ORDER BY id'),
    chapters: rows(db, 'SELECT * FROM chapters ORDER BY id'),
    scenes: rows(db, 'SELECT * FROM scenes ORDER BY id'),
    history: rows(db, 'SELECT * FROM history ORDER BY id'),
    health: rows(db, 'SELECT * FROM chapter_health ORDER BY id'),
    settlements: rows(db, 'SELECT * FROM chapter_settlements ORDER BY chapter_id'),
    summaries: rows(db, 'SELECT * FROM chapter_summaries ORDER BY chapter_id'),
    facts: rows(db, 'SELECT * FROM facts ORDER BY id'),
    timeline: rows(db, 'SELECT * FROM timeline ORDER BY id'),
  });
}

function insertChapter(db, { id, idx, volumeId = 'vol-1', parts, status = 'revised' }) {
  const text = parts.join('\n');
  db.prepare(`INSERT INTO chapters
    (id,book_id,volume_id,idx,title,outline_json,status,word_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, BOOK_ID, volumeId, idx, `第${idx}章`, JSON.stringify({ scenes: parts.map((_, i) => ({ idx: i + 1 })) }), status, hanCount(text), idx);
  for (let i = 0; i < parts.length; i++) {
    const sceneIdx = i + 1;
    const historySeq = idx * 10 + sceneIdx;
    db.prepare(`INSERT INTO history (book_id,seq,role,content)
      VALUES (?,?,?,?)`).run(BOOK_ID, historySeq, 'assistant', parts[i]);
    db.prepare(`INSERT INTO scenes
      (id,chapter_id,idx,pov,location,beat,content,target_words,status,history_seq)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`scene-${idx}-${sceneIdx}`, id, sceneIdx, '李尘', `地点${idx}`, `节拍${sceneIdx}`, parts[i], 1000 + sceneIdx, 'revised', historySeq);
  }
  return text;
}

function createFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anw-feizhai-repair-'));
  const dbPath = path.join(dir, 'fixture.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT, status TEXT);
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, volume_id TEXT, idx INTEGER NOT NULL,
      title TEXT, outline_json TEXT, status TEXT, word_count INTEGER, created_at INTEGER
    );
    CREATE TABLE scenes (
      id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, idx INTEGER NOT NULL,
      pov TEXT, location TEXT, beat TEXT, content TEXT, target_words INTEGER,
      status TEXT, history_seq INTEGER, UNIQUE(chapter_id,idx)
    );
    CREATE TABLE history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, seq INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, UNIQUE(book_id,seq)
    );
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, label TEXT NOT NULL,
      source TEXT, data_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE chapter_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, chapter_id TEXT,
      idx INTEGER NOT NULL, verdict TEXT, issues INTEGER, high_issues INTEGER,
      replan_count INTEGER, failed INTEGER, word_count INTEGER, notes TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE chapter_settlements (
      chapter_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE chapter_summaries (
      chapter_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, summary TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, subject TEXT, predicate TEXT, object TEXT,
      source_chapter INTEGER, status TEXT, note TEXT, created_at INTEGER
    );
    CREATE TABLE timeline (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, chapter_id TEXT, seq INTEGER,
      event TEXT, created_at INTEGER
    );
  `);
 db.prepare('INSERT INTO books VALUES (?,?)').run(BOOK_ID, '示例都市修仙长篇（测试夹具）');
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?,?)').run('vol-1', BOOK_ID, 1, '第一卷', 'outlined');

  const chapter1Text = insertChapter(db, {
    id: 'ch-1', idx: 1, volumeId: null, status: 'done', parts: ['第一章正文。'],
  });
  const chapter103Parts = ['被错误复制的第一场正文。', '被错误复制的第二场正文。'];
  const expected = new Map();
  for (const idx of RESTORE_IDXS) {
    const currentParts = idx === 88
      ? chapter103Parts
      : [`第${idx}章截短正文甲。`, `第${idx}章截短正文乙。`];
    const snapshotParts = [
      `第${idx}章快照中的完整正文第一场，包含更多连续情节。`,
      `第${idx}章快照中的完整正文第二场，结尾与下一章自然衔接。`,
    ];
    const chapterId = `ch-${idx}`;
    const currentText = insertChapter(db, { id: chapterId, idx, parts: currentParts });
    const snapshotId = `snap-${idx}`;
    const snapshotText = snapshotParts.join('\n');
    const snapshotData = {
      chapters: [{
        id: chapterId,
        idx,
        status: 'done',
        word_count: hanCount(snapshotText),
        scenes: snapshotParts.map((content, i) => ({ idx: i + 1, content, status: 'done' })),
      }],
    };
    db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?,?)')
      .run(snapshotId, BOOK_ID, `第${idx}章修复快照`, 'test', JSON.stringify(snapshotData), idx);
    db.prepare('INSERT INTO chapter_settlements VALUES (?,?,?,?,?)')
      .run(chapterId, BOOK_ID, sha256(currentText), JSON.stringify({ summary: `第${idx}章摘要` }), idx);
    db.prepare('INSERT INTO chapter_summaries VALUES (?,?,?,?)')
      .run(chapterId, BOOK_ID, `第${idx}章摘要`, idx);
    db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`fact-${idx}`, BOOK_ID, '李尘', '经历', `第${idx}章事件`, idx, 'active', '', idx);
    db.prepare('INSERT INTO timeline VALUES (?,?,?,?,?,?)')
      .run(`timeline-${idx}`, BOOK_ID, chapterId, idx, `第${idx}章事件`, idx);
    expected.set(idx, {
      chapterId,
      currentText,
      snapshotId,
      snapshotText,
      sceneIds: snapshotParts.map((_, i) => `scene-${idx}-${i + 1}`),
    });
  }
  insertChapter(db, { id: 'ch-103', idx: 103, parts: chapter103Parts, status: 'done' });

  const everyChapter = ['ch-1', ...RESTORE_IDXS.map(idx => `ch-${idx}`), 'ch-103'];
  for (const [offset, chapterId] of everyChapter.entries()) {
    const idx = Number(chapterId.slice(3));
    db.prepare(`INSERT INTO chapter_health
      (book_id,chapter_id,idx,verdict,issues,high_issues,replan_count,failed,word_count,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(BOOK_ID, chapterId, idx, 'pass', 0, 0, 0, 0, 1, '旧记录', offset * 2 + 1);
    db.prepare(`INSERT INTO chapter_health
      (book_id,chapter_id,idx,verdict,issues,high_issues,replan_count,failed,word_count,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(BOOK_ID, chapterId, idx, 'pass', 0, 0, 0, 0, idx === 1 ? hanCount(chapter1Text) : 2, '最新记录', offset * 2 + 2);
  }
  db.prepare(`INSERT INTO chapter_health
    (book_id,chapter_id,idx,verdict,issues,high_issues,replan_count,failed,word_count,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(BOOK_ID, 'ch-6', 6, 'pass', 0, 0, 0, 0, 999, '后插入但时间更旧', 0);
  db.close();

  const manifest = {
    version: 'fixture-v1',
 book: { id: BOOK_ID, title: '示例都市修仙长篇（测试夹具）' },
    volumeBinding: {
      chapterId: 'ch-1', chapterIdx: 1, expectedVolumeId: null,
      volumeId: 'vol-1', volumeIdx: 1,
    },
    restorations: [...expected.entries()].map(([idx, item]) => ({
      chapterId: item.chapterId,
      chapterIdx: idx,
      snapshotId: item.snapshotId,
      expectedCurrentHash: sha256(item.currentText),
      expectedSnapshotHash: sha256(item.snapshotText),
    })),
  };
  return { dir, dbPath, manifest, expected };
}

async function loadRepair() {
  return import(`${pathToFileURL(REPAIR_FILE).href}?t=${Date.now()}-${Math.random()}`);
}

test('dry-run 只读生成高置信修复计划，不创建备份也不改变数据库', async (t) => {
  const fixture = createFixture(t);
  const before = fileHash(fixture.dbPath);
  const { repairDatabase } = await loadRepair();

  const result = await repairDatabase(fixture.dbPath, { manifest: fixture.manifest });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, false);
  assert.equal(result.ready, true);
  assert.equal(result.backup, null);
  assert.equal(result.plan.volumeBindings.length, 1);
  assert.equal(result.plan.restorations.length, RESTORE_IDXS.length);
  assert.ok(result.plan.healthDuplicates.removableRows > 0);
  assert.equal(fileHash(fixture.dbPath), before);
  assert.deepEqual(fs.readdirSync(fixture.dir), ['fixture.db']);
});

test('apply 先备份再原子恢复正文，并能从备份完整还原', async (t) => {
  const fixture = createFixture(t);
  const beforeDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
  const beforeState = domainState(beforeDb);
  const derivedBefore = JSON.stringify({
    summaries: rows(beforeDb, 'SELECT * FROM chapter_summaries ORDER BY chapter_id'),
    facts: rows(beforeDb, 'SELECT * FROM facts ORDER BY id'),
    timeline: rows(beforeDb, 'SELECT * FROM timeline ORDER BY id'),
  });
  assert.equal(fullText(beforeDb, 'ch-88'), fullText(beforeDb, 'ch-103'));
  beforeDb.close();
  const { repairDatabase } = await loadRepair();

  const result = await repairDatabase(fixture.dbPath, { apply: true, manifest: fixture.manifest });

  assert.equal(result.mode, 'apply');
  assert.equal(result.applied, true);
  assert.equal(result.ready, true);
  assert.equal(path.dirname(result.backup.path), fixture.dir);
  assert.equal(fs.existsSync(result.backup.path), true);
  assert.deepEqual(result.backup.integrityCheck, ['ok']);

  const repaired = new DatabaseSync(fixture.dbPath, { readOnly: true });
  assert.equal(repaired.prepare("SELECT volume_id FROM chapters WHERE id='ch-1'").get().volume_id, 'vol-1');
  for (const idx of RESTORE_IDXS) {
    const expected = fixture.expected.get(idx);
    assert.equal(fullText(repaired, expected.chapterId), expected.snapshotText);
    const chapter = repaired.prepare('SELECT status,word_count,outline_json FROM chapters WHERE id=?').get(expected.chapterId);
    assert.equal(chapter.status, 'revised');
    assert.equal(chapter.word_count, hanCount(expected.snapshotText));
    assert.ok(chapter.outline_json.includes('scenes'));
    const scenes = repaired.prepare(`SELECT id,idx,pov,location,beat,target_words,status,history_seq,content
      FROM scenes WHERE chapter_id=? ORDER BY idx`).all(expected.chapterId);
    assert.deepEqual(scenes.map(scene => scene.id), expected.sceneIds);
    for (const scene of scenes) {
      assert.equal(scene.pov, '李尘');
      assert.equal(scene.location, `地点${idx}`);
      assert.equal(scene.beat, `节拍${scene.idx}`);
      assert.equal(scene.target_words, 1000 + scene.idx);
      assert.equal(scene.status, 'revised');
      assert.equal(scene.history_seq, idx * 10 + scene.idx);
      const historical = repaired.prepare('SELECT role,content FROM history WHERE book_id=? AND seq=?')
        .get(BOOK_ID, scene.history_seq);
      assert.equal(historical.role, 'assistant');
      assert.equal(historical.content, scene.content);
    }
    assert.equal(repaired.prepare('SELECT COUNT(*) AS n FROM chapter_settlements WHERE chapter_id=?')
      .get(expected.chapterId).n, 0);
    const health = repaired.prepare('SELECT word_count,notes FROM chapter_health WHERE chapter_id=?').all(expected.chapterId);
    assert.equal(health.length, 1);
    assert.equal(health[0].word_count, hanCount(expected.snapshotText));
    if (idx === 6) assert.equal(health[0].notes, '最新记录');
  }
  assert.notEqual(fullText(repaired, 'ch-88'), fullText(repaired, 'ch-103'));
  assert.equal(JSON.stringify({
    summaries: rows(repaired, 'SELECT * FROM chapter_summaries ORDER BY chapter_id'),
    facts: rows(repaired, 'SELECT * FROM facts ORDER BY id'),
    timeline: rows(repaired, 'SELECT * FROM timeline ORDER BY id'),
  }), derivedBefore);
  assert.equal(repaired.prepare(`SELECT MAX(n) AS maxCount FROM (
    SELECT COUNT(*) AS n FROM chapter_health WHERE book_id=? AND chapter_id IS NOT NULL GROUP BY chapter_id
  )`).get(BOOK_ID).maxCount, 1);
  repaired.close();

  const backup = new DatabaseSync(result.backup.path, { readOnly: true });
  assert.deepEqual(backup.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]), ['ok']);
  assert.equal(domainState(backup), beforeState);
  backup.close();

  fs.copyFileSync(result.backup.path, fixture.dbPath);
  const restored = new DatabaseSync(fixture.dbPath, { readOnly: true });
  assert.equal(domainState(restored), beforeState);
  restored.close();
});

test('apply 用当前正文与快照正文双哈希阻断误应用', async (t) => {
  const { repairDatabase } = await loadRepair();

  await t.test('当前正文哈希变化时拒绝且不创建备份', async (t) => {
    const fixture = createFixture(t);
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("UPDATE scenes SET content=content || '被人工改动' WHERE chapter_id='ch-6' AND idx=1").run();
    db.close();
    const before = fileHash(fixture.dbPath);

    await assert.rejects(
      repairDatabase(fixture.dbPath, { apply: true, manifest: fixture.manifest }),
      error => error.code === 'PRECONDITION_FAILED'
        && error.failures.some(failure => failure.code === 'CURRENT_HASH_MISMATCH' && failure.chapterId === 'ch-6'),
    );
    assert.equal(fileHash(fixture.dbPath), before);
    assert.deepEqual(fs.readdirSync(fixture.dir), ['fixture.db']);
  });

  await t.test('快照正文哈希变化时拒绝且不创建备份', async (t) => {
    const fixture = createFixture(t);
    const db = new DatabaseSync(fixture.dbPath);
    const row = db.prepare("SELECT data_json FROM snapshots WHERE id='snap-35'").get();
    const data = JSON.parse(row.data_json);
    data.chapters[0].scenes[0].content += '被篡改';
    db.prepare("UPDATE snapshots SET data_json=? WHERE id='snap-35'").run(JSON.stringify(data));
    db.close();
    const before = fileHash(fixture.dbPath);

    await assert.rejects(
      repairDatabase(fixture.dbPath, { apply: true, manifest: fixture.manifest }),
      error => error.code === 'PRECONDITION_FAILED'
        && error.failures.some(failure => failure.code === 'SNAPSHOT_HASH_MISMATCH' && failure.chapterId === 'ch-35'),
    );
    assert.equal(fileHash(fixture.dbPath), before);
    assert.deepEqual(fs.readdirSync(fixture.dir), ['fixture.db']);
  });
});

test('history_seq 指向的缓存不是当前 assistant 正文时 fail closed', async (t) => {
  const fixture = createFixture(t);
  const db = new DatabaseSync(fixture.dbPath);
  db.prepare("UPDATE history SET role='user' WHERE book_id=? AND seq=?").run(BOOK_ID, 61);
  db.close();
  const before = fileHash(fixture.dbPath);
  const { repairDatabase } = await loadRepair();

  await assert.rejects(
    repairDatabase(fixture.dbPath, { apply: true, manifest: fixture.manifest }),
    error => error.code === 'PRECONDITION_FAILED'
      && error.failures.some(failure => failure.code === 'HISTORY_POINTER_MISMATCH'
        && failure.chapterId === 'ch-6' && failure.sceneIdx === 1),
  );
  assert.equal(fileHash(fixture.dbPath), before);
  assert.deepEqual(fs.readdirSync(fixture.dir), ['fixture.db']);
});

test('apply 中途失败会回滚全部写入并保留可用备份', async (t) => {
  const fixture = createFixture(t);
  const setup = new DatabaseSync(fixture.dbPath);
  const beforeState = domainState(setup);
  setup.exec(`CREATE TRIGGER force_repair_rollback
    BEFORE UPDATE OF word_count ON chapter_health
    WHEN NEW.chapter_id='ch-94'
    BEGIN SELECT RAISE(ABORT, 'forced repair rollback'); END;`);
  setup.close();
  const { repairDatabase } = await loadRepair();

  let failure;
  try {
    await repairDatabase(fixture.dbPath, { apply: true, manifest: fixture.manifest });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.code, 'APPLY_FAILED');
  assert.ok(failure.backupPath);
  assert.equal(fs.existsSync(failure.backupPath), true);
  const rolledBack = new DatabaseSync(fixture.dbPath, { readOnly: true });
  assert.equal(domainState(rolledBack), beforeState);
  assert.equal(rolledBack.prepare("SELECT volume_id FROM chapters WHERE id='ch-1'").get().volume_id, null);
  assert.equal(fullText(rolledBack, 'ch-88'), fullText(rolledBack, 'ch-103'));
  assert.deepEqual(rolledBack.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]), ['ok']);
  rolledBack.close();
  const backup = new DatabaseSync(failure.backupPath, { readOnly: true });
  assert.equal(domainState(backup), beforeState);
  assert.deepEqual(backup.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]), ['ok']);
  backup.close();
});

test('CLI 参数解析：默认 dry-run 且 apply 强制显式 db', async () => {
  const { parseCliArgs } = await loadRepair();
  assert.deepEqual(parseCliArgs([]), { dbPath: undefined, apply: false, pretty: false });
  assert.deepEqual(parseCliArgs(['--db', 'some.db', '--apply', '--pretty']), {
    dbPath: 'some.db', apply: true, pretty: true,
  });
  assert.throws(() => parseCliArgs(['--apply']), error => error.code === 'APPLY_REQUIRES_DB');

  const child = spawnSync(process.execPath, [REPAIR_FILE, '--apply'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  const errorJson = JSON.parse(child.stderr.trim());
  assert.equal(errorJson.error.code, 'APPLY_REQUIRES_DB');
});
