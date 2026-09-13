// server/engine/planning/opening_intervention.js —— V0.98 开篇候选编排、隔离存储与匿名冷读
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../../db/store.js';
import { runTask, resolveTaskRoute } from '../../llm/router.js';
import { assembleReviewMessages } from '../../llm/cache.js';
import { extractJSON } from '../../util/json.js';
import {
  openingStrategyInstruction, openingCandidateInstruction,
  openingCandidateLengthRepairInstruction,
  openingCandidateAuditInstruction, openingCandidateCompareInstruction,
} from '../prompts.js';
import { openingDiagnosisStatus, collectOpeningInput, diagnoseOpening } from './opening_diagnosis.js';
import { storyPromiseProfileText, storyPromiseStatus } from './story_promise.js';
import { platformGuidanceText } from '../../data/platform_guidance.js';
import { fanqieGenreProfileText } from '../../data/fanqie_genre_profiles.js';
import { historicalEventKeysFromOutline, historicalEventTargetsFromOutline, HISTORICAL_EVENT_ANCHORS } from '../../data/history.js';
import { applyValidatedScenePatch } from '../quality/polish.js';
import { currentStoryYear } from '../narrative/history.js';
import { appendHistory } from '../../llm/cache.js';
import { estimateChineseChars } from '../../llm/tokenizer.js';
import { transitionChapterStatus } from '../pipeline/chapter_status.js';

const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
const compactLength = value => String(value || '').replace(/\s+/g, '').length;
const REPAIR_KINDS = new Set(['head_rewrite', 'chapter1_cold_open', 'standalone_prologue']);
const OPENING_READER_PLACEMENTS = new Set(['prepend_chapter1', 'before_chapter1']);
const FRONT_MATTER_CHECKS = Object.freeze([
  'authorEditorAccepted', 'reviewPassed', 'readerDirectoryOrderCorrect',
  'previousNextNavigationCorrect', 'chapterDataAttributionVisible', 'reorderAfterPublishTested',
]);
const PLAN_FIELDS = [
  'kind', 'strategy_family', 'entry_signature', 'creative_hypothesis', 'entry_time', 'first_actor',
  'immediate_problem', 'first_choice', 'first_state_change', 'strongest_axis', 'transition_plan',
];

function openingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** 独立楔子的平台实测必须六项齐全；单独写 frontMatter=verified 不构成证据。 */
export function platformFrontMatterCompatibility(input = {}) {
  const checks = input?.checks && typeof input.checks === 'object' ? input.checks : {};
  const missing = FRONT_MATTER_CHECKS.filter(key => checks[key] !== true);
  const checkedAt = Number(input?.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) missing.unshift('checkedAt');
  if (input?.frontMatter !== 'verified') missing.unshift('frontMatter');
  return {
    verified: missing.length === 0,
    status: missing.length === 0 ? 'verified' : 'unverified',
    checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : null,
    checks: Object.fromEntries(FRONT_MATTER_CHECKS.map(key => [key, checks[key] === true])),
    missing: [...new Set(missing)],
  };
}

function currentDiagnosis(bookId) {
  const status = openingDiagnosisStatus(bookId);
  return status.exists && !status.stale ? status.report : null;
}

function firstChapterContext(bookId) {
  const chapter = store.chapters.list(bookId).slice().sort((a, b) => a.idx - b.idx)[0] || null;
  const scenes = chapter ? store.scenes.list(chapter.id).slice().sort((a, b) => a.idx - b.idx) : [];
  return {
    chapter,
    scenes,
    firstScene: scenes[0] || null,
    text: chapter ? store.chapters.fullText(chapter.id) || '' : '',
  };
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function eventKeysFrom(value) {
  if (!value || typeof value !== 'object') return [];
  return [...stringList(value.event_keys), ...stringList(value.eventKeys), ...stringList(value.target_event_key)];
}

function openingContract(asset, bookId, { requireApplied = true } = {}) {
  if (!asset || asset.book_id !== bookId || (requireApplied && asset.status !== 'applied')) return null;
  const raw = safeJson(asset.contract_json, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const promiseKey = String(raw.promise_key || '').trim();
  const targetEventKey = String(raw.target_event_key || '').trim();
  const targetVolumeId = String(raw.target_volume_id || '').trim();
  const targetYear = Number(raw.target_year);
  const volume = targetVolumeId ? store.volumes.get(targetVolumeId) : null;
  if (!/^[a-z0-9][a-z0-9:._-]{2,159}$/i.test(promiseKey)
    || !/^[a-z0-9][a-z0-9:._-]{2,199}$/i.test(targetEventKey)
    || !Number.isInteger(targetYear) || targetYear < 1 || targetYear > 9999
    || !volume || volume.book_id !== bookId
    || !contractTargetGrounded(bookId, { target_volume_id: targetVolumeId, target_year: targetYear,
      target_event_key: targetEventKey })) return null;
  return {
    ...raw,
    promise_key: promiseKey,
    target_event_key: targetEventKey,
    target_volume_id: targetVolumeId,
    target_year: targetYear,
    public_question: String(raw.public_question || '').trim().slice(0, 300),
    known_outcome: String(raw.known_outcome || '').trim().slice(0, 300),
    forbidden_early_explanation: stringList(raw.forbidden_early_explanation).slice(0, 12),
  };
}

/**
 * 取得某一真实章节的历史坐标和稳定事件键。章节细纲优先，其次卷纲；
 * 不从楔子正文、摘要或模糊自然语言猜事件。
 */
export function historicalFrameForChapter(bookId, chapterIdx) {
  const chapters = store.chapters.list(bookId);
  const chapter = chapters.find(item => Number(item.idx) === Number(chapterIdx)) || null;
  const chapterOutline = chapter ? (store.chapters.outline(chapter.id) || {}) : {};
  const volume = chapter?.volume_id ? store.volumes.get(chapter.volume_id) : null;
  const volumeOutline = safeJson(volume?.outline_json, {});
  const previousYears = chapters
    .filter(item => Number(item.idx) <= Number(chapterIdx))
    .map(item => Number(store.chapters.outline(item.id)?.year))
    .filter(Number.isInteger);
  const year = Number(chapterOutline.year) || Number(volumeOutline.year) || Number(volumeOutline.start_year)
    || previousYears.at(-1) || Number(currentStoryYear(bookId)) || null;
  const eventKeys = [...new Set([
    ...eventKeysFrom(volumeOutline), ...eventKeysFrom(chapterOutline),
    ...historicalEventKeysFromOutline(volumeOutline, year),
    ...historicalEventKeysFromOutline(chapterOutline, year),
  ])];
  return {
    chapter, volume, year: Number.isInteger(year) ? year : null,
    eventKeys,
  };
}

function proseLeak(value, prose, minLength = 20) {
  const compactValue = String(value || '').replace(/\s+/g, '');
  const compactProse = String(prose || '').replace(/\s+/g, '');
  if (compactValue.length < minLength || compactProse.length < minLength) return false;
  for (let i = 0; i <= compactProse.length - minLength; i++) {
    if (compactValue.includes(compactProse.slice(i, i + minLength))) return true;
  }
  return false;
}

/**
 * 后续创作只能看见“读者已经知道什么/何时允许兑现”的结构合同。
 * opening asset 的 reader prose 永远不进入这个返回值。
 */
export function openingReaderContractText(bookId, chapterIdx) {
  const asset = store.openingAssets.active(bookId);
  const contract = openingContract(asset, bookId);
  if (!contract) return '';
  const frame = historicalFrameForChapter(bookId, chapterIdx);
  const clean = value => proseLeak(value, asset.content) ? '' : String(value || '').trim();
  const publicQuestion = clean(contract.public_question) || '前置层留下的问题须由正篇因果回答';
  const knownOutcome = clean(contract.known_outcome);
  const forbidden = contract.forbidden_early_explanation.map(clean).filter(Boolean);
  const beforeTarget = !Number.isInteger(frame.year) || frame.year < contract.target_year;
  const atTarget = frame.year === contract.target_year
    && frame.volume?.id === contract.target_volume_id
    && frame.eventKeys.includes(contract.target_event_key);
  const lines = [
    '【读者前置契约（只给结构，不得复写前置正文）】',
    `承诺键：${contract.promise_key}`,
    `读者已知并在追问：${publicQuestion}`,
    knownOutcome ? `读者已知结果边界：${knownOutcome}` : '',
    `目标年份：${contract.target_year}`,
    `目标事件键：${contract.target_event_key}`,
    `目标卷ID：${contract.target_volume_id}`,
    `当前历史坐标：${frame.year || '未确定'}`,
    '共同纪律：只能使用以上结构信息；不得猜测、摘抄或复写任何前置正文句子。',
  ];
  if (contract.status === 'fulfilled') {
    lines.push(`兑现状态：已在真实第${Number(contract.fulfilled_chapter) || '?'}章兑现；后续不得把同一答案重新当悬念或机械复述。`);
  } else if (beforeTarget) {
    lines.push('时间边界：目标事件尚未到达；不得让人物预知结果，不得用旁白提前解释因果，不得把读者已知误写成人物已知。');
    if (forbidden.length) lines.push(`提前解释禁区：${forbidden.join('；')}`);
  } else if (atTarget) {
    lines.push('兑现要求：本章须用当前剧情自身的行动、代价和因果链兑现目标事件；不得机械复刻前置层画面或句子。');
  } else {
    lines.push('事件锚尚未同时命中真实卷、年份与事件键：不得伪报兑现，也不得另造一场相似事件硬凑答案。');
  }
  lines.push('审校要求：目标年前检查人物预知、旁白提前解释和前置句式照抄；目标章检查因果兑现，不能把文案重复当兑现。');
  return lines.filter(Boolean).join('\n');
}

/** 仅在已结算真实章节精确命中卷、年份、事件键且审校通过时，幂等兑现读者契约。 */
export function fulfillOpeningReaderContract(bookId, chapterId, { auditPassed = false } = {}) {
  const asset = store.openingAssets.active(bookId);
  const contract = openingContract(asset, bookId);
  const chapter = store.chapters.get(chapterId);
  if (!contract || !chapter || chapter.book_id !== bookId) return { fulfilled: false, reason: 'missing_contract_or_chapter' };
  if (contract.status === 'fulfilled') {
    return {
      fulfilled: true, idempotent: true, promiseKey: contract.promise_key,
      chapterIdx: Number(contract.fulfilled_chapter) || null,
    };
  }
  if (auditPassed !== true) return { fulfilled: false, reason: 'audit_not_passed' };
  if (!['done', 'completed'].includes(String(chapter.status || ''))) {
    return { fulfilled: false, reason: 'chapter_not_settled' };
  }
  const frame = historicalFrameForChapter(bookId, chapter.idx);
  if (frame.volume?.id !== contract.target_volume_id) return { fulfilled: false, reason: 'target_volume_mismatch' };
  if (frame.year !== contract.target_year) return { fulfilled: false, reason: 'target_year_mismatch' };
  if (!frame.eventKeys.includes(contract.target_event_key)) return { fulfilled: false, reason: 'target_event_mismatch' };
  const updated = {
    ...safeJson(asset.contract_json, {}), status: 'fulfilled', fulfilled_chapter: Number(chapter.idx),
    fulfilled_at: Date.now(),
  };
  store.openingAssets.update(asset.id, { contract: updated });
  return {
    fulfilled: true, idempotent: false, promiseKey: contract.promise_key,
    chapterIdx: Number(chapter.idx), assetId: asset.id,
  };
}

export function candidateBudget(kind, settings = {}) {
  const defaults = {
    head_rewrite: { preferred: [600, 1000], hardMax: 1600, soft: true },
    // V0.98.3：200—700 → 300—800（神开局工艺：第一屏冲突+代价+回切钩需要足量篇幅；调研 docs/番茄神开局与楔子工艺调研报告.md）
    chapter1_cold_open: { preferred: [300, 800], hardMax: 1000, soft: true },
    standalone_prologue: { preferred: [700, 1600], hardMax: 2400, soft: true },
    chapter1_draft: { preferred: [1600, 5000], hardMax: 8000, soft: true },
  };
  const custom = settings?.[kind];
  return custom ? structuredClone(custom) : structuredClone(defaults[kind] || { preferred: [0, 8000], hardMax: 12000, soft: true });
}

export function validateCandidateLength(kind, content, settings = {}) {
  const budget = candidateBudget(kind, settings);
  const chars = compactLength(content);
  if (chars > budget.hardMax) return { ok: false, severity: 'error', chars, budget, reason: `超过硬上限 ${budget.hardMax}` };
  if (chars < budget.preferred[0] || chars > budget.preferred[1]) {
    return { ok: true, severity: 'note', chars, budget, reason: `偏离建议区间 ${budget.preferred[0]}—${budget.preferred[1]}` };
  }
  return { ok: true, severity: 'ok', chars, budget, reason: '' };
}

/** 最后一层只负责保证物理上限；优先停在完整句末，绝不把裁剪结果静默当成可采用成稿。 */
function fitCandidateToHardMax(content, hardMax) {
  const source = String(content || '').trim();
  const limit = Math.max(1, Math.floor(Number(hardMax) || 0));
  if (compactLength(source) <= limit) return source;
  const prefixWithin = (value, maxChars) => {
    let used = 0;
    let rawEnd = 0;
    for (const char of String(value || '')) {
      const width = /\s/u.test(char) ? 0 : char.length;
      if (used + width > maxChars) break;
      used += width;
      rawEnd += char.length;
    }
    return String(value || '').slice(0, rawEnd);
  };
  const prefix = prefixWithin(source, limit).trimEnd();
  const boundaries = [...prefix.matchAll(/(?:……|[。！？!?；;])(?:[”’』」】）》）]*)/gu)];
  const minimumNaturalEnd = Math.max(1, Math.floor(limit * 0.65));
  for (let index = boundaries.length - 1; index >= 0; index--) {
    const match = boundaries[index];
    const natural = prefix.slice(0, match.index + match[0].length).trimEnd();
    if (compactLength(natural) >= minimumNaturalEnd) return natural;
  }
  if (limit === 1) return prefixWithin(source, 1).trim();
  const body = prefixWithin(source, limit - 1).trimEnd().replace(/[，、：:；;…—-]+$/u, '');
  return compactLength(body) < limit && body ? `${body}。` : prefixWithin(body, limit).trim();
}

export function coldReadJudgment(value = {}) {
  const axis = value.strongest_axis && typeof value.strongest_axis === 'object'
    ? value.strongest_axis : { kind: '', strength: 0 };
  return {
    ...value,
    strongest_axis: { kind: String(axis.kind || ''), strength: Number(axis.strength || 0) },
    hard_failures: Array.isArray(value.hard_failures) ? value.hard_failures : [],
    issues: Array.isArray(value.issues) ? value.issues : [],
  };
}

/** 一个明确强轴即可进入胜选区；不平均所有维度，也不要求处处高分。 */
export function candidateCanWin(value) {
  const judgment = coldReadJudgment(value);
  const hasHighIssue = judgment.issues.some(issue => issue?.severity === 'high');
  return judgment.hard_failures.length === 0 && !hasHighIssue
    && judgment.strongest_axis.kind && judgment.strongest_axis.strength >= 3;
}

/**
 * V0.98.10：审校引文本地重定位——免费模型常把引文里的段落空白规范化（少一个空行/空格），
 * 逐字 includes 会误判。先精确匹配，再按去空白投影重定位并映射回原文切片（只取真实存在的子串）。
 */
function reanchorAuditQuote(text, quote) {
  const source = String(text || '');
  const q = String(quote || '').trim();
  if (!q) return null;
  if (source.includes(q)) return q;
  const compact = value => String(value).replace(/\s+/g, '');
  const compactText = compact(source);
  const compactQuote = compact(q);
  if (!compactQuote) return null;
  const at = compactText.indexOf(compactQuote);
  if (at < 0) return null;
  let count = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < source.length; i++) {
    if (/\s/.test(source[i])) continue;
    if (count === at) start = i;
    if (count === at + compactQuote.length - 1) { end = i + 1; break; }
    count++;
  }
  if (start < 0 || end < 0) return null;
  return source.slice(start, end);
}

/** V0.98.10：审校证据治理与诊断同源——坏引文/缺根因改法的单条意见只隔离不废整份
 *  （审校契约本身规定“没有引文只能作为 note”）；结构缺失（无最强轴）仍整份 fail-closed。 */
function validateCandidateAudit(value, candidate) {
  const audit = coldReadJudgment(value);
  if (!audit.strongest_axis.kind || !Number.isFinite(audit.strongest_axis.strength)
    || audit.strongest_axis.strength < 0 || audit.strongest_axis.strength > 4) {
    throw openingError('OPENING_CANDIDATE_AUDIT_INVALID', '候选审校缺少 0—4 的最强吸引轴证据');
  }
  const text = String(candidate.content || '');
  const isolated = [];
  const hardFailures = [];
  for (const [index, failure] of (Array.isArray(audit.hard_failures) ? audit.hard_failures : []).entries()) {
    const quote = reanchorAuditQuote(text, failure?.quote);
    if (!String(failure?.code || '').trim() || !String(failure?.reason || '').trim() || !quote) {
      isolated.push({ kind: 'hard_failure', index, severity: 'high', item: failure || null, code: 'quote_unlocatable' });
      continue;
    }
    hardFailures.push({ ...failure, quote });
  }
  const issues = [];
  for (const [index, issue] of audit.issues.entries()) {
    if (!['high', 'medium', 'low'].includes(issue?.severity)) {
      isolated.push({ kind: 'issue', index, severity: String(issue?.severity || ''), item: issue || null, code: 'severity_invalid' });
      continue;
    }
    if (issue.severity === 'low') { issues.push(issue); continue; }
    const quote = reanchorAuditQuote(text, issue?.quote);
    if (!quote || !String(issue?.cause || '').trim() || !String(issue?.smallest_fix || '').trim()) {
      // 审校契约：没有可核对引文的意见只是 note，不触发修改——证据不足的高/中意见隔离而非报废整份。
      isolated.push({ kind: 'issue', index, severity: issue.severity, item: issue || null, code: 'quote_unlocatable' });
      continue;
    }
    issues.push({ ...issue, quote });
  }
  return { ...audit, hard_failures: hardFailures, issues, ...(isolated.length ? { isolated_issues: isolated } : {}) };
}

function chineseInteger(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 99) return '';
  if (number < 10) return digits[number];
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  return `${tens === 1 ? '' : digits[tens]}十${ones ? digits[ones] : ''}`;
}

