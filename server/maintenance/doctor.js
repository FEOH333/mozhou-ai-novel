// server/maintenance/doctor.js —— SQLite 小说数据只读体检
// 只读取原库；快照恢复候选仅输出标识、哈希与长度，不输出/写回正文。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { entityNamePlausible } from '../engine/narrative/names.js'; // V0.93.11：实体类型名检测与 settle 建卡门同源
import { STALE_MATERIAL_AFTER_CHAPTERS } from '../engine/pipeline/continuation.js'; // V0.93.11：时效阈值与续卷注入侧同源
import {
  detectSceneBoundaryFragments,
  detectEvidenceCertaintyStack,
  detectNumericDataDump,
  detectCrossChapterRepeats,
  detectCrossChapterMetaphors,
  detectChapterOpenerTic,
  detectChapterEndingTic,
  detectEditorialVoiceLeak,
  runLocalRules,
  runSceneContinuityRules,
  titleShapeOf,
  titleShapeStreakIssues,
  titleRootRepeatIssues,
} from '../engine/quality/rules.js'; // V0.97.1：推流前结构级正文与风格体检 // V0.107：章名句式族观察面（与卷纲期校验同源）
import { lifecycleStructureIssues } from '../engine/longform/longform_lifecycle.js';
import { detectGrowthPlanDrift, detectLongRunningStateDebts } from '../engine/narrative/characters.js';
import { openingFingerprint } from '../engine/planning/opening_diagnosis.js';
import { platformFrontMatterCompatibility } from '../engine/planning/opening_intervention.js';
import { historicalEventTargetsFromOutline } from '../data/history.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_DB = fileURLToPath(new URL('../../data/novel.db', import.meta.url));
const DONE_STATUSES = new Set(['done', 'settled', 'revised']);
// 完成态（有正文的终态章）：缺摘要/健康记录陈旧只在完成章上判定——
// planned/drafted/partial 是过程态，未结算自然无摘要，健康快照也允许停留在生成中断时刻。
const COMPLETED_STATUSES = new Set(['done', 'settled']);

/** V0.93.11：导出供测试（阈值同源断言） */
export const DEFAULTS = Object.freeze({
  wordCountToleranceRatio: 0.10,
  wordCountToleranceChars: 100,
  similarityNgram: 8,
  similarityThreshold: 0.35,
  exactSentenceMinChars: 20,
  // V0.93.11：与 server/engine/pipeline/continuation.js filterStaleMaterials 的时效阈值同源（15 章）——
  // 此前 doctor 用 12 报"过期"，而注入侧 15 章内仍注入，写审两把尺子打架。
  staleMaterialAfterChapters: STALE_MATERIAL_AFTER_CHAPTERS,
  recoveryMinExtraChars: 200,
  recoveryMinGrowthRatio: 0.25,
  maxFindingsPerCheck: 100,
  // V0.100.16：分段健康一把尺（与 polish.js PARAGRAPH_FLATTEN_MIN_CHARS 同源）——
  // 单场景超此长度且零换行 = 落盘链路剥离换行的形态损坏指纹（返工落盘事故实证）。
  paragraphBreakLostMinChars: 300,
});

