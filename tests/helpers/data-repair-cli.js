// tests/helpers/data-repair-cli.js —— 确定性离线数据修复框架（可执行 CLI + 可导入）
//
// 用途：整库以「双哈希 manifest」为合同做原子正文恢复。默认只读 dry-run；
// 只有显式 --apply 且提供 --db 时才会写入，写入前先做一致性备份。
//
// 合同：manifest.restorations 里每条都同时给出「当前正文哈希」与「快照正文哈希」，
// 两者都必须逐字匹配才认为可修复——任一不符即 fail-closed，不猜、不模糊匹配。
'use strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_DB = fileURLToPath(new URL('../../data/novel.db', import.meta.url));

/** 空 manifest 占位：真实使用须由调用方传入自己的 restorations。 */
export const EMPTY_REPAIR_MANIFEST = Object.freeze({
  version: 'unconfigured',
  book: Object.freeze({ id: '', title: '' }),
  volumeBinding: Object.freeze({
    chapterId: '', chapterIdx: 1, expectedVolumeId: null, volumeId: '', volumeIdx: 1,
  }),
  restorations: Object.freeze([]),
});
function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function hanCount(text) {
  let total = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) total++;
  }
  return total;
}

function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function integrityCheck(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  return rows.map(row => String(Object.values(row)[0] || ''));
}

function chapterScenes(db, chapterId) {
  return db.prepare(`SELECT id,chapter_id,idx,pov,location,beat,content,target_words,status,history_seq
    FROM scenes WHERE chapter_id=? ORDER BY idx`).all(chapterId);
}

function joinedText(scenes) {
  return scenes.map(scene => scene.content || '').join('\n');
}

