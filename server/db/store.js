// server/db/store.js —— node:sqlite 数据访问层（同步 API，本地单用户场景）
'use strict';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(DATA_DIR, 'novel.db');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

let _db = null;

export function db() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_FILE);
  // V0.50：并发防线——多进程/多连接写库时等待而非立即 SQLITE_BUSY 崩溃
  try { _db.exec('PRAGMA busy_timeout = 10000'); } catch { /* 忽略 */ }
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  _db.exec(schema);
  migrate();
  return _db;
}

/** 轻量迁移：旧库补充新列/新表（CREATE IF NOT EXISTS 不覆盖旧表，需手动补列） */
function migrate() {
  const cols = new Set();
  for (const r of db().prepare("PRAGMA table_info(books)").all()) cols.add(r.name);
  if (!cols.has('platform')) db().exec("ALTER TABLE books ADD COLUMN platform TEXT DEFAULT '通用'");
  const fcols = new Set();
  for (const r of db().prepare('PRAGMA table_info(foreshadows)').all()) fcols.add(r.name);
  if (!fcols.has('events_json')) db().exec("ALTER TABLE foreshadows ADD COLUMN events_json TEXT DEFAULT '[]'");
  // V0.17：chapter_health 补充 notes 列（快感审计：情绪标签/钩子/agency）
  let hcols = null;
  try {
    hcols = new Set(db().prepare('PRAGMA table_info(chapter_health)').all().map(r => r.name));
    if (hcols && !hcols.has('notes')) db().exec("ALTER TABLE chapter_health ADD COLUMN notes TEXT DEFAULT ''");
  } catch { /* 表不存在则跳过（schema 已含） */ }
  // V0.29：usage_logs 加 estimated 列（旧库迁移）
  const ulCols = db().prepare("SELECT name FROM pragma_table_info('usage_logs')").all().map(r => r.name);
  if (!ulCols.includes('estimated')) db().exec('ALTER TABLE usage_logs ADD COLUMN estimated INTEGER DEFAULT 0');
  // V0.37：characters 加 deceased/death_chapter 列（旧库迁移）
  const chCols = db().prepare("SELECT name FROM pragma_table_info('characters')").all().map(r => r.name);
  if (!chCols.includes('deceased')) db().exec('ALTER TABLE characters ADD COLUMN deceased INTEGER DEFAULT 0');
  if (!chCols.includes('death_chapter')) db().exec('ALTER TABLE characters ADD COLUMN death_chapter INTEGER');
  // V0.49：characters 加角色弧光维度列（旧库迁移）
  for (const col of ['personality', 'goal', 'fear', 'secret', 'arc', 'relation']) {
    if (!chCols.includes(col)) db().exec(`ALTER TABLE characters ADD COLUMN ${col} TEXT DEFAULT ''`);
  }
  // V0.101：角色语音卡（说话方式 / 禁腔）
  for (const col of ['speech', 'speech_forbid']) {
    if (!chCols.includes(col)) db().exec(`ALTER TABLE characters ADD COLUMN ${col} TEXT DEFAULT ''`);
  }
  // V0.20：locations/items/factions 补 state_json 列（makeEntityApi 统一写该列）
  for (const t of ['locations', 'items', 'factions']) {
    try {
      const ecols = new Set(db().prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
      if (!ecols.has('state_json')) db().exec(`ALTER TABLE ${t} ADD COLUMN state_json TEXT DEFAULT '{}'`);
    } catch { /* 表不存在则跳过（schema 已含） */ }
  }
  // V0.71：locations 表补地点库列（kind 类型/desc 描述/stable 稳定性/status 状态/note 变化记录）
  try {
    const locCols = new Set(db().prepare("PRAGMA table_info('locations')").all().map(r => r.name));
    for (const [col, ddl] of [
      ['kind', "TEXT DEFAULT ''"],
      ['desc', "TEXT DEFAULT ''"],
      ['stable', 'INTEGER DEFAULT 1'],
      ['status', "TEXT DEFAULT 'normal'"],
      ['note', "TEXT DEFAULT ''"],
    ]) {
      if (!locCols.has(col)) db().exec(`ALTER TABLE locations ADD COLUMN ${col} ${ddl}`);
    }
  } catch { /* ignore */ }
  // V0.50：characters 加分级/能力/退出列（旧库迁移）
  for (const col of ['tier', 'abilities_json', 'exit_note']) {
    if (!chCols.includes(col)) db().exec(`ALTER TABLE characters ADD COLUMN ${col} TEXT DEFAULT ''`);
  }
  // V0.40：pending_entities 加 dup_count/note 列（旧库迁移）
  const peCols = db().prepare("SELECT name FROM pragma_table_info('pending_entities')").all().map(r => r.name);
  if (!peCols.includes('dup_count')) db().exec('ALTER TABLE pending_entities ADD COLUMN dup_count INTEGER DEFAULT 1');
  if (!peCols.includes('note')) db().exec('ALTER TABLE pending_entities ADD COLUMN note TEXT DEFAULT \'\'');
  // V0.42：books 加 perspective 列（旧库迁移，默认第三人称）
  const bkCols = db().prepare("SELECT name FROM pragma_table_info('books')").all().map(r => r.name);
  if (!bkCols.includes('perspective')) db().exec("ALTER TABLE books ADD COLUMN perspective TEXT DEFAULT 'third'");
  // V0.82：books 加 era 列（朝代配置 JSON；历史题材）
  if (!bkCols.includes('era')) db().exec("ALTER TABLE books ADD COLUMN era TEXT DEFAULT '{}'");
  // V0.83：scenes 加 scene_type 列（细纲场景类型持久化——技法/诗词按真实类型匹配）
  try {
    const scCols = new Set(db().prepare("PRAGMA table_info('scenes')").all().map(r => r.name));
    if (!scCols.has('scene_type')) db().exec("ALTER TABLE scenes ADD COLUMN scene_type TEXT DEFAULT ''");
  } catch { /* 表不存在则跳过（schema 已含） */ }
  // V0.82：timeline 加历史纪年列（year 公元年 / era_year 年号纪年 / season 季节）
  try {
    const tlCols = new Set(db().prepare("PRAGMA table_info('timeline')").all().map(r => r.name));
    if (!tlCols.has('year')) db().exec('ALTER TABLE timeline ADD COLUMN year INTEGER');
    if (!tlCols.has('era_year')) db().exec("ALTER TABLE timeline ADD COLUMN era_year TEXT DEFAULT ''");
    if (!tlCols.has('season')) db().exec("ALTER TABLE timeline ADD COLUMN season TEXT DEFAULT ''");
  } catch { /* 表不存在则跳过（schema 已含） */ }
  // V0.82：locations 加朝代行政层级/战略属性列（历史题材地点库）
  try {
    const locCols2 = new Set(db().prepare("PRAGMA table_info('locations')").all().map(r => r.name));
    if (!locCols2.has('admin_level')) db().exec("ALTER TABLE locations ADD COLUMN admin_level TEXT DEFAULT ''");
    if (!locCols2.has('strategic')) db().exec("ALTER TABLE locations ADD COLUMN strategic TEXT DEFAULT ''");
  } catch { /* 表不存在则跳过（schema 已含） */ }
  // V0.82：era_events 史实事件锚点表（era_context.real_events 结构化落库，供时间线边界注入）
  db().exec(`CREATE TABLE IF NOT EXISTS era_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    year INTEGER,
    era_year TEXT DEFAULT '',
    event TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  db().exec('CREATE INDEX IF NOT EXISTS idx_era_events_book ON era_events(book_id, year)');
  // V0.95：volumes 补 summary 列（卷级 Arc 摘要——卷速查表）
  try {
    const volCols = new Set(db().prepare("PRAGMA table_info('volumes')").all().map(r => r.name));
    if (!volCols.has('summary')) db().exec("ALTER TABLE volumes ADD COLUMN summary TEXT DEFAULT ''");
  } catch { /* 表不存在则跳过（schema 已含） */ }
  // V0.95：memory_entries 叙事记忆库表（旧库建表）
  db().exec(`CREATE TABLE IF NOT EXISTS memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    category TEXT NOT NULL,
    name TEXT DEFAULT '',
    content TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db().exec('CREATE INDEX IF NOT EXISTS idx_memory_book ON memory_entries(book_id, category)');
  // V0.95：scenes 加 pacing 列（场景节奏标注——写作按节奏注入句长纪律）
  try {
    const scCols2 = new Set(db().prepare("PRAGMA table_info('scenes')").all().map(r => r.name));
    if (!scCols2.has('pacing')) db().exec("ALTER TABLE scenes ADD COLUMN pacing TEXT DEFAULT ''");
  } catch { /* 表不存在则跳过（schema 已含） */ }
  // V0.41：volume_reviews 表（旧库建表）
  db().exec(`CREATE TABLE IF NOT EXISTS volume_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    grade TEXT NOT NULL DEFAULT 'C',
    report_json TEXT NOT NULL DEFAULT '{}',
    issues_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'done',
    revised_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (book_id, volume_id)
  )`);
  // V0.80：contract_promises 契约承诺账本（旧库建表）
  db().exec(`CREATE TABLE IF NOT EXISTS contract_promises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    text TEXT NOT NULL,
    due_chapter INTEGER,
    status TEXT DEFAULT 'open',
    checked_chapter INTEGER,
    fulfilled_chapter INTEGER,
    note TEXT DEFAULT '',
    created_at INTEGER,
    UNIQUE(book_id, text)
  )`);
  try { db().exec('CREATE INDEX IF NOT EXISTS idx_promise_book ON contract_promises(book_id, status)'); } catch { /* ignore */ }
  // V0.80：旧库 contract_promises 补 created_at 列（此前建表漏列，upsert 报错）
  try {
    const cpCols = new Set(db().prepare("PRAGMA table_info('contract_promises')").all().map(r => r.name));
    if (!cpCols.has('created_at')) db().exec("ALTER TABLE contract_promises ADD COLUMN created_at INTEGER");
  } catch { /* ignore */ }
  // V0.97.2：约束必须有生命周期。旧表只有 content/source，恢复与逐章反馈会永久堆进正文上下文。
  try {
    const constraintCols = new Set(db().prepare("PRAGMA table_info('book_constraints')").all().map(r => r.name));
    if (!constraintCols.has('scope_start')) db().exec('ALTER TABLE book_constraints ADD COLUMN scope_start INTEGER');
    if (!constraintCols.has('scope_end')) db().exec('ALTER TABLE book_constraints ADD COLUMN scope_end INTEGER');
    if (!constraintCols.has('constraint_key')) db().exec("ALTER TABLE book_constraints ADD COLUMN constraint_key TEXT DEFAULT ''");
    if (!constraintCols.has('superseded_by')) db().exec("ALTER TABLE book_constraints ADD COLUMN superseded_by TEXT DEFAULT ''");
    db().exec('CREATE INDEX IF NOT EXISTS idx_constraints_scope ON book_constraints(book_id, active, scope_start, scope_end)');
    db().exec('CREATE INDEX IF NOT EXISTS idx_constraints_key ON book_constraints(book_id, constraint_key, active)');
  } catch { /* 旧测试夹具可能没有约束表 */ }
  // V0.100.7：返工 fresh/复用策略必须随运行持久化；旧库安全降级为空策略，
  // 由领域合同解释为仅同运行断点复用，绝不默认开放跨运行候选。
  try {
    const recoveryCols = new Set(db().prepare("PRAGMA table_info('recommendation_recovery_runs')").all().map(r => r.name));
    if (!recoveryCols.has('execution_policy_json')) {
      db().exec("ALTER TABLE recommendation_recovery_runs ADD COLUMN execution_policy_json TEXT NOT NULL DEFAULT '{}'");
    }
  } catch { /* 旧测试夹具可能没有返工运行表 */ }
  // V0.98：旧库新增通用开篇资产表；不重建 chapters，不接触既有正文。
  db().exec(`CREATE TABLE IF NOT EXISTS opening_assets (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('head_rewrite','chapter1_cold_open','standalone_prologue')),
    placement TEXT NOT NULL CHECK(placement IN ('scene_patch','prepend_chapter1','before_chapter1')),
    title TEXT DEFAULT '',
    anchor_scene_id TEXT,
    anchor_start INTEGER,
    anchor_end INTEGER,
    source_excerpt TEXT DEFAULT '',
    source_hash TEXT DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    contract_json TEXT NOT NULL DEFAULT '{}',
    audit_json TEXT NOT NULL DEFAULT '{}',
    rank_json TEXT NOT NULL DEFAULT '{}',
    creative_hypothesis TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'candidate'
      CHECK(status IN ('candidate','audited','selected','applied','retired','rejected')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db().exec('CREATE INDEX IF NOT EXISTS idx_opening_assets_book ON opening_assets(book_id, status, created_at)');
  db().exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_opening_active_reader_layer
    ON opening_assets(book_id)
    WHERE status IN ('selected','applied') AND placement IN ('prepend_chapter1','before_chapter1')`);
  // 旧版维护脚本曾只改 scenes.content，留下“正文是新稿、历史堆是旧稿”。
  // 启动时以当前正文为权威自愈；只替换已存在的 assistant 行，不追加已归档消息。
  repairSceneHistoryDrift();
}

export function uid(prefix = '') {
  return (prefix ? prefix + '-' : '') + randomUUID().slice(0, 8) + '-' + Date.now().toString(36);
}

// ---------- 基础查询辅助 ----------
function all(sql, ...params) { return db().prepare(sql).all(...params); }
function get(sql, ...params) { return db().prepare(sql).get(...params); }
function run(sql, ...params) { return db().prepare(sql).run(...params); }

let transactionDepth = 0;

/** 同步事务边界；回调不得返回 Promise，以免异步工作完成前提前提交。 */
export function transaction(fn) {
  if (typeof fn !== 'function') throw new TypeError('transaction callback must be a function');
  if (transactionDepth > 0) return fn();
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  transactionDepth++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new TypeError('transaction callback must be synchronous');
    }
    d.exec('COMMIT');
    return result;
  } catch (error) {
    try { d.exec('ROLLBACK'); } catch { /* 原异常优先 */ }
    throw error;
  } finally {
    transactionDepth--;
  }
}

/**
 * 以 scenes.content 为完成章正文单一真源，愈合仍然指向旧稿的历史行。
 * 不为无 history_seq/已归档场景新建消息；非 assistant 或多场景共用 seq 一律拒绝自愈。
 */
export function repairSceneHistoryDrift(bookId) {
  const params = [];
  const scope = bookId ? 'AND c.book_id=?' : '';
  if (bookId) params.push(bookId);
  const rows = all(`SELECT s.id AS scene_id, c.book_id, s.history_seq, s.content,
      h.role AS history_role, h.content AS history_content,
      (SELECT COUNT(*) FROM scenes s2
       JOIN chapters c2 ON c2.id=s2.chapter_id
       WHERE c2.book_id=c.book_id AND s2.history_seq=s.history_seq) AS seq_refs
    FROM scenes s
    JOIN chapters c ON c.id=s.chapter_id
    JOIN history h ON h.book_id=c.book_id AND h.seq=s.history_seq
    WHERE s.history_seq IS NOT NULL
      AND TRIM(COALESCE(s.content,''))<>''
      AND (h.role<>'assistant' OR h.content<>s.content)
      ${scope}`, ...params);
  const safe = rows.filter(row => row.history_role === 'assistant' && Number(row.seq_refs) === 1);
  let repaired = 0;
  transaction(() => {
    for (const row of safe) {
      const result = run(`UPDATE history SET content=?
        WHERE book_id=? AND seq=? AND role='assistant'`, row.content, row.book_id, row.history_seq);
      repaired += Number(result.changes || 0);
    }
  });
  if (repaired > 0) {
    try {
      run(`INSERT INTO operation_logs
        (ts,category,level,op,detail,book_id,duration_ms,result)
        VALUES (?,?,?,?,?,?,?,?)`, Date.now(), 'cache', 'info', 'repair_scene_history_drift',
      `以当前场景正文愈合 ${repaired} 条旧历史`, bookId || null, 0, 'ok');
    } catch { /* 旧测试夹具可能无日志表 */ }
  }
  return { scanned: rows.length, repaired, unsafe: rows.length - safe.length };
}

// ---------- 作品 ----------

// ---------- V0.22 快照（打磨回滚） ----------
export const snapshots = {
  add(bookId, { label, source = 'auto', data }) {
    const id = uid('snap');
    run('INSERT INTO snapshots (id, book_id, label, source, data_json, created_at) VALUES (?,?,?,?,?,?)',
      id, bookId, label, source, JSON.stringify(data), Date.now());
    return this.get(id);
  },
  list(bookId) {
    return all('SELECT id, book_id, label, source, created_at FROM snapshots WHERE book_id=? ORDER BY created_at DESC LIMIT 20', bookId);
  },
  /** 内部恢复/审计使用：不限条数，避免完整稿落在界面最近 20 条之外。 */
  listAll(bookId) {
    return all('SELECT id, book_id, label, source, created_at FROM snapshots WHERE book_id=? ORDER BY created_at DESC', bookId);
  },
  get(id) {
    const r = get('SELECT * FROM snapshots WHERE id = ?', id);
    if (!r) return undefined;
    let data = {};
    try { data = JSON.parse(r.data_json || '{}'); } catch { /* ignore */ }
    return { ...r, data };
  },
  remove(id) { run('DELETE FROM snapshots WHERE id = ?', id); },
  clearBook(bookId) { run('DELETE FROM snapshots WHERE book_id=?', bookId); },
};