/** 远期冷开场必须在 asset 正文内部定位回第一章，不能依赖导出器硬拼或 transition_plan 自报。 */
function coldOpenTransitionIssue(bookId, candidate) {
  if (candidate.kind !== 'chapter1_cold_open') return null;
  const contract = safeJson(candidate.contract || candidate.contract_json, {});
  const targetYear = Number(contract.target_year);
  const frame = historicalFrameForChapter(bookId, 1);
  if (!Number.isInteger(targetYear) || !Number.isInteger(frame.year) || targetYear <= frame.year) return null;
  const delta = targetYear - frame.year;
  const chapterOutline = frame.chapter ? (store.chapters.outline(frame.chapter.id) || {}) : {};
  const volumeOutline = safeJson(frame.volume?.outline_json, {});
  const outlineText = JSON.stringify([chapterOutline, volumeOutline]);
  const eraMarkers = outlineText.match(/[\u4e00-\u9fff]{2,4}(?:元|[一二三四五六七八九十]{1,3})年/g) || [];
  const markers = [...new Set([
    String(frame.year), `${delta}年前`, `${chineseInteger(delta)}年前`,
    String(chapterOutline.era_year || ''), String(volumeOutline.era_year || ''), ...eraMarkers,
  ].map(item => item.trim()).filter(Boolean))];
  const content = String(candidate.content || '').trim();
  // 回切必须发生在前置段收束处；开头顺手提到旧年份只是一句回忆，不能冒充转场。
  const transitionTail = content.slice(-Math.min(180, content.length));
  if (markers.some(marker => transitionTail.includes(marker))) return null;
  const quote = transitionTail.slice(-Math.min(60, transitionTail.length));
  return {
    code: 'cold_open_return_unlocated', severity: 'high', quote,
    cause: `前置层从${targetYear}年结束时没有在正文中定位回第1章的${frame.year}年`,
    smallest_fix: `在前置段末用“${delta}年前”或真实年号自然回切，再接原第1章`,
  };
}

/** 契约目标事件的真实信号词集合：注册锚点信号 + 目标年份 + 目标卷名。 */
function coldOpenTargetMarkers(contract) {
  const targetYear = Number(contract.target_year);
  const eventKey = String(contract.target_event_key || '').trim();
  if (!Number.isInteger(targetYear) || !eventKey) return null;
  const anchor = HISTORICAL_EVENT_ANCHORS.find(item => item.eventKey === eventKey) || null;
  const volume = contract.target_volume_id ? store.volumes.get(String(contract.target_volume_id)) : null;
  const markers = [
    String(targetYear),
    ...(anchor ? anchor.signals : []),
    String(volume?.title || ''),
  ].map(item => item.trim()).filter(Boolean);
  return markers.length ? markers : null;
}

/**
 * V0.98.2 前置层必须锚定真实目标事件：契约年份、注册事件信号词或目标卷标题至少出现一个。
 * 本作事故实证：未注入契约时模型把第一章夜戏重写当成“冷开场”，全文没有任何 1259 年事件信号。
 */
function coldOpenTargetGroundedIssue(bookId, candidate) {
  if (candidate.kind !== 'chapter1_cold_open') return null;
  const contract = safeJson(candidate.contract || candidate.contract_json, {});
  const markers = coldOpenTargetMarkers(contract);
  if (!markers) return null;
  const content = String(candidate.content || '');
  if (!content.trim()) return null;
  const targetYear = Number(contract.target_year);
  const eventKey = String(contract.target_event_key || '').trim();
  if (markers.some(marker => content.includes(marker))) return null;
  return {
    code: 'cold_open_target_ungrounded', severity: 'high',
    quote: content.trim().slice(0, 60),
    cause: `前置层没有出现目标事件（${targetYear}年 ${eventKey}）的任何真实信号（年份/事件信号词/目标卷名均缺席），它不是未来场面`,
    smallest_fix: `以目标卷纲与史实锚点重写：写${targetYear}年事件现场的真实年份、地名或人名，保留回切第一章的年差定位`,
  };
}

/**
 * V0.98.3 神开局·第一屏锚定：事件信号词必须出现在前 120 个非空白字内。
 * 番茄免费推流的生死线在第一屏——信号迟到等于把高能场面写成了气氛铺垫（调研 docs/番茄神开局与楔子工艺调研报告.md）。
 */
function coldOpenFirstScreenIssue(bookId, candidate) {
  if (candidate.kind !== 'chapter1_cold_open') return null;
  const contract = safeJson(candidate.contract || candidate.contract_json, {});
  const markers = coldOpenTargetMarkers(contract);
  if (!markers) return null;
  const firstScreen = compactText(candidate.content).slice(0, 120);
  if (!firstScreen) return null;
  if (markers.some(marker => firstScreen.includes(marker))) return null;
  const targetYear = Number(contract.target_year);
  return {
    code: 'cold_open_first_screen_unanchored', severity: 'high',
    quote: String(candidate.content || '').trim().slice(0, 60),
    cause: `目标事件信号（${markers.slice(0, 3).join('、')}等）没有出现在前置层第一屏 120 字内——开场在铺气氛，高能场面迟到了`,
    smallest_fix: `把事件现场（${targetYear}年真实地名/人名/年号）提到前三句：先让砲石、军令或追兵进场，再写风和天色`,
  };
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, '');
}

