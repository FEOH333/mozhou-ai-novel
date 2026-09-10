// server/maintenance/audit-recovery-runs.js —— 推荐返工进度只读审计
//
// 用途：在真正点“一键诊断并返工”之前，先回答三个问题——
//   1. 每条返工运行现在处于什么状态、有没有可沿用的工单；
//   2. 候选里有多少是“旧版无来源”（会被隔离重生）、多少是本运行局部通过；
//   3. 诊断指纹是否仍然有效（决定是补一次综合调用，还是要重跑全部取证批次）。
//
// 始终在临时目录里对一致快照执行，**绝不写入原库**（store 打开库时会跑迁移补列与
// 运行自愈，哪怕幂等也不应发生在作者原库）。不提供 in-place 逃生口。
//
// 用法：
//   node server/maintenance/audit-recovery-runs.js [--db data/novel.db] [--pretty]
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_DB = fileURLToPath(new URL('../../data/novel.db', import.meta.url));
const WORKER_FLAG = '--prepared-copy-worker';

export function parseCliArgs(argv) {
  let dbPath = DEFAULT_DB;
  let pretty = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pretty') pretty = true;
    else if (arg === '--in-place') throw new Error('只读审计不支持 --in-place；请使用自动生成的一致快照');
    else if (arg === '--db') {
      if (!argv[i + 1]) throw new Error('--db 需要一个 SQLite 路径');
      dbPath = argv[++i];
    } else if (arg.startsWith('--db=')) dbPath = arg.slice('--db='.length);
    else throw new Error(`未知参数：${arg}`);
  }
  return { dbPath, pretty };
}

/**
 * 把目标库准备成一个可供 store 打开的 data 目录；返回需要清理的临时目录（若有）。
 * 临时目录放在工程内唯一的 data-debug-recovery-audit-* 目录（已被 .gitignore 忽略）：
 * 系统临时目录常被沙箱拒绝写入，而 node:sqlite 会一直持有句柄，清理失败时要能留痕。
 */
async function prepareDataDir(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`数据库不存在：${resolved}`);
  const ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');
  // NOVEL_AUDIT_TMP_DIR 是调用方提供的父目录，不是可整体删除的私有目录。每次审计
  // 都在其下创建唯一子目录，避免并发踩踏，也避免清理时误删调用方已有文件。
  const configuredRoot = process.env.NOVEL_AUDIT_TMP_DIR
    ? path.resolve(process.env.NOVEL_AUDIT_TMP_DIR)
    : ROOT;
  fs.mkdirSync(configuredRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(
    configuredRoot,
    process.env.NOVEL_AUDIT_TMP_DIR ? 'recovery-audit-' : 'data-debug-recovery-audit-',
  ));
  const snapshotPath = path.join(tmpDir, 'novel.db');
  const source = new DatabaseSync(resolved, { readOnly: true });
  try {
    source.exec('PRAGMA query_only=ON');
    // 必须让 SQLite 自己生成一致快照：直接复制 novel.db 会漏掉 WAL 里已提交但尚未
    // checkpoint 的最新运行，审计会把真实 failed 错报成旧版 rewriting/planned。
    await sqliteBackup(source, snapshotPath);
  } finally {
    source.close();
  }
  return { dataDir: tmpDir, tmpDir };
}

async function inspectPreparedDataDir(dbPath) {
  const store = await import('../db/store.js');
  store.db();
  const healed = store.recommendationRecoveryRuns.healOrphanedInFlight();
  const { publicationDashboard } = await import('../engine/publication_feedback.js');
  const { annotateRecoveryRunsResumability } = await import('../engine/recommendation_recovery.js');

  const books = [];
  for (const book of store.books.list()) {
    const dashboard = publicationDashboard(book.id);
    const runs = annotateRecoveryRunsResumability(book.id, dashboard.recoveryRuns).map(run => ({
        id: run.id,
        status: run.status,
        scope: `${run.start_chapter}-${run.end_chapter}`,
        workOrders: (run.work_orders || []).length,
        resumeKind: run.resumeKind,
        resumeDetail: run.resumeDetail || '',
        hasWholeRangePlan: Boolean(run.result?.repair_plan),
        diagnosisFingerprintValid: /^[a-f0-9]{64}$/.test(String(run.result?.diagnosis_fingerprint || '')),
        // null = 无法/无需试探；true/false = 已在一致快照中与当前正文/反馈比对。
        fingerprintMatches: null,
        candidateStats: run.candidateStats || null,
        snapshotId: run.snapshot_id || null,
    }));
    // 「缺少全范围计划」的判定发生在指纹比对之前，光看 resumeKind 无法知道指纹是否仍有效。
    // 试探法：给副本临时补一个占位计划，让标注走到真正的指纹比对分支，再读结论。
    // 当前数据库必定是一致快照，可安全试探而不触碰作者原库。
    for (const run of runs) {
      if (!run.workOrders || !run.diagnosisFingerprintValid) continue;
      const row = store.recommendationRecoveryRuns.get(run.id);
      const original = row?.result || {};
      if (original.repair_plan) continue;
      store.recommendationRecoveryRuns.update(run.id, {
        result: { ...original, repair_plan: { arcs: [], chapter_orders: [] } },
      });
      try {
        const probe = annotateRecoveryRunsResumability(
          book.id, publicationDashboard(book.id).recoveryRuns,
        ).find(item => item.id === run.id);
        run.fingerprintMatches = probe?.resumeKind === 'execute';
      } finally {
        // 试探只用于判定，结论取到后立即还原，不留影子计划。
        store.recommendationRecoveryRuns.update(run.id, { result: original });
      }
    }
    books.push({
      id: book.id, title: book.title,
      localChapterCount: dashboard.localChapterCount,
      publishedChapterCount: dashboard.profile?.published_chapter_count ?? null,
      recommendationStage: dashboard.profile?.recommendation_stage || null,
      runs,
    });
  }
  return {
    schemaVersion: 1,
    tool: 'recovery-runs-auditor',
    mode: 'read-only-copy',
    dbPath: path.resolve(dbPath),
    generatedAt: new Date().toISOString(),
    healedOrphanedRuns: healed,
    books,
  };
}