const OPENING_KINDS = new Set(['head_rewrite', 'chapter1_cold_open', 'standalone_prologue']);
const OPENING_PLACEMENTS = new Set(['scene_patch', 'prepend_chapter1', 'before_chapter1']);
const OPENING_STATUSES = new Set(['candidate', 'audited', 'selected', 'applied', 'retired', 'rejected']);
const OPENING_TRANSITIONS = Object.freeze({
  candidate: new Set(['audited', 'rejected', 'retired']),
  audited: new Set(['selected', 'rejected', 'retired']),
  selected: new Set(['applied', 'retired']),
  applied: new Set(['retired']),
  retired: new Set(),
  rejected: new Set(),
});
const OPENING_READER_PLACEMENTS = new Set(['prepend_chapter1', 'before_chapter1']);

function serializeOpeningJson(value, fallback) {
  const actual = value === undefined ? fallback : value;
  if (typeof actual === 'string') {
    try { return JSON.stringify(JSON.parse(actual)); } catch { throw new Error('opening asset JSON 字段不是有效 JSON'); }
  }
  try { return JSON.stringify(actual ?? fallback); } catch { throw new Error('opening asset JSON 字段不可序列化'); }
}

function openingField(data, camel, snake, fallback) {
  if (owns(data, camel)) return data[camel] === undefined ? fallback : data[camel];
  if (owns(data, snake)) return data[snake] === undefined ? fallback : data[snake];
  return fallback;
}

// ---------- V0.98 通用开篇干预资产 ----------
export const openingAssets = {
  list(bookId) { return all('SELECT * FROM opening_assets WHERE book_id=? ORDER BY created_at,id', bookId); },
  get(id) { return get('SELECT * FROM opening_assets WHERE id=?', id); },
  active(bookId) {
    return get(`SELECT * FROM opening_assets
      WHERE book_id=? AND status IN ('selected','applied')
        AND placement IN ('prepend_chapter1','before_chapter1')
      ORDER BY updated_at DESC LIMIT 1`, bookId);
  },
  create(bookId, data = {}) {
    if (!get('SELECT id FROM books WHERE id=?', bookId)) throw new Error('作品不存在');
    const kind = String(data.kind || '');
    const placement = String(data.placement || '');
    if (!OPENING_KINDS.has(kind)) throw new Error(`opening asset kind 无效：${kind || '空'}`);
    if (!OPENING_PLACEMENTS.has(placement)) throw new Error(`opening asset placement 无效：${placement || '空'}`);
    const expectedPlacement = {
      head_rewrite: 'scene_patch', chapter1_cold_open: 'prepend_chapter1', standalone_prologue: 'before_chapter1',
    }[kind];
    if (placement !== expectedPlacement) throw new Error(`${kind} 与 placement=${placement} 不匹配`);
    const id = uid('oa');
    const now = Date.now();
    run(`INSERT INTO opening_assets
      (id,book_id,kind,placement,title,anchor_scene_id,anchor_start,anchor_end,source_excerpt,source_hash,
       content,contract_json,audit_json,rank_json,creative_hypothesis,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, bookId, kind, placement, String(data.title || ''),
    openingField(data, 'anchorSceneId', 'anchor_scene_id', null),
    openingField(data, 'anchorStart', 'anchor_start', null),
    openingField(data, 'anchorEnd', 'anchor_end', null),
    String(openingField(data, 'sourceExcerpt', 'source_excerpt', '') || ''),
    String(openingField(data, 'sourceHash', 'source_hash', '') || ''),
    String(data.content || ''),
    serializeOpeningJson(openingField(data, 'contract', 'contract_json', {}), {}),
    serializeOpeningJson(openingField(data, 'audit', 'audit_json', {}), {}),
    serializeOpeningJson(openingField(data, 'rank', 'rank_json', {}), {}),
    String(openingField(data, 'creativeHypothesis', 'creative_hypothesis', '') || ''),
    'candidate', now, now);
    return this.get(id);
  },
  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) return undefined;
    const mapping = {
      title: ['title', value => String(value ?? '')],
      content: ['content', value => String(value ?? '')],
      contract: ['contract_json', value => serializeOpeningJson(value, {})],
      contract_json: ['contract_json', value => serializeOpeningJson(value, {})],
      audit: ['audit_json', value => serializeOpeningJson(value, {})],
      audit_json: ['audit_json', value => serializeOpeningJson(value, {})],
      rank: ['rank_json', value => serializeOpeningJson(value, {})],
      rank_json: ['rank_json', value => serializeOpeningJson(value, {})],
      creativeHypothesis: ['creative_hypothesis', value => String(value ?? '')],
      creative_hypothesis: ['creative_hypothesis', value => String(value ?? '')],
    };
    const sets = [];
    const values = [];
    const columns = new Set();
    for (const [key, value] of Object.entries(patch)) {
      const rule = mapping[key];
      if (!rule) throw new Error(`不允许更新字段：${key}`);
      const [column, normalize] = rule;
      if (columns.has(column)) throw new Error(`字段重复：${column}`);
      columns.add(column);
      sets.push(`${column}=?`);
      values.push(normalize(value));
    }
    if (!sets.length) return current;
    sets.push('updated_at=?');
    values.push(Date.now(), id);
    run(`UPDATE opening_assets SET ${sets.join(',')} WHERE id=?`, ...values);
    return this.get(id);
  },
  transition(id, next) {
    const current = this.get(id);
    if (!current || !OPENING_TRANSITIONS[current.status]?.has(next)) throw new Error('非法状态转换');
    if (next === 'selected' && OPENING_READER_PLACEMENTS.has(current.placement)) {
      const active = this.active(current.book_id);
      if (active && active.id !== id) throw new Error('已有启用的读者前置层');
    }
    try {
      run('UPDATE opening_assets SET status=?,updated_at=? WHERE id=?', next, Date.now(), id);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message)) throw new Error('已有启用的读者前置层');
      throw error;
    }
    return this.get(id);
  },
  remove(id) {
    // V0.98.12：旧方案可清理——未应用的任何状态（candidate/audited/selected/rejected/retired）可删；
    // applied 保持禁删（已应用的发布视图/正文修改必须经撤下流程，保护可回滚资产）。
    return run("DELETE FROM opening_assets WHERE id=? AND status IN ('candidate','audited','selected','rejected','retired')", id);
  },
};

// ---------- V0.99 平台发布反馈闭环 ----------
const RECOMMENDATION_STAGES = new Set([
  'not_applied', 'preparing', 'under_review', 'failed', 'validation', 'recommended', 'terminated',
]);
const EXPOSURE_STATUSES = new Set(['not_exposed', 'validation', 'limited_test', 'recommended', 'organic']);
const PROFILE_SYNC_STATUSES = new Set(['idle', 'syncing', 'ok', 'error']);
const PROFILE_RECOVERY_STATUSES = new Set([
  'idle', 'needs_plan', 'diagnosing', 'planned', 'rewriting', 'verifying', 'completed', 'failed', 'cancelled',
]);
const RECOVERY_RUN_STATUSES = new Set(['diagnosing', 'planned', 'rewriting', 'verifying', 'completed', 'failed', 'cancelled']);

function parseJsonField(raw, fallback) {
  try {
    const value = JSON.parse(raw || JSON.stringify(fallback));
    return value ?? fallback;
  } catch { return fallback; }
}

function publicationProfileRow(row) {
  if (!row) return undefined;
  return {
    ...row,
    public_chapters: parseJsonField(row.public_chapters_json, []),
    pending_sync_chapters: parseJsonField(row.pending_sync_json, []),
  };
}

function recoveryRunRow(row) {
  if (!row) return undefined;
  return {
    ...row,
    confirmed_published_rewrite: !!row.confirmed_published_rewrite,
    quality_curve: parseJsonField(row.quality_curve_json, []),
    work_orders: parseJsonField(row.work_orders_json, []),
    completed_chapters: parseJsonField(row.completed_chapters_json, []),
    rejected_chapters: parseJsonField(row.rejected_chapters_json, []),
    execution_policy: parseJsonField(row.execution_policy_json, {}),
    result: parseJsonField(row.result_json, {}),
  };
}

function integerOrNull(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}无效`);
  return number;
}

function numberOrNull(value, label, { min = 0, max = Number.MAX_VALUE } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}无效`);
  return number;
}

function jsonValue(value, fallback) {
  const actual = value === undefined ? fallback : value;
  try { return JSON.stringify(actual ?? fallback); } catch { throw new Error('发布反馈 JSON 字段不可序列化'); }
}

function publicationValue(data, camel, snake, fallback) {
  if (owns(data, camel)) return data[camel];
  if (owns(data, snake)) return data[snake];
  return fallback;
}

export const publicationProfiles = {
  get(bookId) {
    return publicationProfileRow(get('SELECT * FROM publication_profiles WHERE book_id=?', bookId));
  },
  upsert(bookId, data = {}) {
    if (!books.get(bookId)) throw new Error('作品不存在');
    const current = this.get(bookId);
    const stage = String(publicationValue(data, 'recommendationStage', 'recommendation_stage', current?.recommendation_stage || 'not_applied'));
    const syncStatus = String(publicationValue(data, 'syncStatus', 'sync_status', current?.sync_status || 'idle'));
    const recoveryStatus = String(publicationValue(data, 'recoveryStatus', 'recovery_status', current?.recovery_status || 'idle'));
    if (!RECOMMENDATION_STAGES.has(stage)) throw new Error(`推荐阶段无效：${stage}`);
    if (!PROFILE_SYNC_STATUSES.has(syncStatus)) throw new Error(`同步状态无效：${syncStatus}`);
    if (!PROFILE_RECOVERY_STATUSES.has(recoveryStatus)) throw new Error(`返工状态无效：${recoveryStatus}`);
    const remaining = integerOrNull(publicationValue(data, 'remainingAttempts', 'remaining_attempts', current?.remaining_attempts), '剩余申请次数', { min: 0, max: 3 });
    const turn = integerOrNull(publicationValue(data, 'suspectedTurnChapter', 'suspected_turn_chapter', current?.suspected_turn_chapter), '疑似质量拐点章', { min: 1 });
    const publishedCount = integerOrNull(publicationValue(data, 'publishedChapterCount', 'published_chapter_count', current?.published_chapter_count), '已发布章节数');
    const publishedWords = integerOrNull(publicationValue(data, 'publishedWordCount', 'published_word_count', current?.published_word_count), '公开字数');
    const readerCount = integerOrNull(publicationValue(data, 'publicReaderCount', 'public_reader_count', current?.public_reader_count), '公开读者数');
    const now = Date.now();
    const values = {
      platform: String(publicationValue(data, 'platform', 'platform', current?.platform || 'fanqie') || 'fanqie'),
      workUrl: String(publicationValue(data, 'workUrl', 'work_url', current?.work_url || '') || ''),
      externalBookId: String(publicationValue(data, 'externalBookId', 'external_book_id', current?.external_book_id || '') || ''),
      stage, remaining,
      editorFeedback: String(publicationValue(data, 'editorFeedback', 'editor_feedback', current?.editor_feedback || '') || ''),
      authorDiagnosis: String(publicationValue(data, 'authorDiagnosis', 'author_diagnosis', current?.author_diagnosis || '') || ''),
      turn,
      reviewedAt: integerOrNull(publicationValue(data, 'reviewedAt', 'reviewed_at', current?.reviewed_at), '审核时间'),
      publishedCount, publishedWords, readerCount,
      latestChapterTitle: String(publicationValue(data, 'latestChapterTitle', 'latest_chapter_title', current?.latest_chapter_title || '') || ''),
      latestChapterItemId: String(publicationValue(data, 'latestChapterItemId', 'latest_chapter_item_id', current?.latest_chapter_item_id || '') || ''),
      lastPublishTime: integerOrNull(publicationValue(data, 'lastPublishTime', 'last_publish_time', current?.last_publish_time), '末章发布时间'),
      publicChapters: publicationValue(data, 'publicChapters', 'public_chapters', current?.public_chapters || []),
      lastSyncedAt: integerOrNull(publicationValue(data, 'lastSyncedAt', 'last_synced_at', current?.last_synced_at), '同步时间'),
      syncStatus,
      syncError: String(publicationValue(data, 'syncError', 'sync_error', current?.sync_error || '') || ''),
      pendingSync: publicationValue(data, 'pendingSyncChapters', 'pending_sync_chapters', current?.pending_sync_chapters || []),
      recoveryStatus,
    };
    if (!Array.isArray(values.publicChapters) || !Array.isArray(values.pendingSync)) throw new Error('发布章节或待同步章节必须是数组');
    values.pendingSync = [...new Set(values.pendingSync.map(value => integerOrNull(value, '待同步章节', { min: 1 })))].sort((a, b) => a - b);
    if (current) {
      run(`UPDATE publication_profiles SET
        platform=?,work_url=?,external_book_id=?,recommendation_stage=?,remaining_attempts=?,editor_feedback=?,author_diagnosis=?,
        suspected_turn_chapter=?,reviewed_at=?,published_chapter_count=?,published_word_count=?,public_reader_count=?,
        latest_chapter_title=?,latest_chapter_item_id=?,last_publish_time=?,public_chapters_json=?,last_synced_at=?,
        sync_status=?,sync_error=?,pending_sync_json=?,recovery_status=?,updated_at=? WHERE book_id=?`,
      values.platform, values.workUrl, values.externalBookId, values.stage, values.remaining, values.editorFeedback,
      values.authorDiagnosis, values.turn, values.reviewedAt, values.publishedCount, values.publishedWords, values.readerCount,
      values.latestChapterTitle, values.latestChapterItemId, values.lastPublishTime, jsonValue(values.publicChapters, []), values.lastSyncedAt,
      values.syncStatus, values.syncError, jsonValue(values.pendingSync, []), values.recoveryStatus, now, bookId);
    } else {
      run(`INSERT INTO publication_profiles
        (book_id,platform,work_url,external_book_id,recommendation_stage,remaining_attempts,editor_feedback,author_diagnosis,
         suspected_turn_chapter,reviewed_at,published_chapter_count,published_word_count,public_reader_count,
         latest_chapter_title,latest_chapter_item_id,last_publish_time,public_chapters_json,last_synced_at,
         sync_status,sync_error,pending_sync_json,recovery_status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      bookId, values.platform, values.workUrl, values.externalBookId, values.stage, values.remaining, values.editorFeedback,
      values.authorDiagnosis, values.turn, values.reviewedAt, values.publishedCount, values.publishedWords, values.readerCount,
      values.latestChapterTitle, values.latestChapterItemId, values.lastPublishTime, jsonValue(values.publicChapters, []), values.lastSyncedAt,
      values.syncStatus, values.syncError, jsonValue(values.pendingSync, []), values.recoveryStatus, now, now);
    }
    return this.get(bookId);
  },
  markPendingSync(bookId, chapterIndexes = []) {
    const current = this.get(bookId) || this.upsert(bookId, {});
    const merged = [...new Set([
      ...current.pending_sync_chapters,
      ...chapterIndexes.map(value => integerOrNull(value, '待同步章节', { min: 1 })),
    ])].sort((a, b) => a - b);
    return this.upsert(bookId, { pendingSyncChapters: merged });
  },
  clearPendingSync(bookId, chapterIndexes) {
    const current = this.get(bookId);
    if (!current) return undefined;
    const removeSet = chapterIndexes === undefined ? null : new Set(chapterIndexes.map(Number));
    const next = removeSet ? current.pending_sync_chapters.filter(value => !removeSet.has(value)) : [];
    return this.upsert(bookId, { pendingSyncChapters: next });
  },
};