/** 12 字滑窗重叠率：独立书写的新场面接近 0，把第一章场景搬去开头会大量命中。 */
function coldOpenChapterOverlapRatio(bookId, candidate) {
  const content = compactText(candidate.content);
  if (content.length < 60) return 0;
  const chapter = compactText(firstChapterContext(bookId).text);
  if (chapter.length < 60) return 0;
  const SHINGLE = 12;
  const chapterShingles = new Set();
  for (let i = 0; i + SHINGLE <= chapter.length; i++) chapterShingles.add(chapter.slice(i, i + SHINGLE));
  let hits = 0;
  let total = 0;
  for (let i = 0; i + SHINGLE <= content.length; i += SHINGLE) {
    total++;
    if (chapterShingles.has(content.slice(i, i + SHINGLE))) hits++;
  }
  return total ? hits / total : 0;
}

/** V0.98.2 前置层与第一章正文同质 = 章内重排冒充未来楔子，直接禁止采用。 */
function coldOpenChapterEchoIssue(bookId, candidate) {
  if (candidate.kind !== 'chapter1_cold_open') return null;
  const ratio = coldOpenChapterOverlapRatio(bookId, candidate);
  if (ratio < 0.3) return null;
  const content = String(candidate.content || '').trim();
  return {
    code: 'cold_open_reuses_chapter1', severity: 'high',
    quote: content.slice(0, 60),
    cause: `前置层与第一章正文高度同质（重合率 ${Math.round(ratio * 100)}%），它在对第一章重新排序而不是呈现未来事件`,
    smallest_fix: '以目标卷的真实未来事件重写前置层；第一章原文保持原样，前置层只呈现目标年份的高能一瞬',
  };
}

/**
 * V0.98.12 主角在场判废的依据名：角色卡 protagonist 优先，其次第一章第一场景视点。
 * 单字名不参与匹配（防误匹配常见字），无可信主角名时判废自动跳过。
 */
export function openingProtagonistNames(bookId) {
  const fromCards = store.characters.list(bookId)
    .filter(character => character.tier === 'protagonist')
    .map(character => String(character.name || '').trim())
    .filter(name => name.length >= 2);
  const first = firstChapterContext(bookId);
  const fromPov = String(first.firstScene?.pov || '').trim();
  return [...new Set([...fromCards, ...(fromPov.length >= 2 ? [fromPov] : [])])];
}

/**
 * V0.98.12 主角在场本地判废：念稿式楔子（俯瞰式全景陈述、主角不在场）此前只靠 LLM
 * 审校软判，免费模型屡次漏网——第一屏 120 非空白字内必须出现主角姓名并参与动作。
 */
function coldOpenProtagonistAbsentIssue(bookId, candidate) {
  if (candidate.kind !== 'chapter1_cold_open') return null;
  const names = openingProtagonistNames(bookId);
  if (!names.length) return null;
  const firstScreen = compactText(candidate.content).slice(0, 120);
  if (!firstScreen) return null;
  if (names.some(name => firstScreen.includes(name))) return null;
  const content = String(candidate.content || '').trim();
  return {
    code: 'cold_open_protagonist_absent', severity: 'high',
    quote: content.slice(0, 60),
    cause: `前 120 字没有主角（${names.join('、')}）出现并行动——事件在俯瞰式自述，读者追不到人，这是纪录片念稿式开场`,
    smallest_fix: `把 ${names[0]} 放到第一屏：先写他当下的动作、决定或承受（如“${names[0]}拽开挡路的传令兵”），再由他的眼睛带出局势`,
  };
}

function mergeDeterministicCandidateAudit(bookId, candidate, audit) {
  const issues = [
    coldOpenTransitionIssue(bookId, candidate),
    coldOpenTargetGroundedIssue(bookId, candidate),
    coldOpenFirstScreenIssue(bookId, candidate),
    coldOpenChapterEchoIssue(bookId, candidate),
    coldOpenProtagonistAbsentIssue(bookId, candidate),
  ];
  if (candidate.length_recovery?.method === 'local_boundary_guard') {
    const quote = String(candidate.content || '').trim().slice(-60);
    issues.push({
      code: 'opening_length_local_fallback', severity: 'high', quote,
      cause: `模型两轮压缩后仍超过 ${candidate.length_recovery.hard_max} 字，系统仅在完整句边界执行了安全裁剪`,
      smallest_fix: '重新生成一版上限内的完整候选，保留动作因果与结尾转接，删除重复描写后再参加比较',
    });
  }
  const additions = issues.filter(Boolean).filter(issue => !audit.issues.some(item => item?.code === issue.code));
  return additions.length ? { ...audit, issues: [...audit.issues, ...additions] } : audit;
}

function openingAuditBlockers(value) {
  const audit = safeJson(value, {});
  const hardFailures = Array.isArray(audit.hard_failures) ? audit.hard_failures : [];
  const highIssues = Array.isArray(audit.issues) ? audit.issues.filter(issue => issue?.severity === 'high') : [];
  return [...hardFailures.map(item => ({ ...item, source: 'hard_failure' })),
    ...highIssues.map(item => ({ ...item, source: 'high_issue' }))];
}

