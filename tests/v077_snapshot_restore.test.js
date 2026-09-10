// V0.77：快照恢复必须原子、保留稳定元数据、清理孤儿，并由 HTTP 入口先备份再重建历史。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const unitDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v077-snapshot-unit-'));
process.env.NOVEL_DATA_DIR = unitDataDir;
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');

function makeChapter({ title = '第一章', content = '快照正文' } = {}) {
  const book = store.books.create({ title: `快照书-${Date.now()}-${Math.random()}`, genre: '玄幻', blurb: '测试' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷', status: 'outlined' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title, status: 'done', outline: { goal: '旧目标' },
  });
  store.chapters.update(chapter.id, { wordCount: content.length });
  const historySeq = store.history.append(book.id, 'assistant', content);
  const scene = store.scenes.create(chapter.id, 1, {
    pov: '旧主角', location: '旧城', beat: '旧节拍', content,
    targetWords: 1888, status: 'done',
  });
  store.scenes.update(scene.id, { historySeq });
  return { book, volume, chapter, scene: store.scenes.get(scene.id), historySeq };
}

describe('V0.77 store 快照恢复安全', () => {
  test('现有章场景原位更新：ID 与结构元数据不变，只恢复快照正文状态字段', () => {
    const { book, chapter, scene } = makeChapter();
    const snapshot = store.snapshotBook(book.id);
    const snapChapter = snapshot.chapters[0];
    const snapScene = snapChapter.scenes[0];
    assert.equal(snapChapter.id, chapter.id);
    assert.equal(snapChapter.volume_id, chapter.volume_id);
    assert.equal(snapScene.id, scene.id);
    assert.equal(snapScene.pov, '旧主角');
    assert.equal(snapScene.target_words, 1888);
    assert.equal(snapScene.history_seq, scene.history_seq);

    store.chapters.update(chapter.id, {
      title: '被改标题', status: 'writing', wordCount: 999, outline: { goal: '被改目标' },
    });
    store.scenes.update(scene.id, {
      pov: '当前主角', location: '当前城', beat: '当前节拍', targetWords: 2666,
      content: '被改正文', status: 'writing', historySeq: scene.history_seq,
    });
    const extraHistorySeq = store.history.append(book.id, 'assistant', '快照后多出的场景');
    const extraScene = store.scenes.create(chapter.id, 2, {
      pov: '额外视角', content: '快照后多出的场景', status: 'done',
    });
    store.scenes.update(extraScene.id, { historySeq: extraHistorySeq });

    store.restoreSnapshot(book.id, snapshot);

    const restoredChapter = store.chapters.get(chapter.id);
    const restoredScene = store.scenes.get(scene.id);
    assert.equal(restoredChapter.id, chapter.id);
    assert.equal(restoredChapter.title, '第一章');
    assert.equal(restoredChapter.status, 'done');
    assert.equal(restoredChapter.word_count, '快照正文'.length);
    assert.equal(store.chapters.outline(chapter.id).goal, '旧目标');
    assert.equal(restoredScene.id, scene.id);
    assert.equal(restoredScene.content, '快照正文');
    assert.equal(restoredScene.status, 'done');
    assert.equal(restoredScene.pov, '当前主角');
    assert.equal(restoredScene.location, '当前城');
    assert.equal(restoredScene.beat, '当前节拍');
    assert.equal(restoredScene.target_words, 2666);
    assert.equal(restoredScene.history_seq, scene.history_seq);
    assert.equal(store.scenes.get(extraScene.id), undefined);
    assert.equal(store.db().prepare('SELECT COUNT(*) AS n FROM history WHERE book_id=? AND seq=?').get(book.id, extraHistorySeq).n, 0);
  });

  test('快照中的已删除章可用原章/场景 ID 与元数据恢复', () => {
    const { book, volume, chapter, scene } = makeChapter({ title: '待复活章', content: '复活正文' });
    const snapshot = store.snapshotBook(book.id);
    store.chapters.remove(chapter.id);
    assert.equal(store.chapters.get(chapter.id), undefined);

    store.restoreSnapshot(book.id, snapshot);

    const restoredChapter = store.chapters.get(chapter.id);
    const restoredScene = store.scenes.get(scene.id);
    assert.equal(restoredChapter.id, chapter.id);
    assert.equal(restoredChapter.volume_id, volume.id);
    assert.equal(restoredScene.id, scene.id);
    assert.equal(restoredScene.pov, '旧主角');
    assert.equal(restoredScene.location, '旧城');
    assert.equal(restoredScene.beat, '旧节拍');
    assert.equal(restoredScene.target_words, 1888);
    assert.equal(restoredScene.history_seq, scene.history_seq);
  });

  test('恢复中途失败会回滚此前更新与删除', () => {
    const { book, volume, chapter, scene } = makeChapter({ content: '事务快照正文' });
    const snapshot = store.snapshotBook(book.id);
    store.scenes.update(scene.id, { content: '事务前当前正文' });
    const extra = store.chapters.create(book.id, volume.id, 2, { title: '触发失败章', status: 'done' });
    store.scenes.create(extra.id, 1, { content: '不得被删', status: 'done' });
    store.db().exec(`
      CREATE TRIGGER v077_snapshot_restore_abort
      BEFORE DELETE ON chapters
      WHEN OLD.id = '${extra.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected snapshot restore failure');
      END
    `);
    try {
      assert.throws(() => store.restoreSnapshot(book.id, snapshot), /injected snapshot restore failure/);
    } finally {
      store.db().exec('DROP TRIGGER IF EXISTS v077_snapshot_restore_abort');
    }
    assert.equal(store.scenes.get(scene.id).content, '事务前当前正文');
    assert.ok(store.chapters.get(extra.id));
    assert.equal(store.chapters.fullText(extra.id), '不得被删');
  });

  test('删除快照外章节时清理所有 chapter_id 引用、向量与场景历史', () => {
    const { book, volume } = makeChapter({ content: '保留正文' });
    const snapshot = store.snapshotBook(book.id);
    const extra = store.chapters.create(book.id, volume.id, 2, { title: '快照外章', status: 'done' });
    const historySeq = store.history.append(book.id, 'assistant', '快照外正文');
    const extraScene = store.scenes.create(extra.id, 1, { content: '快照外正文', status: 'done' });
    store.scenes.update(extraScene.id, { historySeq });
    store.summaries.set(extra.id, book.id, '快照外摘要');
    store.chapterSettlements.set(book.id, extra.id, { contentHash: 'hash', result: { summary: 'x' } });
    store.conflicts.create(book.id, { chapterId: extra.id, issue: '快照外冲突' });
    store.timeline.add(book.id, { chapterId: extra.id, event: '快照外事件' });
    store.usageLogs.add({ bookId: book.id, chapterId: extra.id, task: 'write', model: 'mock' });
    store.chapterHealth.add({ bookId: book.id, chapterId: extra.id, idx: 2, verdict: 'ok' });
    store.vectors.add(book.id, { kind: 'chapter', refId: extra.id, chunk: '正文向量', embedding: [1] });
    store.vectors.add(book.id, { kind: 'summary', refId: extra.id, chunk: '摘要向量', embedding: [1] });

    store.restoreSnapshot(book.id, snapshot);

    const db = store.db();
    assert.equal(store.chapters.get(extra.id), undefined);
    for (const table of ['scenes', 'chapter_summaries', 'chapter_settlements', 'conflicts', 'timeline', 'chapter_health']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE chapter_id=?`).get(extra.id).n, 0, table);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE book_id=? AND ref_id=? AND kind IN ('chapter','summary')").get(book.id, extra.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history WHERE book_id=? AND seq=?').get(book.id, historySeq).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs WHERE chapter_id=?').get(extra.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs WHERE book_id=? AND task=?').get(book.id, 'write').n, 1, '成本日志应保留但解除孤儿引用');
  });

  test('无效、空或重复位置快照 fail closed', () => {
    const { book, chapter, scene } = makeChapter({ content: '不可破坏正文' });
    const before = [store.chapters.get(chapter.id), store.scenes.get(scene.id)];
    for (const invalid of [
      null,
      {},
      { chapters: [] },
      { chapters: [{ idx: 1, scenes: 'bad' }] },
      { chapters: [{ idx: 1, scenes: [] }, { idx: 1, scenes: [] }] },
      { chapters: [{ idx: 1, scenes: [{ idx: 1 }, { idx: 1 }] }] },
    ]) {
      assert.throws(() => store.restoreSnapshot(book.id, invalid), error => error?.code === 'INVALID_SNAPSHOT');
    }
    assert.deepEqual(store.chapters.get(chapter.id), before[0]);
    assert.deepEqual(store.scenes.get(scene.id), before[1]);
  });
});

describe('V0.77 HTTP 快照恢复安全', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v077-snapshot-http-'));
  let port;
  let base;
  let child;
  let book;
  let snapshot;
  let sceneId;

  function freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const value = server.address().port;
        server.close(error => error ? reject(error) : resolve(value));
      });
    });
  }

  async function json(method, pathname, body) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json', Origin: base };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${pathname}`, options);
    const raw = await response.text();
    return { response, body: raw ? JSON.parse(raw) : null, raw };
  }

  async function create(pathname, body) {
    const result = await json('POST', pathname, body);
    assert.equal(result.response.status, 200, `${pathname}: ${result.raw}`);
    return result.body;
  }

  before(async () => {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NOVEL_DATA_DIR: dataDir,
        NOVEL_PORT: String(port),
        NOVEL_NO_OPEN: '1',
        NOVEL_MOCK_LLM: '1',
        NOVEL_FAULT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) break;
      } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(Date.now() < deadline, 'test server did not start');

    book = await create('/api/books', { title: 'HTTP 快照书', genre: '玄幻' });
    const volume = await create(`/api/books/${book.id}/volumes`, { title: '第一卷' });
    const chapter = await create(`/api/books/${book.id}/chapters`, { title: '第一章', volumeId: volume.id, status: 'done' });
    sceneId = 'sc-v077-http-restore';
    const db = new DatabaseSync(path.join(dataDir, 'novel.db'));
    db.exec('PRAGMA busy_timeout=10000');
    db.prepare('UPDATE history SET content=? WHERE book_id=? AND seq=1').run('system', book.id);
    db.prepare('UPDATE history SET content=? WHERE book_id=? AND seq=2').run('materials', book.id);
    db.prepare('INSERT INTO history (book_id,seq,role,content) VALUES (?,?,?,?)').run(book.id, 3, 'assistant', '快照正文');
    db.prepare(`INSERT INTO scenes
      (id,chapter_id,idx,pov,location,beat,content,target_words,status,history_seq)
      VALUES (?, ?, 1, '主角', '旧城', '旧节拍', '快照正文', 1888, 'done', 3)`).run(sceneId, chapter.id);
    db.close();
    snapshot = await create(`/api/books/${book.id}/snapshots`, { label: 'HTTP 恢复点' });

    const changed = new DatabaseSync(path.join(dataDir, 'novel.db'));
    changed.exec('PRAGMA busy_timeout=10000');
    changed.prepare("UPDATE scenes SET content='备份应保存的当前正文', status='revised' WHERE id=?").run(sceneId);
    changed.prepare("UPDATE history SET content='备份应保存的当前正文' WHERE book_id=? AND seq=3").run(book.id);
    changed.close();
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('HTTP 恢复先生成路径安全的一致备份，再恢复并重建正文历史', async () => {
    const result = await json('POST', `/api/books/${book.id}/snapshots/${snapshot.id}/restore`, {});
    assert.equal(result.response.status, 200, result.raw);
    assert.equal(result.body.ok, true);
    assert.equal(typeof result.body.backup, 'string');
    const backupDir = path.resolve(dataDir, 'backups');
    const backupPath = path.resolve(result.body.backup);
    const rel = path.relative(backupDir, backupPath);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), backupPath);
    assert.equal(fs.existsSync(backupPath), true);

    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(backupDb.prepare('SELECT content FROM scenes WHERE id=?').get(sceneId).content, '备份应保存的当前正文');
    backupDb.close();

    const live = new DatabaseSync(path.join(dataDir, 'novel.db'));
    const scene = live.prepare('SELECT * FROM scenes WHERE id=?').get(sceneId);
    assert.equal(scene.content, '快照正文');
    assert.equal(scene.pov, '主角');
    assert.equal(scene.location, '旧城');
    assert.equal(scene.beat, '旧节拍');
    assert.equal(scene.target_words, 1888);
    assert.ok(scene.history_seq >= 3);
    assert.equal(live.prepare('SELECT content FROM history WHERE book_id=? AND seq=?').get(book.id, scene.history_seq).content, '快照正文');
    assert.equal(live.prepare("SELECT COUNT(*) AS n FROM history WHERE book_id=? AND content='备份应保存的当前正文'").get(book.id).n, 0);
    live.close();
  });

  test('自动备份失败时 HTTP 恢复 fail closed', async () => {
    const livePath = path.join(dataDir, 'novel.db');
    const changed = new DatabaseSync(livePath);
    changed.exec('PRAGMA busy_timeout=10000');
    changed.prepare("UPDATE scenes SET content='备份失败时必须保留' WHERE id=?").run(sceneId);
    changed.close();

    const backupDir = path.join(dataDir, 'backups');
    const parkedDir = path.join(dataDir, 'backups-before-failure');
    if (fs.existsSync(backupDir)) fs.renameSync(backupDir, parkedDir);
    else fs.mkdirSync(parkedDir, { recursive: true });
    fs.writeFileSync(backupDir, '阻止创建备份目录');
    try {
      const result = await json('POST', `/api/books/${book.id}/snapshots/${snapshot.id}/restore`, {});
      assert.equal(result.response.status, 400, result.raw);
      const verify = new DatabaseSync(livePath, { readOnly: true });
      assert.equal(verify.prepare('SELECT content FROM scenes WHERE id=?').get(sceneId).content, '备份失败时必须保留');
      verify.close();
    } finally {
      fs.rmSync(backupDir, { force: true });
      fs.renameSync(parkedDir, backupDir);
    }
  });
});

after(() => {
  try { fs.rmSync(unitDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