function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function sha256(text) {
  return createHash('sha256').update(text || '', 'utf8').digest('hex');
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function containsOpeningProse(container, prose, minChars = 20) {
  const haystack = cleanText(container);
  const needle = cleanText(prose);
  if (!needle || !haystack) return false;
  if (needle.length < minChars) return haystack.includes(needle);
  for (let offset = 0; offset <= needle.length - minChars; offset += 10) {
    if (haystack.includes(needle.slice(offset, offset + minChars))) return true;
  }
  return haystack.includes(needle.slice(-minChars));
}

const OPENING_STATUSES = new Set(['candidate', 'audited', 'selected', 'applied', 'retired', 'rejected']);
const OPENING_READER_PLACEMENTS = new Set(['prepend_chapter1', 'before_chapter1']);

/** V0.98：只读检查开篇资产、叙事记忆隔离、发布同步包与平台实测证据。 */
export function checkOpeningAssets(db, bookId) {
  if (!hasTable(db, 'opening_assets')) return { ok: true, enabled: false, assets: 0, issues: [], warnings: [] };
  const issues = [];
  const add = (code, severity, message, detail = {}) => issues.push({ code, severity, message, ...detail });
  const assets = all(db, 'SELECT * FROM opening_assets WHERE book_id=? ORDER BY created_at,id', bookId);
  const bookColumns = ['id', 'title', 'blurb', 'genre', 'platform', 'settings_json'].filter(column => hasColumn(db, 'books', column));
  const book = bookColumns.length ? db.prepare(`SELECT ${bookColumns.join(',')} FROM books WHERE id=?`).get(bookId) : null;
  const settings = parseJson(book?.settings_json, {});

  const chapterColumns = ['id', 'book_id', 'volume_id', 'idx', 'title', 'outline_json'].filter(column => hasColumn(db, 'chapters', column));
  const chapters = chapterColumns.length
    ? all(db, `SELECT ${chapterColumns.join(',')} FROM chapters WHERE book_id=? ORDER BY idx,id`, bookId) : [];
  const scenesByChapter = new Map(chapters.map(chapter => [chapter.id, []]));
  const sceneById = new Map();
  if (hasTable(db, 'scenes')) {
    const sceneRows = all(db, `SELECT s.id,s.chapter_id,s.idx,COALESCE(s.content,'') content
      FROM scenes s JOIN chapters c ON c.id=s.chapter_id WHERE c.book_id=? ORDER BY c.idx,s.idx`, bookId);
    for (const scene of sceneRows) {
      sceneById.set(scene.id, scene);
      if (!scenesByChapter.has(scene.chapter_id)) scenesByChapter.set(scene.chapter_id, []);
      scenesByChapter.get(scene.chapter_id).push(scene);
    }
  }
  const openingChapters = chapters.slice(0, 10).map(chapter => ({
    idx: Number(chapter.idx), title: chapter.title || '',
    text: (scenesByChapter.get(chapter.id) || []).map(scene => scene.content || '').filter(Boolean).join('\n\n'),
  }));
  const firstText = openingChapters[0]?.text || '';
  const currentSourceFingerprint = book ? openingFingerprint(book, openingChapters) : '';
  const currentPromiseFingerprint = String(settings.storyPromiseProfile?.source_fingerprint || '');

  for (const asset of assets) {
    if (!OPENING_STATUSES.has(asset.status)) {
      add('OPENING_STATUS_INVALID', 'error', `开篇资产状态无效：${asset.status}`, { assetId: asset.id });
    }
  }
  const activeReaders = assets.filter(asset => ['selected', 'applied'].includes(asset.status)
    && OPENING_READER_PLACEMENTS.has(asset.placement));
  if (activeReaders.length > 1) {
    add('OPENING_ACTIVE_LAYER_CONFLICT', 'error', '同一作品存在多个启用中的读者前置层', {
      assetIds: activeReaders.map(asset => asset.id),
    });
  }

  for (const asset of assets.filter(item => item.placement === 'scene_patch' && !['retired', 'rejected'].includes(item.status))) {
    const scene = sceneById.get(asset.anchor_scene_id);
    const start = Number(asset.anchor_start);
    const end = Number(asset.anchor_end);
    const anchorValid = scene && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start
      && end <= String(scene.content || '').length
      && String(scene.content || '').slice(start, end) === String(asset.source_excerpt || '');
    if (!anchorValid || sha256(scene?.content || '') !== String(asset.source_hash || '')) {
      add('OPENING_SOURCE_STALE', 'error', '顺叙补丁的源场景、哈希或字符锚已经变化', {
        assetId: asset.id, sceneId: asset.anchor_scene_id || null,
      });
    }
  }

  const memorySpecs = [
    ['history', ['role', 'content']], ['facts', ['subject', 'predicate', 'object', 'note']],
    ['timeline', ['event']], ['rolling_summaries', ['content']], ['vectors', ['kind', 'ref_id', 'chunk']],
  ];
  const memoryRows = [];
  for (const [table, wanted] of memorySpecs) {
    if (!hasTable(db, table) || !hasColumn(db, table, 'book_id')) continue;
    const fields = wanted.filter(column => hasColumn(db, table, column));
    if (!fields.length) continue;
    for (const row of all(db, `SELECT ${fields.join(',')} FROM ${table} WHERE book_id=?`, bookId)) {
      memoryRows.push({ source: table, text: fields.map(field => row[field] || '').join(' ') });
    }
  }
  for (const asset of activeReaders) {
    for (const row of memoryRows) {
      if (containsOpeningProse(row.text, asset.content)) {
        add('OPENING_MEMORY_LEAK', 'error', '读者前置正文泄漏进了故事记忆', {
          assetId: asset.id, source: row.source,
        });
        break;
      }
    }
  }

  const volumes = hasTable(db, 'volumes')
    ? all(db, `SELECT ${['id', 'book_id', 'idx', 'outline_json'].filter(column => hasColumn(db, 'volumes', column)).join(',')}
      FROM volumes WHERE book_id=?`, bookId) : [];
  const volumeById = new Map(volumes.map(volume => [volume.id, volume]));
  for (const asset of assets.filter(item => OPENING_READER_PLACEMENTS.has(item.placement)
    && !['retired', 'rejected'].includes(item.status))) {
    const contract = parseJson(asset.contract_json, null);
    const targetVolume = contract?.target_volume_id ? volumeById.get(String(contract.target_volume_id)) : null;
    const targetYear = Number(contract?.target_year);
    const targetEvent = String(contract?.target_event_key || '').trim();
    const targetChapters = targetVolume ? chapters.filter(chapter => chapter.volume_id === targetVolume.id) : [];
    const targetOutline = parseJson(targetVolume?.outline_json, {});
    const startYear = Number(targetOutline.start_year);
    const endYear = Number(targetOutline.end_year);
    const chapterOutlines = targetChapters.map(chapter => parseJson(chapter.outline_json, {}));
    const years = [Number(targetOutline.year), startYear, endYear,
      ...chapterOutlines.map(outline => Number(outline.year))].filter(Number.isInteger);
    const groundedTargets = [
      ...historicalEventTargetsFromOutline(targetOutline),
      ...chapterOutlines.flatMap(historicalEventTargetsFromOutline),
    ];
    const yearGrounded = years.includes(targetYear)
      || (Number.isInteger(startYear) && Number.isInteger(endYear)
        && targetYear >= startYear && targetYear <= endYear);
    const invalid = [];
    if (!contract || !String(contract.promise_key || '').trim()) invalid.push('promise_key');
    if (!targetVolume) invalid.push('target_volume_id');
    if (!Number.isInteger(targetYear) || !yearGrounded) invalid.push('target_year');
    if (!targetEvent || !groundedTargets.some(target => target.year === targetYear
      && target.eventKey === targetEvent)) invalid.push('target_event_key');
    if (contract?.status === 'fulfilled') {
      const fulfilled = chapters.find(chapter => Number(chapter.idx) === Number(contract.fulfilled_chapter));
      if (!fulfilled || fulfilled.volume_id !== targetVolume?.id) invalid.push('fulfilled_chapter');
    }
    if (invalid.length) add('OPENING_CONTRACT_INVALID', 'error', '读者契约的卷、年份或事件锚不存在或不一致', {
      assetId: asset.id, invalid: [...new Set(invalid)],
    });
  }

  const compatibility = platformFrontMatterCompatibility(
    settings.openingIntervention?.platformCompatibility || settings.platformCompatibility || {},
  );
  for (const asset of assets.filter(item => item.placement === 'before_chapter1'
    && !['retired', 'rejected'].includes(item.status))) {
    if (!compatibility.verified) add('OPENING_PLATFORM_UNVERIFIED', 'warning', '独立楔子的目录、审核、导航和数据归属尚未完成六项实测', {
      assetId: asset.id, missing: compatibility.missing,
    });
  }

  for (const asset of assets.filter(item => item.status === 'applied')) {
    const application = parseJson(asset.rank_json, {}).application || {};
    let currentAfter = firstText;
    if (asset.placement === 'prepend_chapter1') currentAfter = asset.content
      ? `${String(asset.content).trim()}\n\n${firstText.trimStart()}` : firstText;
    if (asset.placement === 'before_chapter1') currentAfter = asset.content
      ? `楔子\n\n${String(asset.content).trim()}\n\n${firstText}` : firstText;
    if (!application.after_hash || application.after_hash !== sha256(currentAfter)) {
      add('OPENING_PUBLISH_PATCH_STALE', 'error', '发布同步包的目标哈希已不对应当前读者文本', {
        assetId: asset.id, expected: application.after_hash || '', current: sha256(currentAfter),
      });
    }
  }

  let diagnosis = null;
  if (hasTable(db, 'public_materials') && hasColumn(db, 'public_materials', 'book_id')
    && hasColumn(db, 'public_materials', 'kind') && hasColumn(db, 'public_materials', 'content')) {
    const row = db.prepare("SELECT content FROM public_materials WHERE book_id=? AND kind='opening_diagnosis' ORDER BY rowid DESC LIMIT 1").get(bookId);
    diagnosis = parseJson(row?.content, null);
    if (row && (!diagnosis || diagnosis.version !== 3
      || diagnosis.source_fingerprint !== currentSourceFingerprint
      || diagnosis.promise_profile_fingerprint !== currentPromiseFingerprint)) {
      add('OPENING_DIAGNOSIS_STALE', 'error', '开篇诊断不是基于当前正文与创作宪章', {
        currentFingerprint: currentSourceFingerprint,
      });
    }
  }
  for (const asset of assets.filter(item => !['retired', 'rejected'].includes(item.status))) {
    const rank = parseJson(asset.rank_json, {});
    const staleSource = !rank.source_fingerprint || rank.source_fingerprint !== currentSourceFingerprint;
    const stalePromise = !rank.promise_profile_fingerprint || rank.promise_profile_fingerprint !== currentPromiseFingerprint;
    const staleDiagnosis = Boolean(rank.diagnosis_fingerprint)
      && rank.diagnosis_fingerprint !== currentSourceFingerprint;
    if (staleSource || stalePromise || staleDiagnosis) add('OPENING_REVIEW_STALE', 'error', '候选审校或盲评使用了旧版正文/创作宪章', {
      assetId: asset.id, staleSource, stalePromise, staleDiagnosis,
    });
  }

  const warnings = issues.filter(issue => issue.severity === 'warning');
  return {
    ok: issues.every(issue => issue.severity !== 'error'), enabled: true, assets: assets.length,
    activeReaderLayers: activeReaders.map(asset => asset.id), currentSourceFingerprint,
    currentPromiseFingerprint, issues, warnings,
  };
}

function cleanText(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function textLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function hanCharacterCount(text) {
  let count = 0;
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) count++;
  }
  return count;
}

