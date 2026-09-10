// V0.77 数据安全：备份必须是 SQLite 一致性快照，并遵守自定义数据目录与保留策略
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v077-backup-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');

after(() => {
  try { store.db().close(); } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('backup 生成可校验的一致性快照并保留当前 WAL 中的数据', async () => {
  const book = store.books.create({ title: '快照中的书', genre: '玄幻' });
  const backupDir = path.join(tmp, 'backups');
  const dest = await store.backup({
    directory: backupDir,
    filename: 'novel-test.db',
    prefix: 'novel-',
    retention: 7,
  });

  assert.equal(dest, path.join(backupDir, 'novel-test.db'));
  assert.ok(fs.existsSync(dest));
  const snapshot = new DatabaseSync(dest, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('SELECT title FROM books WHERE id=?').get(book.id).title, '快照中的书');
  } finally {
    snapshot.close();
  }
});

test('backup 默认落在 NOVEL_DATA_DIR，按前缀只保留最新 N 份', async () => {
  const names = ['backup_202608090001.db', 'backup_202608090002.db', 'backup_202608090003.db'];
  for (const filename of names) {
    await store.backup({ filename, retention: 2 });
  }
  const remaining = fs.readdirSync(tmp).filter(name => /^backup_\d+\.db$/.test(name)).sort();
  assert.deepEqual(remaining, names.slice(-2));
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'data', names.at(-1))), '不得忽略 NOVEL_DATA_DIR');
});

test('backup 拒绝让文件名逃出目标目录，且可幂等跳过每日已有快照', async () => {
  await assert.rejects(
    store.backup({ directory: path.join(tmp, 'backups'), filename: '..\\escape.db' }),
    /filename|路径|path/i,
  );

  const first = await store.backup({
    directory: path.join(tmp, 'backups'),
    filename: 'novel-2026-08-09.db',
    prefix: 'novel-',
    retention: 7,
  });
  const before = fs.statSync(first).mtimeMs;
  const second = await store.backup({
    directory: path.join(tmp, 'backups'),
    filename: 'novel-2026-08-09.db',
    prefix: 'novel-',
    retention: 7,
    skipIfExists: true,
  });
  assert.equal(second, first);
  assert.equal(fs.statSync(second).mtimeMs, before);
});