function inspectDatabase(db, manifest) {
  const failures = [];
  const requiredTables = ['books', 'volumes', 'chapters', 'scenes', 'snapshots', 'chapter_health'];
  for (const table of requiredTables) {
    if (!hasTable(db, table)) failures.push({ code: 'MISSING_TABLE', table });
  }
  if (failures.length) {
    return {
      ready: false,
      failures,
      plan: { volumeBindings: [], restorations: [], healthDuplicates: { chapters: 0, removableRows: 0 } },
      prepared: [],
    };
  }

  const book = db.prepare('SELECT id,title FROM books WHERE id=?').get(manifest.book.id);
  if (!book || book.title !== manifest.book.title) {
    failures.push({
      code: 'BOOK_MISMATCH',
      expected: manifest.book,
      actual: book ? { id: book.id, title: book.title } : null,
    });
  }

  const volumeBindings = [];
  const binding = manifest.volumeBinding;
  const bindingChapter = db.prepare('SELECT id,book_id,volume_id,idx FROM chapters WHERE id=?').get(binding.chapterId);
  const targetVolume = db.prepare('SELECT id,book_id,idx FROM volumes WHERE id=?').get(binding.volumeId);
  if (!bindingChapter
    || bindingChapter.book_id !== manifest.book.id
    || Number(bindingChapter.idx) !== Number(binding.chapterIdx)
    || bindingChapter.volume_id !== binding.expectedVolumeId) {
    failures.push({
      code: 'VOLUME_BINDING_PRECONDITION_FAILED',
      chapterId: binding.chapterId,
      expectedVolumeId: binding.expectedVolumeId,
      actualVolumeId: bindingChapter?.volume_id ?? null,
    });
  } else if (!targetVolume
    || targetVolume.book_id !== manifest.book.id
    || Number(targetVolume.idx) !== Number(binding.volumeIdx)) {
    failures.push({
      code: 'TARGET_VOLUME_MISMATCH',
      volumeId: binding.volumeId,
      expectedIdx: binding.volumeIdx,
    });
  } else {
    volumeBindings.push({
      chapter: { id: binding.chapterId, idx: binding.chapterIdx },
      fromVolumeId: binding.expectedVolumeId,
      toVolume: { id: binding.volumeId, idx: binding.volumeIdx },
    });
  }

  const restorations = [];
  const prepared = [];
  for (const item of manifest.restorations) {
    const chapter = db.prepare(`SELECT id,book_id,idx,status,word_count,outline_json
      FROM chapters WHERE id=?`).get(item.chapterId);
    if (!chapter || chapter.book_id !== manifest.book.id || Number(chapter.idx) !== Number(item.chapterIdx)) {
      failures.push({ code: 'CHAPTER_MISMATCH', chapterId: item.chapterId, chapterIdx: item.chapterIdx });
      continue;
    }
    const currentScenes = chapterScenes(db, chapter.id);
    const currentText = joinedText(currentScenes);
    const currentHash = sha256(currentText);
    if (currentHash !== item.expectedCurrentHash) {
      failures.push({
        code: 'CURRENT_HASH_MISMATCH',
        chapterId: chapter.id,
        chapterIdx: chapter.idx,
        expectedHash: item.expectedCurrentHash,
        actualHash: currentHash,
      });
      continue;
    }
    let historyMismatch = false;
    for (const scene of currentScenes) {
      if (scene.history_seq == null) continue;
      const historical = hasTable(db, 'history')
        ? db.prepare('SELECT book_id,role,content FROM history WHERE book_id=? AND seq=?')
          .get(manifest.book.id, scene.history_seq)
        : null;
      if (!historical || historical.book_id !== manifest.book.id
        || historical.role !== 'assistant' || historical.content !== scene.content) {
        failures.push({
          code: 'HISTORY_POINTER_MISMATCH',
          chapterId: chapter.id,
          chapterIdx: chapter.idx,
          sceneIdx: scene.idx,
          historySeq: scene.history_seq,
          expectedContentHash: sha256(scene.content || ''),
          actualRole: historical?.role || null,
          actualContentHash: historical ? sha256(historical.content || '') : null,
        });
        historyMismatch = true;
      }
    }
    if (historyMismatch) continue;

    const snapshot = db.prepare('SELECT id,book_id,label,data_json,created_at FROM snapshots WHERE id=?')
      .get(item.snapshotId);
    if (!snapshot || snapshot.book_id !== manifest.book.id) {
      failures.push({ code: 'SNAPSHOT_MISMATCH', snapshotId: item.snapshotId, chapterId: chapter.id });
      continue;
    }
    let snapshotData;
    try {
      snapshotData = JSON.parse(snapshot.data_json || '{}');
    } catch {
      failures.push({ code: 'SNAPSHOT_JSON_INVALID', snapshotId: snapshot.id, chapterId: chapter.id });
      continue;
    }
    const archived = (snapshotData.chapters || [])
      .find(candidate => candidate.id === chapter.id && Number(candidate.idx) === Number(chapter.idx));
    if (!archived || !Array.isArray(archived.scenes) || !archived.scenes.length) {
      failures.push({ code: 'SNAPSHOT_CHAPTER_MISSING', snapshotId: snapshot.id, chapterId: chapter.id });
      continue;
    }
    const snapshotScenes = [...archived.scenes]
      .sort((left, right) => Number(left.idx) - Number(right.idx));
    const sceneIndexes = snapshotScenes.map(scene => Number(scene.idx));
    if (sceneIndexes.some(idx => !Number.isInteger(idx) || idx < 1)
      || new Set(sceneIndexes).size !== sceneIndexes.length) {
      failures.push({ code: 'SNAPSHOT_SCENES_INVALID', snapshotId: snapshot.id, chapterId: chapter.id });
      continue;
    }
    if (item.expectedSceneCount != null && snapshotScenes.length !== Number(item.expectedSceneCount)) {
      failures.push({
        code: 'SNAPSHOT_SCENE_COUNT_MISMATCH',
        snapshotId: snapshot.id,
        chapterId: chapter.id,
        expectedSceneCount: item.expectedSceneCount,
        actualSceneCount: snapshotScenes.length,
      });
      continue;
    }
    const snapshotText = joinedText(snapshotScenes);
    const snapshotHash = sha256(snapshotText);
    if (snapshotHash !== item.expectedSnapshotHash) {
      failures.push({
        code: 'SNAPSHOT_HASH_MISMATCH',
        snapshotId: snapshot.id,
        chapterId: chapter.id,
        chapterIdx: chapter.idx,
        expectedHash: item.expectedSnapshotHash,
        actualHash: snapshotHash,
      });
      continue;
    }
    const restoredWordCount = hanCount(snapshotText);
    if (item.expectedRestoredWordCount != null
      && restoredWordCount !== Number(item.expectedRestoredWordCount)) {
      failures.push({
        code: 'SNAPSHOT_WORD_COUNT_MISMATCH',
        snapshotId: snapshot.id,
        chapterId: chapter.id,
        expectedWordCount: item.expectedRestoredWordCount,
        actualWordCount: restoredWordCount,
      });
      continue;
    }
    restorations.push({
      chapter: { id: chapter.id, idx: chapter.idx },
      current: { hash: currentHash, length: currentText.replace(/\s/g, '').length },
      snapshot: {
        id: snapshot.id,
        label: snapshot.label,
        hash: snapshotHash,
        length: snapshotText.replace(/\s/g, '').length,
      },
      sceneCount: snapshotScenes.length,
      restoredWordCount,
      settlementMarker: hasTable(db, 'chapter_settlements') ? 'invalidate' : 'not_available',
      resultingChapterStatus: 'revised',
    });
    prepared.push({ chapter, currentScenes, snapshotScenes, snapshotText, restoredWordCount });
  }

  const duplicates = db.prepare(`SELECT chapter_id,COUNT(*) AS count
    FROM chapter_health
    WHERE book_id=? AND chapter_id IS NOT NULL
    GROUP BY chapter_id HAVING COUNT(*)>1 ORDER BY chapter_id`).all(manifest.book.id);
  const healthDuplicates = {
    chapters: duplicates.length,
    removableRows: duplicates.reduce((sum, row) => sum + Number(row.count) - 1, 0),
  };
  return {
    ready: failures.length === 0,
    failures,
    plan: { volumeBindings, restorations, healthDuplicates },
    prepared,
  };
}