export async function auditRecoveryRuns(dbPath, { inPlace = false } = {}) {
  if (inPlace) throw new Error('只读审计不支持 in-place；请使用自动生成的一致快照');
  const resolvedDbPath = path.resolve(dbPath);
  const { dataDir, tmpDir } = await prepareDataDir(resolvedDbPath);
  try {
    // store/config 在模块首次加载时就锁定 NOVEL_DATA_DIR。仅修改当前进程环境变量会被
    // Node 的模块缓存绕过，审计作为库调用时可能直接“自愈”源库。强制用全新子进程
    // 打开副本，CLI 与模块 API 因而拥有完全相同的隔离语义。
    const child = spawnSync(process.execPath, [THIS_FILE, WORKER_FLAG, resolvedDbPath], {
      encoding: 'utf8',
      env: { ...process.env, NOVEL_DATA_DIR: dataDir },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.status !== 0) {
      throw new Error(String(child.stderr || child.stdout || `审计子进程退出码 ${child.status}`).trim());
    }
    return JSON.parse(String(child.stdout || '').trim());
  } finally {
    // node:sqlite 仍持有副本句柄，删除可能失败；失败不审计失败，只留一个可手工清理的目录。
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略：副本目录可手工清理 */ }
    }
  }
}

/** 人类可读摘要：默认 JSON，--pretty 时附一段可直接读懂的清单。 */
function summarize(report) {
  const lines = [];
  for (const book of report.books) {
    lines.push(`《${book.title}》 本地 ${book.localChapterCount} 章 / 已发布 ${book.publishedChapterCount ?? '未填'} / 推荐阶段 ${book.recommendationStage || '-'}`);
    if (!book.runs.length) { lines.push('  （无返工运行）'); continue; }
    for (const run of book.runs) {
      lines.push(`  ${run.id}  ${run.status}  第${run.scope}章  工单${run.workOrders}  ${run.resumeKind}`);
      if (run.resumeDetail) lines.push(`        ${run.resumeDetail}`);
      const stats = run.candidateStats;
      if (stats && stats.total) {
        lines.push(`        候选 ${stats.total}：局部通过 ${stats.localPassed} / 整段通过 ${stats.globalPassed} / 整段否决 ${stats.globalRejected} / 旧版无来源 ${stats.legacyUntrusted} / 已落盘 ${stats.applied}`);
      }
      if (run.workOrders > 0 && !run.hasWholeRangePlan && run.diagnosisFingerprintValid) {
        if (run.fingerprintMatches === true) {
          lines.push('        需重新诊断：缺全范围计划，但诊断指纹仍有效 → 取证批次全部复用，只补一次综合调用');
        } else if (run.fingerprintMatches === false) {
          lines.push('        需重新诊断：诊断指纹已失效 → 全部取证批次与综合都要重跑');
        } else {
          lines.push('        需重新诊断：指纹比对未得出结论，按失败关闭处理');
        }
      }
      if (run.workOrders > 0 && !run.diagnosisFingerprintValid) {
        lines.push('        诊断指纹非当前合同格式 → 旧诊断结论一律作废');
      }
    }
  }
  return lines.join('\n');
}

async function main() {
  try {
    const { dbPath, pretty } = parseCliArgs(process.argv.slice(2));
    const report = await auditRecoveryRuns(dbPath);
    if (pretty) process.stdout.write(`${summarize(report)}\n\n`);
    process.stdout.write(`${JSON.stringify(report, null, pretty ? 2 : 0)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

async function workerMain() {
  try {
    const dbPath = process.argv[3];
    const report = await inspectPreparedDataDir(dbPath);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  if (process.argv[2] === WORKER_FLAG) await workerMain();
  else await main();
}