function dedupeStrategies(strategies) {
  const seen = new Set();
  return strategies.filter(strategy => {
    const signature = String(strategy.entry_signature || `${strategy.kind}|${strategy.family || strategy.strategy_family}`);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/**
 * V0.98.2 确定性策略蓝图。远期高能楔子（chapter1_cold_open）是本功能的产品目标：
 * 只要本地解析出可达的真实远期契约目标，它就是默认核心策略，与开篇健康度无关；
 * 顺叙强化（head_rewrite）降级为「诊断证明开篇弱」时的救济路径，不再冒充楔子。
 */
export function planOpeningStrategies(profile, diagnosis, {
  hasPublishedText = false, allowStandalonePrologue = false, platformCompatibility = {},
  contractTarget = null,
} = {}) {
  if (!hasPublishedText) {
    return dedupeStrategies([
      { kind: 'chapter1_draft', family: 'chronological_choice', strategy_family: 'chronological_choice', entry_signature: 'present|protagonist|choice|state-change', why: '在顺叙中让人物先行动' },
      { kind: 'chapter1_draft', family: 'in_medias_res', strategy_family: 'in_medias_res', entry_signature: 'danger|protagonist|response|new-danger', why: '从已经发生的眼前困局切入' },
      { kind: 'chapter1_draft', family: 'relationship_choice', strategy_family: 'relationship_choice', entry_signature: 'relationship|protagonist|protect|bond-change', why: '从一段关系迫出的选择切入' },
    ]);
  }
  const strategies = [
    { kind: 'baseline', family: 'existing_text', strategy_family: 'existing_text', entry_signature: 'existing-text', why: '真实原稿作为零改动对照' },
  ];
  if (contractTarget) {
    strategies.push({
      kind: 'chapter1_cold_open', family: 'future_result_present_question',
      strategy_family: 'future_result_present_question',
      entry_signature: `future:${contractTarget.target_year}|protagonist|unanswered-cause|return-present`,
      creative_hypothesis: '把目标卷的真实高能一瞬放到读者第一屏，用「他怎样走到这里」的因果缺口驱动追读',
      entry_time: `${contractTarget.target_year}年目标事件现场`, first_actor: '事件时刻的主角',
      immediate_problem: '目标事件中的眼前危局与必须护住的人',
      first_choice: '在事件现场作出符合成长轨迹的守护选择',
      first_state_change: '读者确认长期承诺真实可达，但不知道因果路径',
      strongest_axis: 'question',
      transition_plan: '以事件现场的动作或旧物意象回切第一章真实年份，紧接原第一章正文',
      why: '推流期先立住远期长期承诺；事件由本地契约目标锚定，不由模型即兴',
    });
  }
  const weakOpening = Number(diagnosis?.rubric?.promise_alignment?.score) <= 2
    || String(diagnosis?.recommendation?.kind || '') === 'head_rewrite'
    || diagnosis?.strategies?.some(item => item.kind === 'head_rewrite' && item.required === true);
  if (weakOpening) {
    strategies.push({
      kind: 'head_rewrite', family: 'chronological_choice', strategy_family: 'chronological_choice',
      entry_signature: 'present|protagonist|choice|state-change',
      creative_hypothesis: '诊断显示开篇承诺不清：在原时空更早显出人物的典型行动方式',
      entry_time: '第一章原时空', first_actor: '第一章主角',
      immediate_problem: '原稿进入逻辑中模糊的眼前问题', first_choice: '更早作出属于人物的选择',
      first_state_change: '第一章自身的问题更早成立', strongest_axis: 'character',
      transition_plan: '保留第一章其余场景原样接回',
      why: '弱开篇救济；健康开篇不需要章内重写',
    });
  }
  const specialNeed = diagnosis?.recommendation?.kind === 'standalone_prologue'
    || diagnosis?.strategies?.some(item => item.kind === 'standalone_prologue' && item.required === true);
  if (allowStandalonePrologue && platformFrontMatterCompatibility(platformCompatibility).verified && specialNeed) {
    strategies.push({
      kind: 'standalone_prologue', family: 'separate_front_matter', strategy_family: 'separate_front_matter',
      entry_signature: 'front-matter|other-time|question|chapter-one', why: '承担第一章确实无法承担的特殊前置信息',
    });
  }
  return dedupeStrategies(strategies);
}

function baselineCandidate(bookId) {
  const first = firstChapterContext(bookId);
  if (!first.chapter || !first.text.trim()) return null;
  return {
    candidate_id: 'baseline', kind: 'baseline', placement: 'existing_text', strategy_family: 'existing_text',
    entry_signature: `baseline:${hash(first.text)}`, creative_hypothesis: '保留真实原稿，作为所有干预方案的零改动对照',
    content: first.text, reader_text: first.text, chapter_id: first.chapter.id,
    generator_model: 'human-existing-text', length: compactLength(first.text),
  };
}

function validatePlan(candidate, { mode, seenSignatures, settings, diagnosis }) {
  if (!candidate || typeof candidate !== 'object') throw openingError('OPENING_CANDIDATE_INVALID', '候选不是对象');
  for (const field of PLAN_FIELDS) {
    if (!String(candidate[field] || '').trim()) throw openingError('OPENING_CANDIDATE_INVALID', `候选缺少 ${field}`);
  }
  if (mode === 'create' && candidate.kind !== 'chapter1_draft') {
    throw openingError('OPENING_CANDIDATE_INVALID', '新书候选必须通过正常第一章流程落库');
  }
  if (mode === 'repair' && !REPAIR_KINDS.has(candidate.kind)) {
    throw openingError('OPENING_CANDIDATE_INVALID', `存量候选 kind 无效：${candidate.kind}`);
  }
  const signature = String(candidate.entry_signature).trim();
  if (seenSignatures.has(signature)) throw openingError('OPENING_CANDIDATE_DUPLICATE', `候选进入逻辑重复：${signature}`);
  seenSignatures.add(signature);
  const length = validateCandidateLength(candidate.kind, candidate.content, settings?.candidateBudgets || {});
  if (!length.ok) throw openingError('OPENING_CANDIDATE_TOO_LONG', `${candidate.kind} ${length.reason}`);
  if (candidate.kind === 'standalone_prologue') {
    if (!platformFrontMatterCompatibility(settings?.platformCompatibility).verified) {
      throw openingError('OPENING_FRONT_MATTER_UNVERIFIED', '独立楔子的目录、审核与阅读顺序尚未完成平台实测');
    }
    const specialNeed = diagnosis?.recommendation?.kind === 'standalone_prologue'
      || diagnosis?.strategies?.some(item => item.kind === 'standalone_prologue' && item.required === true);
    if (!settings?.allowStandalonePrologue || !specialNeed) {
      throw openingError('OPENING_STANDALONE_NOT_JUSTIFIED', '诊断未证明第一章无法承担该特殊功能');
    }
  }
  return { ...structuredClone(candidate), length_check: length };
}

function normalizeRepairAnchors(candidate, first) {
  if (candidate.kind !== 'head_rewrite') return candidate;
  const scene = store.scenes.get(candidate.anchor_scene_id);
  if (!scene || scene.chapter_id !== first.chapter?.id) throw openingError('OPENING_PATCH_ANCHOR_INVALID', '顺叙强化候选必须锚定第一章真实场景');
  const source = String(scene.content || '');
  const start = Number(candidate.anchor_start);
  const end = Number(candidate.anchor_end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) {
    throw openingError('OPENING_PATCH_ANCHOR_INVALID', '顺叙强化候选字符范围无效');
  }
  if (source.slice(start, end) !== String(candidate.source_excerpt || '')) {
    throw openingError('OPENING_PATCH_ANCHOR_INVALID', '顺叙强化候选原文范围不匹配');
  }
  if (hash(source) !== candidate.source_hash) throw openingError('OPENING_PATCH_STALE', '顺叙强化候选源场景哈希已过期');
  return candidate;
}

function validatedContractTarget(bookId, target) {
  if (!target) return null;
  const volume = store.volumes.get(String(target.target_volume_id || ''));
  const targetYear = Number(target.target_year);
  const targetEventKey = String(target.target_event_key || '').trim();
  const promiseKey = String(target.promise_key || '').trim();
  if (!volume || volume.book_id !== bookId
    || !Number.isInteger(targetYear) || targetYear < 1 || targetYear > 9999
    || !/^[a-z0-9][a-z0-9:._-]{2,199}$/i.test(targetEventKey)
    || !/^[a-z0-9][a-z0-9:._-]{2,159}$/i.test(promiseKey)
    || !contractTargetGrounded(bookId, { target_volume_id: volume.id, target_year: targetYear,
      target_event_key: targetEventKey })) {
    throw openingError('OPENING_CONTRACT_TARGET_INVALID', '读者契约目标卷、年份、事件键或承诺键无效');
  }
  return {
    promise_key: promiseKey, target_event_key: targetEventKey, target_year: targetYear,
    target_volume_id: volume.id,
  };
}

function volumeTargetEvidence(bookId, volume) {
  const outline = safeJson(volume?.outline_json, {});
  const chapterOutlines = store.chapters.listByVolume(volume?.id || '').map(chapter => store.chapters.outline(chapter.id) || {});
  const years = [Number(outline.year), Number(outline.start_year), Number(outline.end_year),
    ...chapterOutlines.map(item => Number(item.year))].filter(Number.isInteger);
  const targets = [...new Map([
    ...historicalEventTargetsFromOutline(outline),
    ...chapterOutlines.flatMap(historicalEventTargetsFromOutline),
  ].map(target => [`${target.eventKey}\u0000${target.year}`, target])).values()];
  const eventKeys = [...new Set(targets.map(target => target.eventKey))];
  return { outline, years, eventKeys, targets };
}

function contractTargetGrounded(bookId, target) {
  const volume = store.volumes.get(String(target?.target_volume_id || ''));
  if (!volume || volume.book_id !== bookId) return false;
  const year = Number(target.target_year);
  const eventKey = String(target.target_event_key || '');
  const evidence = volumeTargetEvidence(bookId, volume);
  const start = Number(evidence.outline.start_year);
  const end = Number(evidence.outline.end_year);
  const yearGrounded = evidence.years.includes(year)
    || (Number.isInteger(start) && Number.isInteger(end) && year >= start && year <= end);
  return yearGrounded && evidence.targets.some(target => target.year === year && target.eventKey === eventKey);
}

/** 优先使用作者配置，其次使用卷纲稳定事件键；后续卷优先于开篇卷的局部事件。 */
export function inferOpeningContractTarget(bookId) {
  const configured = store.books.settings(bookId)?.openingIntervention?.contractTarget;
  if (configured) return validatedContractTarget(bookId, configured);
  const ordered = store.volumes.list(bookId).slice().sort((a, b) => Number(a.idx) - Number(b.idx));
  const targetOrder = [...ordered.filter(volume => Number(volume.idx) > 1), ...ordered.filter(volume => Number(volume.idx) <= 1)];
  for (const volume of targetOrder) {
    const evidence = volumeTargetEvidence(bookId, volume);
    for (const target of evidence.targets) {
      const candidate = {
        target_year: target.year, target_event_key: target.eventKey,
        promise_key: `opening:${target.year}:${hash(target.eventKey).slice(0, 16)}`,
        target_volume_id: volume.id,
      };
      // 章纲可以提前引用未来事件作为伏笔；只有年份与事件在本卷同时落地时才可作为兑现卷。
      if (contractTargetGrounded(bookId, candidate)) return validatedContractTarget(bookId, candidate);
    }
  }
  return null;
}

/**
 * V0.98.2 生成前 grounding：把已解析的契约目标连同目标卷材料一起交给写作与审校指令。
 * 契约不再是生成后附加的校验数据——远期楔子必须从这个真实事件里写出来。
 */
export function openingContractEventContext(bookId, target) {
  if (!target) return null;
  const volume = store.volumes.get(String(target.target_volume_id || ''));
  if (!volume || volume.book_id !== bookId) return null;
  const outline = safeJson(volume.outline_json, {});
  const anchor = HISTORICAL_EVENT_ANCHORS.find(item => item.eventKey === target.target_event_key) || null;
  const frame = historicalFrameForChapter(bookId, 1);
  const openingYear = Number.isInteger(frame.year) ? frame.year : null;
  return {
    ...target,
    volume_title: String(volume.title || ''),
    volume_summary: String(outline.summary || '').slice(0, 500),
    volume_goal: String(outline.goal || '').slice(0, 300),
    historical_anchor: String(outline.historical_anchor || '').slice(0, 300),
    volume_years: [Number(outline.start_year), Number(outline.end_year)].filter(Number.isInteger),
    event_signals: anchor ? [...anchor.signals] : [],
    protagonist_names: openingProtagonistNames(bookId),
    opening_year: openingYear,
    year_delta: openingYear && Number.isInteger(target.target_year) ? target.target_year - openingYear : null,
  };
}

function candidateReaderText(candidate, first) {
  if (candidate.kind === 'head_rewrite') {
    const scene = store.scenes.get(candidate.anchor_scene_id);
    const replacement = String(candidate.content || '');
    const patchedScene = scene.content.slice(0, candidate.anchor_start) + replacement + scene.content.slice(candidate.anchor_end);
    const sceneTexts = first.scenes.map(item => item.id === scene.id ? patchedScene : String(item.content || ''));
    return sceneTexts.join('\n\n');
  }
  if (candidate.kind === 'chapter1_cold_open') return `${String(candidate.content || '').trim()}\n\n${first.text.trimStart()}`;
  if (candidate.kind === 'standalone_prologue') return `楔子\n\n${String(candidate.content || '').trim()}\n\n${first.text.trimStart()}`;
  return String(candidate.content || '');
}

async function requestStrategies(bookId, input, { mode, signal }) {
  const instruction = openingStrategyInstruction({ ...input, mode });
  const result = await runTask({
    task: 'opening_strategy', bookId, jsonMode: true, signal,
    messages: assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]),
  });
  const parsed = extractJSON(result.content);
  if (!parsed || !Array.isArray(parsed.strategies)) throw openingError('OPENING_STRATEGY_INVALID', '开篇结构构思结果无 strategies');
  return { strategies: parsed.strategies, model: result.route?.model || result.model || '' };
}

async function requestCandidate(bookId, input, strategy, { signal, onEvent }) {
  const instruction = openingCandidateInstruction({ ...input, strategy, budget: candidateBudget(strategy.kind, input.settings?.candidateBudgets) });
  let parsed = null;
  let result = null;
  // V0.98.8：免费档存在瞬时坏响应（空正文或无 JSON 的纯散文，finish=stop）——解析失败静默重试
  // 一次再判失败；两次都坏才 OPENING_CANDIDATE_INVALID fail-closed，不把单次抖动炸给作者。
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = await runTask({
      task: 'opening_candidate', bookId, jsonMode: true, signal,
      messages: assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]),
    });
    parsed = extractJSON(result.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) break;
    parsed = null;
    if (attempt === 1) onEvent?.({ type: 'opening_stage', step: 'drafting', detail: '候选 JSON 解析失败，原样重试 1 次' });
  }
  if (!parsed) throw openingError('OPENING_CANDIDATE_INVALID', '开篇正文候选无法解析');
  const candidate = { ...strategy, ...parsed };
  if (candidate.kind === 'head_rewrite' && input.firstScene) {
    const source = String(input.firstScene.content || '');
    Object.assign(candidate, {
      anchor_scene_id: input.firstScene.id, anchor_start: 0, anchor_end: source.length,
      source_excerpt: source, source_hash: hash(source),
    });
  }
  return { candidate, model: result.route?.model || result.model || '' };
}

async function requestCandidateLengthRepair(bookId, input, candidate, budget, source, attempt, { signal }) {
  const strategy = Object.fromEntries(PLAN_FIELDS.map(field => [field, candidate[field]]));
  const instruction = openingCandidateLengthRepairInstruction({
    strategy, content: source,
    sourceExcerpt: candidate.kind === 'head_rewrite' ? String(input.firstScene?.content || '') : '',
    budget, currentChars: compactLength(source), attempt,
    contractEvent: ['chapter1_cold_open', 'standalone_prologue'].includes(candidate.kind) ? input.contractEvent : null,
  });
  const result = await runTask({
    task: 'opening_candidate', bookId, jsonMode: true, signal,
    routeOverride: {
      thinking: 'disabled', reasoningEffort: 'low', temperature: 0.25,
      maxTokens: Math.max(3000, Math.min(12000, Math.ceil(Number(budget.hardMax || 8000) * 2.2))),
    },
    messages: assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]),
  });
  const parsed = extractJSON(result.content);
  const content = String(parsed?.content || '').trim();
  if (!content) throw openingError('OPENING_CANDIDATE_LENGTH_REPAIR_INVALID', '开篇候选压缩结果为空或无法解析');
  return { content, model: result.route?.model || result.model || '' };
}

/** 模型违反硬长度时立即在当前候选内收敛，避免写完整批后才报错并丢弃全部结果。 */
async function conformGeneratedCandidateLength(bookId, input, candidate, { signal, onEvent }) {
  const settings = input.settings?.candidateBudgets || {};
  const initial = validateCandidateLength(candidate.kind, candidate.content, settings);
  if (initial.ok) return candidate;
  const originalChars = initial.chars;
  const attempts = [];
  let source = String(candidate.content || '').trim();
  let shortest = source;
  for (let attempt = 1; attempt <= 2; attempt++) {
    onEvent?.({
      type: 'opening_stage', step: 'conforming_length',
      detail: `${candidate.strategy_family || candidate.kind} 超过 ${initial.budget.hardMax} 字，压缩收敛 ${attempt}/2`,
    });
    try {
      const repaired = await requestCandidateLengthRepair(bookId, input, candidate, initial.budget, source, attempt, { signal });
      const check = validateCandidateLength(candidate.kind, repaired.content, settings);
      attempts.push({ attempt, chars: check.chars, ok: check.ok });
      if (compactLength(repaired.content) < compactLength(shortest)) shortest = repaired.content;
      if (check.ok) {
        return {
          ...candidate, content: repaired.content,
          length_recovery: {
            method: 'model_compaction', attempts, original_chars: originalChars,
            final_chars: check.chars, hard_max: initial.budget.hardMax, model: repaired.model,
          },
        };
      }
      source = repaired.content;
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
      attempts.push({ attempt, chars: compactLength(source), ok: false, error: error?.code || error?.message || String(error) });
    }
  }
  const content = fitCandidateToHardMax(shortest, initial.budget.hardMax);
  const final = validateCandidateLength(candidate.kind, content, settings);
  if (!content || !final.ok) throw openingError('OPENING_CANDIDATE_TOO_LONG', `${candidate.kind} 长度安全收敛失败`);
  return {
    ...candidate, content,
    length_recovery: {
      method: 'local_boundary_guard', attempts, original_chars: originalChars,
      final_chars: final.chars, hard_max: initial.budget.hardMax,
    },
  };
}