function chapterTexts(db, chapters) {
  if (!hasTable(db, 'scenes')) return new Map(chapters.map(ch => [ch.id, '']));
  const rows = all(db, `
    SELECT s.chapter_id, s.idx, COALESCE(s.content, '') AS content
    FROM scenes s
    JOIN chapters c ON c.id=s.chapter_id
    WHERE c.book_id=?
    ORDER BY s.chapter_id, s.idx
  `, chapters[0]?.book_id || '');
  const grouped = new Map(chapters.map(ch => [ch.id, []]));
  for (const row of rows) {
    if (!grouped.has(row.chapter_id)) grouped.set(row.chapter_id, []);
    grouped.get(row.chapter_id).push(row.content || '');
  }
  return new Map([...grouped].map(([id, parts]) => [id, parts.join('\n')]));
}

function checkChapterIndex(chapters) {
  const counts = new Map();
  const invalid = [];
  for (const chapter of chapters) {
    const idx = Number(chapter.idx);
    if (!Number.isInteger(idx) || idx < 1) invalid.push({ chapterId: chapter.id, idx: chapter.idx });
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }
  const valid = [...counts.keys()].filter(Number.isInteger).filter(n => n >= 1).sort((a, b) => a - b);
  const duplicates = valid.filter(idx => counts.get(idx) > 1);
  const gaps = [];
  const max = valid.at(-1) || 0;
  for (let idx = 1; idx <= max; idx++) if (!counts.has(idx)) gaps.push(idx);
  return {
    ok: !duplicates.length && !gaps.length && !invalid.length,
    min: valid[0] || null,
    max: max || null,
    duplicates,
    gaps,
    invalid,
  };
}

function checkVolumeAssignments(db, bookId, chapters) {
  const bookVolumes = hasTable(db, 'volumes')
    ? all(db, 'SELECT id, book_id, idx, title FROM volumes WHERE book_id=? ORDER BY idx', bookId)
    : [];
  const allVolumes = hasTable(db, 'volumes')
    ? all(db, 'SELECT id, book_id, idx, title FROM volumes')
    : [];
  const volumeBook = new Map(allVolumes.map(v => [v.id, v.book_id]));
  const unassigned = chapters
    .filter(ch => ch.volume_id == null || ch.volume_id === '')
    .map(ch => ({ chapterId: ch.id, idx: ch.idx }));
  const missingVolumeRefs = chapters
    .filter(ch => ch.volume_id && !volumeBook.has(ch.volume_id))
    .map(ch => ({ chapterId: ch.id, idx: ch.idx, volumeId: ch.volume_id }));
  const crossBookRefs = chapters
    .filter(ch => ch.volume_id && volumeBook.has(ch.volume_id) && volumeBook.get(ch.volume_id) !== bookId)
    .map(ch => ({ chapterId: ch.id, idx: ch.idx, volumeId: ch.volume_id, volumeBookId: volumeBook.get(ch.volume_id) }));
  return {
    ok: !unassigned.length && !missingVolumeRefs.length && !crossBookRefs.length,
    volumeCount: bookVolumes.length,
    unassigned,
    missingVolumeRefs,
    crossBookRefs,
    volumes: bookVolumes,
  };
}

function checkVolumeExportOrder(chapters, volumes) {
  const sortedChapters = [...chapters].sort((a, b) => Number(a.idx) - Number(b.idx) || String(a.id).localeCompare(String(b.id)));
  const sortedVolumes = [...volumes].sort((a, b) => Number(a.idx) - Number(b.idx) || String(a.id).localeCompare(String(b.id)));
  const order = [];
  for (const chapter of sortedChapters.filter(ch => !ch.volume_id)) order.push(chapter);
  for (const volume of sortedVolumes) {
    for (const chapter of sortedChapters.filter(ch => ch.volume_id === volume.id)) order.push(chapter);
  }
  const included = new Set(order.map(ch => ch.id));
  const omitted = sortedChapters
    .filter(ch => !included.has(ch.id))
    .map(ch => ({ chapterId: ch.id, idx: ch.idx, volumeId: ch.volume_id }));
  const inversions = [];
  for (let i = 1; i < order.length; i++) {
    if (Number(order[i].idx) <= Number(order[i - 1].idx)) {
      inversions.push({
        previous: { chapterId: order[i - 1].id, idx: order[i - 1].idx },
        current: { chapterId: order[i].id, idx: order[i].idx },
      });
    }
  }
  return {
    ok: !inversions.length && !omitted.length && order.length === chapters.length,
    chapterOrder: order.map(ch => ({ chapterId: ch.id, idx: ch.idx })),
    inversions,
    omitted,
  };
}

function toleranceFor(actual, options) {
  return Math.max(options.wordCountToleranceChars, Math.round(actual * options.wordCountToleranceRatio));
}

function checkWordCounts(chapters, texts, options) {
  const mismatches = [];
  for (const chapter of chapters) {
    const text = texts.get(chapter.id) || '';
    const rawChars = text.length;
    const nonWhitespaceChars = textLength(text);
    const actualChars = hanCharacterCount(text);
    const stored = Number(chapter.word_count) || 0;
    const delta = stored - actualChars;
    const tolerance = toleranceFor(actualChars, options);
    if (Math.abs(delta) > tolerance) {
      mismatches.push({
        chapterId: chapter.id,
        idx: chapter.idx,
        storedWordCount: stored,
        actualChars,
        rawChars,
        nonWhitespaceChars,
        delta,
        tolerance,
      });
    }
  }
  return { ok: !mismatches.length, metric: 'han_characters', mismatches };
}

/** V0.93.11：导出供测试——缺摘要只在完成态（done/settled）章判定 */
export function checkSummaries(db, bookId, chapters) {
  const rows = hasTable(db, 'chapter_summaries')
    ? all(db, 'SELECT chapter_id, summary FROM chapter_summaries WHERE book_id=?', bookId)
    : [];
  const summaries = new Map(rows.map(row => [row.chapter_id, row.summary || '']));
  // V0.93.11：只在完成态（done/settled）章上查缺摘要——planned/drafted 是过程态，
 // 未结算自然无摘要（此前实测 ch27-34 规划章被误报缺摘要）。
  const missing = chapters
    .filter(ch => COMPLETED_STATUSES.has(ch.status) && !summaries.get(ch.id)?.trim())
    .map(ch => ({ chapterId: ch.id, idx: ch.idx, status: ch.status }));
  return { ok: !missing.length, missing };
}

function newestHealth(rows) {
  return [...rows].sort((a, b) => {
    const time = Number(b.created_at || 0) - Number(a.created_at || 0);
    return time || Number(b.id || 0) - Number(a.id || 0);
  })[0];
}