function backupPathFor(dbPath) {
  const parsed = path.parse(dbPath);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  let candidate = path.join(parsed.dir, `${parsed.name}.repair-backup-${stamp}${parsed.ext || '.db'}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}.repair-backup-${stamp}-${suffix}${parsed.ext || '.db'}`);
    suffix++;
  }
  return candidate;
}

async function createConsistentBackup(dbPath) {
  const backupPath = backupPathFor(dbPath);
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    source.exec('PRAGMA query_only=ON');
    await backup(source, backupPath);
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    copy.exec('PRAGMA query_only=ON');
    const integrity = integrityCheck(copy);
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      const error = new Error(`备份完整性检查失败：${integrity.join('; ')}`);
      error.code = 'BACKUP_INTEGRITY_FAILED';
      error.backupPath = backupPath;
      throw error;
    }
    return { path: backupPath, integrityCheck: integrity };
  } finally {
    copy.close();
  }
}

function outlineScene(chapter, idx) {
  let outline = {};
  try { outline = JSON.parse(chapter.outline_json || '{}'); } catch { /* 保留空元数据 */ }
  return (outline.scenes || []).find(scene => Number(scene.idx) === Number(idx)) || {};
}

function insertedSceneId(chapterId, idx) {
  return `sc-repair-${sha256(`${chapterId}:${idx}`).slice(0, 24)}`;
}

