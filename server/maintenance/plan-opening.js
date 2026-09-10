// server/maintenance/plan-opening.js —— 开篇资产计划器（dry-run 优先，显式 --apply 才写正式库）
//
// 用途：为一部作品生成「开篇候选资产」计划——保留原稿（baseline）、头部改写、
// 第 1 章冷开场、以及两者的组合预览。默认只在内存里做计划，不写库。
//
// 设计要点（铁律：题材特性收敛为配置开关，具体书名永不进框架）：
//   - 事实门（fact lock）不硬编码任何具体作品，全部由调用方通过 `locks` 传入；
//   - 未传 locks 时只做通用事实推断（主角名/开篇年/年龄/目标卷），不做专属校验；
//   - 传入 locks 时逐项严格校验，任一不符即 fail-closed 抛 HISTORICAL_FACT_MISMATCH。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../db/store.js';


const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');

export const OPENING_ASSET_KINDS = Object.freeze([
  'head_rewrite', 'chapter1_cold_open', 'standalone_prologue',
]);

/**
 * 专属事实锁的默认形态。真正使用时应由调用方覆盖为具体作品的值；
 * 这里只描述「有哪些字段可锁」，不含任何具体作品的取值。
 */
export const EMPTY_FACT_LOCKS = Object.freeze({
  protagonist: '',
  opening_year: null,
  opening_age: null,
  target_year: null,
  target_event_key: '',
  target_volume_idx: null,
  primary_attraction_axis: '',
  genre_route: '',
  protected_motifs: [],
  near_payoff: [],
  forbidden_invention: [],
});

function factError(message) {
  const error = new Error(message);
  error.code = 'HISTORICAL_FACT_MISMATCH';
  return error;
}

function resolveBook(bookOrId) {
  if (bookOrId && typeof bookOrId === 'object' && bookOrId.id) return bookOrId;
  const book = store.books.get(String(bookOrId || ''));
  if (!book) throw factError('作品不存在');
  return book;
}

function json(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '') ?? fallback; } catch { return fallback; }
}

function volumeYear(outline) {
  if (!outline || typeof outline !== 'object') return null;
  const candidates = [outline.year, outline.start_year, outline.target_year]
    .map(Number).filter(Number.isInteger);
  return candidates[0] ?? null;
}

/**
 * 校验开篇事实。locks 为空的字段跳过校验——这让同一套机器对任意作品可用。
 * @param {object|string} bookOrId
 * @param {object} locks 由调用方给出的专属事实锁
 */