/** V0.93.11：导出供测试——word_count_changed 只在完成态章判定 */
export function checkHealth(db, bookId, chapters, options) {
  if (!hasTable(db, 'chapter_health')) {
    return { ok: true, available: false, duplicateRecords: [], staleRecords: [], orphanRecords: [] };
  }
  const rows = all(db, 'SELECT * FROM chapter_health WHERE book_id=? ORDER BY id', bookId);
  const chapterMap = new Map(chapters.map(ch => [ch.id, ch]));
  const groups = new Map();
  const orphanRecords = [];
  for (const row of rows) {
    if (!row.chapter_id || !chapterMap.has(row.chapter_id)) {
      orphanRecords.push({ healthId: row.id, chapterId: row.chapter_id, idx: row.idx });
      continue;
    }
    if (!groups.has(row.chapter_id)) groups.set(row.chapter_id, []);
    groups.get(row.chapter_id).push(row);
  }
  const duplicateRecords = [];
  const staleRecords = [];
  for (const [chapterId, records] of groups) {
    const chapter = chapterMap.get(chapterId);
    if (records.length > 1) duplicateRecords.push({ chapterId, idx: chapter.idx, count: records.length });
    const latest = newestHealth(records);
    const current = Number(chapter.word_count) || 0;
    const healthCount = Number(latest.word_count) || 0;
    const reasons = [];
    if (Number(latest.idx) !== Number(chapter.idx)) reasons.push('chapter_idx_changed');
    // V0.93.11：word_count_changed 只在完成态章上判定——drafted/planned 的健康快照
    // 停留在"生成中断/中止"时刻（word_count=0），与当前在途字数不同是预期，不是陈旧
 // （此前实测 ch27 用户中止快照被误报为 stale）。
    if (COMPLETED_STATUSES.has(chapter.status) && Math.abs(healthCount - current) > toleranceFor(current, options)) {
      reasons.push('word_count_changed');
    }
    if (reasons.length) {
      staleRecords.push({
        chapterId,
        idx: chapter.idx,
        healthId: latest.id,
        healthWordCount: healthCount,
        currentWordCount: current,
        reasons,
      });
    }
  }
  return {
    ok: !duplicateRecords.length && !staleRecords.length && !orphanRecords.length,
    available: true,
    duplicateRecords,
    staleRecords,
    orphanRecords,
  };
}

function ngrams(text, size) {
  const normalized = cleanText(text);
  const result = new Set();
  for (let i = 0; i <= normalized.length - size; i++) result.add(normalized.slice(i, i + size));
  return { normalized, grams: result };
}

function sentenceList(text, minChars) {
  return String(text || '')
    .split(/(?<=[。！？!?])/u)
    .map(sentence => sentence.trim().replace(/\s+/g, ''))
    .filter(sentence => cleanText(sentence).length >= minChars);
}

function checkSimilarity(chapters, texts, options) {
  const eligible = chapters
    .filter(ch => DONE_STATUSES.has(ch.status) || (texts.get(ch.id) || '').trim())
    .sort((a, b) => Number(a.idx) - Number(b.idx));
  const prepared = new Map(eligible.map(ch => [ch.id, ngrams(texts.get(ch.id) || '', options.similarityNgram)]));
  const highSimilarity = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const left = eligible[i];
      const right = eligible[j];
      if (Math.abs(Number(left.idx) - Number(right.idx)) <= 1) continue;
      const a = prepared.get(left.id);
      const b = prepared.get(right.id);
      if (a.normalized.length < options.exactSentenceMinChars || b.normalized.length < options.exactSentenceMinChars) continue;
      const small = a.grams.size <= b.grams.size ? a.grams : b.grams;
      const large = a.grams.size <= b.grams.size ? b.grams : a.grams;
      if (!small.size) continue;
      let intersection = 0;
      for (const gram of small) if (large.has(gram)) intersection++;
      const containment = intersection / small.size;
      if (containment < options.similarityThreshold) continue;
      highSimilarity.push({
        leftChapterId: left.id,
        leftIdx: left.idx,
        rightChapterId: right.id,
        rightIdx: right.idx,
        ngram: options.similarityNgram,
        containment: round(containment),
        jaccard: round(intersection / (a.grams.size + b.grams.size - intersection)),
      });
    }
  }
  highSimilarity.sort((a, b) => b.containment - a.containment);

  const sentenceChapters = new Map();
  for (const chapter of eligible) {
    for (const sentence of new Set(sentenceList(texts.get(chapter.id) || '', options.exactSentenceMinChars))) {
      if (!sentenceChapters.has(sentence)) sentenceChapters.set(sentence, []);
      sentenceChapters.get(sentence).push({ chapterId: chapter.id, idx: chapter.idx });
    }
  }
  const exactSentenceRepeats = [];
  for (const [sentence, seenIn] of sentenceChapters) {
    const nonAdjacent = seenIn.some((left, i) => seenIn.slice(i + 1).some(right => Math.abs(Number(left.idx) - Number(right.idx)) > 1));
    if (!nonAdjacent) continue;
    exactSentenceRepeats.push({ sentence: sentence.slice(0, 120), chapters: seenIn });
  }
  return {
    ok: !highSimilarity.length && !exactSentenceRepeats.length,
    threshold: options.similarityThreshold,
    highSimilarity: highSimilarity.slice(0, options.maxFindingsPerCheck),
    exactSentenceRepeats: exactSentenceRepeats.slice(0, options.maxFindingsPerCheck),
    truncated: highSimilarity.length > options.maxFindingsPerCheck || exactSentenceRepeats.length > options.maxFindingsPerCheck,
  };
}

function suspiciousEntity(table, name) {
  // V0.93.11：检测词表与 settle 建卡门同源（server/engine/narrative/names.js entityNamePlausible）——
  // 写审同源：模型自报"青铜薄片"为地点时 settle 不建卡，存量误建卡由 doctor 同样检出。
  const kindMap = { locations: 'locations', factions: 'factions', items: 'items' };
  const reasons = entityNamePlausible(kindMap[table] || table, name);
  return reasons;
}

function checkEntityTypes(db, bookId) {
  const suspicious = [];
  for (const table of ['locations', 'factions', 'items']) {
    if (!hasTable(db, table)) continue;
    for (const entity of all(db, `SELECT id, name FROM ${table} WHERE book_id=? ORDER BY name`, bookId)) {
      const reasons = suspiciousEntity(table, entity.name);
      if (reasons.length) suspicious.push({ table, id: entity.id, name: entity.name, reasons });
    }
  }
  return { ok: !suspicious.length, suspicious };
}

function parseChapterNumbers(content, suffixPattern) {
  const result = [];
  const re = new RegExp(`第\\s*(\\d+)\\s*章${suffixPattern}`, 'g');
  for (const match of String(content || '').matchAll(re)) result.push(Number(match[1]));
  return result;
}

function parseTargetChapters(content) {
  const result = [];
  for (const match of String(content || '').matchAll(/目标第\s*(\d+)\s*章/gu)) result.push(Number(match[1]));
  return result;
}