function applyInspectedPlan(db, manifest, inspected) {
  const changes = {
    volumeBindings: 0,
    restoredChapters: 0,
    updatedScenes: 0,
    insertedScenes: 0,
    deletedScenes: 0,
    updatedHistoryRows: 0,
    invalidatedSettlementMarkers: 0,
    removedHealthDuplicates: 0,
    updatedHealthRows: 0,
  };
  changes.volumeBindings += Number(db.prepare('UPDATE chapters SET volume_id=? WHERE id=? AND volume_id IS NULL')
    .run(manifest.volumeBinding.volumeId, manifest.volumeBinding.chapterId).changes || 0);

  for (const item of inspected.prepared) {
    const currentByIdx = new Map(item.currentScenes.map(scene => [Number(scene.idx), scene]));
    const snapshotByIdx = new Map(item.snapshotScenes.map(scene => [Number(scene.idx), scene]));
    for (const current of item.currentScenes) {
      if (snapshotByIdx.has(Number(current.idx))) continue;
      changes.deletedScenes += Number(db.prepare('DELETE FROM scenes WHERE id=?').run(current.id).changes || 0);
    }
    for (const snapshotScene of item.snapshotScenes) {
      const idx = Number(snapshotScene.idx);
      const current = currentByIdx.get(idx);
      const content = String(snapshotScene.content || '');
      if (current) {
        changes.updatedScenes += Number(db.prepare("UPDATE scenes SET content=?,status='revised' WHERE id=?")
          .run(content, current.id).changes || 0);
        if (current.history_seq != null && hasTable(db, 'history')) {
          changes.updatedHistoryRows += Number(db.prepare(`UPDATE history SET content=?
            WHERE book_id=? AND seq=? AND role='assistant'`)
            .run(content, manifest.book.id, current.history_seq).changes || 0);
        }
      } else {
        const planned = outlineScene(item.chapter, idx);
        changes.insertedScenes += Number(db.prepare(`INSERT INTO scenes
          (id,chapter_id,idx,pov,location,beat,content,target_words,status,history_seq)
          VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
          .run(
            insertedSceneId(item.chapter.id, idx), item.chapter.id, idx,
            planned.pov || '', planned.location || '', planned.beat || '', content,
            Number(planned.target_words || planned.targetWords) || 1000, 'revised',
          ).changes || 0);
      }
    }
    db.prepare("UPDATE chapters SET status='revised',word_count=? WHERE id=?")
      .run(item.restoredWordCount, item.chapter.id);
    if (hasTable(db, 'chapter_settlements')) {
      changes.invalidatedSettlementMarkers += Number(db.prepare('DELETE FROM chapter_settlements WHERE chapter_id=?')
        .run(item.chapter.id).changes || 0);
    }
    changes.restoredChapters++;
  }

  changes.removedHealthDuplicates += Number(db.prepare(`DELETE FROM chapter_health WHERE id IN (
    SELECT id FROM (
      SELECT id,ROW_NUMBER() OVER (
        PARTITION BY chapter_id ORDER BY created_at DESC,id DESC
      ) AS freshness_rank
      FROM chapter_health
      WHERE book_id=? AND chapter_id IS NOT NULL
    ) WHERE freshness_rank>1
  )`).run(manifest.book.id).changes || 0);
  for (const item of inspected.prepared) {
    changes.updatedHealthRows += Number(db.prepare('UPDATE chapter_health SET word_count=? WHERE book_id=? AND chapter_id=?')
      .run(item.restoredWordCount, manifest.book.id, item.chapter.id).changes || 0);
  }
  return changes;
}

function postApplyCheck(db, manifest) {
  const failures = [];
  const binding = db.prepare('SELECT volume_id FROM chapters WHERE id=?').get(manifest.volumeBinding.chapterId);
  if (binding?.volume_id !== manifest.volumeBinding.volumeId) {
    failures.push({ code: 'POST_VOLUME_BINDING_FAILED', chapterId: manifest.volumeBinding.chapterId });
  }
  for (const item of manifest.restorations) {
    const scenes = chapterScenes(db, item.chapterId);
    const actualHash = sha256(joinedText(scenes));
    if (actualHash !== item.expectedSnapshotHash) {
      failures.push({
        code: 'POST_RESTORE_HASH_MISMATCH',
        chapterId: item.chapterId,
        expectedHash: item.expectedSnapshotHash,
        actualHash,
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

export async function repairDatabase(dbPath, { apply = false, manifest = EMPTY_REPAIR_MANIFEST } = {}) {
  const explicitDb = typeof dbPath === 'string' && dbPath.trim() !== '';
  if (apply && !explicitDb) {
    const error = new Error('--apply 必须显式提供 --db 路径');
    error.code = 'APPLY_REQUIRES_DB';
    throw error;
  }
  const resolved = path.resolve(explicitDb ? dbPath : DEFAULT_DB);
  if (!fs.existsSync(resolved)) {
    const error = new Error(`数据库不存在：${resolved}`);
    error.code = 'DB_NOT_FOUND';
    throw error;
  }
  const db = new DatabaseSync(resolved, { readOnly: true });
  let preflight;
  let integrity;
  try {
    db.exec('PRAGMA query_only=ON');
    integrity = integrityCheck(db);
    preflight = inspectDatabase(db, manifest);
    if (!apply) {
      return {
        schemaVersion: 1,
        tool: 'generic-offline-repair',
        mode: 'dry-run',
        dbPath: resolved,
        manifestVersion: manifest.version,
        integrityCheck: integrity,
        ready: integrity.length === 1 && integrity[0] === 'ok' && preflight.ready,
        failures: preflight.failures,
        plan: preflight.plan,
        backup: null,
        applied: false,
      };
    }
  } finally {
    db.close();
  }

  if (integrity.length !== 1 || integrity[0] !== 'ok' || !preflight.ready) {
    const error = new Error('修复前置条件未通过');
    error.code = 'PRECONDITION_FAILED';
    error.failures = preflight.failures;
    throw error;
  }

  const backupInfo = await createConsistentBackup(resolved);
  const writable = new DatabaseSync(resolved);
  try {
    writable.exec('PRAGMA busy_timeout=5000');
    writable.exec('BEGIN IMMEDIATE');
    try {
      const lockedInspection = inspectDatabase(writable, manifest);
      if (!lockedInspection.ready) {
        const error = new Error('取得写锁后双哈希前置条件已变化');
        error.code = 'PRECONDITION_FAILED';
        error.failures = lockedInspection.failures;
        throw error;
      }
      const changes = applyInspectedPlan(writable, manifest, lockedInspection);
      const postCheck = postApplyCheck(writable, manifest);
      if (!postCheck.ok) {
        const error = new Error('修复后哈希校验失败');
        error.code = 'POSTCONDITION_FAILED';
        error.failures = postCheck.failures;
        throw error;
      }
      const postIntegrity = integrityCheck(writable);
      if (postIntegrity.length !== 1 || postIntegrity[0] !== 'ok') {
        const error = new Error(`修复后完整性检查失败：${postIntegrity.join('; ')}`);
        error.code = 'POST_INTEGRITY_FAILED';
        throw error;
      }
      writable.exec('COMMIT');
      return {
        schemaVersion: 1,
        tool: 'generic-offline-repair',
        mode: 'apply',
        dbPath: resolved,
        manifestVersion: manifest.version,
        integrityCheck: postIntegrity,
        ready: true,
        failures: [],
        plan: lockedInspection.plan,
        backup: backupInfo,
        changes,
        postCheck,
        applied: true,
      };
    } catch (error) {
      try { writable.exec('ROLLBACK'); } catch { /* 事务可能尚未建立 */ }
      if (!error.code || String(error.code).startsWith('ERR_SQLITE')) {
        const wrapped = new Error(`原子修复失败，事务已回滚：${error.message}`);
        wrapped.code = 'APPLY_FAILED';
        wrapped.causeCode = error.code || null;
        wrapped.backupPath = backupInfo.path;
        throw wrapped;
      }
      error.backupPath ||= backupInfo.path;
      throw error;
    }
  } finally {
    writable.close();
  }
}

function argumentError(message, code = 'INVALID_ARGUMENT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseCliArgs(argv) {
  let dbPath;
  let apply = false;
  let pretty = false;
  let explicitDryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--dry-run') {
      explicitDryRun = true;
    } else if (arg === '--pretty') {
      pretty = true;
    } else if (arg === '--db') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw argumentError('--db 需要路径');
      dbPath = value;
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
      if (!dbPath) throw argumentError('--db 需要路径');
    } else {
      throw argumentError(`未知参数：${arg}`);
    }
  }
  if (apply && explicitDryRun) throw argumentError('--apply 与 --dry-run 不能同时使用');
  if (apply && !dbPath) throw argumentError('--apply 必须显式提供 --db 路径', 'APPLY_REQUIRES_DB');
  return { dbPath, apply, pretty };
}

async function main() {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const result = await repairDatabase(args.dbPath, { apply: args.apply });
    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  } catch (error) {
    const payload = {
      error: {
        code: error.code || 'REPAIR_FAILED',
        message: error.message,
        ...(error.failures ? { failures: error.failures } : {}),
        ...(error.backupPath ? { backupPath: error.backupPath } : {}),
        ...(error.causeCode ? { causeCode: error.causeCode } : {}),
      },
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  await main();
}