export const recommendationReviews = {
  list(bookId) { return all('SELECT * FROM recommendation_reviews WHERE book_id=? ORDER BY reviewed_at DESC,created_at DESC', bookId); },
  add(bookId, data = {}) {
    if (!books.get(bookId)) throw new Error('作品不存在');
    const stage = String(data.stage || 'failed');
    if (!RECOMMENDATION_STAGES.has(stage)) throw new Error(`推荐阶段无效：${stage}`);
    const remaining = integerOrNull(data.remainingAttempts ?? data.remaining_attempts, '剩余申请次数', { min: 0, max: 3 });
    const now = Date.now();
    const id = uid('review');
    const reviewedAt = integerOrNull(data.reviewedAt ?? data.reviewed_at, '审核时间') ?? now;
    run(`INSERT INTO recommendation_reviews
      (id,book_id,stage,remaining_attempts,feedback,source,reviewed_at,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, bookId, stage, remaining, String(data.feedback || ''), String(data.source || 'manual'), reviewedAt, now);
    return get('SELECT * FROM recommendation_reviews WHERE id=?', id);
  },
};

export const publicationMetrics = {
  list(bookId) { return all('SELECT * FROM publication_metrics WHERE book_id=? ORDER BY observed_at DESC,created_at DESC', bookId); },
  add(bookId, data = {}) {
    if (!books.get(bookId)) throw new Error('作品不存在');
    const exposure = String(data.exposureStatus ?? data.exposure_status ?? 'not_exposed');
    if (!EXPOSURE_STATUSES.has(exposure)) throw new Error(`曝光状态无效：${exposure}`);
    const values = {
      impressions: integerOrNull(data.impressions, '曝光数'), readers: integerOrNull(data.readers, '读者数'),
      bookshelfAdds: integerOrNull(data.bookshelfAdds ?? data.bookshelf_adds, '加书架数'),
      readThroughRate: numberOrNull(data.readThroughRate ?? data.read_through_rate, '读完率', { min: 0, max: 100 }),
      followRate: numberOrNull(data.followRate ?? data.follow_rate, '追读率', { min: 0, max: 100 }),
    };
    const now = Date.now();
    const id = uid('metric');
    const observedAt = integerOrNull(data.observedAt ?? data.observed_at, '观察时间') ?? now;
    run(`INSERT INTO publication_metrics
      (id,book_id,exposure_status,impressions,readers,bookshelf_adds,read_through_rate,follow_rate,note,observed_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, bookId, exposure, values.impressions, values.readers, values.bookshelfAdds,
    values.readThroughRate, values.followRate, String(data.note || ''), observedAt, now);
    return get('SELECT * FROM publication_metrics WHERE id=?', id);
  },
};

export const recommendationRecoveryRuns = {
  list(bookId) {
    return all('SELECT * FROM recommendation_recovery_runs WHERE book_id=? ORDER BY created_at DESC', bookId).map(recoveryRunRow);
  },
  get(id) { return recoveryRunRow(get('SELECT * FROM recommendation_recovery_runs WHERE id=?', id)); },
  create(bookId, data = {}) {
    if (!books.get(bookId)) throw new Error('作品不存在');
    const start = integerOrNull(data.startChapter ?? data.start_chapter ?? 1, '返工起始章', { min: 1 });
    const end = integerOrNull(data.endChapter ?? data.end_chapter ?? 20, '返工结束章', { min: start });
    const status = String(data.status || 'diagnosing');
    if (!RECOVERY_RUN_STATUSES.has(status)) throw new Error(`返工运行状态无效：${status}`);
    const now = Date.now();
    const id = uid('recovery');
    run(`INSERT INTO recommendation_recovery_runs
      (id,book_id,start_chapter,end_chapter,status,confirmed_published_rewrite,snapshot_id,quality_curve_json,
       work_orders_json,completed_chapters_json,rejected_chapters_json,execution_policy_json,result_json,error,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, bookId, start, end, status, data.confirmedPublishedRewrite ? 1 : 0, data.snapshotId || null,
    jsonValue(data.qualityCurve, []), jsonValue(data.workOrders, []), jsonValue(data.completedChapters, []),
    jsonValue(data.rejectedChapters, []), jsonValue(data.executionPolicy ?? data.execution_policy, {}),
    jsonValue(data.result, {}), String(data.error || ''), now, now);
    return this.get(id);
  },
  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) return undefined;
    const mapping = {
      status: ['status', value => {
        const status = String(value); if (!RECOVERY_RUN_STATUSES.has(status)) throw new Error(`返工运行状态无效：${status}`); return status;
      }],
      confirmedPublishedRewrite: ['confirmed_published_rewrite', value => value ? 1 : 0],
      confirmed_published_rewrite: ['confirmed_published_rewrite', value => value ? 1 : 0],
      snapshotId: ['snapshot_id', value => value || null], snapshot_id: ['snapshot_id', value => value || null],
      qualityCurve: ['quality_curve_json', value => jsonValue(value, [])], quality_curve: ['quality_curve_json', value => jsonValue(value, [])],
      workOrders: ['work_orders_json', value => jsonValue(value, [])], work_orders: ['work_orders_json', value => jsonValue(value, [])],
      completedChapters: ['completed_chapters_json', value => jsonValue(value, [])], completed_chapters: ['completed_chapters_json', value => jsonValue(value, [])],
      rejectedChapters: ['rejected_chapters_json', value => jsonValue(value, [])], rejected_chapters: ['rejected_chapters_json', value => jsonValue(value, [])],
      executionPolicy: ['execution_policy_json', value => jsonValue(value, {})], execution_policy: ['execution_policy_json', value => jsonValue(value, {})],
      result: ['result_json', value => jsonValue(value, {})], error: ['error', value => String(value || '')],
    };
    const sets = [];
    const values = [];
    const columns = new Set();
    for (const [key, value] of Object.entries(patch)) {
      const rule = mapping[key];
      if (!rule) throw new Error(`不允许更新返工字段：${key}`);
      if (columns.has(rule[0])) continue;
      columns.add(rule[0]); sets.push(`${rule[0]}=?`); values.push(rule[1](value));
    }
    if (!sets.length) return current;
    sets.push('updated_at=?'); values.push(Date.now(), id);
    run(`UPDATE recommendation_recovery_runs SET ${sets.join(',')} WHERE id=?`, ...values);
    return this.get(id);
  },
  // V0.100.1 启动自愈：diagnosing/rewriting/verifying 都是进程内瞬时态（LLM 调用与原子落盘
  // 只在存活进程内推进），进程中断后这些运行永远不会再推进——用户刷新页面只能看到
  // "诊断未完成"却无从续跑。诊断落 failed 让批次检查点走断点续跑；执行回 planned 让
  // 已验证工单可直接重新发起（候选应用是进程内原子切换，中断即未落盘，正文无损）。
  healOrphanedInFlight() {
    const now = Date.now();
    const note = (sql, status) => db().prepare(sql).run(status, now).changes;
    const diagnosed = note(
      `UPDATE recommendation_recovery_runs SET status=?,
        error=CASE WHEN error='' THEN '诊断进程中断；已验证批次检查点已保留，重新诊断将从断点续跑' ELSE error END,
        updated_at=? WHERE status='diagnosing'`, 'failed');
    const executing = note(
      `UPDATE recommendation_recovery_runs SET status=?,
        error=CASE WHEN error='' THEN '返工执行进程中断；候选未落盘、正文未被覆盖，可直接重新执行（需重新确认）' ELSE error END,
        updated_at=? WHERE status IN ('rewriting','verifying')`, 'planned');
    return diagnosed + executing;
  },
};

// ---------- V0.100 正文/派生状态同版本 ----------
const NARRATIVE_REVISION_STATUSES = new Set(['building', 'ready', 'applying', 'valid', 'stale', 'failed']);
const NARRATIVE_BLOCKING_STATUSES = new Set(['building', 'ready', 'applying', 'stale']);

function narrativeRevisionRow(row) {
  if (!row) return undefined;
  return { ...row, manifest: parseJsonField(row.manifest_json, {}) };
}

function chapterProjectionRow(row) {
  if (!row) return undefined;
  return { ...row, payload: parseJsonField(row.payload_json, {}) };
}

export const narrativeRevisions = {
  list(bookId) {
    return all('SELECT * FROM narrative_revisions WHERE book_id=? ORDER BY created_at DESC, rowid DESC', bookId)
      .map(narrativeRevisionRow);
  },
  get(id) { return narrativeRevisionRow(get('SELECT * FROM narrative_revisions WHERE id=?', id)); },
  current(bookId) {
    return narrativeRevisionRow(get(`SELECT * FROM narrative_revisions
      WHERE book_id=? AND status='valid' ORDER BY completed_at DESC, created_at DESC, rowid DESC LIMIT 1`, bookId));
  },
  blocking(bookId) {
    // failed 只是一次候选构建失败，不能遮住更早仍待处理的 stale 版本；
    // valid 则是明确的最新稳定边界，看到它即可停止向前追溯。
    const rows = all(`SELECT * FROM narrative_revisions WHERE book_id=?
      ORDER BY created_at DESC, rowid DESC`, bookId);
    for (const row of rows) {
      if (row.status === 'failed') continue;
      if (row.status === 'valid') return null;
      if (NARRATIVE_BLOCKING_STATUSES.has(row.status)) return narrativeRevisionRow(row);
    }
    return null;
  },
  create(bookId, data = {}) {
    if (!books.get(bookId)) throw new Error('作品不存在');
    const from = integerOrNull(data.fromChapter ?? data.from_chapter, '派生重建起始章', { min: 1 });
    const through = integerOrNull(data.throughChapter ?? data.through_chapter, '派生重建结束章', { min: from });
    if (from === null || through === null) throw new Error('派生状态版本缺少有效章节范围');
    const status = String(data.status || 'building');
    if (!NARRATIVE_REVISION_STATUSES.has(status)) throw new Error(`派生状态版本无效：${status}`);
    const sourceHash = String(data.sourceHash ?? data.source_hash ?? '').trim();
    if (!sourceHash) throw new Error('派生状态版本缺少正文指纹');
    const id = uid('nrev');
    const now = Date.now();
    run(`INSERT INTO narrative_revisions
      (id,book_id,parent_id,from_chapter,through_chapter,status,source_hash,reason,manifest_json,error,created_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, bookId, data.parentId ?? data.parent_id ?? null, from, through, status, sourceHash,
    String(data.reason || ''), jsonValue(data.manifest, {}), String(data.error || ''), now,
    status === 'valid' ? now : null);
    return this.get(id);
  },
  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) return undefined;
    const sets = [];
    const values = [];
    if (patch.fromChapter !== undefined || patch.from_chapter !== undefined
      || patch.throughChapter !== undefined || patch.through_chapter !== undefined) {
      const from = integerOrNull(
        patch.fromChapter ?? patch.from_chapter ?? current.from_chapter,
        '派生重建起始章', { min: 1 },
      );
      const through = integerOrNull(
        patch.throughChapter ?? patch.through_chapter ?? current.through_chapter,
        '派生重建结束章', { min: from },
      );
      if (from === null || through === null) throw new Error('派生状态版本缺少有效章节范围');
      sets.push('from_chapter=?', 'through_chapter=?'); values.push(from, through);
    }
    if (patch.status !== undefined) {
      const status = String(patch.status);
      if (!NARRATIVE_REVISION_STATUSES.has(status)) throw new Error(`派生状态版本无效：${status}`);
      sets.push('status=?'); values.push(status);
      if (status === 'valid') { sets.push('completed_at=?'); values.push(Date.now()); }
    }
    if (patch.sourceHash !== undefined || patch.source_hash !== undefined) {
      const value = String(patch.sourceHash ?? patch.source_hash ?? '').trim();
      if (!value) throw new Error('派生状态版本缺少正文指纹');
      sets.push('source_hash=?'); values.push(value);
    }
    if (patch.manifest !== undefined) { sets.push('manifest_json=?'); values.push(jsonValue(patch.manifest, {})); }
    if (patch.error !== undefined) { sets.push('error=?'); values.push(String(patch.error || '')); }
    if (patch.reason !== undefined) { sets.push('reason=?'); values.push(String(patch.reason || '')); }
    if (!sets.length) return current;
    values.push(id);
    run(`UPDATE narrative_revisions SET ${sets.join(',')} WHERE id=?`, ...values);
    return this.get(id);
  },
  complete(id, { sourceHash, manifest = {} } = {}) {
    return this.update(id, { status: 'valid', sourceHash, manifest, error: '' });
  },
  fail(id, error) { return this.update(id, { status: 'failed', error: String(error || '') }); },
  /**
   * V0.100.1 断点续跑：找回最近一次在同一正文指纹下失败的重建版本。
   * 失败版本里已验证的逐章投影是断点缓存——下一轮重建复用它们，不再从第一章重新取证。
   * 正文一旦变化（base_source_hash 不等）整批缓存失效；list 按创建时间倒序，find 即最新。
   */
  latestFailedForBase(bookId, baseHash) {
    if (!baseHash) return null;
    return this.list(bookId).find(
      row => row.status === 'failed' && row.manifest?.base_source_hash === baseHash,
    ) || null;
  },
  /**
   * V0.100.1 启动自愈：building/ready/applying 都是进程内瞬时态（LLM 取证与原子提交只在存活进程内推进），
   * 进程被杀后永远不会推进，会把作品永久卡在"重建中"。启动时全部标记 failed——
   * fail-closed 语义与构建失败一致：正文与旧派生状态未被覆盖，可安全重建。
   */
  failOrphanedInFlight() {
    const result = run(`UPDATE narrative_revisions SET status='failed', error=?
      WHERE status IN ('building','ready','applying')`,
    '构建进程中断，版本未提交；启动时自愈标记为失败（正文与旧派生状态未被覆盖）');
    return result?.changes ?? 0;
  },
};

export const chapterProjections = {
  list(revisionId) {
    return all('SELECT * FROM chapter_projections WHERE revision_id=? ORDER BY chapter_idx', revisionId)
      .map(chapterProjectionRow);
  },
  get(revisionId, chapterId) {
    return chapterProjectionRow(get('SELECT * FROM chapter_projections WHERE revision_id=? AND chapter_id=?', revisionId, chapterId));
  },
  set(revisionId, bookId, chapterId, data = {}) {
    const revision = narrativeRevisions.get(revisionId);
    const chapter = chapters.get(chapterId);
    if (!revision || revision.book_id !== bookId) throw new Error('派生状态版本不存在或不属于目标作品');
    if (!chapter || chapter.book_id !== bookId) throw new Error('投影章节不存在或不属于目标作品');
    const chapterIdx = integerOrNull(data.chapterIdx ?? data.chapter_idx ?? chapter.idx, '投影章节号', { min: 1 });
    const sourceHash = String(data.sourceHash ?? data.source_hash ?? '').trim();
    if (!sourceHash) throw new Error('章节投影缺少正文指纹');
    run(`INSERT INTO chapter_projections
      (revision_id,book_id,chapter_id,chapter_idx,source_hash,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(revision_id,chapter_id) DO UPDATE SET
        chapter_idx=excluded.chapter_idx,source_hash=excluded.source_hash,
        payload_json=excluded.payload_json,created_at=excluded.created_at`,
    revisionId, bookId, chapterId, chapterIdx, sourceHash, jsonValue(data.payload, {}), Date.now());
    return this.get(revisionId, chapterId);
  },
  clear(revisionId) { run('DELETE FROM chapter_projections WHERE revision_id=?', revisionId); },
};

export const narrativePatterns = {
  list(bookId, { beforeChapter = null, limit = 20 } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 20));
    if (Number.isInteger(Number(beforeChapter))) {
      return all(`SELECT * FROM narrative_patterns WHERE book_id=? AND chapter_idx<?
        ORDER BY chapter_idx DESC LIMIT ?`, bookId, Number(beforeChapter), n)
        .map(row => ({ ...row, features: parseJsonField(row.features_json, {}) }));
    }
    return all('SELECT * FROM narrative_patterns WHERE book_id=? ORDER BY chapter_idx DESC LIMIT ?', bookId, n)
      .map(row => ({ ...row, features: parseJsonField(row.features_json, {}) }));
  },
  upsert(bookId, chapterId, data = {}) {
    const chapter = chapters.get(chapterId);
    if (!chapter || chapter.book_id !== bookId) throw new Error('结构签名章节不存在');
    const signature = String(data.signature || '').trim();
    const sourceHash = String(data.sourceHash ?? data.source_hash ?? '').trim();
    if (!signature || !sourceHash) throw new Error('结构签名缺少 signature/sourceHash');
    run(`INSERT INTO narrative_patterns
      (book_id,chapter_id,chapter_idx,revision_id,signature,features_json,source_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(book_id,chapter_id) DO UPDATE SET
        chapter_idx=excluded.chapter_idx,revision_id=excluded.revision_id,signature=excluded.signature,
        features_json=excluded.features_json,source_hash=excluded.source_hash,created_at=excluded.created_at`,
    bookId, chapterId, chapter.idx, String(data.revisionId || ''), signature,
    jsonValue(data.features, {}), sourceHash, Date.now());
    return this.list(bookId, { beforeChapter: chapter.idx + 1, limit: 1 })[0];
  },
  clear(bookId) { run('DELETE FROM narrative_patterns WHERE book_id=?', bookId); },
};