function likelyResolvedPlan(content, recentText) {
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!line.includes('[resolve]')) continue;
    const desc = line.replace(/^.*?\[resolve\]\s*/u, '').split(/[（(]/u)[0].replace(/的线索$/u, '').trim();
    if (desc.length < 4 || !recentText.includes(cleanText(desc))) continue;
    // 截到“并/且/后/再”等并列连接词，保留可在近期正文中精确核验的短结果短语，
    // 例如“修复钥匙并揭示封印”提取为“修复钥匙”。
    const actions = [...line.matchAll(/(?:取得|夺得|获得|修复|开启|揭示|找到|发现|击败|救出|离开|进入)[^，。；）)并且后再以]{2,10}/gu)]
      .map(match => cleanText(match[0]));
    if (actions.some(action => action.length >= 4 && recentText.includes(action))) return true;
  }
  return false;
}

function checkStaleMaterials(db, bookId, chapters, texts, options) {
  if (!hasTable(db, 'public_materials')) return { ok: true, available: false, findings: [] };
  const latestIdx = Math.max(0, ...chapters.map(ch => Number(ch.idx) || 0));
  const recentIds = [...chapters]
    .sort((a, b) => Number(b.idx) - Number(a.idx))
    .slice(0, 8)
    .map(ch => ch.id);
  let recentText = cleanText(recentIds.map(id => texts.get(id) || '').join('\n'));
  if (hasTable(db, 'chapter_summaries')) {
    const summaries = all(db, 'SELECT summary FROM chapter_summaries WHERE book_id=? ORDER BY updated_at DESC LIMIT 8', bookId);
    recentText += cleanText(summaries.map(row => row.summary || '').join('\n'));
  }
  const paidForeshadows = hasTable(db, 'foreshadows')
    ? all(db, "SELECT desc FROM foreshadows WHERE book_id=? AND status='paid_off'", bookId).map(row => row.desc).filter(Boolean)
    : [];
  const findings = [];
  const materials = all(db, 'SELECT id, kind, content, updated_at FROM public_materials WHERE book_id=? ORDER BY kind', bookId);
  for (const material of materials) {
    const reasons = [];
    const generated = parseChapterNumbers(material.content, '(?:时)?生成');
    const targets = parseTargetChapters(material.content);
    const generatedChapter = generated.at(-1) || null;
    if (generatedChapter && latestIdx - generatedChapter > options.staleMaterialAfterChapters
      && ['polish_feedback', 'foreshadow_plan', 'growth_remedy', 'world_progress'].includes(material.kind)) {
      reasons.push('generated_too_long_ago');
    }
    if (targets.some(chapter => chapter < latestIdx) && /\[(?:resolve|advance)\]/u.test(material.content || '')) {
      reasons.push('target_chapter_passed');
    }
    if (paidForeshadows.some(desc => desc && String(material.content || '').includes(desc))) {
      reasons.push('references_paid_off_foreshadow');
    }
    if (material.kind === 'foreshadow_plan' && likelyResolvedPlan(material.content, recentText)) {
      reasons.push('plan_likely_already_realized');
    }
    if (reasons.length) {
      findings.push({
        materialId: material.id,
        kind: material.kind,
        generatedChapter,
        targetChapters: targets,
        latestChapter: latestIdx,
        reasons: [...new Set(reasons)],
      });
    }
  }
  return { ok: !findings.length, available: true, findings };
}

