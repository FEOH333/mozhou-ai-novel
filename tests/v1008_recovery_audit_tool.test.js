// V0.100.8：推荐返工进度只读审计工具。
// 这条工具存在的理由：返工链路多次出现"测试全绿但生产不可用"，根因都是某个投影层
// 悄悄裁掉了下游判定依赖的字段。它必须能在点按钮之前回答"我现在点下去会发生什么"，
// 并且默认只读副本，绝不能改动作者的库。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 审计工具会把库复制到副本目录再分析；测试并发跑文件时必须各自隔离，
// 否则多个文件会争用同一个 data-debug-recovery-audit。
process.env.NOVEL_AUDIT_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1008-audit-'));

const store = await import('../server/db/store.js');
const { auditRecoveryRuns, parseCliArgs } = await import('../server/maintenance/audit-recovery-runs.js');

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 源库「未被改动」的判据：只比对持久化内容，即主文件与 WAL。
 *
 * 刻意排除 `-shm`：它是 SQLite 的共享内存索引，不是数据库内容的一部分，
 * 任何连接（包括只读打开）都可能让内核重写它的字节。把 SHM 纳入逐字哈希，
 * 会在不同平台/时序下随机报「源库被改动」的假阳性——
 * 实测 GitHub Actions 的 Linux runner 上必然触发。
 */
function sqlitePersistentHashes(file) {
  return Object.fromEntries([file, `${file}-wal`]
    .filter(target => fs.existsSync(target))
    .map(target => [path.basename(target), sha256File(target)]));
}

function buildBook(title) {
  const book = store.books.create({ title, genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let idx = 1; idx <= 6; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: `第${idx}章`, status: 'done', wordCount: 300,
    });
    store.scenes.create(chapter.id, 1, {
 content: `主角核对第${idx}号木牌，确认第${idx}处哨点仍在原位。\n\n“第${idx}队照册回报。”梁茂压上名单。`,
      status: 'done', targetWords: 300,
    });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  return book;
}

test('V0.100.8 返工审计默认走副本，绝不改动原库', async () => {
  const book = buildBook('审计只读副本');
  store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 6, status: 'failed',
    workOrders: [{ chapter: 6, action: 'rebuild', objective: '转折', evidence: ['哨点'], reason: '停滞' }],
    result: { diagnosis_fingerprint: 'a'.repeat(64) },
  });

  const sourceDb = path.join(process.env.NOVEL_DATA_DIR, 'novel.db');
  const before = sha256File(sourceDb);
  const report = await auditRecoveryRuns(sourceDb);

  assert.equal(report.mode, 'read-only-copy');
  assert.equal(sha256File(sourceDb), before, '默认模式必须只审计副本，原库不得有任何字节变化');
  const bookReport = report.books.find(item => item.id === book.id);
  assert.equal(bookReport.runs[0].workOrders, 1);
  assert.equal(bookReport.runs[0].hasWholeRangePlan, false);
});

test('V0.100.9 返工审计必须包含 WAL 中的最新提交，不能拿过期主文件生成假报告', () => {
  const book = buildBook('审计 WAL 一致快照');
  const sourceDb = path.join(process.env.NOVEL_DATA_DIR, 'novel.db');
  // 先把既有内容压回主文件，再把目标运行单独留在 WAL；直接 copyFile(novel.db)
  // 必然看不见它，只有 SQLite 在线 backup 才能得到一致快照。
  store.db().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 6, status: 'rewriting',
    workOrders: [{ chapter: 6, action: 'rebuild', objective: '转折', evidence: ['哨点'], reason: '停滞' }],
    result: { diagnosis_fingerprint: 'c'.repeat(64) },
  });
  assert.ok(fs.statSync(`${sourceDb}-wal`).size > 0, '夹具必须把目标运行留在 WAL');
  const before = sqlitePersistentHashes(sourceDb);

  const child = spawnSync(process.execPath, [
    path.resolve('server/maintenance/audit-recovery-runs.js'), '--db', sourceDb,
  ], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  const bookReport = report.books.find(item => item.id === book.id);
  const runReport = bookReport?.runs.find(item => item.id === run.id);

  assert.equal(runReport?.status, 'planned',
    '副本应包含 WAL 里的 rewriting 运行，并只在副本中把它自愈为 planned');
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'rewriting',
    '审计不得把源库运行一并自愈');
  assert.deepEqual(sqlitePersistentHashes(sourceDb), before,
    '主文件与 WAL 必须逐字不变（SHM 是内存索引，不属内容，不参与比对）');
});