export const narrativeLessons = {
  list(bookId, { status = null } = {}) {
    const rows = status
      ? all('SELECT * FROM narrative_lessons WHERE book_id=? AND status=? ORDER BY confidence DESC, updated_at DESC', bookId, status)
      : all('SELECT * FROM narrative_lessons WHERE book_id=? ORDER BY updated_at DESC', bookId);
    return rows.map(row => ({
      ...row,
      evidence: parseJsonField(row.evidence_json, []),
      outcome: parseJsonField(row.outcome_json, {}),
    }));
  },
  upsert(bookId, data = {}) {
    if (!books.get(bookId)) throw new Error('作品不存在');
    const key = String(data.key ?? data.lessonKey ?? data.lesson_key ?? '').trim();
    const problem = String(data.problem || '').trim();
    const positiveTarget = String(data.positiveTarget ?? data.positive_target ?? '').trim();
    const status = String(data.status || 'provisional');
    if (!key || !problem || !positiveTarget) throw new Error('叙事经验缺少 key/problem/positiveTarget');
    if (!new Set(['provisional', 'active', 'retired']).has(status)) throw new Error(`叙事经验状态无效：${status}`);
    const existing = get('SELECT * FROM narrative_lessons WHERE book_id=? AND lesson_key=?', bookId, key);
    const now = Date.now();
    if (existing) {
      run(`UPDATE narrative_lessons SET source=?,status=?,problem=?,positive_target=?,evidence_json=?,
        scope_start=?,scope_end=?,confidence=?,outcome_json=?,updated_at=? WHERE id=?`,
      String(data.source || existing.source), status, problem, positiveTarget, jsonValue(data.evidence, []),
      data.scopeStart ?? data.scope_start ?? null, data.scopeEnd ?? data.scope_end ?? null,
      Math.max(0, Math.min(1, Number(data.confidence) || 0.5)), jsonValue(data.outcome, {}), now, existing.id);
      return this.list(bookId).find(row => row.id === existing.id);
    }
    const id = uid('lesson');
    run(`INSERT INTO narrative_lessons
      (id,book_id,lesson_key,source,status,problem,positive_target,evidence_json,scope_start,scope_end,
       confidence,uses,outcome_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, bookId, key, String(data.source || 'recovery'), status, problem, positiveTarget,
    jsonValue(data.evidence, []), data.scopeStart ?? data.scope_start ?? null,
    data.scopeEnd ?? data.scope_end ?? null, Math.max(0, Math.min(1, Number(data.confidence) || 0.5)),
    0, jsonValue(data.outcome, {}), now, now);
    return this.list(bookId).find(row => row.id === id);
  },
  activate(id) { run("UPDATE narrative_lessons SET status='active',updated_at=? WHERE id=?", Date.now(), id); },
  markUsed(ids = []) {
    for (const id of ids) run('UPDATE narrative_lessons SET uses=uses+1,updated_at=? WHERE id=?', Date.now(), id);
  },
};

export const narrativeEntityBaselines = {
  list(bookId, entityKind = null) {
    const rows = entityKind
      ? all('SELECT * FROM narrative_entity_baselines WHERE book_id=? AND entity_kind=? ORDER BY entity_id', bookId, entityKind)
      : all('SELECT * FROM narrative_entity_baselines WHERE book_id=? ORDER BY entity_kind,entity_id', bookId);
    return rows.map(row => ({ ...row, baseline: parseJsonField(row.baseline_json, {}) }));
  },
  set(bookId, entityKind, entityId, baseline) {
    run(`INSERT INTO narrative_entity_baselines (book_id,entity_kind,entity_id,baseline_json,created_at)
      VALUES (?,?,?,?,?) ON CONFLICT(book_id,entity_kind,entity_id) DO NOTHING`,
    bookId, String(entityKind), String(entityId), jsonValue(baseline, {}), Date.now());
  },
  clear(bookId) { run('DELETE FROM narrative_entity_baselines WHERE book_id=?', bookId); },
};

function stableEntityBaseline(kind, row) {
  let card = {};
  try { card = JSON.parse(row.card_json || '{}'); } catch { card = {}; }
  const source = String(card.source || '').toLowerCase();
  const role = String(card.role || '').trim();
  if (source === 'narrative_projection') return false;
  if (kind === 'character') {
    if (/待完善|正文取证|自动抽取/.test(role)) return false;
    return row.first_chapter == null
      || ['protagonist', 'major'].includes(String(row.tier || ''))
      || [row.personality, row.goal, row.fear, row.secret, row.arc, row.relation, row.exit_note]
        .some(value => String(value || '').trim())
      || (role && role !== '（待完善）');
  }
  if (row.first_chapter == null) return true;
  if (kind === 'location') {
    return Boolean(String(row.desc || '').trim() || String(row.kind || '').trim()
      || String(row.admin_level || '').trim() || String(row.strategic || '').trim());
  }
  // 旧结算自动建卡通常只有 type/detail 且带首现章；作者/设定生成卡有更丰富字段。
  return Object.keys(card).some(key => !['type', 'detail', 'source'].includes(key));
}

function baselineCardJson(raw) {
  let card = {};
  try { card = JSON.parse(raw || '{}'); } catch { card = {}; }
  // narrative_notes 是完成章结算派生物，不属于人物设定态。
  const { narrative_notes: _notes, ...stable } = card;
  return JSON.stringify(stable);
}

/**
 * 首次同版回放前冻结设定态实体。后续正文抽取新建的实体不进入 baseline，下一次
 * 回放会先删掉再由有正文证据的 projection 重建，避免旧稿人物/地点悄悄残留。
 */
export function captureNarrativeEntityBaselines(bookId) {
  const specs = {
    character: {
      table: 'characters',
      fields: ['name', 'card_json', 'personality', 'goal', 'fear', 'secret', 'arc', 'relation', 'speech', 'speech_forbid', 'tier', 'abilities_json', 'exit_note'],
    },
    location: {
      table: 'locations',
      fields: ['name', 'card_json', 'kind', 'desc', 'stable', 'admin_level', 'strategic'],
    },
    item: { table: 'items', fields: ['name', 'card_json', 'owner'] },
    faction: { table: 'factions', fields: ['name', 'card_json'] },
  };
  let captured = 0;
  for (const [kind, spec] of Object.entries(specs)) {
    for (const row of all(`SELECT * FROM ${spec.table} WHERE book_id=?`, bookId)) {
      if (!stableEntityBaseline(kind, row)) continue;
      const baseline = Object.fromEntries(spec.fields.map(field => [field, row[field]]));
      if (Object.prototype.hasOwnProperty.call(baseline, 'card_json')) {
        baseline.card_json = baselineCardJson(baseline.card_json);
      }
      const before = narrativeEntityBaselines.list(bookId, kind).some(item => item.entity_id === row.id);
      narrativeEntityBaselines.set(bookId, kind, row.id, baseline);
      if (!before) captured++;
    }
  }
  return captured;
}

/**
 * 清空只应由完成章正文推导出来的状态，并恢复实体的设定态。必须在外层事务中调用；
 * 本函数不碰正文、平台审核/作品数据、用户约束、书契约或版本快照。
 */
export function resetNarrativeProjectionState(bookId, { throughChapter = Number.MAX_SAFE_INTEGER } = {}) {
  const through = Math.max(1, Number(throughChapter) || Number.MAX_SAFE_INTEGER);
  captureNarrativeEntityBaselines(bookId);

  const deleteTables = [
    'facts', 'chapter_summaries', 'chapter_settlements', 'timeline', 'rolling_summaries',
    'memory_entries', 'pending_entities', 'chapter_health', 'vectors', 'narrative_patterns',
    'book_archives', 'volume_reviews',
  ];
  for (const table of deleteTables) run(`DELETE FROM ${table} WHERE book_id=?`, bookId);
  run('DELETE FROM conflicts WHERE book_id=?', bookId);
  // 已写区间的伏笔与期待必须由新正文重新举证；未来章预登记项保留。
  run('DELETE FROM foreshadows WHERE book_id=? AND (planted_chapter IS NULL OR planted_chapter<=?)', bookId, through);
  run('DELETE FROM pleasure_hooks WHERE book_id=? AND planted_chapter<=?', bookId, through);

  // 旧稿产生的自动约束不能继续约束新稿；作者手填约束和纯未来作用域不动。
  run(`UPDATE book_constraints SET active=0
    WHERE book_id=? AND source<>'user' AND (scope_start IS NULL OR scope_start<=?)`, bookId, through);
  run(`UPDATE contract_promises SET status='open',checked_chapter=NULL,fulfilled_chapter=NULL
    WHERE book_id=?`, bookId);
  run(`UPDATE story_arcs SET status='opening',last_active_chapter=COALESCE(opened_chapter,0)
    WHERE book_id=?`, bookId);
  run("UPDATE volumes SET summary='' WHERE book_id=?", bookId);

  const baselines = narrativeEntityBaselines.list(bookId);
  const restoreKinds = {
    character: 'characters', location: 'locations', item: 'items', faction: 'factions',
  };
  for (const [kind, table] of Object.entries(restoreKinds)) {
    const keepIds = baselines.filter(item => item.entity_kind === kind).map(item => item.entity_id);
    if (keepIds.length) {
      const placeholders = keepIds.map(() => '?').join(',');
      run(`DELETE FROM ${table} WHERE book_id=? AND id NOT IN (${placeholders})`, bookId, ...keepIds);
    } else {
      run(`DELETE FROM ${table} WHERE book_id=?`, bookId);
    }
  }

  for (const entry of baselines) {
    const b = entry.baseline || {};
    if (entry.entity_kind === 'character') {
      run(`UPDATE characters SET name=?,card_json=?,state_json='{}',first_chapter=NULL,last_chapter=NULL,
        deceased=0,death_chapter=NULL,personality=?,goal=?,fear=?,secret=?,arc=?,relation=?,speech=?,speech_forbid=?,tier=?,abilities_json=?,exit_note=?
        WHERE id=? AND book_id=?`,
      b.name || '', b.card_json || '{}', b.personality || '', b.goal || '', b.fear || '', b.secret || '',
      b.arc || '', b.relation || '', b.speech || '', b.speech_forbid || '', b.tier || 'minor', b.abilities_json || '[]', b.exit_note || '', entry.entity_id, bookId);
    } else if (entry.entity_kind === 'location') {
      run(`UPDATE locations SET name=?,card_json=?,state_json='{}',first_chapter=NULL,last_chapter=NULL,
        kind=?,desc=?,stable=?,status='normal',note='',admin_level=?,strategic=? WHERE id=? AND book_id=?`,
      b.name || '', b.card_json || '{}', b.kind || '', b.desc || '', Number(b.stable) ? 1 : 0,
      b.admin_level || '', b.strategic || '', entry.entity_id, bookId);
    } else if (entry.entity_kind === 'item') {
      run(`UPDATE items SET name=?,card_json=?,state_json='{}',owner=?,first_chapter=NULL,last_chapter=NULL
        WHERE id=? AND book_id=?`, b.name || '', b.card_json || '{}', b.owner || '', entry.entity_id, bookId);
    } else if (entry.entity_kind === 'faction') {
      run(`UPDATE factions SET name=?,card_json=?,state_json='{}',first_chapter=NULL,last_chapter=NULL
        WHERE id=? AND book_id=?`, b.name || '', b.card_json || '{}', entry.entity_id, bookId);
    }
  }
  return { cleared: deleteTables, baselines: baselines.length, throughChapter: through };
}

/** 生成当前全书快照数据（章节+场景正文） */
export function snapshotBook(bookId) {
  const chapters = all('SELECT id, volume_id, idx, title, status, word_count, outline_json, created_at FROM chapters WHERE book_id=? ORDER BY idx', bookId);
  return {
    chapters: chapters.map(c => ({
      id: c.id, volume_id: c.volume_id, idx: c.idx, title: c.title, status: c.status,
      word_count: c.word_count, outline_json: c.outline_json, created_at: c.created_at,
      scenes: all(`SELECT id, idx, pov, location, beat, content, target_words, status, history_seq
        FROM scenes WHERE chapter_id=? ORDER BY idx`, c.id),
    })),
    opening_assets: all('SELECT * FROM opening_assets WHERE book_id=? ORDER BY created_at,id', bookId),
  };
}

function invalidSnapshot(message) {
  const error = new Error(`无效快照：${message}`);
  error.code = 'INVALID_SNAPSHOT';
  return error;
}

function validateSnapshot(data, bookId) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.chapters) || data.chapters.length === 0) {
    throw invalidSnapshot('chapters 必须是非空数组');
  }
  const chapterIndexes = new Set();
  for (const chapter of data.chapters) {
    if (!chapter || typeof chapter !== 'object' || !Number.isInteger(chapter.idx) || chapter.idx < 1) {
      throw invalidSnapshot('章节 idx 必须是正整数');
    }
    if (chapterIndexes.has(chapter.idx)) throw invalidSnapshot(`章节 idx ${chapter.idx} 重复`);
    chapterIndexes.add(chapter.idx);
    if (!Array.isArray(chapter.scenes)) throw invalidSnapshot(`第 ${chapter.idx} 章 scenes 必须是数组`);
    const sceneIndexes = new Set();
    for (const scene of chapter.scenes) {
      if (!scene || typeof scene !== 'object' || !Number.isInteger(scene.idx) || scene.idx < 1) {
        throw invalidSnapshot(`第 ${chapter.idx} 章场景 idx 必须是正整数`);
      }
      if (sceneIndexes.has(scene.idx)) throw invalidSnapshot(`第 ${chapter.idx} 章场景 idx ${scene.idx} 重复`);
      sceneIndexes.add(scene.idx);
    }
  }
  let openingAssets = null;
  if (owns(data, 'opening_assets')) {
    if (!Array.isArray(data.opening_assets)) throw invalidSnapshot('opening_assets 必须是数组');
    const ids = new Set();
    let activeReaderLayers = 0;
    for (const asset of data.opening_assets) {
      if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string' || !asset.id) throw invalidSnapshot('opening asset 缺少 id');
      if (ids.has(asset.id)) throw invalidSnapshot(`opening asset id ${asset.id} 重复`);
      ids.add(asset.id);
      if (asset.book_id !== bookId) throw invalidSnapshot(`opening asset ${asset.id} 不属于目标作品`);
      if (!OPENING_KINDS.has(asset.kind) || !OPENING_PLACEMENTS.has(asset.placement) || !OPENING_STATUSES.has(asset.status)) {
        throw invalidSnapshot(`opening asset ${asset.id} 枚举无效`);
      }
      for (const field of ['contract_json', 'audit_json', 'rank_json']) {
        try { JSON.parse(asset[field] || '{}'); } catch { throw invalidSnapshot(`opening asset ${asset.id} 的 ${field} 无效`); }
      }
      if (['selected', 'applied'].includes(asset.status) && OPENING_READER_PLACEMENTS.has(asset.placement)) activeReaderLayers++;
    }
    if (activeReaderLayers > 1) throw invalidSnapshot('opening_assets 存在多个 active reader layer');
    openingAssets = data.opening_assets;
  }
  return { chapters: data.chapters, openingAssets };
}

function owns(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function availableSnapshotId(table, candidate, prefix) {
  if (typeof candidate === 'string' && candidate.trim() && !get(`SELECT id FROM ${table} WHERE id=?`, candidate)) {
    return candidate;
  }
  return uid(prefix);
}

function validSnapshotVolume(bookId, volumeId) {
  if (typeof volumeId !== 'string' || !volumeId) return null;
  return get('SELECT id FROM volumes WHERE id=? AND book_id=?', volumeId, bookId)?.id || null;
}

function removeSceneWithHistory(bookId, scene) {
  if (scene?.history_seq != null) run('DELETE FROM history WHERE book_id=? AND seq=?', bookId, scene.history_seq);
  run('DELETE FROM scenes WHERE id=?', scene.id);
}

/** 删除章节以及所有以 chapter_id/ref_id 指向它的派生数据，避免无外键旧库留下孤儿。 */
function removeChapterGraph(bookId, chapterId) {
  for (const scene of all('SELECT id, history_seq FROM scenes WHERE chapter_id=?', chapterId)) {
    if (scene.history_seq != null) run('DELETE FROM history WHERE book_id=? AND seq=?', bookId, scene.history_seq);
  }
  for (const table of ['scenes', 'chapter_summaries', 'chapter_settlements', 'conflicts', 'timeline', 'chapter_health']) {
    run(`DELETE FROM ${table} WHERE chapter_id=?`, chapterId);
  }
  // 成本日志属于审计记录，不删除费用；仅解除已经不存在的章节引用。
  run('UPDATE usage_logs SET chapter_id=NULL WHERE book_id=? AND chapter_id=?', bookId, chapterId);
  run("DELETE FROM vectors WHERE book_id=? AND ref_id=? AND kind IN ('chapter','summary')", bookId, chapterId);
  run('DELETE FROM chapters WHERE id=? AND book_id=?', chapterId, bookId);
}

/**
 * 从快照恢复章节/场景正文。
 * - 整个同步变更位于一个事务内；
 * - 已存在行按卷内位置原位更新，只回写快照正文状态字段，保留稳定 ID/结构元数据；
 * - 快照外章节连同派生引用一并清理。
 */
export function restoreSnapshot(bookId, data) {
  const { chapters: snapshotChapters, openingAssets: snapshotOpeningAssets } = validateSnapshot(data, bookId);
  if (!get('SELECT id FROM books WHERE id=?', bookId)) throw invalidSnapshot('目标作品不存在');
  if (snapshotOpeningAssets) {
    for (const asset of snapshotOpeningAssets) {
      const collision = get('SELECT book_id FROM opening_assets WHERE id=?', asset.id);
      if (collision && collision.book_id !== bookId) throw invalidSnapshot(`opening asset id ${asset.id} 已被其他作品占用`);
    }
  }

  return transaction(() => {
    const keptChapterIds = new Set();
    let restoredScenes = 0;

    for (const snapshotChapter of snapshotChapters) {
      let chapter = get('SELECT * FROM chapters WHERE book_id=? AND idx=?', bookId, snapshotChapter.idx);
      let chapterId;
      if (chapter) {
        chapterId = chapter.id;
        const sets = [];
        const values = [];
        for (const [key, column] of [
          ['title', 'title'], ['status', 'status'], ['word_count', 'word_count'], ['outline_json', 'outline_json'],
        ]) {
          if (owns(snapshotChapter, key)) {
            sets.push(`${column}=?`);
            values.push(snapshotChapter[key]);
          }
        }
        if (sets.length) run(`UPDATE chapters SET ${sets.join(',')} WHERE id=?`, ...values, chapterId);
      } else {
        chapterId = availableSnapshotId('chapters', snapshotChapter.id, 'ch');
        const outlineJson = owns(snapshotChapter, 'outline_json')
          ? (typeof snapshotChapter.outline_json === 'string' ? snapshotChapter.outline_json : JSON.stringify(snapshotChapter.outline_json || {}))
          : '{}';
        run(`INSERT INTO chapters
          (id,book_id,volume_id,idx,title,outline_json,status,word_count,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        chapterId,
        bookId,
        validSnapshotVolume(bookId, snapshotChapter.volume_id),
        snapshotChapter.idx,
        owns(snapshotChapter, 'title') ? snapshotChapter.title : '',
        outlineJson,
        owns(snapshotChapter, 'status') ? snapshotChapter.status : 'planned',
        owns(snapshotChapter, 'word_count') ? snapshotChapter.word_count : 0,
        Number.isInteger(snapshotChapter.created_at) ? snapshotChapter.created_at : Date.now());
        chapter = get('SELECT * FROM chapters WHERE id=?', chapterId);
      }
      keptChapterIds.add(chapterId);

      const existingScenes = all('SELECT * FROM scenes WHERE chapter_id=? ORDER BY idx', chapterId);
      const existingByIdx = new Map(existingScenes.map(scene => [scene.idx, scene]));
      const keptSceneIds = new Set();
      for (const snapshotScene of snapshotChapter.scenes) {
        const scene = existingByIdx.get(snapshotScene.idx);
        if (scene) {
          const sets = [];
          const values = [];
          for (const [key, column] of [['content', 'content'], ['status', 'status']]) {
            if (owns(snapshotScene, key)) {
              sets.push(`${column}=?`);
              values.push(snapshotScene[key]);
            }
          }
          if (sets.length) run(`UPDATE scenes SET ${sets.join(',')} WHERE id=?`, ...values, scene.id);
          if (owns(snapshotScene, 'content') && scene.history_seq != null) {
            run('UPDATE history SET role=?, content=? WHERE book_id=? AND seq=?',
              'assistant', snapshotScene.content, bookId, scene.history_seq);
          }
          keptSceneIds.add(scene.id);
        } else {
          const sceneId = availableSnapshotId('scenes', snapshotScene.id, 'sc');
          const wantedHistorySeq = Number.isInteger(snapshotScene.history_seq)
            && get('SELECT seq FROM history WHERE book_id=? AND seq=?', bookId, snapshotScene.history_seq)
            ? snapshotScene.history_seq : null;
          run(`INSERT INTO scenes
            (id,chapter_id,idx,pov,location,beat,content,target_words,status,history_seq)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
          sceneId,
          chapterId,
          snapshotScene.idx,
          owns(snapshotScene, 'pov') ? snapshotScene.pov : '',
          owns(snapshotScene, 'location') ? snapshotScene.location : '',
          owns(snapshotScene, 'beat') ? snapshotScene.beat : '',
          owns(snapshotScene, 'content') ? snapshotScene.content : '',
          owns(snapshotScene, 'target_words') ? snapshotScene.target_words : 1000,
          owns(snapshotScene, 'status') ? snapshotScene.status : 'planned',
          wantedHistorySeq);
          keptSceneIds.add(sceneId);
        }
        restoredScenes++;
      }
      for (const scene of existingScenes) {
        if (!keptSceneIds.has(scene.id)) removeSceneWithHistory(bookId, scene);
      }
    }

    let deletedChapters = 0;
    for (const chapter of all('SELECT id FROM chapters WHERE book_id=?', bookId)) {
      if (keptChapterIds.has(chapter.id)) continue;
      removeChapterGraph(bookId, chapter.id);
      deletedChapters++;
    }
    let restoredOpeningAssets = null;
    if (snapshotOpeningAssets) {
      run('DELETE FROM opening_assets WHERE book_id=?', bookId);
      for (const asset of snapshotOpeningAssets) {
        run(`INSERT INTO opening_assets
          (id,book_id,kind,placement,title,anchor_scene_id,anchor_start,anchor_end,source_excerpt,source_hash,
           content,contract_json,audit_json,rank_json,creative_hypothesis,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        asset.id, bookId, asset.kind, asset.placement, asset.title || '', asset.anchor_scene_id || null,
        asset.anchor_start ?? null, asset.anchor_end ?? null, asset.source_excerpt || '', asset.source_hash || '',
        asset.content || '', serializeOpeningJson(asset.contract_json || '{}', {}),
        serializeOpeningJson(asset.audit_json || '{}', {}), serializeOpeningJson(asset.rank_json || '{}', {}),
        asset.creative_hypothesis || '', asset.status,
        Number.isInteger(asset.created_at) ? asset.created_at : Date.now(),
        Number.isInteger(asset.updated_at) ? asset.updated_at : Date.now());
      }
      restoredOpeningAssets = snapshotOpeningAssets.length;
    }
    return { restoredChapters: keptChapterIds.size, restoredScenes, deletedChapters, restoredOpeningAssets };
  });
}