async function auditCandidate(bookId, input, candidate, { signal }) {
  const instruction = openingCandidateAuditInstruction({ ...input, candidate });
  const result = await runTask({
    task: 'opening_candidate_audit', bookId, jsonMode: true, signal,
    messages: assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]),
  });
  const audit = extractJSON(result.content);
  if (!audit || !Array.isArray(audit.hard_failures) || !audit.strongest_axis) {
    throw openingError('OPENING_CANDIDATE_AUDIT_INVALID', '开篇候选审校结果无效');
  }
  return { audit, model: result.route?.model || result.model || '' };
}

function assetPayload(candidate, generatorModel, audit, fingerprints = {}) {
  const placement = {
    head_rewrite: 'scene_patch', chapter1_cold_open: 'prepend_chapter1', standalone_prologue: 'before_chapter1',
  }[candidate.kind];
  return {
    kind: candidate.kind, placement, title: candidate.title || '', content: candidate.content,
    anchor_scene_id: candidate.anchor_scene_id, anchor_start: candidate.anchor_start, anchor_end: candidate.anchor_end,
    source_excerpt: candidate.source_excerpt, source_hash: candidate.source_hash,
    contract: candidate.contract || safeJson(candidate.contract_json, {}), audit,
    rank: {
      entry_signature: candidate.entry_signature, strategy_family: candidate.strategy_family,
      generator_model: generatorModel, length_check: candidate.length_check,
      length_recovery: candidate.length_recovery || null,
      source_fingerprint: fingerprints.source_fingerprint || '',
      promise_profile_fingerprint: fingerprints.promise_profile_fingerprint || '',
      diagnosis_fingerprint: fingerprints.diagnosis_fingerprint || '',
    },
    creative_hypothesis: candidate.creative_hypothesis,
  };
}

/** 先验证整批结构与锚点，再一次性落库，避免五选一只写进了前两个。 */
export async function composeOpeningCandidates(bookId, {
  mode = 'repair', signal, onEvent, data, allowStandalonePrologue, strategyPlans, contractTarget,
} = {}) {
  if (!['repair', 'create'].includes(mode)) throw openingError('OPENING_MODE_INVALID', `未知模式：${mode}`);
  const book = store.books.get(bookId);
  if (!book) throw openingError('OPENING_BOOK_MISSING', '作品不存在');
  const promise = storyPromiseStatus(bookId);
  if (!promise.exists || promise.stale) throw openingError('STORY_PROMISE_REQUIRED', promise.exists ? '创作宪章已过期' : '创作宪章未完成');
  const diagnosis = mode === 'repair' ? currentDiagnosis(bookId) : null;
  const first = firstChapterContext(bookId);
  if (mode === 'repair' && (!first.chapter || !first.text.trim())) throw openingError('OPENING_TEXT_REQUIRED', '存量修复需要第一章实际正文');
  const settings = store.books.settings(bookId);
  const interventionSettings = {
    ...(settings.openingIntervention || {}),
    ...(allowStandalonePrologue !== undefined ? { allowStandalonePrologue } : {}),
  };
  const route = promise.profile?.texture?.route || 'general';
  // 契约目标完全由本地书纲决定，必须在任何付费模型调用前完成校验（V0.98.1），
  // 并且从 V0.98.2 起作为生成材料前置注入——远期楔子必须从这个真实事件里写出来。
  const target = validatedContractTarget(bookId, contractTarget || inferOpeningContractTarget(bookId));
  const contractEvent = openingContractEventContext(bookId, target);
  const input = {
    book, profile: promise.profile, storyPromise: storyPromiseProfileText(promise.profile), diagnosis,
    currentOpening: first.text, firstScene: first.firstScene,
    contractTarget: target, contractEvent,
    platformGuidance: platformGuidanceText(book.platform), genreProfile: fanqieGenreProfileText(book.genre, route),
    settings: interventionSettings,
  };
  const collected = collectOpeningInput(bookId);
  const fingerprints = {
    source_fingerprint: collected.source_fingerprint,
    promise_profile_fingerprint: collected.promise_profile_fingerprint,
    diagnosis_fingerprint: diagnosis?.source_fingerprint || '',
  };

  let rawCandidates = data?.candidates;
  let generatorModel = resolveTaskRoute('opening_candidate', settings).model;
  if (!rawCandidates) {
    // V0.98.2：存量修复不再让模型即兴设计策略——确定性蓝图直接决定「远期高能楔子为核心、
    // 顺叙强化仅弱开篇救济」，省掉一次策略调用，也杜绝“把第一章内容搬去开头”的跑偏方向。
    let planned;
    if (Array.isArray(strategyPlans)) {
      planned = { strategies: structuredClone(strategyPlans), model: generatorModel };
    } else if (mode === 'create') {
      onEvent?.({ type: 'opening_stage', step: 'planning', detail: '先构思不同进入逻辑' });
      planned = await requestStrategies(bookId, input, { mode, signal });
    } else {
      onEvent?.({
        type: 'opening_stage', step: 'planning',
        detail: target
          ? `确定性蓝图：远期高能楔子（${target.target_year}年目标事件）${Number(diagnosis?.rubric?.promise_alignment?.score) <= 2 ? ' + 弱开篇顺叙救济' : ''}`
          : '确定性蓝图：无远期契约目标，仅诊断驱动救济',
      });
      planned = {
        strategies: planOpeningStrategies(promise.profile, diagnosis, {
          hasPublishedText: true,
          allowStandalonePrologue: interventionSettings.allowStandalonePrologue,
          platformCompatibility: interventionSettings.platformCompatibility,
          contractTarget: target,
        }),
        model: generatorModel,
      };
    }
    generatorModel = planned.model || generatorModel;
    const generatable = planned.strategies.filter(strategy => strategy.kind !== 'baseline');
    if (mode === 'repair' && generatable.length === 0) {
      const baselineOnly = baselineCandidate(bookId);
      onEvent?.({
        type: 'opening_stage', step: 'candidates_ready',
        detail: target ? '诊断未发现开篇弱点且无其他策略，保留原稿' : '未解析到可达的远期契约目标，保留原稿',
      });
      return {
        mode, candidates: baselineOnly ? [baselineOnly] : [], generator_model: generatorModel,
        skipped: true, reason: target ? 'no_weak_opening_rescue_needed' : 'no_grounded_contract_target',
      };
    }
    rawCandidates = [];
    for (const strategy of generatable) {
      onEvent?.({ type: 'opening_stage', step: 'drafting', detail: `写作候选：${strategy.strategy_family || strategy.kind}` });
      const written = await requestCandidate(bookId, input, strategy, { signal, onEvent });
      generatorModel = written.model || generatorModel;
      rawCandidates.push(await conformGeneratedCandidateLength(bookId, input, written.candidate, { signal, onEvent }));
    }
  }
  if (!Array.isArray(rawCandidates)) throw openingError('OPENING_CANDIDATE_INVALID', '候选列表不是数组');
  if (target) rawCandidates = rawCandidates.map(candidate => ['chapter1_cold_open', 'standalone_prologue'].includes(candidate?.kind)
    ? { ...candidate, contract: { ...safeJson(candidate.contract || candidate.contract_json, {}), ...target } }
    : candidate);

  const seenSignatures = new Set();
  const baseline = mode === 'repair' ? baselineCandidate(bookId) : null;
  if (baseline) seenSignatures.add(baseline.entry_signature);
  const validated = rawCandidates
    .filter(candidate => candidate?.kind !== 'baseline')
    .map(candidate => validatePlan(candidate, { mode, seenSignatures, settings: interventionSettings, diagnosis }))
    .map(candidate => mode === 'repair' ? normalizeRepairAnchors(candidate, first) : candidate);
  if (mode === 'create') {
    if (validated.length < 3 || new Set(validated.map(item => item.strategy_family)).size < 3) {
      throw openingError('OPENING_CANDIDATE_DIVERSITY', '新书至少需要三种不同的进入逻辑');
    }
  } else {
    // V0.98.2：存量修复允许「原稿 + 一个远期楔子」的精简对比；但仍禁止同策略族重复冒充多方案。
    const families = new Set(validated.map(item => item.strategy_family));
    if (validated.length < 1 || families.size !== validated.length) {
      throw openingError('OPENING_CANDIDATE_DIVERSITY', '存量修复至少需要一个与原稿不同的进入逻辑，且策略族不得重复');
    }
  }

  const audited = [];
  for (const [index, candidate] of validated.entries()) {
    onEvent?.({
      type: 'opening_stage', step: 'auditing',
      detail: `审校候选 ${index + 1}/${validated.length}：${candidate.strategy_family || candidate.kind}`,
    });
    let audit = candidate.audit;
    let auditModel = '';
    if (!audit && data) audit = { hard_failures: [], issues: [], strongest_axis: { kind: candidate.strongest_axis, strength: 3 } };
    if (!audit) {
      const result = await auditCandidate(bookId, input, candidate, { signal });
      audit = result.audit;
      auditModel = result.model;
    }
    const validatedAudit = validateCandidateAudit(audit, candidate);
    audited.push({ ...candidate, audit: mergeDeterministicCandidateAudit(bookId, candidate, validatedAudit), audit_model: auditModel });
  }

  const resultCandidates = [];
  if (baseline) resultCandidates.push(baseline);
  if (mode === 'create') {
    for (const candidate of audited) {
      resultCandidates.push({
        ...candidate, candidate_id: `draft:${hash(candidate.entry_signature)}`, reader_text: candidate.content,
        generator_model: generatorModel, ...fingerprints,
      });
    }
  } else {
    store.transaction(() => {
      for (const candidate of audited) {
        const asset = store.openingAssets.create(bookId, assetPayload(candidate, generatorModel, candidate.audit, fingerprints));
        store.openingAssets.transition(asset.id, 'audited');
        resultCandidates.push({
          ...candidate, candidate_id: asset.id, asset_id: asset.id, placement: asset.placement,
          reader_text: candidateReaderText(candidate, first), generator_model: generatorModel,
        });
      }
    });
  }
  onEvent?.({ type: 'opening_stage', step: 'candidates_ready', detail: `生成 ${resultCandidates.length} 个可读版本` });
  return { mode, candidates: resultCandidates, generator_model: generatorModel };
}

export function openingAssetFreshness(bookId, assetOrId) {
  const asset = typeof assetOrId === 'string' ? store.openingAssets.get(assetOrId) : assetOrId;
  if (!asset || asset.book_id !== bookId) return { fresh: false, reason: 'not_owned' };
  if (asset.status === 'applied') return { fresh: true, reason: 'already_applied' };
  const rank = safeJson(asset.rank_json, {});
  let current;
  try { current = collectOpeningInput(bookId); } catch (error) {
    return { fresh: false, reason: error?.code || 'input_unavailable' };
  }
  if (!rank.source_fingerprint || rank.source_fingerprint !== current.source_fingerprint) {
    return { fresh: false, reason: 'source_changed', expected: rank.source_fingerprint || '', current: current.source_fingerprint };
  }
  if (!rank.promise_profile_fingerprint || rank.promise_profile_fingerprint !== current.promise_profile_fingerprint) {
    return { fresh: false, reason: 'promise_changed', expected: rank.promise_profile_fingerprint || '', current: current.promise_profile_fingerprint };
  }
  if (asset.placement === 'scene_patch') {
    const scene = store.scenes.get(asset.anchor_scene_id);
    if (!scene || hash(scene.content) !== asset.source_hash
      || String(scene.content || '').slice(asset.anchor_start, asset.anchor_end) !== asset.source_excerpt) {
      return { fresh: false, reason: 'patch_source_changed' };
    }
  }
  return { fresh: true, reason: 'current' };
}