function recoveryCandidates(db, bookId, chapters, texts, options) {
  if (!hasTable(db, 'snapshots')) return [];
  const byId = new Map(chapters.map(ch => [ch.id, ch]));
  const byIdx = new Map(chapters.map(ch => [Number(ch.idx), ch]));
  const best = new Map();
  for (const snapshot of all(db, 'SELECT id, label, data_json, created_at FROM snapshots WHERE book_id=? ORDER BY created_at', bookId)) {
    let data;
    try { data = JSON.parse(snapshot.data_json || '{}'); } catch { continue; }
    for (const archived of data.chapters || []) {
      const currentChapter = byId.get(archived.id) || byIdx.get(Number(archived.idx));
      if (!currentChapter) continue;
      const snapshotText = (archived.scenes || [])
        .sort((a, b) => Number(a.idx) - Number(b.idx))
        .map(scene => scene.content || '')
        .join('\n');
      const currentText = texts.get(currentChapter.id) || '';
      const currentLength = textLength(currentText);
      const snapshotLength = textLength(snapshotText);
      const minimumGain = Math.max(options.recoveryMinExtraChars, Math.round(currentLength * options.recoveryMinGrowthRatio));
      if (snapshotLength < currentLength + minimumGain || sha256(snapshotText) === sha256(currentText)) continue;
      const candidate = {
        chapter: { id: currentChapter.id, idx: currentChapter.idx },
        current: { hash: sha256(currentText), length: currentLength },
        snapshot: { id: snapshot.id, label: snapshot.label, hash: sha256(snapshotText), length: snapshotLength },
      };
      const previous = best.get(currentChapter.id);
      if (!previous || candidate.snapshot.length > previous.snapshot.length
        || (candidate.snapshot.length === previous.snapshot.length && Number(snapshot.created_at) > previous.createdAt)) {
        best.set(currentChapter.id, { ...candidate, createdAt: Number(snapshot.created_at) || 0 });
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => Number(a.chapter.idx) - Number(b.chapter.idx))
    .map(({ createdAt, ...candidate }) => candidate);
}

function issueCount(checks) {
  return Object.values(checks).reduce((sum, check) => sum + (check?.ok === false ? 1 : 0), 0);
}

/** V0.107 章卷命名观察面（只读度量，不拦截）：逐卷章名句式族分布 + 连排/占比/词根复读信号。
 *  检测与卷纲期校验同源（rules.titleShapeStreakIssues/titleRootRepeatIssues）——doctor 只观察，
 *  拦截发生在卷纲生成期（纠正重答）与审校 proseFix；ok 恒 true，不进 issueCount。 */
function checkTitleShapes(chapters) {
  const SHAPE_LABEL = { terse: '极简名词', four: '四字格', mid: '中长句', long: '长句', question: '问句' };
  const byVolume = new Map();
  for (const ch of chapters) {
    const key = ch.volume_id || '(未分卷)';
    if (!byVolume.has(key)) byVolume.set(key, []);
    byVolume.get(key).push(ch);
  }
  const volumes = [];
  for (const [volumeId, rows] of byVolume) {
    const titles = rows.map(r => r.title || '');
    const shapes = titles.map(titleShapeOf).filter(Boolean);
    const dist = {};
    for (const s of shapes) {
      const label = SHAPE_LABEL[s] || s;
      dist[label] = (dist[label] || 0) + 1;
    }
    volumes.push({
      volumeId: volumeId === '(未分卷)' ? null : volumeId,
      chapters: rows.length,
      idxRange: rows.length ? [rows[0].idx, rows[rows.length - 1].idx] : [],
      shapeDistribution: dist,
      streaks: titleShapeStreakIssues(titles).map(s => s.detail),
      rootRepeats: titleRootRepeatIssues(titles).map(r => r.detail),
    });
  }
  return { ok: true, observation: true, volumes };
}

/** V0.108 人物活性观察面（只读度量，不拦截）：backstory/motive_root/web 与对手三件的
 *  覆盖率统计（按 protagonist/major/minor 分层）——回填缺口一眼可见；ok 恒 true。
 *  旧库/测试库 characters 可能缺 tier/deceased/card_json 列——按 pragma 实际列动态组查询。 */
function checkCharacterVitality(db, bookId) {
  if (!hasTable(db, 'characters')) return { ok: true, observation: true, available: false };
  const cols = new Set(all(db, `SELECT name FROM pragma_table_info('characters')`).map(r => String(r.name)));
  const hasTier = cols.has('tier');
  const hasDeceased = cols.has('deceased');
  const hasCard = cols.has('card_json');
  const select = [
    hasTier ? 'tier' : "NULL AS tier",
    hasDeceased ? 'deceased' : '0 AS deceased',
    hasCard ? 'card_json' : "'' AS card_json",
  ].join(', ');
  const rows = all(db, `SELECT ${select} FROM characters WHERE book_id=?`, bookId);
  const tiers = { protagonist: { total: 0, backstory: 0, motive: 0, web: 0 }, major: { total: 0, backstory: 0, motive: 0, web: 0 }, minor: { total: 0, backstory: 0, motive: 0, web: 0 } };
  let rivals = 0;
  let rivalsComplete = 0;
  for (const row of rows) {
    if (row.deceased) continue;
    const tier = hasTier && tiers[row.tier] ? row.tier : 'minor';
    let card = {};
    try { card = JSON.parse(row.card_json || '{}') || {}; } catch { /* ignore */ }
    const t = tiers[tier];
    t.total++;
    if (card.backstory) t.backstory++;
    if (card.motive_root) t.motive++;
    if (card.web) t.web++;
    if (card.rival === true) {
      rivals++;
      if (card.agenda && card.no_retreat && card.stance) rivalsComplete++;
    }
  }
  return { ok: true, observation: true, tiers, rivals, rivalsComplete };
}

/** V0.97 残章/过程态滞留报告（推流前体检硬缺口实证：ch34 drafted 残章 821 字带细纲残留，
 *  字数与完成度指标均正常，纯指标体检看不见——过程态章带正文即列出）。 */
function checkDraftedStall(chapters, texts) {
  const stalled = chapters
    .filter(ch => !DONE_STATUSES.has(ch.status) && (texts.get(ch.id) || '').trim().length > 0)
    .map(ch => ({
      chapterId: ch.id, idx: ch.idx, title: ch.title, status: ch.status,
      chars: textLength(texts.get(ch.id) || ''),
    }))
    .sort((a, b) => Number(a.idx) - Number(b.idx));
  return { ok: stalled.length === 0, stalled };
}

/** V0.97.1 角色相似名清查（精读实证：潘九/潘六斗同场撞名、田二/田三一字差——读者分不清谁是谁）。
 *  高风险：同姓数字名，或活动区间重叠/相邻的近名。明确亲属、以“老/小/阿”起首的通用称呼、
 *  以及相隔三章以上才出场的近名仍列入 ignored 供人工查看，但不让 doctor 假报整书有问题。 */
function checkSimilarNames(db, bookId) {
  if (!hasTable(db, 'characters')) return { ok: true, skipped: true, pairs: [], ignored: [] };
  const NUMERALS = '零一二三四五六七八九十百千万两0123456789';
  const columns = new Set(all(db, 'PRAGMA table_info(characters)').map(row => row.name));
  const select = [
    'name',
    columns.has('card_json') ? "COALESCE(card_json, '') AS card_json" : "'' AS card_json",
    columns.has('first_chapter') ? 'first_chapter' : 'NULL AS first_chapter',
    columns.has('last_chapter') ? 'last_chapter' : 'NULL AS last_chapter',
  ].join(', ');
  const chapterNumber = value => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const roster = all(db, `SELECT ${select} FROM characters WHERE book_id=?`, bookId)
    .map(row => ({
      ...row,
      name: String(row.name || '').trim(),
      first: chapterNumber(row.first_chapter),
      last: chapterNumber(row.last_chapter),
    }))
    .filter(row => row.name.length >= 2 && row.name.length <= 4)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const lev = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  };
  const activeGap = (a, b) => {
    if (![a.first, a.last, b.first, b.last].every(Number.isFinite)) return null;
    if (a.last < b.first) return b.first - a.last;
    if (b.last < a.first) return a.first - b.last;
    return 0;
  };
  // 只认“该角色本身是亲属”的角色卡措辞；“某人父亲的旧交”不能因此把两名赵姓人误判成一家。
  const familyRe = /主角(?:的)?(?:幼|长)?(?:兄|弟|姐|妹)|(?:幼|长|胞|亲)(?:兄|弟|姐|妹)|父子|父女|母子|母女|夫妻/;
  const pairs = [];
  const ignored = [];
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const left = roster[i], right = roster[j];
      const a = left.name, b = right.name;
      const givenA = a.slice(1), givenB = b.slice(1);
      const numeralCollision = a[0] === b[0]
        && [...givenA].some(c => NUMERALS.includes(c)) && [...givenB].some(c => NUMERALS.includes(c));
      const nearDuplicate = lev(a, b) <= 1;
      if (!numeralCollision && !nearDuplicate) continue;
      const reason = numeralCollision ? '同姓数字名' : '一字之差';
      const gap = activeGap(left, right);
      const intentionalFamily = a[0] === b[0] && familyRe.test(`${left.card_json} ${right.card_json}`);
      const genericPrefix = a[0] === b[0] && ['老', '小', '阿'].includes(a[0]);
      if (!numeralCollision && (intentionalFamily || genericPrefix || (gap !== null && gap > 3))) {
        ignored.push({
          a, b, reason,
          ignoredBecause: intentionalFamily ? '明确亲属' : genericPrefix ? '通用称呼前缀' : `出场相隔${gap}章`,
        });
        continue;
      }
      pairs.push({ a, b, reason, activeGap: gap });
    }
  }
  return { ok: pairs.length === 0, pairs, ignored };
}