export const books = {
  list() {
    return all('SELECT * FROM books ORDER BY updated_at DESC');
  },
  get(id) { return get('SELECT * FROM books WHERE id = ?', id); },
  create({ title, genre = '玄幻', blurb = '', platform = '通用', settings = {}, perspective = 'third', era = '{}' }) {
    const id = uid('bk');
    const now = Date.now();
    // V0.42：叙述视角（third=第三人称 / first=第一人称主角）；V0.82：era 朝代配置
    run('INSERT INTO books (id, title, genre, blurb, platform, perspective, era, created_at, updated_at, settings_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, title, genre, blurb, platform, perspective, typeof era === 'string' ? era : JSON.stringify(era || {}), now, now, JSON.stringify(settings));
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    if (patch.settings) next.settings_json = JSON.stringify(patch.settings);
    if (patch.era !== undefined) next.era = typeof patch.era === 'string' ? patch.era : JSON.stringify(patch.era || {});
    run('UPDATE books SET title=?, genre=?, blurb=?, platform=?, perspective=?, era=?, settings_json=?, updated_at=? WHERE id=?',
      next.title, next.genre, next.blurb, next.platform || '通用', next.perspective || 'third', next.era, next.settings_json, Date.now(), id);
    return this.get(id);
  },
  remove(id) {
    // scenes 无 book_id 列，先按章删除
    const chIds = all('SELECT id FROM chapters WHERE book_id=?', id).map(r => r.id);
    for (const cid of chIds) run('DELETE FROM scenes WHERE chapter_id=?', cid);
    for (const t of ['history', 'chapters', 'volumes', 'facts', 'characters', 'locations', 'items',
      'factions', 'foreshadows', 'worldbook', 'chapter_summaries', 'conflicts', 'timeline', 'usage_logs',
      'vectors', 'pending_entities', 'public_materials', 'rolling_summaries', 'chapter_settlements',
      // V0.16/V0.17 新增表
      'chapter_health', 'book_archives', 'book_constraints', 'pleasure_hooks', 'story_arcs', 'snapshots',
      // V0.41：卷审阅记录与操作日志一并清理（此前遗留孤儿数据）
      'volume_reviews', 'operation_logs',
      // V0.80：契约承诺账本
      'contract_promises',
      // V0.82：史实事件锚点
      'era_events',
      // V0.98：开篇候选/读者前置层
      'opening_assets',
      // V0.99：推流反馈、数据快照与前 20 章返工账本
      'recommendation_reviews', 'publication_metrics', 'recommendation_recovery_runs', 'publication_profiles',
      // V0.100：同版派生状态、结构签名、学习账本与实体设计态
      'narrative_revisions', 'chapter_projections', 'narrative_patterns', 'narrative_lessons',
      'narrative_entity_baselines']) {
      run(`DELETE FROM ${t} WHERE book_id = ?`, id);
    }
    run('DELETE FROM books WHERE id = ?', id);
  },
  settings(id) {
    const b = this.get(id);
    return b ? (JSON.parse(b.settings_json || '{}') || {}) : {};
  },
};

// ---------- 公共材料 ----------
export const materials = {
  all(bookId) {
    return all('SELECT * FROM public_materials WHERE book_id = ? ORDER BY kind', bookId);
  },
  get(bookId, kind) {
    return get('SELECT * FROM public_materials WHERE book_id = ? AND kind = ?', bookId, kind);
  },
  /** 写入公共材料。返回 {version, cacheRebuilt} */
  set(bookId, kind, content) {
    const cur = this.get(bookId, kind);
    const now = Date.now();
    if (cur) {
      run('UPDATE public_materials SET content=?, version=version+1, updated_at=? WHERE book_id=? AND kind=?',
        content, now, bookId, kind);
      return { version: cur.version + 1, cacheRebuilt: content !== cur.content };
    }
    run('INSERT INTO public_materials (book_id, kind, content, version, updated_at) VALUES (?,?,?,1,?)',
      bookId, kind, content, now);
    return { version: 1, cacheRebuilt: true };
  },
};

// ---------- 卷 / 章 / 场景 ----------
export const volumes = {
  list(bookId) { return all('SELECT * FROM volumes WHERE book_id = ? ORDER BY idx', bookId); },
  get(id) { return get('SELECT * FROM volumes WHERE id = ?', id); },
  create(bookId, idx, data = {}) {
    const id = uid('vol');
    run('INSERT INTO volumes (id, book_id, idx, title, goal, outline_json, status) VALUES (?,?,?,?,?,?,?)',
      id, bookId, idx, data.title || '', data.goal || '', JSON.stringify(data.outline || {}), data.status || 'planned');
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    if (patch.title !== undefined) { sets.push('title=?'); vals.push(patch.title); }
    if (patch.goal !== undefined) { sets.push('goal=?'); vals.push(patch.goal); }
    if (patch.outline !== undefined) { sets.push('outline_json=?'); vals.push(JSON.stringify(patch.outline)); }
    if (patch.status !== undefined) { sets.push('status=?'); vals.push(patch.status); }
    if (patch.summary !== undefined) { sets.push('summary=?'); vals.push(patch.summary); }
    if (sets.length) { vals.push(id); run(`UPDATE volumes SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  remove(id) {
    const vs = this.get(id);
    if (vs) {
      const chs = chapters.listByVolume(id);
      for (const c of chs) chapters.remove(c.id);
      run('DELETE FROM volumes WHERE id=?', id);
    }
  },
};

export const chapters = {
  list(bookId) { return all('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx', bookId); },
  listByVolume(volumeId) { return all('SELECT * FROM chapters WHERE volume_id = ? ORDER BY idx', volumeId); },
  get(id) { return get('SELECT * FROM chapters WHERE id = ?', id); },
  count(bookId) { return get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', bookId).n; },
  create(bookId, volumeId, idx, data = {}) {
    const id = uid('ch');
    const now = Date.now();
    const wordCount = data.wordCount ?? data.word_count ?? 0;
    run('INSERT INTO chapters (id, book_id, volume_id, idx, title, outline_json, status, word_count, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, bookId, volumeId || null, idx, data.title || '', JSON.stringify(data.outline || {}), data.status || 'planned', wordCount, now);
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    if (patch.title !== undefined) { sets.push('title=?'); vals.push(patch.title); }
    if (patch.outline !== undefined) { sets.push('outline_json=?'); vals.push(JSON.stringify(patch.outline)); }
    if (patch.status !== undefined) { sets.push('status=?'); vals.push(patch.status); }
    const wordCount = patch.wordCount ?? patch.word_count;
    if (wordCount !== undefined) { sets.push('word_count=?'); vals.push(wordCount); }
    if (sets.length) { vals.push(id); run(`UPDATE chapters SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  remove(id) {
    run('DELETE FROM scenes WHERE chapter_id=?', id);
    run('DELETE FROM chapter_summaries WHERE chapter_id=?', id);
    run('DELETE FROM chapters WHERE id=?', id);
  },
  outline(id) {
    const c = this.get(id);
    return c ? (JSON.parse(c.outline_json || '{}') || {}) : null;
  },
  /** 章全文（按场景拼接） */
  fullText(id) {
    const scs = scenes.list(id);
    return scs.map(s => s.content).filter(Boolean).join('\n\n');
  },
};

export const scenes = {
  list(chapterId) { return all('SELECT * FROM scenes WHERE chapter_id = ? ORDER BY idx', chapterId); },
  get(id) { return get('SELECT * FROM scenes WHERE id = ?', id); },
  remove(id) { run('DELETE FROM scenes WHERE id = ?', id); },
  create(chapterId, idx, data = {}) {
    const id = uid('sc');
    // V0.83：scene_type 列（细纲场景类型持久化）；V0.95：pacing 列（场景节奏标注）
    run('INSERT INTO scenes (id, chapter_id, idx, pov, location, beat, content, target_words, status, scene_type, pacing) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, chapterId, idx, data.pov || '', data.location || '', data.beat || '', data.content || '',
      data.targetWords || 1000, data.status || 'planned', data.sceneType || '', data.pacing || '');
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    for (const [k, col] of [['pov', 'pov'], ['location', 'location'], ['beat', 'beat'], ['content', 'content'], ['status', 'status'], ['targetWords', 'target_words'], ['historySeq', 'history_seq'], ['sceneType', 'scene_type'], ['pacing', 'pacing']]) {
      if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]); }
    }
    if (sets.length) { vals.push(id); run(`UPDATE scenes SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  clear(chapterId) { run('DELETE FROM scenes WHERE chapter_id=?', chapterId); },
};

// ---------- 历史堆 ----------
export const history = {
  list(bookId) { return all('SELECT role, content FROM history WHERE book_id = ? ORDER BY seq', bookId); },
  listFrom(bookId, fromSeq) { return all('SELECT seq, role, content FROM history WHERE book_id=? AND seq>=? ORDER BY seq', bookId, fromSeq); },
  count(bookId) { return get('SELECT COUNT(*) AS n FROM history WHERE book_id = ?', bookId).n; },
  append(bookId, role, content) {
    const seq = this.lastSeq(bookId) + 1;
    run('INSERT INTO history (book_id, seq, role, content) VALUES (?,?,?,?)', bookId, seq, role, content);
    return seq;
  },
  /** 替换指定 seq 的消息（修订场景用；调用方需提示缓存重建代价）。V0.70：返回影响行数（0 = 目标不存在，调用方应回退 append） */
  replace(bookId, seq, role, content) {
    const r = run('UPDATE history SET role=?, content=? WHERE book_id=? AND seq=?', role, content, bookId, seq);
    return r.changes || 0;
  },
  /** 删除 seq >= fromSeq 的消息（回滚当前章尾部）；V0.43 记录缓存重建原因 */
  truncateFrom(bookId, fromSeq, reason = '') {
    run('DELETE FROM history WHERE book_id=? AND seq>=?', bookId, fromSeq);
    if (reason) {
      try {
        operationLogs.add({ ts: Date.now(), category: 'cache', level: 'info', op: 'rebuild', detail: `truncateFrom ${fromSeq}：${reason}`, bookId });
      } catch { /* ignore */ }
    }
  },
  lastSeq(bookId) {
    const r = get('SELECT MAX(seq) AS n FROM history WHERE book_id=?', bookId);
    return r ? r.n || 0 : 0;
  },
};

// ---------- 事实库 ----------
export const facts = {
  list(bookId, { status } = {}) {
    // 同一章批量抽取时多条记录经常共享毫秒时间戳；rowid 作为稳定的写入顺序兜底。
    if (status) return all('SELECT * FROM facts WHERE book_id=? AND status=? ORDER BY created_at DESC, rowid DESC', bookId, status);
    return all('SELECT * FROM facts WHERE book_id=? ORDER BY created_at DESC, rowid DESC', bookId);
  },
  active(bookId) { return this.list(bookId, { status: 'active' }); },
  recent(bookId, { status = 'active', limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 50));
    return all('SELECT * FROM facts WHERE book_id=? AND status=? ORDER BY created_at DESC, rowid DESC LIMIT ?', bookId, status, safeLimit);
  },
  get(id) { return get('SELECT * FROM facts WHERE id=?', id); },
  create(bookId, { subject, predicate, object, sourceChapter, note = '' }) {
    const id = uid('fct');
    run('INSERT INTO facts (id, book_id, subject, predicate, object, source_chapter, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, bookId, subject, predicate, object, sourceChapter || null, 'active', note, Date.now());
    return this.get(id);
  },
  /** 标记旧事实为 superseded（新事实覆盖旧事实） */
  supersede(oldId, newId) {
    if (newId) run('UPDATE facts SET status=?, note=note || ? WHERE id=?', 'superseded', ` superseded_by=${newId}`, oldId);
    else run('UPDATE facts SET status=? WHERE id=?', 'superseded', oldId);
  },
  setStatus(id, status) { run('UPDATE facts SET status=? WHERE id=?', status, id); },
};

// ---------- 角色/地点/物品/势力 ----------
const entityCols = ['id', 'book_id', 'name', 'card_json', 'state_json', 'first_chapter', 'last_chapter', 'created_at'];

function makeEntityApi(table) {
  return {
    list(bookId) { return all(`SELECT * FROM ${table} WHERE book_id=? ORDER BY created_at`, bookId); },
    get(id) { return get(`SELECT * FROM ${table} WHERE id=?`, id); },
    // V0.93.5：实体卡建卡支持章节锚点（待登记实体转正时写入 first/last_chapter）
    create(bookId, { name, card = {}, state = {}, firstChapter, lastChapter }) {
      const id = uid('ent');
      const now = Date.now();
      run(`INSERT INTO ${table} (id, book_id, name, card_json, state_json, first_chapter, last_chapter, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        id, bookId, name, JSON.stringify(card), JSON.stringify(state),
        firstChapter ?? null, lastChapter ?? null, now);
      return this.get(id);
    },
    update(id, patch) {
      const cur = this.get(id); if (!cur) return null;
      const sets = []; const vals = [];
      if (patch.name !== undefined) { sets.push('name=?'); vals.push(patch.name); }
      if (patch.card !== undefined) { sets.push('card_json=?'); vals.push(JSON.stringify(patch.card)); }
      if (patch.state !== undefined) { sets.push('state_json=?'); vals.push(JSON.stringify(patch.state)); }
      if (patch.firstChapter !== undefined) { sets.push('first_chapter=?'); vals.push(patch.firstChapter); }
      if (patch.lastChapter !== undefined) { sets.push('last_chapter=?'); vals.push(patch.lastChapter); }
      if (sets.length) { vals.push(id); run(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`, ...vals); }
      return this.get(id);
    },
    remove(id) { run(`DELETE FROM ${table} WHERE id=?`, id); },
  };
}

const baseCharacters = makeEntityApi('characters');
// V0.37：角色生命周期扩展（deceased 退场标记 + 死亡章节）——仅 characters 表有这些列
// V0.49：角色弧光维度列（personality/goal/fear/secret/arc/relation）结构化读写
// V0.50：分级 tier / 能力 abilities / 退出 exitNote
export const characters = {
  ...baseCharacters,
  create(bookId, { name, card = {}, state = {}, firstChapter, personality = '', goal = '', fear = '', secret = '', arc = '', relation = '', speech = '', speechForbid = '', tier = 'minor', abilities = [], exitNote = '' }) {
    const id = uid('ch');
    run('INSERT INTO characters (id, book_id, name, card_json, state_json, first_chapter, personality, goal, fear, secret, arc, relation, speech, speech_forbid, tier, abilities_json, exit_note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, bookId, name, JSON.stringify(card), JSON.stringify(state), firstChapter ?? null, personality, goal, fear, secret, arc, relation, speech, speechForbid, tier, JSON.stringify(abilities), exitNote, Date.now());
    return this.get(id);
  },
  update(id, patch) {
    const cur = baseCharacters.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    if (patch.deceased !== undefined) { sets.push('deceased=?'); vals.push(patch.deceased ? 1 : 0); }
    if (patch.deathChapter !== undefined) { sets.push('death_chapter=?'); vals.push(patch.deathChapter); }
    // V0.49：弧光维度列；V0.101：说话/禁腔
    for (const col of ['personality', 'goal', 'fear', 'secret', 'arc', 'relation', 'speech']) {
      if (patch[col] !== undefined) { sets.push(`${col}=?`); vals.push(patch[col]); }
    }
    if (patch.speechForbid !== undefined) { sets.push('speech_forbid=?'); vals.push(patch.speechForbid); }
    if (patch.speech_forbid !== undefined && patch.speechForbid === undefined) {
      sets.push('speech_forbid=?'); vals.push(patch.speech_forbid);
    }
    // V0.50：分级/能力/退出
    if (patch.tier !== undefined) { sets.push('tier=?'); vals.push(patch.tier); }
    if (patch.abilities !== undefined) { sets.push('abilities_json=?'); vals.push(JSON.stringify(patch.abilities)); }
    if (patch.exitNote !== undefined) { sets.push('exit_note=?'); vals.push(patch.exitNote); }
    if (sets.length) { vals.push(id); run(`UPDATE characters SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return baseCharacters.update(id, patch);
  },
  /** 已退场角色（死亡）列表 */
  deceasedList(bookId) {
    return all('SELECT * FROM characters WHERE book_id=? AND deceased=1 ORDER BY death_chapter', bookId);
  },
};
// V0.71：地点库扩展（kind 类型/desc 描述/stable 稳定性/status 状态/note 变化记录）
const baseLocations = makeEntityApi('locations');
export const locations = {
  ...baseLocations,
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    if (patch.name !== undefined) { sets.push('name=?'); vals.push(patch.name); }
    if (patch.card !== undefined) { sets.push('card_json=?'); vals.push(JSON.stringify(patch.card)); }
    if (patch.state !== undefined) { sets.push('state_json=?'); vals.push(JSON.stringify(patch.state)); }
    if (patch.firstChapter !== undefined) { sets.push('first_chapter=?'); vals.push(patch.firstChapter); }
    if (patch.lastChapter !== undefined) { sets.push('last_chapter=?'); vals.push(patch.lastChapter); }
    for (const col of ['kind', 'desc', 'status', 'note']) {
      if (patch[col] !== undefined) { sets.push(`${col}=?`); vals.push(patch[col]); }
    }
    // V0.82：历史题材地点库——行政层级/战略属性（路/州/县/寨/堡 + 三江汇流/锁江天堑）
    for (const col of ['adminLevel', 'strategic']) {
      if (patch[col] !== undefined) { sets.push(`${col.replace(/[A-Z]/, m => '_' + m.toLowerCase())}=?`); vals.push(patch[col]); }
    }
    if (patch.stable !== undefined) { sets.push('stable=?'); vals.push(patch.stable ? 1 : 0); }
    if (sets.length) { vals.push(id); run(`UPDATE locations SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
};
export const items = makeEntityApi('items');
export const factions = makeEntityApi('factions');

// ---------- 伏笔 ----------
export const foreshadows = {
  list(bookId, { status } = {}) {
    if (status) return all('SELECT * FROM foreshadows WHERE book_id=? AND status=? ORDER BY created_at', bookId, status);
    return all('SELECT * FROM foreshadows WHERE book_id=? ORDER BY created_at', bookId);
  },
  get(id) { return get('SELECT * FROM foreshadows WHERE id=?', id); },
  create(bookId, { desc, type = '剧情伏笔', plantedChapter, advanceChapters = [], payoffChapter, status = 'planted', importance = 'medium', note = '', events = [] }) {
    const id = uid('fs');
    run('INSERT INTO foreshadows (id, book_id, desc, type, planted_chapter, advance_chapters, payoff_chapter, status, importance, note, events_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, bookId, desc, type, plantedChapter || null, JSON.stringify(advanceChapters), payoffChapter || null,
      status, importance, note, JSON.stringify(events), Date.now());
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    const map = { desc: 'desc', type: 'type', plantedChapter: 'planted_chapter', payoffChapter: 'payoff_chapter',
      status: 'status', importance: 'importance', note: 'note' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]); }
    }
    if (patch.advanceChapters !== undefined) { sets.push('advance_chapters=?'); vals.push(JSON.stringify(patch.advanceChapters)); }
    if (patch.events !== undefined) { sets.push('events_json=?'); vals.push(JSON.stringify(patch.events)); }
    if (sets.length) { vals.push(id); run(`UPDATE foreshadows SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  /** 追加一条事件流水（章级推进记录） */
  appendEvent(id, chapter, note) {
    const cur = this.get(id); if (!cur) return this.get(id);
    let events = [];
    try { events = JSON.parse(cur.events_json || '[]'); } catch { events = []; }
    events.push({ chapter, note: note || '' });
    run('UPDATE foreshadows SET events_json=? WHERE id=?', JSON.stringify(events), id);
    return this.get(id);
  },
  /** 活跃伏笔：已埋设未回收（planted/advanced），按重要性排序 */
  active(bookId) {
    return all("SELECT * FROM foreshadows WHERE book_id=? AND status IN ('planted','advanced') ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at", bookId);
  },
  /** 遗忘预警：超过 payoff+容忍章数仍未回收 */
  forgotten(bookId, currentChapter, tolerance = 10) {
    return all("SELECT * FROM foreshadows WHERE book_id=? AND status IN ('planted','advanced') AND payoff_chapter IS NOT NULL AND ? > payoff_chapter + ?",
      bookId, currentChapter, tolerance);
  },
  /** 临近回收：距回收章 ≤2 章（注入"可开始收束"提示） */
  approachingPayoff(bookId, currentChapter, window = 2) {
    return all("SELECT * FROM foreshadows WHERE book_id=? AND status IN ('planted','advanced') AND payoff_chapter IS NOT NULL AND payoff_chapter >= ? AND payoff_chapter - ? <= ?",
      bookId, currentChapter, window, currentChapter);
  },
  remove(id) { run('DELETE FROM foreshadows WHERE id=?', id); },
};

// ---------- 滚动摘要（全书进度，动态注入尾部） ----------
export const rollingSummaries = {
  get(bookId) { return get('SELECT * FROM rolling_summaries WHERE book_id=?', bookId)?.content || ''; },
  set(bookId, content) {
    const cur = get('SELECT book_id FROM rolling_summaries WHERE book_id=?', bookId);
    if (cur) run('UPDATE rolling_summaries SET content=?, updated_at=? WHERE book_id=?', content, Date.now(), bookId);
    else run('INSERT INTO rolling_summaries (book_id, content, updated_at) VALUES (?,?,?)', bookId, content, Date.now());
  },
};

// ---------- 世界书 ----------
export const worldbook = {
  list(bookId, { enabledOnly = false } = {}) {
    if (enabledOnly) return all('SELECT * FROM worldbook WHERE book_id=? AND enabled=1 ORDER BY priority DESC, created_at', bookId);
    return all('SELECT * FROM worldbook WHERE book_id=? ORDER BY priority DESC, created_at', bookId);
  },
  get(id) { return get('SELECT * FROM worldbook WHERE id=?', id); },
  create(bookId, { keywords = [], content, priority = 0, category = '通用' }) {
    const id = uid('wb');
    run('INSERT INTO worldbook (id, book_id, keywords, content, priority, category, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)',
      id, bookId, JSON.stringify(keywords), content, priority, category, Date.now());
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    const map = { content: 'content', priority: 'priority', category: 'category' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]); }
    }
    if (patch.keywords !== undefined) { sets.push('keywords=?'); vals.push(JSON.stringify(patch.keywords)); }
    if (patch.enabled !== undefined) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0); }
    if (sets.length) { vals.push(id); run(`UPDATE worldbook SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  remove(id) { run('DELETE FROM worldbook WHERE id=?', id); },
};

// ---------- V0.28 操作日志 ----------
export const operationLogs = {
  add({ ts, category, level, op, detail, bookId, durationMs, result }) {
    run('INSERT INTO operation_logs (ts, category, level, op, detail, book_id, duration_ms, result) VALUES (?,?,?,?,?,?,?,?)',
      ts ?? Date.now(), category || 'api', level || 'info', op || '', detail || '', bookId ?? null, durationMs ?? null, result ?? 'ok');
  },
  list({ category, level, bookId, limit = 500, offset = 0 } = {}) {
    const where = []; const vals = [];
    if (category) { where.push('category=?'); vals.push(category); }
    if (level) { where.push('level=?'); vals.push(level); }
    if (bookId) { where.push('book_id=?'); vals.push(bookId); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return {
      items: all(`SELECT * FROM operation_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...vals, limit, offset),
      total: get(`SELECT COUNT(*) AS c FROM operation_logs ${w}`, ...vals)?.c || 0,
    };
  },
  count() { return get('SELECT COUNT(*) AS c FROM operation_logs')?.c || 0; },
  trimOldest(n) { run('DELETE FROM operation_logs WHERE id IN (SELECT id FROM operation_logs ORDER BY id ASC LIMIT ?)', n); },
  clear() { run('DELETE FROM operation_logs'); },
};

// ---------- 摘要 / 冲突 / 时间线 ----------
export const summaries = {
  get(chapterId) { return get('SELECT * FROM chapter_summaries WHERE chapter_id=?', chapterId); },
  set(chapterId, bookId, summary) {
    const cur = this.get(chapterId);
    if (cur) run('UPDATE chapter_summaries SET summary=?, updated_at=? WHERE chapter_id=?', summary, Date.now(), chapterId);
    else run('INSERT INTO chapter_summaries (chapter_id, book_id, summary, updated_at) VALUES (?,?,?,?)', chapterId, bookId, summary, Date.now());
  },
  list(bookId) { return all('SELECT * FROM chapter_summaries WHERE book_id=? ORDER BY updated_at', bookId); },
  // V0.86 修复：此前 summaries 无 remove——rewriteOpening/rewriteChapterRange 调 store.summaries.remove
  // 抛 TypeError 被 try/catch 吞掉 → 重写章节的摘要从未清除（旧摘要污染重写后的正文上下文）
  remove(chapterId) { run('DELETE FROM chapter_summaries WHERE chapter_id=?', chapterId); },
};

export const chapterSettlements = {
  get(chapterId) {
    const row = get('SELECT * FROM chapter_settlements WHERE chapter_id=?', chapterId);
    if (!row) return undefined;
    let result = {};
    try { result = JSON.parse(row.result_json || '{}'); } catch { /* 保留空结果 */ }
    return { ...row, result };
  },
  set(bookId, chapterId, { contentHash, result }) {
    run(`INSERT INTO chapter_settlements (chapter_id, book_id, content_hash, result_json, created_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(chapter_id) DO UPDATE SET
        book_id=excluded.book_id,
        content_hash=excluded.content_hash,
        result_json=excluded.result_json,
        created_at=excluded.created_at`,
    chapterId, bookId, contentHash, JSON.stringify(result || {}), Date.now());
    return this.get(chapterId);
  },
  remove(chapterId) { run('DELETE FROM chapter_settlements WHERE chapter_id=?', chapterId); },
  clearBook(bookId) { run('DELETE FROM chapter_settlements WHERE book_id=?', bookId); },
};

export const conflicts = {
  list(bookId) { return all('SELECT * FROM conflicts WHERE book_id=? ORDER BY created_at DESC', bookId); },
  create(bookId, { chapterId, type = '设定冲突', quote = '', issue = '' }) {
    const id = uid('cfl');
    run('INSERT INTO conflicts (id, book_id, chapter_id, type, quote, issue, resolution, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, bookId, chapterId || null, type, quote, issue, 'open', Date.now());
    return get('SELECT * FROM conflicts WHERE id=?', id);
  },
  resolve(id, resolution) { run('UPDATE conflicts SET resolution=? WHERE id=?', resolution, id); },
  /**
   * 场景恢复/修订成功后的自动核销：
   * - 章节所有场景均完整时，生成失败类债务已经失效；
   * - 带原文引用的冲突若引用已不在最终正文中，说明修订已经删除了问题证据。
   * 空引用的事实债务不做武断处理，仍留给审校或人工确认；
   * 完成章遗留的「质量门未通过」已过时，随完成态核销。
   */
  resolveRecoveredChapter(chapterId, chapterText = '') {
    const chapter = chapters.get(chapterId);
    if (!chapter) return 0;
    const text = String(chapterText || chapters.fullText(chapterId));
    const rows = all("SELECT * FROM conflicts WHERE chapter_id=? AND resolution='open'", chapterId);
    const sceneRows = scenes.list(chapterId);
    const complete = sceneRows.length > 0
      && sceneRows.every(scene => ['done', 'revised'].includes(scene.status) && String(scene.content || '').trim());
    let resolved = 0;
    for (const row of rows) {
      const recoveryFailure = /生成失败|生成中断|流式中断/.test(row.type || '')
        || /STREAM_INCOMPLETE|场景生成结果为空|生成中断|章细纲返回空/.test(row.issue || '');
      const staleQualityGate = complete && /质量门未通过/.test(row.type || '');
      const quoteRemoved = String(row.quote || '').trim() && !text.includes(String(row.quote).trim());
      if ((complete && recoveryFailure) || staleQualityGate || quoteRemoved) {
        run('UPDATE conflicts SET resolution=? WHERE id=?',
          (complete && recoveryFailure) || staleQualityGate ? 'auto_recovered' : 'auto_fixed_quote_removed', row.id);
        resolved++;
      }
    }
    return resolved;
  },
  // V0.60 防屎山：删除指定章节之前的所有债务（圆场窗口已过，保留无意义）
  // V0.70 修复：chapter_id 是 TEXT UUID、传参是 INTEGER idx，直接 `chapter_id < ?` 恒 false → 清理从未生效。
  // 改为 JOIN chapters 取 idx 比较
  pruneBefore(bookId, chapterIdx) {
    const r = run(`DELETE FROM conflicts WHERE book_id=? AND chapter_id IN (SELECT id FROM chapters WHERE idx < ?)`,
      bookId, chapterIdx);
    // V0.95：全局债（chapter_id IS NULL——契约承诺未兑现/卷体检 ch=0 工单）此前永久残留，
    // 300 章后 conflicts 表被全局债堆满、UI/体检噪声。全局债无章锚点无法按章龄归档，
    // 改为保留上限兜底：open 全局债超过 20 条时删最老的（正常流应被 resolve/人工处理）。
    let pruned = 0;
    const stale = all(`SELECT id FROM conflicts WHERE book_id=? AND chapter_id IS NULL AND resolution='open' ORDER BY created_at DESC LIMIT -1 OFFSET 20`, bookId);
    for (const row of stale) {
      run('DELETE FROM conflicts WHERE id=?', row.id);
      pruned++;
    }
    return (r.changes || 0) + pruned;
  },
  // V0.60：删除指定类型债务（存量清理用）
  removeByType(bookId, type) {
    const r = run('DELETE FROM conflicts WHERE book_id=? AND type=?', bookId, type);
    return r.changes || 0;
  },
};

export const timeline = {
  list(bookId) { return all('SELECT * FROM timeline WHERE book_id=? ORDER BY seq', bookId); },
  add(bookId, { chapterId, event, year, eraYear, season }) {
    const max = get('SELECT MAX(seq) AS n FROM timeline WHERE book_id=?', bookId);
    const seq = (max ? max.n : 0) + 1;
    // V0.82：历史纪年列（year 公元年 / era_year 年号纪年 / season 季节）
    run('INSERT INTO timeline (id, book_id, chapter_id, seq, event, year, era_year, season, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      uid('tl'), bookId, chapterId || null, seq, event, year || null, eraYear || '', season || '', Date.now());
  },
  remove(id) { run('DELETE FROM timeline WHERE id=?', id); }, // V0.83：开篇重写清理旧时间线
};

// V0.82：史实事件锚点（era_context.real_events 结构化落库，供"已过/未到史实节点"边界注入）
export const eraEvents = {
  list(bookId) { return all('SELECT * FROM era_events WHERE book_id=? ORDER BY year', bookId); },
  clear(bookId) { run('DELETE FROM era_events WHERE book_id=?', bookId); },
  add(bookId, { year, eraYear, event, note = '' }) {
    run('INSERT INTO era_events (book_id, year, era_year, event, note, created_at) VALUES (?,?,?,?,?,?)',
      bookId, year || null, eraYear || '', event || '', note || '', Date.now());
  },
  /** 根据当前故事公元年返回史实边界注入文本：已过节点（不可改前因）+ 未到节点（不得提前发生） */
  boundaryText(bookId, currentYear) {
    const rows = this.list(bookId);
    if (!rows.length) return '';
    const y = Number(currentYear);
    const passed = rows.filter(r => r.year !== null && (y ? r.year < y : false)).slice(-4);
    const upcoming = rows.filter(r => r.year !== null && (y ? r.year >= y : true)).slice(0, 4);
    const parts = [];
    if (passed.length) parts.push(`已过史实节点（不得改写前因）：${passed.map(r => `${r.era_year || r.year}·${r.event}`).join('；')}`);
    if (upcoming.length) parts.push(`未到史实节点（不得提前发生）：${upcoming.map(r => `${r.era_year || r.year}·${r.event}`).join('；')}`);
    return parts.join('\n');
  },
};

// ---------- V0.93.10 历史人物档案（登场窗/官职/立场/结局；era_context.figures 落库） ----------
export const historicalFigures = {
  list(bookId) {
    return all('SELECT * FROM historical_figures WHERE book_id=? ORDER BY first_year', bookId).map(row => ({
      ...row,
      aliases: (() => { try { return JSON.parse(row.aliases_json || '[]'); } catch { return []; } })(),
    }));
  },
  clear(bookId) { run('DELETE FROM historical_figures WHERE book_id=?', bookId); },
  add(bookId, { name, aliases = [], firstYear, deathYear, office = '', stance = '', constraint = '', alterable = '', source = 'era_context' }) {
    if (!name) return;
    run('INSERT INTO historical_figures (book_id, name, aliases_json, first_year, death_year, office, stance, constraint_text, alterable, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      bookId, name, JSON.stringify(aliases || []), firstYear ?? null, deathYear ?? null, office, stance, constraint, alterable, source, Date.now());
  },
};

// ---------- 用量日志（成本面板） ----------
export const usageLogs = {
  add({ bookId, chapterId, task, model, promptHit, promptMiss, completion, cost, costIfMiss, durationMs, estimated = 0, extra = {} }) {
    run('INSERT INTO usage_logs (ts, book_id, chapter_id, task, model, prompt_hit, prompt_miss, completion, cost, cost_if_miss, duration_ms, estimated, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      Date.now(), bookId || null, chapterId || null, task || '', model || '', promptHit || 0, promptMiss || 0,
      completion || 0, cost || 0, costIfMiss || 0, durationMs || 0, estimated ? 1 : 0, JSON.stringify(extra));
    // 保留最近 5000 条，避免无限增长
    const cnt = get('SELECT COUNT(*) AS n FROM usage_logs').n;
    if (cnt > 5000) run('DELETE FROM usage_logs WHERE id IN (SELECT id FROM usage_logs ORDER BY id ASC LIMIT ?)', cnt - 5000);
  },
  list({ bookId, limit = 200 } = {}) {
    if (bookId) return all('SELECT * FROM usage_logs WHERE book_id=? ORDER BY ts DESC LIMIT ?', bookId, limit);
    return all('SELECT * FROM usage_logs ORDER BY ts DESC LIMIT ?', limit);
  },
  aggregate({ bookId } = {}) {
    // V0.84：命中率统计剔除两类行——estimated（估算，无真实 usage 数据）与 noCacheData（端点未上报缓存字段，
    // 不是"100% miss"而是"无前缀缓存能力"）——此前这两类行被当全 miss 拖低命中率（归零/忽低假象）
    const where = bookId ? 'WHERE book_id=?' : '';
    const params = bookId ? [bookId] : [];
    const row = get(`SELECT COUNT(*) AS calls,
        SUM(CASE WHEN estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1 THEN prompt_hit ELSE 0 END) AS total_hit,
        SUM(CASE WHEN estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1 THEN prompt_miss ELSE 0 END) AS total_miss,
        SUM(completion) AS total_completion,
        SUM(cost) AS total_cost, SUM(cost_if_miss) AS total_cost_if_miss, SUM(duration_ms) AS total_ms
        FROM usage_logs ${where}`, ...params);
    const byTask = all(`SELECT task, model, COUNT(*) AS calls,
        SUM(CASE WHEN estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1 THEN prompt_hit ELSE 0 END) AS hit,
        SUM(CASE WHEN estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1 THEN prompt_miss ELSE 0 END) AS miss,
        SUM(completion) AS completion, SUM(cost) AS cost, SUM(cost_if_miss) AS cost_if_miss
        FROM usage_logs ${where} GROUP BY task, model`, ...params);
    // V0.43：按章节命中率（归因 miss 来源；JOIN chapters 拿 idx/title）
    const byChapter = bookId
      ? all(`SELECT u.chapter_id, c.idx AS chapter_idx, c.title AS chapter_title,
          COUNT(*) AS calls,
          SUM(CASE WHEN u.estimated=0 AND json_extract(u.extra,'$.noCacheData') IS NOT 1 THEN u.prompt_hit ELSE 0 END) AS hit,
          SUM(CASE WHEN u.estimated=0 AND json_extract(u.extra,'$.noCacheData') IS NOT 1 THEN u.prompt_miss ELSE 0 END) AS miss,
          SUM(u.completion) AS completion, SUM(u.cost) AS cost
          FROM usage_logs u LEFT JOIN chapters c ON c.id = u.chapter_id
          WHERE u.book_id=? GROUP BY u.chapter_id ORDER BY miss DESC LIMIT 30`, bookId)
      : [];
    // V0.69：按天聚合（趋势图数据——费用/命中率；V0.84 同样剔除 estimated/noCacheData）
    const byDay = all(`SELECT date(ts/1000,'unixepoch','localtime') AS day,
        COUNT(*) AS calls,
        SUM(CASE WHEN estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1 THEN prompt_hit ELSE 0 END) AS hit,
        SUM(CASE WHEN estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1 THEN prompt_miss ELSE 0 END) AS miss,
        SUM(completion) AS completion,
        SUM(cost) AS cost
        FROM usage_logs ${where} GROUP BY day ORDER BY day`, ...params);
    // V0.93.6：近期命中率口径——取最近 500 条原始记录过滤后（剔除 estimated/noCacheData），
    // 反映"当前创作状态"的真实命中率。全量累计会被历史旧版本运行（如 08-07 注入未限流期）
    // 稀释成假象，近期口径才是缓存健康度的实时仪表。
    // V0.93.6：近期命中率口径——最近 500 条**有效**调用（先剔除 estimated/noCacheData 再截窗），
    // 反映"当前创作状态"的真实命中率。全量累计会被历史旧版本运行（如 08-07 注入未限流期）
    // 稀释成假象，近期口径才是缓存健康度的实时仪表。
    const recentWhere = bookId
      ? `estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1 AND book_id=?`
      : `estimated=0 AND json_extract(extra,'$.noCacheData') IS NOT 1`;
    const recentRow = get(`SELECT COUNT(*) AS calls,
        SUM(prompt_hit) AS hit, SUM(prompt_miss) AS miss
        FROM (SELECT prompt_hit, prompt_miss FROM usage_logs WHERE ${recentWhere} ORDER BY ts DESC LIMIT 500)`, ...params);
    const r = row || {};
    const totalTokens = (r.total_hit || 0) + (r.total_miss || 0);
    const rHit = recentRow?.hit || 0, rMiss = recentRow?.miss || 0, rTokens = rHit + rMiss;
    return {
      calls: r.calls || 0,
      totalHit: r.total_hit || 0,
      totalMiss: r.total_miss || 0,
      totalCompletion: r.total_completion || 0,
      hitRatio: totalTokens > 0 ? (r.total_hit || 0) / totalTokens : 0,
      // V0.93.6：近期（最近 500 条原始记录内有效调用）命中率
      recentCalls: recentRow?.calls || 0,
      recentHit: rHit,
      recentMiss: rMiss,
      recentHitRatio: rTokens > 0 ? rHit / rTokens : 0,
      cost: r.total_cost || 0,
      costIfMiss: r.total_cost_if_miss || 0,
      saving: Math.max(0, (r.total_cost_if_miss || 0) - (r.total_cost || 0)),
      durationMs: r.total_ms || 0,
      byTask,
      byChapter,
      byDay,
    };
  },
};

// ---------- 向量 ----------
export const vectors = {
  list(bookId, kind) {
    if (kind) return all('SELECT * FROM vectors WHERE book_id=? AND kind=?', bookId, kind);
    return all('SELECT * FROM vectors WHERE book_id=?', bookId);
  },
  clear(bookId) { run('DELETE FROM vectors WHERE book_id=?', bookId); },
  add(bookId, { kind, refId, chunk, embedding }) {
    run('INSERT INTO vectors (book_id, kind, ref_id, chunk, embedding_json, created_at) VALUES (?,?,?,?,?,?)',
      bookId, kind || 'chapter', refId || null, chunk, JSON.stringify(embedding), Date.now());
  },
  count(bookId) { return get('SELECT COUNT(*) AS n FROM vectors WHERE book_id=?', bookId).n; },
  /** V0.95：按引用删除（增量索引幂等重建单章向量） */
  removeByRef(bookId, kind, refId) {
    run('DELETE FROM vectors WHERE book_id=? AND kind=? AND ref_id=?', bookId, kind || 'chapter', refId || null);
  },
};

// ---------- 待登记实体 ----------
export const pendingEntities = {
  list(bookId) { return all('SELECT * FROM pending_entities WHERE book_id=? AND status=? ORDER BY created_at', bookId, 'pending'); },
  /** V0.40：全量（含已处理记录，供前端展示状态） */
  listAll(bookId, { limit = 100 } = {}) {
    return all('SELECT * FROM pending_entities WHERE book_id=? ORDER BY created_at DESC LIMIT ?', bookId, limit);
  },
  add(bookId, { name, context, sourceChapter }) {
    // V0.40：同名待登记再次出现 → 合并上下文 + 计数（强信号），类型推断与建卡统一由
    // tidyPendingEntities 在章结算时执行（此前无条件建角色卡，物品/地点被误建成角色）
    const dup = get('SELECT * FROM pending_entities WHERE book_id=? AND name=? AND status=?', bookId, name, 'pending');
    if (dup) {
      const merged = [dup.context, context].filter(Boolean).join('；').slice(0, 300);
      run('UPDATE pending_entities SET context=?, dup_count=COALESCE(dup_count,1)+1 WHERE id=?', merged, dup.id);
      return dup;
    }
    run('INSERT INTO pending_entities (book_id, name, context, source_chapter, status, dup_count, created_at) VALUES (?,?,?,?,?,1,?)',
      bookId, name, context || '', sourceChapter || null, 'pending', Date.now());
    return get('SELECT * FROM pending_entities WHERE book_id=? AND name=? AND status=?', bookId, name, 'pending');
  },
  /** V0.40：标记处理结果（status + 备注） */
  markResolved(id, status, note = '') {
    run('UPDATE pending_entities SET status=?, note=? WHERE id=?', status, note, id);
  },
  resolve(id, status) { run('UPDATE pending_entities SET status=? WHERE id=?', status, id); },
};

// ---------- 章节健康快照（漂移检测） ----------
export const chapterHealth = {
  add({ bookId, chapterId, idx, verdict = 'ok', issues = 0, highIssues = 0, replanCount = 0, failed = 0, wordCount = 0, notes = '' }) {
    run('INSERT INTO chapter_health (book_id, chapter_id, idx, verdict, issues, high_issues, replan_count, failed, word_count, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      bookId, chapterId || null, idx, verdict, issues, highIssues, replanCount, failed ? 1 : 0, wordCount || 0, notes || '', Date.now());
    return get('SELECT * FROM chapter_health WHERE id=last_insert_rowid()');
  },
  /** 每个真实章节只保留一条当前健康状态；chapterId 为空的全局/测试信号仍按事件追加。 */
  upsert(data) {
    if (!data.chapterId) return this.add(data);
    const cur = get('SELECT * FROM chapter_health WHERE book_id=? AND chapter_id=? ORDER BY id DESC LIMIT 1', data.bookId, data.chapterId);
    if (!cur) return this.add(data);
    run(`UPDATE chapter_health SET idx=?, verdict=?, issues=?, high_issues=?, replan_count=?, failed=?, word_count=?, notes=?, created_at=? WHERE id=?`,
      data.idx ?? cur.idx,
      data.verdict ?? cur.verdict,
      data.issues ?? cur.issues,
      data.highIssues ?? cur.high_issues,
      data.replanCount ?? cur.replan_count,
      data.failed ? 1 : 0,
      data.wordCount ?? cur.word_count,
      // 空串表示本轮没有失败说明：清掉旧纯文本错误；快感/吸引力门写入的 JSON 仍保留。
      (data.notes != null && data.notes !== '')
        ? data.notes
        : (/^\s*[\[{]/.test(cur.notes || '') ? (cur.notes || '') : ''),
      Date.now(),
      cur.id);
    return get('SELECT * FROM chapter_health WHERE id=?', cur.id);
  },
  list(bookId, { limit = 20 } = {}) {
    return all('SELECT * FROM chapter_health WHERE book_id=? ORDER BY idx DESC LIMIT ?', bookId, limit);
  },
  recent(bookId, n = 3) {
    // 兼容旧库：真实章节曾在每次重跑时追加多行，这里只取每章最新一行；
    // chapter_id 为空的是独立系统信号，仍逐条保留。
    return all(`SELECT * FROM chapter_health
      WHERE book_id=? AND (
        chapter_id IS NULL OR id IN (
          SELECT MAX(id) FROM chapter_health WHERE book_id=? AND chapter_id IS NOT NULL GROUP BY chapter_id
        )
      ) ORDER BY idx DESC, id DESC LIMIT ?`, bookId, bookId, n);
  },
  count(bookId) { return get('SELECT COUNT(*) AS n FROM chapter_health WHERE book_id=?', bookId).n; },
  getByChapter(chapterId) { return get('SELECT * FROM chapter_health WHERE chapter_id=? ORDER BY id DESC LIMIT 1', chapterId) || null; },
  removeByChapter(chapterId) {
    const r = run('DELETE FROM chapter_health WHERE chapter_id=?', chapterId);
    return r.changes || 0;
  },
  update(id, patch) {
    const cur = get('SELECT * FROM chapter_health WHERE id=?', id); if (!cur) return null;
    const sets = []; const vals = [];
    const map = { verdict: 'verdict', issues: 'issues', highIssues: 'high_issues', replanCount: 'replan_count', failed: 'failed', wordCount: 'word_count', notes: 'notes' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]); }
    }
    if (sets.length) { vals.push(id); run(`UPDATE chapter_health SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return get('SELECT * FROM chapter_health WHERE id=?', id);
  },
};

// ---------- 归档批次（上下文压缩） ----------
export const archives = {
  list(bookId) { return all('SELECT * FROM book_archives WHERE book_id=? ORDER BY batch', bookId); },
  last(bookId) { return get('SELECT * FROM book_archives WHERE book_id=? ORDER BY batch DESC LIMIT 1', bookId) || null; },
  add(bookId, { batch, rangeStart, rangeEnd, summaryJson, tokensSaved }) {
    run('INSERT INTO book_archives (id, book_id, batch, range_start, range_end, summary_json, tokens_saved, created_at) VALUES (?,?,?,?,?,?,?,?)',
      uid('ar'), bookId, batch, rangeStart, rangeEnd, JSON.stringify(summaryJson), tokensSaved || 0, Date.now());
  },
};

// ---------- 全局约束反哺 ----------
export const constraints = {
  list(bookId, { activeOnly = true } = {}) {
    if (activeOnly) return all('SELECT * FROM book_constraints WHERE book_id=? AND active=1 ORDER BY created_at', bookId);
    return all('SELECT * FROM book_constraints WHERE book_id=? ORDER BY created_at DESC', bookId);
  },
  // V0.97.2：内容去重之外增加 scope + stable key。相同 key 的新判断会核销旧判断，
  // 防止“角色下一章死亡”和“角色继续服役”同时成为永久写作命令。
  add(bookId, {
    content, source = 'recovery', key = '', constraintKey = '',
    scopeStart = null, scopeEnd = null,
  }) {
    const body = String(content || '').trim();
    if (!body) throw new TypeError('constraint content must not be empty');
    const stableKey = String(constraintKey || key || '').trim();
    const scopeNumber = value => value === null || value === undefined || value === ''
      ? null
      : (Number.isInteger(Number(value)) ? Number(value) : null);
    const start = scopeNumber(scopeStart);
    const end = scopeNumber(scopeEnd);
    if (start !== null && end !== null && end < start) {
      throw new RangeError(`constraint scope_end ${end} < scope_start ${start}`);
    }
    const exact = stableKey
      ? get(`SELECT id FROM book_constraints
        WHERE book_id=? AND constraint_key=? AND content=? AND active=1
          AND COALESCE(scope_start,-1)=COALESCE(?,-1) AND COALESCE(scope_end,-1)=COALESCE(?,-1)`,
        bookId, stableKey, body, start, end)
      : get('SELECT id FROM book_constraints WHERE book_id=? AND content=? AND active=1', bookId, body);
    if (exact) return exact.id;
    const id = uid('ct');
    transaction(() => {
      if (stableKey) {
        run(`UPDATE book_constraints SET active=0, superseded_by=?
          WHERE book_id=? AND constraint_key=? AND active=1`, id, bookId, stableKey);
      }
      run(`INSERT INTO book_constraints
        (id, book_id, content, source, active, scope_start, scope_end, constraint_key, superseded_by, created_at)
        VALUES (?,?,?,?,1,?,?,?,?,?)`, id, bookId, body, source, start, end, stableKey, '', Date.now());
    });
    return id;
  },
  text(bookId) {
    return this.list(bookId, { activeOnly: true }).map(c => `- ${c.content}`).join('\n');
  },
  /**
   * V0.73 缓存+质量修复：写作注入用的限流约束文本。
   * 全局约束（recovery/user，数量少且长期有效）始终保留；
   * 逐章反馈约束（pleasure/polish，会无限累积）只取最近 limit 条，
   * 并整体截断到 maxChars（防止 400+ 条累积约束把 write 指令撑到数十万 tokens、
   * 缓存尾部全 miss、模型被过时指令干扰）。
   * @returns {string} 裁剪后的约束文本（每行一条，'- ' 前缀）
   */
  recentText(bookId, { limit = 12, maxChars = 3000, chapterIdx = null } = {}) {
    const rows = this.list(bookId, { activeOnly: true }); // created_at ASC
    const current = Number.isInteger(Number(chapterIdx)) ? Number(chapterIdx) : null;
    const ephemeralSources = new Set(['recovery', 'pleasure', 'polish', 'batch_scan', 'length_floor']);
    const hasScope = row => (row.scope_start !== null && row.scope_start !== undefined)
      || (row.scope_end !== null && row.scope_end !== undefined);
    const inScope = row => {
      if (current === null) return true; // 管理/诊断兼容：无章节坐标时展示全部活动项
      if (hasScope(row)) {
        const start = row.scope_start === null || row.scope_start === undefined ? -Infinity : Number(row.scope_start);
        const end = row.scope_end === null || row.scope_end === undefined ? Infinity : Number(row.scope_end);
        return current >= start && current <= end;
      }
      if (row.source === 'user') return true;
      // fail closed：旧 recovery/逐章反馈没有生命周期，不能再猜成全书永久铁律。
      return !ephemeralSources.has(row.source);
    };
    const eligible = rows.filter(inScope);
    const globals = eligible.filter(row => row.source === 'user' || !hasScope(row));
    const scopedNewest = eligible.filter(hasScope)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, limit);
    const candidates = [...globals, ...scopedNewest];
    const seen = new Set();
    const ordered = [];
    for (const row of candidates) {
      const normalized = String(row.content || '').replace(/[\s，。！？；：、]/g, '');
      const dedupeKey = row.constraint_key || normalized;
      if (!normalized || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      ordered.push(row);
    }
    const budget = Math.max(0, Number(maxChars) || 0);
    if (!budget) return '';
    let text = '';
    for (const row of ordered) {
      const line = `- ${row.content}`;
      const separator = text ? '\n' : '';
      if (text.length + separator.length + line.length <= budget) {
        text += separator + line;
        continue;
      }
      // 第一条本身超限时保留可识别前缀；其余情况不截断下一条命令。
      if (!text) text = line.slice(0, budget);
      break;
    }
    return text;
  },
  deactivate(id) { run('UPDATE book_constraints SET active=0 WHERE id=?', id); },
};

// ---------- V0.17 快感引擎：期待-满足账本 ----------
export const pleasureHooks = {
  list(bookId, { status } = {}) {
    if (status) return all('SELECT * FROM pleasure_hooks WHERE book_id=? AND status=? ORDER BY planted_chapter', bookId, status);
    return all('SELECT * FROM pleasure_hooks WHERE book_id=? ORDER BY planted_chapter', bookId);
  },
  get(id) { return get('SELECT * FROM pleasure_hooks WHERE id=?', id); },
  create(bookId, { desc, kind = 'short', type = '悬念钩', plantedChapter, dueChapter, status = 'open', intensity = 3, lastProgressChapter = null, note = '' }) {
    const id = uid('ph');
    run('INSERT INTO pleasure_hooks (id, book_id, desc, kind, type, planted_chapter, due_chapter, status, intensity, last_progress_chapter, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, bookId, desc, kind, type, plantedChapter || 0, dueChapter || null, status, intensity, lastProgressChapter, note || '', Date.now());
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    const map = { desc: 'desc', kind: 'kind', type: 'type', plantedChapter: 'planted_chapter', dueChapter: 'due_chapter',
      status: 'status', intensity: 'intensity', lastProgressChapter: 'last_progress_chapter', note: 'note' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]); }
    }
    if (sets.length) { vals.push(id); run(`UPDATE pleasure_hooks SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  /** 开放且未超期过久的活跃钩子（注入细纲/正文用） */
  active(bookId) {
    return all("SELECT * FROM pleasure_hooks WHERE book_id=? AND status IN ('open','progressing','confirmed') ORDER BY kind, planted_chapter", bookId);
  },
  /** 超期未兑现（due 已过且无进度确认） */
  expired(bookId, currentChapter, tolerance = 3) {
    return all("SELECT * FROM pleasure_hooks WHERE book_id=? AND status IN ('open') AND due_chapter IS NOT NULL AND ? > due_chapter + ?", bookId, currentChapter, tolerance);
  },
  remove(id) { run('DELETE FROM pleasure_hooks WHERE id=?', id); },
};

// ---------- V0.17 快感引擎：并行叙事弧线 ----------
export const storyArcs = {
  list(bookId, { status } = {}) {
    if (status) return all('SELECT * FROM story_arcs WHERE book_id=? AND status=? ORDER BY opened_chapter', bookId, status);
    return all('SELECT * FROM story_arcs WHERE book_id=? ORDER BY opened_chapter', bookId);
  },
  get(id) { return get('SELECT * FROM story_arcs WHERE id=?', id); },
  create(bookId, { name, type = '支线', status = 'opening', openedChapter, targetChapter, note = '' }) {
    const id = uid('arc');
    run('INSERT INTO story_arcs (id, book_id, name, type, status, opened_chapter, target_chapter, last_active_chapter, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, bookId, name, type, status, openedChapter || 0, targetChapter || null, openedChapter || 0, note || '', Date.now());
    return this.get(id);
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    const map = { name: 'name', type: 'type', status: 'status', openedChapter: 'opened_chapter', targetChapter: 'target_chapter',
      lastActiveChapter: 'last_active_chapter', note: 'note' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]); }
    }
    if (sets.length) { vals.push(id); run(`UPDATE story_arcs SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  /** 未闭合弧线（并行 3-5 条） */
  open(bookId, currentChapter = null) {
    if (Number.isInteger(currentChapter)) {
      return all("SELECT * FROM story_arcs WHERE book_id=? AND status != 'closed' AND opened_chapter <= ? ORDER BY opened_chapter", bookId, currentChapter);
    }
    return all("SELECT * FROM story_arcs WHERE book_id=? AND status != 'closed' ORDER BY opened_chapter", bookId);
  },
  /** 长期无进展的弧线（需要回填提醒） */
  stale(bookId, currentChapter, tolerance = 8) {
    return all("SELECT * FROM story_arcs WHERE book_id=? AND status != 'closed' AND opened_chapter <= ? AND last_active_chapter IS NOT NULL AND ? > last_active_chapter + ?", bookId, currentChapter, currentChapter, tolerance);
  },
  remove(id) { run('DELETE FROM story_arcs WHERE id=?', id); },
};

// ---------- V0.95 叙事记忆库（人物声音/承诺/道具细节/名场面/关系里程碑——文学质感的结构化载体） ----------
export const memoryEntries = {
  list(bookId, { category, chapterGte } = {}) {
    if (category) return all('SELECT * FROM memory_entries WHERE book_id=? AND category=? ORDER BY chapter DESC, id DESC', bookId, category);
    if (Number.isInteger(chapterGte)) return all('SELECT * FROM memory_entries WHERE book_id=? AND chapter>=? ORDER BY chapter DESC, id DESC', bookId, chapterGte);
    return all('SELECT * FROM memory_entries WHERE book_id=? ORDER BY chapter DESC, id DESC', bookId);
  },
  count(bookId) { return get('SELECT COUNT(*) AS n FROM memory_entries WHERE book_id=?', bookId).n; },
  create(bookId, { category, name = '', content, chapter }) {
    const r = run('INSERT INTO memory_entries (book_id, category, name, content, chapter, created_at) VALUES (?,?,?,?,?,?)',
      bookId, category, String(name || '').slice(0, 40), String(content || '').slice(0, 80).trim(), Number(chapter) || 0, Date.now());
    return r.changes ? this.lastInsert() : null;
  },
  lastInsert() { return get('SELECT * FROM memory_entries WHERE id = last_insert_rowid()'); },
  removeByChapter(bookId, chapter) { run('DELETE FROM memory_entries WHERE book_id=? AND chapter=?', bookId, chapter); },
  /** 预算裁剪：保留最新 budget 条（零 LLM 降级路径） */
  pruneToBudget(bookId, budget) {
    const total = this.count(bookId);
    if (total <= budget) return 0;
    const keepIds = new Set(all('SELECT id FROM memory_entries WHERE book_id=? ORDER BY chapter DESC, id DESC LIMIT ?', bookId, budget).map(r => r.id));
    let removed = 0;
    for (const row of all('SELECT id FROM memory_entries WHERE book_id=?', bookId)) {
      if (!keepIds.has(row.id)) { run('DELETE FROM memory_entries WHERE id=?', row.id); removed++; }
    }
    return removed;
  },
};

// ---------- V0.80 契约承诺账本（书契约"前N章承诺"结构化落库 + 到期校验） ----------
export const contractPromises = {
  list(bookId, { status } = {}) {
    if (status) return all('SELECT * FROM contract_promises WHERE book_id=? AND status=? ORDER BY due_chapter', bookId, status);
    return all('SELECT * FROM contract_promises WHERE book_id=? ORDER BY due_chapter', bookId);
  },
  get(id) { return get('SELECT * FROM contract_promises WHERE id=?', id); },
  /** 幂等 upsert：同书同承诺文本只保留一条（UNIQUE(book_id,text)） */
  upsert(bookId, { text, dueChapter, status = 'open', note = '' }) {
    const exist = get('SELECT * FROM contract_promises WHERE book_id=? AND text=?', bookId, text);
    if (exist) {
      run('UPDATE contract_promises SET due_chapter=?, status=?, note=? WHERE id=?',
        dueChapter ?? exist.due_chapter, status ?? exist.status, note || exist.note, exist.id);
      return this.get(exist.id);
    }
    run('INSERT INTO contract_promises (book_id, text, due_chapter, status, checked_chapter, fulfilled_chapter, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
      bookId, text, dueChapter || null, status, null, null, note || '', Date.now());
    const row = get('SELECT * FROM contract_promises WHERE book_id=? AND text=?', bookId, text);
    return row;
  },
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const sets = []; const vals = [];
    const map = { dueChapter: 'due_chapter', status: 'status', checkedChapter: 'checked_chapter', fulfilledChapter: 'fulfilled_chapter', note: 'note' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=?`); vals.push(patch[k]); }
    }
    if (sets.length) { vals.push(id); run(`UPDATE contract_promises SET ${sets.join(',')} WHERE id=?`, ...vals); }
    return this.get(id);
  },
  /** 到期未核对的承诺（供 checkPromiseFulfillment 逐批处理） */
  due(bookId, currentChapter) {
    return all("SELECT * FROM contract_promises WHERE book_id=? AND status='open' AND due_chapter IS NOT NULL AND due_chapter <= ? AND (checked_chapter IS NULL OR checked_chapter < ?)",
      bookId, currentChapter, currentChapter);
  },
  remove(id) { run('DELETE FROM contract_promises WHERE id=?', id); },
};

// ---------- 备份 ----------
/**
 * 使用 SQLite Online Backup API 生成一致性快照。
 * 直接复制 WAL 模式下的 novel.db 可能遗漏仍在 -wal 文件里的提交，不能作为可靠备份。
 */
export async function backup({
  directory = DATA_DIR,
  filename,
  prefix = 'backup_',
  retention = 10,
  skipIfExists = false,
} = {}) {
  const targetDir = path.resolve(directory);
  const stamp = new Date().toISOString().replace(/\D/g, '');
  const targetName = filename || `${prefix}${stamp}.db`;
  if (!targetName || path.basename(targetName) !== targetName || !targetName.toLowerCase().endsWith('.db')) {
    throw new Error('backup filename 必须是目标目录内的 .db 文件名');
  }
  if (!prefix || path.basename(prefix) !== prefix || /[\\/]/.test(prefix)) {
    throw new Error('backup prefix 含非法路径字符');
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const dest = path.resolve(targetDir, targetName);
  const rel = path.relative(targetDir, dest);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('backup path 超出目标目录');
  }
  if (skipIfExists && fs.existsSync(dest)) return dest;
  if (fs.existsSync(dest)) throw new Error(`backup already exists: ${targetName}`);

  // 先写临时文件并校验，再原子改名，避免中断后留下看似成功的残缺快照。
  const temp = path.join(targetDir, `.${targetName}.${randomUUID()}.tmp.db`);
  try {
    await sqliteBackup(db(), temp);
    const snapshot = new DatabaseSync(temp, { readOnly: true });
    try {
      const check = snapshot.prepare('PRAGMA integrity_check').get();
      if (check?.integrity_check !== 'ok') throw new Error(`backup integrity_check failed: ${check?.integrity_check || 'unknown'}`);
    } finally {
      snapshot.close();
    }
    fs.renameSync(temp, dest);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }

  const keep = Math.max(1, Math.min(1000, Number(retention) || 10));
  const backups = fs.readdirSync(targetDir)
    .filter(name => name.startsWith(prefix) && name.toLowerCase().endsWith('.db'))
    .map(name => {
      const file = path.join(targetDir, name);
      return { name, file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  while (backups.length > keep) fs.rmSync(backups.shift().file, { force: true });
  return dest;
}

export const volumeReviews = {
  repairLegacyRefs(bookId) {
    const params = bookId ? [bookId] : [];
    const where = bookId ? 'WHERE vr.book_id=?' : '';
    const legacy = all(`SELECT vr.id, v.id AS volume_id
      FROM volume_reviews vr
      JOIN volumes v ON v.book_id=vr.book_id AND v.idx=CAST(vr.volume_id AS INTEGER)
        AND TRIM(CAST(vr.volume_id AS TEXT), '0123456789.')=''
      ${where}`, ...params);
    let repaired = 0;
    for (const row of legacy) {
      const duplicate = get('SELECT id FROM volume_reviews WHERE id<>? AND book_id=(SELECT book_id FROM volume_reviews WHERE id=?) AND volume_id=?',
        row.id, row.id, row.volume_id);
      if (duplicate) {
        run('DELETE FROM volume_reviews WHERE id=?', row.id);
      } else {
        run('UPDATE volume_reviews SET volume_id=? WHERE id=?', row.volume_id, row.id);
      }
      repaired++;
    }
    return repaired;
  },
  upsert(bookId, volumeRef, { grade, report, issues, status = 'done', revisedCount = 0 }) {
    const volumeId = get('SELECT id FROM volumes WHERE book_id=? AND (id=? OR idx=?) ORDER BY id=? DESC LIMIT 1',
      bookId, String(volumeRef), Number(volumeRef), String(volumeRef))?.id || String(volumeRef);
    const prev = get('SELECT * FROM volume_reviews WHERE book_id=? AND volume_id=?', bookId, volumeId);
    const json = (v) => (typeof v === 'string' ? v : JSON.stringify(v || null));
    if (prev) {
      run('UPDATE volume_reviews SET grade=?, report_json=?, issues_json=?, status=?, revised_count=?, created_at=? WHERE id=?',
        grade, json(report), json(issues), status, revisedCount, Date.now(), prev.id);
      return get('SELECT * FROM volume_reviews WHERE id=?', prev.id);
    }
    run('INSERT INTO volume_reviews (book_id, volume_id, grade, report_json, issues_json, status, revised_count, created_at) VALUES (?,?,?,?,?,?,?,?)',
      bookId, volumeId, grade, json(report), json(issues), status, revisedCount, Date.now());
    return get('SELECT * FROM volume_reviews WHERE book_id=? AND volume_id=?', bookId, volumeId);
  },
  list(bookId) { return all('SELECT * FROM volume_reviews WHERE book_id=? ORDER BY volume_id', bookId); },
  byVolume(bookId, volumeRef) {
    const volumeId = get('SELECT id FROM volumes WHERE book_id=? AND (id=? OR idx=?) ORDER BY id=? DESC LIMIT 1',
      bookId, String(volumeRef), Number(volumeRef), String(volumeRef))?.id || String(volumeRef);
    return get('SELECT * FROM volume_reviews WHERE book_id=? AND volume_id=?', bookId, volumeId);
  },
  setStatus(id, status) { run('UPDATE volume_reviews SET status=? WHERE id=?', status, id); },
};