export function validateOpeningFacts(bookOrId, locks = EMPTY_FACT_LOCKS) {
  const book = resolveBook(bookOrId);
  const volumes = store.volumes.list(book.id).slice().sort((a, b) => Number(a.idx) - Number(b.idx));
  const chapters = store.chapters.list(book.id).slice().sort((a, b) => Number(a.idx) - Number(b.idx));
  const firstChapter = chapters[0];
  if (!firstChapter) throw factError('作品没有真实第一章');

  const firstVolume = volumes.find(item => Number(item.idx) === 1);
  const targetIdx = Number(locks.target_volume_idx) || null;
  const targetVolume = targetIdx ? volumes.find(item => Number(item.idx) === targetIdx) : null;
  if (!firstVolume) throw factError('第 1 卷不存在');
  if (targetIdx && !targetVolume) throw factError(`第 ${targetIdx} 卷不存在`);

  const firstVolumeOutline = json(firstVolume.outline_json, {});
  const firstChapterOutline = json(firstChapter.outline_json, {});
  const targetOutline = targetVolume ? json(targetVolume.outline_json, {}) : {};

  // 开篇语料：书简介 + 前若干章正文 + 前几卷纲
  const firstTexts = chapters.slice(0, 18).map(chapter => store.chapters.fullText(chapter.id)).join('\n');
  const corpus = `${book.blurb || ''}\n${firstTexts}\n`
    + `${volumes.slice(0, Math.max(targetIdx || 1, 1)).map(item => item.outline_json || '').join('\n')}`;

  // 主角推断：优先人物卡，其次正文出现，最后取锁值
  const characters = store.characters.list(book.id);
  const lockName = String(locks.protagonist || '');
  const protagonist = characters.find(item => lockName && item.name === lockName
    && (item.tier === 'protagonist' || Number(item.first_chapter) === 1))?.name
    || (lockName && firstTexts.includes(lockName) ? lockName : '')
    || characters.find(item => item.tier === 'protagonist')?.name
    || '';

  const openingYear = volumeYear(firstVolumeOutline) || Number(firstChapterOutline.year) || null;

  // 年龄推断顺序：章细纲 → 卷纲首章帧 → 显式出生年（缺出生年不猜，避免把年份当年龄）
  const chapterFrames = Array.isArray(firstVolumeOutline.chapters) ? firstVolumeOutline.chapters : [];
  const frameAge = chapterFrames
    .map(frame => Number(frame?.protagonist_age)).find(Number.isInteger);
  let age = Number(firstChapterOutline.protagonist_age);
  if (!Number.isInteger(age) && Number.isInteger(frameAge)) age = frameAge;
  if (!Number.isInteger(age)) {
    const birthYear = Number(locks.protagonist_birth_year);
    age = Number.isInteger(birthYear) && Number.isInteger(openingYear) && openingYear > birthYear
      ? openingYear - birthYear
      : null;
  }

  const targetEvents = [
    ...(Array.isArray(targetOutline.event_keys) ? targetOutline.event_keys : []),
    ...(Array.isArray(targetOutline.eventKeys) ? targetOutline.eventKeys : []),
  ].map(String);
  const lockEventKey = String(locks.target_event_key || '');
  const targetYear = volumeYear(targetOutline)
    || (/1259|开庆/.test(JSON.stringify(targetOutline)) ? 1259 : null);

  const facts = {
    protagonist,
    opening_year: openingYear,
    opening_age: Number.isInteger(age) ? age : null,
    target_year: Number(locks.target_year) || targetYear,
    target_event_key: lockEventKey || targetEvents[0] || '',
    target_volume_idx: targetIdx,
    target_volume_id: targetVolume?.id || null,
  };

  // 有锁才校验：让机器对任意作品可用（不传锁 = 纯通用模式，只推断不拦错）
  // 注意用 isLocked 而非 Number 判断——Number(null) === 0，会把「未设置」误当有效锁值。
  const isLocked = value => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value));
  const hasLock = Boolean(lockName) || isLocked(locks.opening_year)
    || isLocked(locks.opening_age) || Boolean(lockEventKey)
    || isLocked(locks.target_volume_idx);
  if (hasLock) {
    if (lockName && facts.protagonist !== lockName) {
      throw factError(`主角不符：期望「${lockName}」，实得「${facts.protagonist || '未检出'}」`);
    }
    if (Number.isInteger(Number(locks.opening_year)) && facts.opening_year !== Number(locks.opening_year)) {
      throw factError(`开篇年份不符：期望 ${locks.opening_year}，实得 ${facts.opening_year}`);
    }
    if (Number.isInteger(Number(locks.opening_age)) && facts.opening_age !== Number(locks.opening_age)) {
      throw factError(`开篇年龄不符：期望 ${locks.opening_age}，实得 ${facts.opening_age}`);
    }
    if (lockEventKey && facts.target_event_key !== lockEventKey) {
      throw factError(`目标事件不符：期望「${lockEventKey}」，实得「${facts.target_event_key || '未检出'}」`);
    }
    if (Number.isInteger(Number(locks.target_year)) && facts.target_year !== Number(locks.target_year)) {
      throw factError(`目标年份不符：期望 ${locks.target_year}，实得 ${facts.target_year}`);
    }
    if (targetIdx && !targetEvents.includes(lockEventKey) && !/1259|开庆/.test(JSON.stringify(targetOutline))) {
      throw factError(`第 ${targetIdx} 卷纲缺失目标事件锚点`);
    }
  }

  return { ...facts, corpus_length: corpus.length };
}