/** V0.97.1 推流前结构级正文体检：只读，不依赖模型，不把“指标正常”当“正文可推流”。 */
export function checkProseStructure(db, bookId, chapters, texts) {
  const grouped = new Map(chapters.map(ch => [ch.id, []]));
  if (hasTable(db, 'scenes')) {
    for (const row of all(db, `
      SELECT s.chapter_id, s.idx, COALESCE(s.content, '') AS content
      FROM scenes s JOIN chapters c ON c.id=s.chapter_id
      WHERE c.book_id=? ORDER BY c.idx, s.idx
    `, bookId)) {
      if (!grouped.has(row.chapter_id)) grouped.set(row.chapter_id, []);
      grouped.get(row.chapter_id).push(row);
    }
  }
  const boundaryFragments = [];
  const evidenceOverreach = [];
  const numericDumps = [];
  const paragraphBreaks = [];
  for (const chapter of chapters) {
    for (const finding of detectSceneBoundaryFragments(grouped.get(chapter.id) || [])) {
      boundaryFragments.push({ chapterId: chapter.id, chapterIdx: chapter.idx, ...finding });
    }
    // V0.100.16：分段损坏检测——超长零换行场景。正常中文正文 300 字以上必然多段
    // （实测最密场景 521 字 12 段）；零换行一坨说明写入链路剥掉了候选的换行。
    for (const scene of grouped.get(chapter.id) || []) {
      const content = String(scene.content || '');
      if (content.length > DEFAULTS.paragraphBreakLostMinChars && !/[\r\n]/.test(content)) {
        paragraphBreaks.push({
          chapterId: chapter.id, chapterIdx: chapter.idx, sceneIdx: scene.idx,
          chars: content.length,
        });
      }
    }
    const text = texts.get(chapter.id) || '';
    for (const finding of detectEvidenceCertaintyStack(text).filter(x => x.severity === 'medium')) {
      evidenceOverreach.push({ chapterId: chapter.id, chapterIdx: chapter.idx, ...finding });
    }
    for (const finding of detectNumericDataDump(text)) {
      numericDumps.push({ chapterId: chapter.id, chapterIdx: chapter.idx, ...finding });
    }
  }
  return {
    ok: boundaryFragments.length === 0 && evidenceOverreach.length === 0 && numericDumps.length === 0
      && paragraphBreaks.length === 0,
    boundaryFragments,
    evidenceOverreach,
    numericDumps,
    paragraphBreaks,
  };
}

/** V0.97.2：故事记忆只能记“发生了什么”，不能保存“不要怎么写”的编辑禁令。 */
export function checkStoryMemoryPurity(db, bookId) {
  const findings = [];
  const scan = (source, rows, textOf, chapterOf = () => null) => {
    for (const row of rows) {
      const text = String(textOf(row) || '');
      for (const issue of detectEditorialVoiceLeak(text)) {
        findings.push({ source, chapterIdx: chapterOf(row), quote: issue.quote, issue: issue.issue });
      }
    }
  };
  if (hasTable(db, 'chapter_summaries')) {
    scan('chapter_summary', all(db, `SELECT cs.summary, c.idx chapter_idx
      FROM chapter_summaries cs LEFT JOIN chapters c ON c.id=cs.chapter_id WHERE cs.book_id=?`, bookId),
    row => row.summary, row => row.chapter_idx);
  }
  if (hasTable(db, 'rolling_summaries')) {
    scan('rolling_summary', all(db, 'SELECT content FROM rolling_summaries WHERE book_id=?', bookId), row => row.content);
  }
  if (hasTable(db, 'facts')) {
    scan('fact', all(db, `SELECT subject, predicate, object, note, source_chapter
      FROM facts WHERE book_id=? AND status='active'`, bookId),
    row => `${row.subject || ''} ${row.predicate || ''} ${row.object || ''}`, row => row.source_chapter);
  }
  if (hasTable(db, 'memory_entries')) {
    scan('narrative_memory', all(db, 'SELECT content, chapter FROM memory_entries WHERE book_id=?', bookId),
      row => row.content, row => row.chapter);
  }
  if (hasTable(db, 'characters')) {
    const fields = ['name', 'card_json', 'state_json', 'secret', 'arc', 'relation']
      .filter(column => hasColumn(db, 'characters', column));
    scan('character_memory', all(db, `SELECT ${fields.join(', ')} FROM characters WHERE book_id=?`, bookId),
      row => fields.map(field => row[field] || '').join(' '));
  }
  if (hasTable(db, 'chapter_settlements')) {
    scan('settlement', all(db, 'SELECT result_json FROM chapter_settlements WHERE book_id=?', bookId), row => {
      try {
        const result = JSON.parse(row.result_json || '{}');
        return `${result.summary || ''} ${result.rolling_update || ''}`;
      } catch { return ''; }
    });
  }
  return { ok: findings.length === 0, findings };
}

/** V0.97.2：总卷数、阶段与结局交付必须是一套单调且唯一的结构。 */
export function checkLifecycleIntegrity(db, book) {
  if (!hasTable(db, 'volumes') || !hasColumn(db, 'volumes', 'outline_json')) return { ok: true, enabled: false, issues: [] };
  const volumes = all(db, 'SELECT idx, title, goal, outline_json FROM volumes WHERE book_id=? ORDER BY idx', book.id);
  let settings = {};
  try { settings = JSON.parse(book.settings_json || '{}') || {}; } catch { settings = {}; }
  const configuredTotal = Number(settings.longformLifecycle?.plannedVolumes || settings.plannedVolumes || settings.volumeCount) || null;
  const hasLifecycleData = Number(settings.longformLifecycle?.version) >= 1
    || Boolean(settings.longformLifecycle?.enforce)
    || volumes.some(row => /lifecycle_stage|ending_delivery/.test(String(row.outline_json || '')));
  if (!hasLifecycleData) return { ok: true, enabled: false, configuredTotal, actualTotal: volumes.at(-1)?.idx || 0, issues: [] };
  const issues = lifecycleStructureIssues(volumes, { configuredTotal });
  return { ok: issues.length === 0, enabled: true, configuredTotal, actualTotal: volumes.at(-1)?.idx || 0, issues };
}

/** 成长目标和悬案状态不能多年停在同一句话上；只报债务，不替作者判定升官或定罪。 */
export function checkNarrativeStalls(db, bookId, chapters) {
  if (!hasTable(db, 'characters')) return { ok: true, longRunningStates: [], growthDebts: [] };
  const characterFields = ['name', 'first_chapter', 'last_chapter', 'state_json', 'card_json', 'abilities_json', 'tier']
    .filter(column => hasColumn(db, 'characters', column));
  const characters = all(db, `SELECT ${characterFields.join(', ')} FROM characters WHERE book_id=?`, bookId);
  const currentChapter = [...chapters]
    .filter(chapter => !['planned', 'outlined'].includes(chapter.status))
    .sort((a, b) => Number(b.idx) - Number(a.idx))[0] || chapters.at(-1);
  const currentIdx = Number(currentChapter?.idx) || 0;
  const longRunningStates = detectLongRunningStateDebts(characters, { chapterIdx: currentIdx, threshold: 8 });
  const growthDebts = [];
  if (currentChapter?.volume_id && hasTable(db, 'volumes') && hasColumn(db, 'volumes', 'goal')) {
    const volume = db.prepare('SELECT id, goal, outline_json FROM volumes WHERE id=?').get(currentChapter.volume_id);
    if (volume) {
      const volumeChapters = chapters.filter(chapter => chapter.volume_id === volume.id).sort((a, b) => Number(a.idx) - Number(b.idx));
      const position = volumeChapters.findIndex(chapter => chapter.id === currentChapter.id);
      const progress = position >= 0 && volumeChapters.length ? (position + 1) / volumeChapters.length : 0;
      const protagonist = characters.find(character => character.tier === 'protagonist') || characters[0];
      let role = '';
      try { role = JSON.parse(protagonist?.card_json || '{}')?.role || ''; } catch { /* ignore */ }
      growthDebts.push(...detectGrowthPlanDrift({
        volumeGoal: `${volume.goal || ''} ${volume.outline_json || ''}`,
        currentState: `${protagonist?.state_json || ''} ${role} ${protagonist?.abilities_json || ''}`,
        volumeProgress: progress,
      }));
    }
  }
  return { ok: longRunningStates.length === 0 && growthDebts.length === 0, currentChapter: currentIdx, longRunningStates, growthDebts };
}