function ownedAsset(bookId, id, { requireFresh = true } = {}) {
  const asset = store.openingAssets.get(id);
  if (!asset || asset.book_id !== bookId) throw openingError('OPENING_ASSET_NOT_OWNED', `候选资产不属于当前作品：${id}`);
  if (!['audited', 'selected', 'applied'].includes(asset.status)) throw openingError('OPENING_ASSET_NOT_AUDITED', `候选尚未完成审校：${id}`);
  if (requireFresh) {
    const freshness = openingAssetFreshness(bookId, asset);
    if (!freshness.fresh) throw openingError('OPENING_ASSET_STALE', `候选已过期：${freshness.reason}`);
  }
  return asset;
}

function assetCandidate(asset, first) {
  const rank = safeJson(asset.rank_json, {});
  const raw = {
    kind: asset.kind, content: asset.content, anchor_scene_id: asset.anchor_scene_id,
    anchor_start: asset.anchor_start, anchor_end: asset.anchor_end,
    contract: safeJson(asset.contract_json, {}),
  };
  return {
    candidate_id: asset.id, asset_id: asset.id, kind: asset.kind, placement: asset.placement,
    strategy_family: rank.strategy_family || '', entry_signature: rank.entry_signature || '',
    creative_hypothesis: asset.creative_hypothesis || '', content: asset.content,
    reader_text: candidateReaderText(raw, first), generator_model: rank.generator_model || '',
    audit: safeJson(asset.audit_json, {}),
  };
}

function deterministicShuffle(items, seed) {
  return items.slice().sort((a, b) => hash(`${seed}:${a.candidate_id}`).localeCompare(hash(`${seed}:${b.candidate_id}`)));
}

async function runBlindOpeningJudge(bookId, candidates, input, judgeModel, round, signal) {
  const anonymous = candidates.map((candidate, index) => ({ label: `版本${String.fromCharCode(65 + index)}`, text: candidate.reader_text }));
  const instruction = openingCandidateCompareInstruction({ ...input, candidates: anonymous, round });
  const result = await runTask({
    task: 'opening_candidate_compare', bookId, jsonMode: true, signal,
    routeOverride: judgeModel ? { model: judgeModel } : undefined,
    messages: assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]),
  });
  const parsed = extractJSON(result.content);
  if (!parsed || !parsed.winner_label || !parsed.judgments) throw openingError('OPENING_COMPARE_INVALID', '匿名比较结果结构无效');
  const byLabel = new Map(anonymous.map((item, index) => [item.label, candidates[index].candidate_id]));
  const judgments = {};
  for (const [label, judgment] of Object.entries(parsed.judgments)) {
    const id = byLabel.get(label);
    if (id) judgments[id] = judgment;
  }
  return { winner_id: byLabel.get(parsed.winner_label), reason: parsed.reason || '', judgments };
}

function validateCompareRound(round, candidateIds, index) {
  if (!round || !candidateIds.has(round.winner_id) || !round.judgments || typeof round.judgments !== 'object') {
    throw openingError('OPENING_COMPARE_INVALID', `第 ${index + 1} 轮匿名比较结构无效`);
  }
  const judgments = {};
  for (const id of candidateIds) judgments[id] = coldReadJudgment(round.judgments[id] || {});
  return { winner_id: round.winner_id, reason: String(round.reason || ''), judgments };
}

export async function compareOpeningCandidates(bookId, assetIds, { data, signal, onEvent } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw openingError('OPENING_BOOK_MISSING', '作品不存在');
  if (!Array.isArray(assetIds) || new Set(assetIds).size !== assetIds.length) throw openingError('OPENING_COMPARE_INVALID', '候选资产列表无效或重复');
  const first = firstChapterContext(bookId);
  const baseline = baselineCandidate(bookId);
  if (!baseline) throw openingError('OPENING_TEXT_REQUIRED', '匿名比较需要真实第一章原稿');
  const assets = assetIds.map(id => ownedAsset(bookId, id));
  const candidates = [baseline, ...assets.map(asset => assetCandidate(asset, first))];
  const promise = storyPromiseStatus(bookId);
  if (!promise.exists || promise.stale) throw openingError('STORY_PROMISE_REQUIRED', '创作宪章缺失或已过期');
  const settings = store.books.settings(bookId);
  const intervention = settings.openingIntervention || {};
  const defaultJudgeModel = resolveTaskRoute('opening_candidate_compare', settings).model;
  const judgeModel = String(intervention.judgeModel || defaultJudgeModel);
  const route = promise.profile?.texture?.route || 'general';
  const input = {
    book, storyPromise: storyPromiseProfileText(promise.profile), diagnosis: currentDiagnosis(bookId),
    platformGuidance: platformGuidanceText(book.platform), genreProfile: fanqieGenreProfileText(book.genre, route),
  };
  let rawRounds = data;
  if (!rawRounds) {
    rawRounds = [];
    for (let round = 1; round <= 2; round++) {
      onEvent?.({ type: 'opening_stage', step: 'comparing', detail: `匿名比较第 ${round}/2 轮` });
      const order = deterministicShuffle(candidates, `${bookId}:round:${round}`);
      rawRounds.push(await runBlindOpeningJudge(bookId, order, input, intervention.judgeModel, round, signal));
    }
  } else {
    for (let round = 1; round <= 2; round++) {
      onEvent?.({ type: 'opening_stage', step: 'comparing', detail: `匿名比较第 ${round}/2 轮` });
    }
  }
  if (!Array.isArray(rawRounds) || rawRounds.length !== 2) throw openingError('OPENING_COMPARE_INVALID', '匿名比较必须恰好两轮');
  const candidateIds = new Set(candidates.map(candidate => candidate.candidate_id));
  const rounds = rawRounds.map((round, index) => validateCompareRound(round, candidateIds, index));
  const sameWinner = rounds[0].winner_id === rounds[1].winner_id;
  const winnerId = sameWinner ? rounds[0].winner_id : null;
  const winnerJudgments = winnerId ? rounds.map(round => round.judgments[winnerId]) : [];
  const sameAxis = winnerJudgments.length === 2
    && winnerJudgments[0].strongest_axis.kind
    && winnerJudgments[0].strongest_axis.kind === winnerJudgments[1].strongest_axis.kind;
  const winnerAsset = winnerId ? assets.find(asset => asset.id === winnerId) : null;
  const winnerBlockers = winnerAsset ? openingAuditBlockers(winnerAsset.audit_json) : [];
  const evidenceStable = sameWinner && sameAxis && rounds.every(round => round.reason.trim())
    && winnerJudgments.every(candidateCanWin) && winnerBlockers.length === 0;
  const generationModels = new Set(assets.map(asset => safeJson(asset.rank_json, {}).generator_model).filter(Boolean));
  const independentJudge = generationModels.size > 0 && [...generationModels].every(model => model !== judgeModel);
  let status = evidenceStable ? 'stable_winner' : 'no_stable_winner';
  if (evidenceStable && !independentJudge) status = 'single_model_advisory';
  const winner = winnerId ? candidates.find(candidate => candidate.candidate_id === winnerId) : null;
  // V0.98.11：比较结果附可读提示——同模型下两轮同胜者只是「仅供参考」而非「没有胜出」，
  // 明确告知作者可手动采用，避免「流程成功但保守不采用」被误读为失败。
  const kindLabel = kind => ({ baseline: '原稿', head_rewrite: '顺叙强化版', chapter1_cold_open: '第一章内嵌楔子版', standalone_prologue: '独立楔子版', chapter1_draft: '第一章草稿' }[kind] || '该方案');
  let message;
  if (status === 'stable_winner') message = `两轮匿名比较稳定胜出：${kindLabel(winner?.kind)}`;
  else if (status === 'single_model_advisory') message = `候选「${kindLabel(winner?.kind)}」两轮均被选为胜者，但生成与裁判同模型、仅作参考，未自动应用——可在下方候选区手动「采用此方案」`;
  else if (sameWinner) message = `两轮同胜者「${kindLabel(winner?.kind)}」，但证据（强轴一致/审校）不齐，未自动应用`;
  else message = '两轮结论不一致，没有稳定胜者，保留原稿';
  const result = {
    status, auto_safe: status === 'stable_winner', winner, message,
    rounds, judge_model: judgeModel, generation_models: [...generationModels],
    blocking_issues: winnerBlockers,
    notice: '模型模拟冷读，不是真实读者或平台结果',
  };
  for (const asset of assets) {
    const rank = safeJson(asset.rank_json, {});
    store.openingAssets.update(asset.id, { rank: { ...rank, comparison: {
      status, winner: winnerId === asset.id, judge_model: judgeModel, rounds,
    } } });
  }
  onEvent?.({ type: 'opening_stage', step: 'compared', detail: status === 'stable_winner' ? '两轮匿名比较得到稳定胜者' : status === 'single_model_advisory' ? '同模型结果仅供参考' : '没有稳定胜者，保留原稿' });
  return result;
}

/** 新书候选尚未落库为 opening asset；同样做两轮乱序冷读，但不会污染正文或记忆。 */
export async function compareDraftOpeningCandidates(bookId, candidates, { data, signal, onEvent } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw openingError('OPENING_BOOK_MISSING', '作品不存在');
  if (!Array.isArray(candidates) || candidates.length < 3) throw openingError('OPENING_COMPARE_INVALID', '新书冷读至少需要三个候选');
  const ids = candidates.map(item => String(item.candidate_id || ''));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw openingError('OPENING_COMPARE_INVALID', '新书候选 ID 缺失或重复');
  const promise = storyPromiseStatus(bookId);
  if (!promise.exists || promise.stale) throw openingError('STORY_PROMISE_REQUIRED', '创作宪章缺失或已过期');
  const settings = store.books.settings(bookId);
  const intervention = settings.openingIntervention || {};
  const defaultJudgeModel = resolveTaskRoute('opening_candidate_compare', settings).model;
  const judgeModel = String(intervention.judgeModel || defaultJudgeModel);
  const route = promise.profile?.texture?.route || 'general';
  const input = {
    book, storyPromise: storyPromiseProfileText(promise.profile), diagnosis: null,
    platformGuidance: platformGuidanceText(book.platform), genreProfile: fanqieGenreProfileText(book.genre, route),
  };
  let rawRounds = data;
  if (!rawRounds) {
    rawRounds = [];
    for (let round = 1; round <= 2; round++) {
      onEvent?.({ type: 'opening_stage', step: 'comparing', detail: `匿名比较第 ${round}/2 轮` });
      const order = deterministicShuffle(candidates, `${bookId}:draft-round:${round}`);
      rawRounds.push(await runBlindOpeningJudge(bookId, order, input, intervention.judgeModel, round, signal));
    }
  } else {
    for (let round = 1; round <= 2; round++) {
      onEvent?.({ type: 'opening_stage', step: 'comparing', detail: `匿名比较第 ${round}/2 轮` });
    }
  }
  if (!Array.isArray(rawRounds) || rawRounds.length !== 2) throw openingError('OPENING_COMPARE_INVALID', '匿名比较必须恰好两轮');
  const candidateIds = new Set(ids);
  const rounds = rawRounds.map((round, index) => validateCompareRound(round, candidateIds, index));
  const sameWinner = rounds[0].winner_id === rounds[1].winner_id;
  const winnerId = sameWinner ? rounds[0].winner_id : null;
  const winnerJudgments = winnerId ? rounds.map(round => round.judgments[winnerId]) : [];
  const sameAxis = winnerJudgments.length === 2
    && winnerJudgments[0].strongest_axis.kind
    && winnerJudgments[0].strongest_axis.kind === winnerJudgments[1].strongest_axis.kind;
  const evidenceStable = sameWinner && sameAxis && rounds.every(round => round.reason.trim())
    && winnerJudgments.every(candidateCanWin);
  const generationModels = new Set(candidates.map(item => item.generator_model).filter(Boolean));
  const independentJudge = generationModels.size > 0 && [...generationModels].every(model => model !== judgeModel);
  let status = evidenceStable ? 'stable_winner' : 'no_stable_winner';
  if (evidenceStable && !independentJudge) status = 'single_model_advisory';
  const result = {
    status, auto_safe: status === 'stable_winner',
    winner: winnerId ? candidates.find(item => item.candidate_id === winnerId) : null,
    rounds, judge_model: judgeModel, generation_models: [...generationModels],
    notice: '模型模拟冷读，不是真实读者或平台结果',
  };
  onEvent?.({ type: 'opening_stage', step: 'cold_reading', detail: status === 'stable_winner'
    ? '两轮跨模型冷读得到稳定第一章方案'
    : status === 'single_model_advisory' ? '同模型冷读仅供参考，未自动采用' : '两轮结论不一致，沿用正常第一章蓝图' });
  return result;
}