test('V0.100.9 返工审计作为模块调用时也必须隔离 store 缓存，不能自愈源库', async () => {
  const book = buildBook('审计模块缓存隔离');
  const sourceDb = path.join(process.env.NOVEL_DATA_DIR, 'novel.db');
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 6, status: 'rewriting',
    workOrders: [{ chapter: 6, action: 'rebuild', objective: '转折', evidence: ['哨点'], reason: '停滞' }],
    result: { diagnosis_fingerprint: 'd'.repeat(64) },
  });
  const before = sqlitePersistentHashes(sourceDb);

  const report = await auditRecoveryRuns(sourceDb);
  const runReport = report.books
    .find(item => item.id === book.id)?.runs
    .find(item => item.id === run.id);

  assert.equal(runReport?.status, 'planned', '只允许副本自愈后显示 planned');
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'rewriting',
    'store.js 已在宿主进程加载时，审计也不得误用缓存连接去修改源库');
  assert.deepEqual(sqlitePersistentHashes(sourceDb), before,
    '模块调用前后主文件与 WAL 必须逐字不变');
});

test('V0.100.9 返工审计只清理自己创建的唯一临时目录，不得递归删除调用方目录', async () => {
  buildBook('审计临时目录边界');
  const sourceDb = path.join(process.env.NOVEL_DATA_DIR, 'novel.db');
  const callerDir = path.resolve(process.env.NOVEL_AUDIT_TMP_DIR);
  fs.mkdirSync(callerDir, { recursive: true });
  const sentinel = path.join(callerDir, '调用方文件-不得删除.txt');
  fs.writeFileSync(sentinel, 'keep');

  await auditRecoveryRuns(sourceDb);

  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep',
    'NOVEL_AUDIT_TMP_DIR 是调用方提供的父目录，不是允许整目录删除的私有目录');
});

test('V0.100.8 返工审计如实区分"指纹有效只补综合"与"指纹失效需全部重跑"', async () => {
  const book = buildBook('审计指纹判定');
  // 指纹是当前合同格式但与当前正文不符 → 必须判定为失效，避免用户误以为只花一次调用。
  store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 6, status: 'planned',
    workOrders: [{ chapter: 6, action: 'rebuild', objective: '转折', evidence: ['哨点'], reason: '停滞' }],
    result: { diagnosis_fingerprint: 'b'.repeat(64) },
  });

  const sourceDb = path.join(process.env.NOVEL_DATA_DIR, 'novel.db');
  const report = await auditRecoveryRuns(sourceDb);
  const run = report.books.find(item => item.id === book.id).runs[0];

  assert.equal(run.diagnosisFingerprintValid, true, '64 位十六进制才算当前合同格式');
  assert.equal(run.fingerprintMatches, false, '与当前正文不符的指纹必须判失效');
  assert.equal(run.hasWholeRangePlan, false);
});

test('V0.100.8 返工审计参数解析只接受已知开关', () => {
  const defaults = parseCliArgs([]);
  assert.equal(defaults.pretty, false);
  assert.deepEqual(parseCliArgs(['--pretty']), { ...defaults, pretty: true });
  assert.throws(() => parseCliArgs(['--in-place']), /只读审计不支持.*in-place/,
    '审计入口不得提供会迁移和自愈源库的伪只读开关');
  assert.equal(parseCliArgs(['--db=x.db']).dbPath, 'x.db');
  assert.throws(() => parseCliArgs(['--destroy']), /未知参数/);
  assert.throws(() => parseCliArgs(['--db']), /需要一个 SQLite 路径/);
});

test('V0.100.9 返工审计模块 API 也拒绝 inPlace，不能绕过 CLI 安全边界', async () => {
  const sourceDb = path.join(process.env.NOVEL_DATA_DIR, 'novel.db');
  await assert.rejects(
    () => auditRecoveryRuns(sourceDb, { inPlace: true }),
    /只读审计不支持.*in-place/,
  );
});

test('V0.100.8 返工审计对不存在的库显式失败，不静默输出空报告', async () => {
  await assert.rejects(
    () => auditRecoveryRuns(path.join(process.env.NOVEL_DATA_DIR, 'missing.db')),
    /数据库不存在/,
  );
});