/** V0.97.1 全书风格回归：新章质量门原本只在生成当时运行，旧章更新后没有统一复扫。
 * doctor 现在按章节顺序重跑本地规则、场景连续性、跨章复读/比喻与起收式轮换。
 * medium/high 进入 blocking；low 仅作 advisories，不把意象型标题等软提示伪装成硬故障。 */
function checkStyleQuality(db, bookId, chapters, texts) {
  const sceneMap = new Map(chapters.map(chapter => [chapter.id, []]));
  if (hasTable(db, 'scenes')) {
    for (const row of all(db, `
      SELECT s.chapter_id, s.idx, COALESCE(s.content, '') AS content
      FROM scenes s JOIN chapters c ON c.id=s.chapter_id
      WHERE c.book_id=? ORDER BY c.idx, s.idx
    `, bookId)) {
      if (!sceneMap.has(row.chapter_id)) sceneMap.set(row.chapter_id, []);
      sceneMap.get(row.chapter_id).push(row);
    }
  }
  const ordered = [...chapters].sort((a, b) => Number(a.idx) - Number(b.idx));
  const prior = [];
  const blocking = [];
  const advisories = [];
  for (const chapter of ordered) {
    const text = texts.get(chapter.id) || '';
    const previous = prior.slice(-12);
    const issues = [
      ...runLocalRules(text),
      ...runSceneContinuityRules(sceneMap.get(chapter.id) || []),
      ...detectCrossChapterRepeats(text, previous),
      ...detectCrossChapterMetaphors(text, previous),
      ...detectChapterOpenerTic(text.slice(0, 300), previous.map(row => row.text.slice(0, 300))),
      ...detectChapterEndingTic(text, previous.map(row => row.text.slice(-500))),
    ];
    for (const issue of issues) {
      const finding = {
        chapterIdx: chapter.idx,
        severity: issue.severity,
        type: issue.type,
        quote: issue.quote,
        issue: issue.issue,
      };
      if (['medium', 'high'].includes(issue.severity)) blocking.push(finding);
      else advisories.push(finding);
    }
    prior.push({ idx: chapter.idx, text });
  }
  return { ok: blocking.length === 0, blocking, advisories };
}

function auditBook(db, book, options) {
  const chapters = all(db, `
    SELECT id, book_id, volume_id, idx, title, status, word_count, outline_json
    FROM chapters WHERE book_id=? ORDER BY idx, id
  `, book.id);
  const texts = chapterTexts(db, chapters);
  const assignments = checkVolumeAssignments(db, book.id, chapters);
  const checks = {
    chapterIndex: checkChapterIndex(chapters),
    volumeAssignments: assignments,
    volumeExportOrder: checkVolumeExportOrder(chapters, assignments.volumes),
    wordCounts: checkWordCounts(chapters, texts, options),
    summaries: checkSummaries(db, book.id, chapters),
    health: checkHealth(db, book.id, chapters, options),
    similarity: checkSimilarity(chapters, texts, options),
    entityTypes: checkEntityTypes(db, book.id),
    staleMaterials: checkStaleMaterials(db, book.id, chapters, texts, options),
    draftedStall: checkDraftedStall(chapters, texts), // V0.97：残章/过程态滞留（推流前必清）
    similarNames: checkSimilarNames(db, book.id), // V0.97：角色相似名清查（读者分不清谁是谁）
    proseStructure: checkProseStructure(db, book.id, chapters, texts), // V0.97.1：断句/物证过顺/数字报表化
    styleQuality: checkStyleQuality(db, book.id, chapters, texts), // V0.97.1：旧章也跑全书风格回归
    storyMemoryPurity: checkStoryMemoryPurity(db, book.id), // V0.97.2：编辑意见不得伪装成事实/摘要
    lifecycleIntegrity: checkLifecycleIntegrity(db, book), // V0.97.2：卷数与终局唯一性
    narrativeStalls: checkNarrativeStalls(db, book.id, chapters), // V0.97.2：成长/调查长线冻结
    openingAssets: checkOpeningAssets(db, book.id), // V0.98：开篇资产隔离、时效、契约和发布闭环
    titleShapes: checkTitleShapes(chapters), // V0.107：章名句式族观察面（只读度量，不拦截）
    characterVitality: checkCharacterVitality(db, book.id), // V0.108：人物活性键覆盖率观察面（只读）
  };
  delete checks.volumeAssignments.volumes;
  return {
    id: book.id,
    title: book.title || '',
    genre: book.genre || '',
    metrics: {
      chapters: chapters.length,
      writtenChapters: chapters.filter(ch => DONE_STATUSES.has(ch.status)).length,
      sceneChars: [...texts.values()].reduce((sum, text) => sum + textLength(text), 0),
    },
    issueChecks: issueCount(checks),
    checks,
    recoveryCandidates: recoveryCandidates(db, book.id, chapters, texts, options),
  };
}

/**
 * 对 SQLite 小说库执行只读体检。
 * @param {string} dbPath SQLite 文件路径
 * @param {object} overrides 可覆盖诊断阈值（测试/离线批处理）
 */
export function auditDatabase(dbPath = DEFAULT_DB, overrides = {}) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`数据库不存在：${resolved}`);
  const options = { ...DEFAULTS, ...overrides };
  const db = new DatabaseSync(resolved, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    const integrityValues = integrityRows.map(row => String(Object.values(row)[0] || ''));
    const integrityCheck = integrityValues.length === 1 ? integrityValues[0] : integrityValues;
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (!hasTable(db, 'books') || !hasTable(db, 'chapters')) throw new Error('不是受支持的小说数据库：缺少 books/chapters 表');
    const books = hasColumn(db, 'books', 'settings_json')
      ? all(db, 'SELECT id, title, genre, settings_json FROM books ORDER BY id')
      : all(db, 'SELECT id, title, genre, NULL AS settings_json FROM books ORDER BY id');
    const reports = books.map(book => auditBook(db, book, options));
    return {
      schemaVersion: 1,
      tool: 'novel-data-doctor',
      mode: 'read-only',
      dbPath: resolved,
      generatedAt: new Date().toISOString(),
      database: { integrityCheck, foreignKeyViolations },
      summary: {
        books: reports.length,
        booksWithIssues: reports.filter(book => book.issueChecks > 0).length,
        issueChecks: reports.reduce((sum, book) => sum + book.issueChecks, 0),
        recoveryCandidates: reports.reduce((sum, book) => sum + book.recoveryCandidates.length, 0),
      },
      books: reports,
    };
  } finally {
    db.close();
  }
}

export function parseCliArgs(argv) {
  let dbPath = DEFAULT_DB;
  let pretty = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pretty') {
      pretty = true;
    } else if (arg === '--db') {
      if (!argv[i + 1]) throw new Error('--db 需要一个 SQLite 路径');
      dbPath = argv[++i];
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { dbPath, pretty };
}

function runCli() {
  try {
    const { dbPath, pretty } = parseCliArgs(process.argv.slice(2));
    const report = auditDatabase(dbPath);
    process.stdout.write(`${JSON.stringify(report, null, pretty ? 2 : 0)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) runCli();