/** 新书在第一章落笔前运行；失败由调用方降级，不会创建或清空章节。 */
export async function prepareOpeningBeforeChapterOne(bookId, { signal, onEvent, data } = {}) {
  const chapters = store.chapters.list(bookId);
  if (chapters.some(chapter => String(store.chapters.fullText(chapter.id) || '').trim())) {
    return { ok: true, skipped: true, status: 'existing_text' };
  }
  const collected = collectOpeningInput(bookId);
  const cached = safeJson(store.books.settings(bookId)?.openingIntervention?.prewriteReview, null);
  if (cached?.source_fingerprint === collected.source_fingerprint
    && cached?.promise_profile_fingerprint === collected.promise_profile_fingerprint) {
    return { ok: true, skipped: true, ...cached };
  }
  onEvent?.({ type: 'opening_stage', step: 'strategizing', detail: '生成不同的第一章进入方案' });
  const composed = await composeOpeningCandidates(bookId, { mode: 'create', signal, onEvent, data: data?.compose });
  const comparison = await compareDraftOpeningCandidates(bookId, composed.candidates, {
    signal, onEvent, data: data?.compare,
  });
  const review = {
    status: comparison.status,
    auto_safe: comparison.auto_safe,
    source_fingerprint: collected.source_fingerprint,
    promise_profile_fingerprint: collected.promise_profile_fingerprint,
    winner: comparison.winner,
    rounds: comparison.rounds,
    judge_model: comparison.judge_model,
    generation_models: comparison.generation_models,
    created_at: Date.now(),
  };
  const settings = store.books.settings(bookId);
  settings.openingIntervention = { ...(settings.openingIntervention || {}), prewriteReview: review };
  store.books.update(bookId, { settings });
  return { ok: true, ...review, candidates: composed.candidates };
}

/** 稳定的新书胜者成为真实第一章单场景草稿，之后仍走正常审校、修订和结算。 */
export function applyNewBookOpeningCandidate(bookId, candidate) {
  const book = store.books.get(bookId);
  const chapter = store.chapters.list(bookId).find(item => Number(item.idx) === 1);
  const content = String(candidate?.content || '').trim();
  if (!book || !chapter) return { ok: false, code: 'OPENING_CHAPTER_ONE_MISSING', message: '第一章结构尚未建立' };
  if (String(store.chapters.fullText(chapter.id) || '').trim()) return { ok: false, code: 'OPENING_TEXT_EXISTS', message: '第一章已有正文，禁止自动覆盖' };
  if (candidate?.kind !== 'chapter1_draft' || !content) return { ok: false, code: 'OPENING_DRAFT_INVALID', message: '第一章候选无效' };
  if (store.scenes.list(chapter.id).some(scene => String(scene.content || '').trim())) {
    return { ok: false, code: 'OPENING_SCENE_EXISTS', message: '第一章已有场景草稿，禁止自动覆盖' };
  }
  const snapshot = store.snapshots.add(bookId, {
    label: '采用新书开篇方案前', source: 'opening-intervention', data: store.snapshotBook(bookId),
  });
  let scene;
  store.transaction(() => {
    for (const existing of store.scenes.list(chapter.id)) store.scenes.remove(existing.id);
    const targetWords = Math.max(700, estimateChineseChars(content));
    const outline = {
      title: chapter.title || '第一章', pace: 'advance',
      goal: candidate.first_state_change || '人物以自己的选择改变眼前局面',
      conflict: candidate.immediate_problem || '眼前困局', continuity_from: '',
      continuity_to: candidate.continue_question || '选择带来新的后果', obligations: [], forbidden: [],
      scenes: [{ id: 's1', pov: candidate.first_actor || '', location: '', scene_type: 'suspense', pacing: '推进',
        beat: `${candidate.first_actor || '主角'}面对${candidate.immediate_problem || '眼前困局'}，作出${candidate.first_choice || '主动选择'}并造成${candidate.first_state_change || '局面变化'}`,
        target_words: targetWords }],
      foreshadows_used: [], new_hooks: [],
      ending_hook: { desc: candidate.continue_question || '这一选择将带来什么后果？', type: '悬念', intensity: 3 },
      checkpoints: [], opening_strategy_family: candidate.strategy_family || '',
      opening_entry_signature: candidate.entry_signature || '',
    };
    store.chapters.update(chapter.id, { outline });
    scene = store.scenes.create(chapter.id, 1, {
      pov: candidate.first_actor || '', beat: outline.scenes[0].beat,
      content: '', targetWords, status: 'planned', sceneType: 'suspense', pacing: '推进',
    });
    const seq = appendHistory(bookId, 'assistant', content);
    store.scenes.update(scene.id, { content, status: 'done', historySeq: seq });
    store.chapters.update(chapter.id, { wordCount: estimateChineseChars(content) });
    transitionChapterStatus(bookId, chapter.id, 'drafted', { reason: '采用跨模型稳定的新书开篇方案' });
    const settings = store.books.settings(bookId);
    settings.openingIntervention = { ...(settings.openingIntervention || {}), newBookApplied: {
      candidate_id: candidate.candidate_id || '', entry_signature: candidate.entry_signature || '',
      snapshot_id: snapshot.id, content_hash: hash(content), applied_at: Date.now(),
    } };
    store.books.update(bookId, { settings });
  });
  return { ok: true, chapterId: chapter.id, sceneId: scene.id, snapshotId: snapshot.id };
}

/** 把隔离保存的读者前置层合成到发布视图；不改场景、不写历史堆。 */
export function composeOpeningAsset(openingAsset, firstChapterText) {
  const original = String(firstChapterText || '');
  if (!openingAsset) return { beforeBook: '', firstChapterText: original };
  const content = String(openingAsset.content || '').trim();
  if (openingAsset.placement === 'prepend_chapter1') {
    return { beforeBook: '', firstChapterText: content ? `${content}\n\n${original.trimStart()}` : original };
  }
  if (openingAsset.placement === 'before_chapter1') {
    return { beforeBook: content ? `楔子\n\n${content}` : '', firstChapterText: original };
  }
  return { beforeBook: '', firstChapterText: original };
}

export function buildOpeningPublishPatch({ book, chapter, beforeText, afterText, asset }) {
  const before = String(beforeText || '');
  const after = String(afterText || '');
  return {
    book_id: book?.id || '', chapter_id: chapter?.id || '', chapter_idx: Number(chapter?.idx || 0),
    asset_id: asset?.id || '', mode: asset?.placement || '',
    before_hash: hash(before), after_hash: hash(after),
    changed_chars: Math.abs(compactLength(after) - compactLength(before)),
    before_text: before, after_text: after, generated_at: Date.now(),
  };
}

function applicationFailure(result) {
  const error = new Error(result.message || '开篇资产应用失败');
  error.code = result.code || 'OPENING_APPLY_FAILED';
  error.result = result;
  return error;
}

/**
 * 应用已经 selected 的候选。顺叙补丁原子改场景；内嵌/独立楔子只激活读者编排层。
 * 快照在写事务之前创建，因此事务回滚也不会抹掉恢复点。
 */
export function applySelectedOpeningAsset(bookId, assetId) {
  const book = store.books.get(bookId);
  const asset = store.openingAssets.get(assetId);
  if (!book || !asset || asset.book_id !== bookId) return { ok: false, code: 'OPENING_ASSET_NOT_OWNED', message: '开篇资产不存在或不属于当前作品' };
  if (asset.status !== 'selected') return { ok: false, code: 'OPENING_ASSET_NOT_SELECTED', message: '只有已选中的候选才能应用' };
  if (asset.placement === 'before_chapter1') {
    const compatibility = platformFrontMatterCompatibility(store.books.settings(bookId)?.openingIntervention?.platformCompatibility);
    if (!compatibility.verified) return {
      ok: false, code: 'OPENING_FRONT_MATTER_UNVERIFIED',
      message: `独立楔子平台实测未完成：${compatibility.missing.join(', ')}`,
    };
  }
  if (OPENING_READER_PLACEMENTS.has(asset.placement)
    && !openingContract(asset, bookId, { requireApplied: false })) {
    return { ok: false, code: 'OPENING_CONTRACT_INVALID', message: '读者前置层缺少可达的真实卷、年份或事件契约' };
  }
  const auditBlockers = openingAuditBlockers(asset.audit_json);
  if (auditBlockers.length) {
    return { ok: false, code: 'OPENING_AUDIT_BLOCKED', message: '候选仍有硬伤或 high 问题，禁止应用', blockers: auditBlockers };
  }
  const first = firstChapterContext(bookId);
  if (!first.chapter || !first.text.trim()) return { ok: false, code: 'OPENING_TEXT_REQUIRED', message: '第一章正文不存在' };

  // 在产生任何正文/资产状态写入前先做确定性陈旧检查，避免为明显失效候选制造无意义快照。
  if (asset.placement === 'scene_patch') {
    const scene = store.scenes.get(asset.anchor_scene_id);
    if (!scene || scene.chapter_id !== first.chapter.id) return { ok: false, code: 'REWRITE_SCENE_MISSING', message: '目标场景不存在' };
    if (hash(scene.content) !== asset.source_hash) return { ok: false, code: 'OPENING_PATCH_STALE', message: '源场景已变化，开篇候选失效' };
    if (String(scene.content || '').slice(asset.anchor_start, asset.anchor_end) !== asset.source_excerpt) {
      return { ok: false, code: 'OPENING_PATCH_ANCHOR_MISMATCH', message: '目标字符范围与原文不一致' };
    }
  }
  const freshness = openingAssetFreshness(bookId, asset);
  if (!freshness.fresh) return { ok: false, code: 'OPENING_ASSET_STALE', message: `开篇候选已过期：${freshness.reason}` };

  const snapshot = store.snapshots.add(bookId, {
    label: `应用开篇候选前（${asset.kind}）`, source: 'opening-intervention', data: store.snapshotBook(bookId),
  });
  const beforeText = first.text;
  let afterText = beforeText;
  let requiresStateRebuild = false;
  try {
    store.transaction(() => {
      if (asset.placement === 'scene_patch') {
        const applied = applyValidatedScenePatch(bookId, {
          sceneId: asset.anchor_scene_id, start: asset.anchor_start, end: asset.anchor_end,
          expected: asset.source_excerpt, sourceHash: asset.source_hash, replacement: asset.content,
        });
        if (!applied.ok) throw applicationFailure(applied);
        requiresStateRebuild = applied.requiresStateRebuild === true;
        afterText = store.chapters.fullText(first.chapter.id);
      } else if (OPENING_READER_PLACEMENTS.has(asset.placement)) {
        const composed = composeOpeningAsset(asset, beforeText);
        afterText = [composed.beforeBook, composed.firstChapterText].filter(Boolean).join('\n\n');
      } else {
        throw applicationFailure({ code: 'OPENING_PLACEMENT_INVALID', message: `不支持的开篇位置：${asset.placement}` });
      }
      const rank = safeJson(asset.rank_json, {});
      store.openingAssets.update(asset.id, { rank: { ...rank, application: {
        before_hash: hash(beforeText), after_hash: hash(afterText), snapshot_id: snapshot.id, applied_at: Date.now(),
      } } });
      store.openingAssets.transition(asset.id, 'applied');
    });
  } catch (error) {
    return error?.result || { ok: false, code: error?.code || 'OPENING_APPLY_FAILED', message: error.message, snapshotId: snapshot.id };
  }
  return {
    ok: true, asset: store.openingAssets.get(asset.id), snapshotId: snapshot.id,
    requiresStateRebuild,
    publishPatch: buildOpeningPublishPatch({ book, chapter: first.chapter, beforeText, afterText, asset }),
  };
}