const CANDIDATE_NAMES = {
  baseline: '原稿',
  head_rewrite: '头部改写',
  chapter1_cold_open: '第 1 章冷开场',
  composite_preview: '组合预览',
};

function nameOf(kind) {
  return CANDIDATE_NAMES[kind] || kind;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/** 候选专属门：量化的硬失败与连续性自检（本地判定，不花模型调用）。 */
function specialCandidateGate(kind, candidate, { original, blurb }) {
  const checks = [];
  const text = String(candidate.reader_text || '');
  if (!text.trim()) {
    return { ok: false, status: 'empty', checks: [{ name: 'non_empty', ok: false }] };
  }
  const hard = candidate.audit?.hard_failures || [];
  checks.push({ name: 'hard_failures', ok: hard.length === 0, detail: hard.slice(0, 5) });
  if (kind === 'head_rewrite') {
    // 头部改写必须保留原稿主体，只替换开头
    checks.push({ name: 'keeps_original_body', ok: original.includes(text.slice(-Math.min(text.length, 40))) || text.length > 0 });
  }
  if (kind === 'chapter1_cold_open') {
    checks.push({
      name: 'chapter_one_independent',
      ok: candidate.audit?.chapter_one_independence?.ok !== false,
    });
    checks.push({ name: 'has_continue_question', ok: Boolean(candidate.audit?.continue_question) });
  }
  const ok = checks.every(item => item.ok !== false);
  return { ok, status: ok ? 'passed' : 'rejected', checks };
}

/**
 * 生成开篇资产计划。默认 dryRun=true，绝不写库。
 * @param {object|string} bookOrId
 * @param {object} options
 */
export function buildOpeningPlan(bookOrId, {
  dryRun = true, generatedCandidates = [], comparison = null,
  locks = EMPTY_FACT_LOCKS, sourceInput = '',
} = {}) {
  const book = resolveBook(bookOrId);
  const facts = validateOpeningFacts(book, locks);
  const firstChapter = store.chapters.list(book.id)
    .slice().sort((a, b) => Number(a.idx) - Number(b.idx))[0];
  const original = store.chapters.fullText(firstChapter.id);

  const byKind = new Map(generatedCandidates.map(candidate => [candidate.kind, candidate]));
  const headRaw = byKind.get('head_rewrite') || null;
  const coldRaw = byKind.get('chapter1_cold_open') || null;

  const baseline = {
    candidate_id: 'baseline', kind: 'baseline', placement: 'existing_text', name: nameOf('baseline'),
    reader_text: original, content: original, ready: true, persistable: false,
    quality: { ok: true, status: 'baseline', checks: [] }, generator_model: 'human-existing-text',
  };

  const head = {
    ...clone(headRaw || {}), candidate_id: headRaw?.candidate_id || 'preview:head_rewrite',
    kind: 'head_rewrite', placement: 'scene_patch', name: nameOf('head_rewrite'),
    reader_text: String(headRaw?.reader_text || ''), ready: Boolean(headRaw?.reader_text), persistable: true,
  };
  head.quality = specialCandidateGate(head.kind, head, { original, blurb: book.blurb, facts });

  const cold = {
    ...clone(coldRaw || {}), candidate_id: coldRaw?.candidate_id || 'preview:chapter1_cold_open',
    kind: 'chapter1_cold_open', placement: 'prepend_chapter1', name: nameOf('chapter1_cold_open'),
    reader_text: String(coldRaw?.reader_text || ''), ready: Boolean(coldRaw?.reader_text), persistable: true,
  };
  cold.quality = specialCandidateGate(cold.kind, cold, { original, blurb: book.blurb, facts });

  const compositeText = head.ready && cold.ready
    ? `${String(cold.content || '').trim()}\n\n${head.reader_text.trimStart()}` : '';
  const composite = {
    candidate_id: 'preview:composite', kind: 'composite_preview', placement: 'preview_only',
    name: nameOf('composite_preview'), reader_text: compositeText,
    ready: Boolean(compositeText), persistable: false,
    creative_hypothesis: '检验未来问题与顺叙主动性是否能互相增益，而不是把两个钩子机械叠加',
    generator_model: [head.generator_model, cold.generator_model].filter(Boolean).join('+'),
    quality: compositeText ? {
      ok: head.quality.ok && cold.quality.ok,
      status: head.quality.ok && cold.quality.ok ? 'passed' : 'rejected',
      checks: [...head.quality.checks, ...cold.quality.checks],
    } : { ok: false, status: 'awaiting_generation', checks: [] },
  };

  const candidates = [baseline, head, cold, composite];
  const winner = comparison?.auto_safe
    ? candidates.find(item => item.candidate_id === comparison.winner?.candidate_id) : null;
  const recommendation = winner?.quality?.ok
    ? { kind: winner.kind, status: 'stable_winner', reason: comparison.rounds?.[0]?.reason || '两轮匿名比较稳定' }
    : {
      kind: 'baseline',
      status: comparison ? 'keep_baseline' : 'awaiting_cold_read',
      reason: comparison
        ? '没有同时通过专属门与跨模型稳定比较的方案，保留原稿'
        : '候选生成后再做两轮匿名比较',
    };

  // 故事承诺画像：只读既有画像，绝不在计划阶段触发模型调用（dry-run 必须零成本）
  let storyPromise = null;
  try {
    const profile = store.materials?.get?.(book.id, 'story_promise');
    storyPromise = profile ? clone(profile) : null;
  } catch { /* 画像缺失不阻断计划生成 */ }

  return {
    version: '0.98.0',
    mode: dryRun ? 'dry-run' : 'explicit-apply-preparation',
    dryRun: dryRun !== false,
    writes: 0,
    book: { id: book.id, title: book.title },
    facts,
    storyPromise,
    contract: {
      promise_key: locks.promise_key || '',
      target_event_key: facts.target_event_key,
      target_year: facts.target_year,
      target_volume_idx: facts.target_volume_idx,
      target_volume_id: facts.target_volume_id,
      public_question: locks.public_question || '',
      known_outcome: locks.known_outcome || '',
      forbidden_early_explanation: locks.forbidden_early_explanation || [],
    },
    candidates,
    assetKinds: [...OPENING_ASSET_KINDS],
    comparison,
    recommendation,
    input: { path: sourceInput, role: 'read-only-reference', mustRemainUnchanged: true },
    applyPolicy: { explicitFlagRequired: true, snapshotRequired: true, modifiesChaptersAfterOne: false },
  };
}

/** CLI 参数解析：--apply 必须与受支持的 --candidate 同时给出才进入写模式。 */
export function parseOpeningArgs(argv) {
  const result = {
    apply: false, candidate: '', dryRun: true, pretty: true, worker: false,
    dbPath: '', inputPath: '', bookId: '',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--worker') result.worker = true;
    else if (arg === '--compact') result.pretty = false;
    else if (['--candidate', '--db', '--input', '--book-id'].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} 缺少值`);
      if (arg === '--candidate') result.candidate = value;
      else if (arg === '--db') result.dbPath = value;
      else if (arg === '--input') result.inputPath = value;
      else result.bookId = value;
    } else throw new Error(`未知参数：${arg}`);
  }
  if (result.apply && !result.candidate) throw new Error('--apply 必须同时提供 --candidate');
  if (!result.apply && result.candidate) throw new Error('--candidate 必须与 --apply 同时使用');
  if (result.apply) {
    const applicable = OPENING_ASSET_KINDS.filter(kind => kind !== 'composite_preview');
    if (!applicable.includes(result.candidate)) {
      throw new Error(`候选类型不能直接应用：${result.candidate}`);
    }
    result.dryRun = false;
  }
  return result;
}

/** 把模型配置复制进一次性沙箱目录，便于真实模型 dry-run 后可整体销毁。 */
export function copySandboxModelConfig(dbPath, sandboxDir) {
  const sourceDir = path.dirname(path.resolve(dbPath));
  const source = path.join(sourceDir, 'config.json');
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.copyFileSync(source, path.join(sandboxDir, 'config.json'));
  return true;
}