export async function auditOpeningAsset(bookId, assetId, { signal, data } = {}) {
  const asset = store.openingAssets.get(assetId);
  if (!asset || asset.book_id !== bookId) throw openingError('OPENING_ASSET_NOT_OWNED', '开篇候选不存在或不属于当前作品');
  if (asset.status === 'audited') return { ok: true, skipped: true, asset };
  if (asset.status !== 'candidate') throw openingError('OPENING_ASSET_STATE_INVALID', `当前状态不能审校：${asset.status}`);
  const promise = storyPromiseStatus(bookId);
  if (!promise.exists || promise.stale) throw openingError('STORY_PROMISE_REQUIRED', '创作宪章缺失或已过期');
  const book = store.books.get(bookId);
  const first = firstChapterContext(bookId);
  const route = promise.profile?.texture?.route || 'general';
  let auditTarget = null;
  try { auditTarget = validatedContractTarget(bookId, safeJson(asset.contract_json, {})); } catch { /* 无效契约由选择/应用闸门拦截 */ }
  const input = {
    book, profile: promise.profile, storyPromise: storyPromiseProfileText(promise.profile),
    diagnosis: currentDiagnosis(bookId), currentOpening: first.text, firstScene: first.firstScene,
    contractEvent: openingContractEventContext(bookId, auditTarget),
    platformGuidance: platformGuidanceText(book.platform), genreProfile: fanqieGenreProfileText(book.genre, route),
    settings: store.books.settings(bookId).openingIntervention || {},
  };
  const candidate = assetCandidate(asset, first);
  let audit = data;
  let auditModel = '';
  if (!audit) {
    const result = await auditCandidate(bookId, input, candidate, { signal });
    audit = result.audit;
    auditModel = result.model;
  }
  const validated = mergeDeterministicCandidateAudit(bookId, candidate, validateCandidateAudit(audit, candidate));
  const rank = safeJson(asset.rank_json, {});
  store.openingAssets.update(asset.id, { audit: validated, rank: { ...rank, audit_model: auditModel || rank.audit_model || '' } });
  store.openingAssets.transition(asset.id, 'audited');
  return { ok: true, asset: store.openingAssets.get(asset.id), audit: validated };
}

export function selectOpeningAsset(bookId, assetId) {
  const asset = store.openingAssets.get(assetId);
  if (!asset || asset.book_id !== bookId) throw openingError('OPENING_ASSET_NOT_OWNED', '开篇候选不存在或不属于当前作品');
  if (asset.placement === 'before_chapter1') {
    const compatibility = platformFrontMatterCompatibility(store.books.settings(bookId)?.openingIntervention?.platformCompatibility);
    if (!compatibility.verified) throw openingError('OPENING_FRONT_MATTER_UNVERIFIED', `独立楔子平台实测未完成：${compatibility.missing.join(', ')}`);
  }
  if (asset.status === 'selected') return { ok: true, skipped: true, asset };
  if (asset.status !== 'audited') throw openingError('OPENING_ASSET_NOT_AUDITED', '只有已审校候选才能选择');
  if (OPENING_READER_PLACEMENTS.has(asset.placement)
    && !openingContract(asset, bookId, { requireApplied: false })) {
    throw openingError('OPENING_CONTRACT_INVALID', '读者前置层缺少可达的真实卷、年份或事件契约');
  }
  if (openingAuditBlockers(asset.audit_json).length) {
    throw openingError('OPENING_AUDIT_BLOCKED', '候选仍有硬伤或 high 问题，禁止选择');
  }
  const freshness = openingAssetFreshness(bookId, asset);
  if (!freshness.fresh) throw openingError('OPENING_ASSET_STALE', `候选已过期：${freshness.reason}`);
  store.openingAssets.transition(asset.id, 'selected');
  return { ok: true, asset: store.openingAssets.get(asset.id) };
}

export function retireOpeningAsset(bookId, assetId) {
  const asset = store.openingAssets.get(assetId);
  if (!asset || asset.book_id !== bookId) throw openingError('OPENING_ASSET_NOT_OWNED', '开篇候选不存在或不属于当前作品');
  if (asset.status === 'retired') return { ok: true, skipped: true, asset };
  if (!['candidate', 'audited', 'selected', 'applied'].includes(asset.status)) {
    throw openingError('OPENING_ASSET_STATE_INVALID', `当前状态不能停用：${asset.status}`);
  }
  store.openingAssets.transition(asset.id, 'retired');
  return { ok: true, asset: store.openingAssets.get(asset.id) };
}

/** V0.98.12 删除旧开篇方案：未应用的任何状态（candidate/audited/selected/rejected/retired）都可清理；
 *  已应用状态禁止直接删除——先撤下前置层再删，发布差异仍可在应用快照中恢复。 */
export function removeOpeningAsset(bookId, assetId) {
  const asset = store.openingAssets.get(assetId);
  if (!asset || asset.book_id !== bookId) throw openingError('OPENING_ASSET_NOT_OWNED', '开篇候选不存在或不属于当前作品');
  if (asset.status === 'applied') {
    throw openingError('OPENING_ASSET_APPLIED', '已应用的方案不能直接删除：请先撤下前置层（或取消应用）后再删除；发布差异可在应用快照中恢复');
  }
  store.openingAssets.remove(assetId);
  return { ok: true, removed: assetId };
}

function snapshotFirstChapterText(snapshot) {
  const chapter = snapshot?.data?.chapters?.slice().sort((a, b) => Number(a.idx) - Number(b.idx))[0];
  return chapter?.scenes?.slice().sort((a, b) => Number(a.idx) - Number(b.idx))
    .map(scene => String(scene.content || '')).filter(Boolean).join('\n\n') || '';
}

export function currentOpeningPublishPatch(bookId) {
  const book = store.books.get(bookId);
  const first = firstChapterContext(bookId);
  if (!book || !first.chapter) return { ok: false, code: 'OPENING_TEXT_REQUIRED', message: '第一章不存在' };
  const applied = store.openingAssets.list(bookId)
    .filter(asset => asset.status === 'applied')
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))[0] || null;
  if (!applied) return { ok: true, changed: false, patch: null };
  const application = safeJson(applied.rank_json, {}).application || {};
  const snapshot = application.snapshot_id ? store.snapshots.get(application.snapshot_id) : null;
  const beforeText = snapshotFirstChapterText(snapshot) || first.text;
  const composed = composeOpeningAsset(applied, first.text);
  const readerAfter = [composed.beforeBook, composed.firstChapterText].filter(Boolean).join('\n\n');
  const patch = buildOpeningPublishPatch({
    book, chapter: first.chapter, beforeText,
    afterText: applied.placement === 'scene_patch' ? first.text : readerAfter,
    asset: applied,
  });
  return {
    ok: true, changed: patch.before_hash !== patch.after_hash,
    patch: { ...patch, before_book: composed.beforeBook, first_chapter_text: composed.firstChapterText,
      snapshot_id: application.snapshot_id || null },
  };
}

export function readerOpeningVersionFingerprint(bookId) {
  const first = firstChapterContext(bookId);
  const active = store.openingAssets.active(bookId);
  const composed = composeOpeningAsset(active?.status === 'applied' ? active : null, first.text);
  return hash(JSON.stringify({ beforeBook: composed.beforeBook, firstChapterText: composed.firstChapterText }));
}

/** 真实反馈仅在本书内留作假设校准，不更新平台画像，也不作因果归因。 */
export function recordOpeningFeedback(bookId, input = {}, { onEvent } = {}) {
  if (!store.books.get(bookId)) throw openingError('OPENING_BOOK_MISSING', '作品不存在');
  const metrics = Array.isArray(input.metrics) ? input.metrics.slice(0, 30).map(item => ({
    name: String(item?.name || '').trim().slice(0, 80),
    value: item?.value == null ? null : String(item.value).slice(0, 120),
    window: String(item?.window || '').trim().slice(0, 120),
    note: String(item?.note || '').trim().slice(0, 300),
  })).filter(item => item.name) : [];
  const comments = Array.isArray(input.comments)
    ? input.comments.slice(0, 20).map(value => String(value || '').trim().slice(0, 500)).filter(Boolean) : [];
  const active = store.openingAssets.active(bookId);
  const record = {
    id: `ofb_${Date.now()}_${hash(JSON.stringify(input)).slice(0, 8)}`,
    opening_version_hash: readerOpeningVersionFingerprint(bookId),
    observed_at: Number(input.observed_at) || Date.now(), metrics, comments,
    observation_window: String(input.observation_window || '').slice(0, 160),
    confounders: stringList(input.confounders).slice(0, 20).map(value => value.slice(0, 200)),
    note: String(input.note || '').slice(0, 1000),
    active_asset_id: active?.status === 'applied' ? active.id : null,
    hypothesis: active?.creative_hypothesis || '',
    interpretation: '仅记录与当前开篇假设一致或冲突的线索；封面、书名、流量与时间窗口等混杂因素未被自动排除，不能据此宣称正文造成指标变化。',
  };
  const settings = store.books.settings(bookId);
  const previous = Array.isArray(settings.openingFeedbackRecords) ? settings.openingFeedbackRecords : [];
  settings.openingFeedbackRecords = [...previous, record].slice(-50);
  store.books.update(bookId, { settings });
  const event = {
    type: 'opening_stage', step: 'feedback_recorded', assetId: record.active_asset_id,
    detail: '真实后台观察已按当前开篇版本留档，仅用于本书后续假设校准',
  };
  onEvent?.(event);
  return { ok: true, record, global_profile_changed: false, event };
}

/** 第1/3/10章及作者配置字数点做非阻塞复核；失败显式 unreviewed，绝不阻断后续章节。 */
export async function maybeReviewOpening(bookId, completedChapterIdx, { signal, onEvent, data } = {}) {
  const settings = store.books.settings(bookId);
  const intervention = settings.openingIntervention || {};
  const reviewed = new Set(Array.isArray(intervention.reviewedCheckpoints) ? intervention.reviewedCheckpoints : []);
  const completedIdx = Number(completedChapterIdx) || 0;
  const chapterKeys = [1, 3, 10].filter(idx => completedIdx >= idx && !reviewed.has(`chapter:${idx}`));
  const wordCheckpoint = Number(intervention.wordCheckpoint);
  const completedWords = store.chapters.list(bookId)
    .filter(chapter => Number(chapter.idx) <= completedIdx && ['done', 'settled'].includes(chapter.status))
    .reduce((sum, chapter) => sum + Number(chapter.word_count || estimateChineseChars(store.chapters.fullText(chapter.id))), 0);
  const wordKey = Number.isFinite(wordCheckpoint) && wordCheckpoint > 0 ? `words:${wordCheckpoint}` : '';
  const wordDue = wordKey && completedWords >= wordCheckpoint && !reviewed.has(wordKey);
  if (!chapterKeys.length && !wordDue) return { ok: true, skipped: true };
  const due = [...chapterKeys.map(idx => `chapter:${idx}`), ...(wordDue ? [wordKey] : [])];
  try {
    const result = await diagnoseOpening(bookId, { signal, onEvent, data });
    const current = store.books.settings(bookId);
    current.openingIntervention = {
      ...(current.openingIntervention || {}),
      reviewedCheckpoints: [...new Set([...(current.openingIntervention?.reviewedCheckpoints || []), ...due])],
    };
    store.books.update(bookId, { settings: current });
    return { ...result, checkpoints: due };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
    onEvent?.({ type: 'opening_stage', step: 'unreviewed', detail: `开篇复核未完成：${error?.message || error}` });
    return { ok: false, unreviewed: true, error: error?.message || String(error), checkpoints: due };
  }
}
