// V0.99：平台发布/推荐反馈单一真源。动态事实只注入最终用户指令（L4），不得写入缓存前缀。
'use strict';

import * as store from '../db/store.js';
import { candidateValidationStats } from './recovery_contract.js';

const FANQIE_HOST = 'fanqienovel.com';
const FANQIE_PATH = /^\/page\/(\d+)$/;
const RECOMMENDATION_STAGES = new Set([
  'not_applied', 'preparing', 'under_review', 'failed', 'validation', 'recommended', 'terminated',
]);
const EXPOSURE_STATUSES = new Set(['not_exposed', 'validation', 'limited_test', 'recommended', 'organic']);
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

function inputError(message, code = 'INVALID_PUBLICATION_INPUT') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (nullable) return null;
    throw inputError(`${label}不能为空`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw inputError(`${label}必须是 ${min}—${max} 之间的整数`);
  return number;
}

function percentage(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw inputError(`${label}必须在 0—100 之间`);
  return number;
}

function boundedText(value, label, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) throw inputError(`${label}过长，最多 ${maxLength} 字符`);
  return text;
}

export function parseFanqieBookUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw || '').trim()); } catch { throw inputError('请输入有效的番茄作品链接'); }
  const match = parsed.pathname.match(FANQIE_PATH);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== FANQIE_HOST || parsed.port || parsed.username
      || parsed.password || parsed.search || parsed.hash || !match) {
    throw inputError('番茄作品链接必须是 https://fanqienovel.com/page/数字作品ID');
  }
  const url = `https://${FANQIE_HOST}/page/${match[1]}`;
  return { url, bookId: match[1] };
}

function extractAssignedObject(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw inputError('番茄公开页面结构已变化：找不到 __INITIAL_STATE__', 'FANQIE_PAGE_CHANGED');
  const equalIndex = source.indexOf('=', markerIndex + marker.length);
  if (equalIndex < 0) throw inputError('番茄公开页面结构已变化：初始化数据缺少赋值', 'FANQIE_PAGE_CHANGED');
  const start = source.indexOf('{', equalIndex + 1);
  if (start < 0) throw inputError('番茄公开页面结构已变化：初始化数据不是对象', 'FANQIE_PAGE_CHANGED');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw inputError('番茄公开页面结构已变化：初始化数据不完整', 'FANQIE_PAGE_CHANGED');
}

function firstValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function nonNegative(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function normalizeTimestamp(value) {
  const number = nonNegative(value);
  if (number === null) return null;
  return number > 0 && number < 10_000_000_000 ? number * 1000 : number;
}

function collectChapterRows(value, output = [], seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectChapterRows(item, output, seen);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const id = firstValue(value, ['itemId', 'item_id', 'chapterId', 'chapter_id']);
  const title = firstValue(value, ['title', 'chapterTitle', 'chapter_title', 'chapterName', 'chapter_name']);
  if (id !== undefined && title !== undefined) {
    const key = String(id);
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ id: key, title: String(title) });
    }
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child) && /chapter|volume|list/i.test(key)) collectChapterRows(child, output, seen);
  }
  return output;
}

export function parseFanqieInitialState(html, expectedBookId = '') {
  const source = String(html || '');
  const raw = extractAssignedObject(source, 'window.__INITIAL_STATE__');
  let state;
  try { state = JSON.parse(raw); } catch { throw inputError('番茄公开页面结构已变化：初始化数据无法解析', 'FANQIE_PAGE_CHANGED'); }
  const page = state?.page;
  if (!page || typeof page !== 'object') throw inputError('番茄公开页面结构已变化：缺少作品信息', 'FANQIE_PAGE_CHANGED');
  const externalBookId = String(firstValue(page, ['bookId', 'book_id']) || '');
  if (!externalBookId) throw inputError('番茄公开页面结构已变化：缺少作品 ID', 'FANQIE_PAGE_CHANGED');
  if (expectedBookId && externalBookId !== String(expectedBookId)) {
    throw inputError(`番茄作品 ID 不一致：链接为 ${expectedBookId}，页面为 ${externalBookId}`, 'FANQIE_BOOK_MISMATCH');
  }
  const bookTitle = String(firstValue(page, ['bookName', 'book_name', 'title']) || '').trim();
  if (!bookTitle) throw inputError('番茄公开页面结构已变化：缺少书名', 'FANQIE_PAGE_CHANGED');
  const chapterRoot = firstValue(page, ['chapterListWithVolume', 'chapter_list_with_volume', 'chapterList', 'chapter_list']);
  const chapters = collectChapterRows(chapterRoot).map((chapter, index) => ({ ...chapter, index: index + 1 }));
  if (!chapters.length) throw inputError('番茄公开章节列表为空或页面结构已变化', 'FANQIE_PAGE_CHANGED');
  const last = chapters.at(-1);
  return {
    platform: 'fanqie',
    externalBookId,
    bookTitle,
    publishedChapterCount: chapters.length,
    // 缺字段与真实的 0 必须区分；页面结构变化时不能把未知伪装成零数据。
    publishedWordCount: nonNegative(firstValue(page, ['wordNumber', 'word_number', 'wordCount', 'word_count'])),
    readerCount: nonNegative(firstValue(page, ['readCount', 'read_count', 'readerCount', 'reader_count'])),
    latestChapterTitle: String(firstValue(page, ['lastChapterTitle', 'last_chapter_title']) || last.title),
    latestChapterItemId: String(firstValue(page, ['lastChapterItemId', 'last_chapter_item_id']) || last.id),
    lastPublishTime: normalizeTimestamp(firstValue(page, ['lastPublishTime', 'last_publish_time'])),
    chapters,
  };
}

async function readLimitedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw inputError('番茄公开页面过大，已停止读取', 'FANQIE_PAGE_TOO_LARGE');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw inputError('番茄公开页面过大，已停止读取', 'FANQIE_PAGE_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw inputError('番茄公开页面过大，已停止读取', 'FANQIE_PAGE_TOO_LARGE');
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    try { await reader.cancel(); } catch { /* response already complete */ }
  }
}

export async function fetchFanqiePublication(rawUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  signal,
  maxBytes = MAX_PAGE_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境不支持 fetch');
  const parsedUrl = parseFanqieBookUrl(rawUrl);
  const timeout = AbortSignal.timeout(Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000)));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(parsedUrl.url, {
      redirect: 'error', signal: combined,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; NovelWriterPublicationSync/0.99)',
      },
    });
  } catch (error) {
    if (combined.aborted) {
      const wrapped = new Error(signal?.aborted ? '已取消番茄作品同步' : '番茄作品同步超时');
      wrapped.code = signal?.aborted ? 'ABORTED' : 'FANQIE_SYNC_TIMEOUT';
      throw wrapped;
    }
    const wrapped = new Error(`无法读取番茄公开页面：${error.message}`);
    wrapped.code = 'FANQIE_SYNC_NETWORK';
    throw wrapped;
  }
  if (!response.ok) {
    const error = new Error(`番茄公开页面返回 HTTP ${response.status}`);
    error.code = 'FANQIE_SYNC_HTTP';
    throw error;
  }
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml')) {
    throw inputError(`番茄公开页面类型异常：${type}`, 'FANQIE_PAGE_CHANGED');
  }
  return parseFanqieInitialState(await readLimitedText(response, maxBytes), parsedUrl.bookId);
}

function normalizeTitle(value) {
  return String(value || '').replace(/[\s《》<>]/g, '').toLowerCase();
}

export async function syncFanqiePublication(bookId, options = {}) {
  const book = store.books.get(bookId);
  if (!book) throw inputError('作品不存在', 'NOT_FOUND');
  const profile = store.publicationProfiles.get(bookId);
  if (!profile?.work_url) throw inputError('请先填写番茄作品链接');
  store.publicationProfiles.upsert(bookId, { syncStatus: 'syncing', syncError: '' });
  try {
    const snapshot = await fetchFanqiePublication(profile.work_url, options);
    if (normalizeTitle(book.title) !== normalizeTitle(snapshot.bookTitle) && options.allowTitleMismatch !== true) {
      throw inputError(`作品名称不一致：本地《${book.title}》，番茄《${snapshot.bookTitle}》`, 'FANQIE_BOOK_MISMATCH');
    }
    const profilePatch = {
      platform: 'fanqie', externalBookId: snapshot.externalBookId,
      publishedChapterCount: snapshot.publishedChapterCount,
      latestChapterTitle: snapshot.latestChapterTitle,
      latestChapterItemId: snapshot.latestChapterItemId,
      publicChapters: snapshot.chapters,
      lastSyncedAt: Date.now(), syncStatus: 'ok', syncError: '',
    };
    // 页面偶发缺失可选字段时保留上次成功值；真实的 0 仍会作为非空数字正常更新。
    if (snapshot.publishedWordCount != null) profilePatch.publishedWordCount = snapshot.publishedWordCount;
    if (snapshot.readerCount != null) profilePatch.publicReaderCount = snapshot.readerCount;
    if (snapshot.lastPublishTime != null) profilePatch.lastPublishTime = snapshot.lastPublishTime;
    const updated = store.publicationProfiles.upsert(bookId, profilePatch);
    return { profile: updated, snapshot, localChapterCount: store.chapters.count(bookId) };
  } catch (error) {
    store.publicationProfiles.upsert(bookId, { syncStatus: 'error', syncError: error.message });
    throw error;
  }
}

export function shouldRefreshPublication(profile, {
  now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000,
} = {}) {
  if (!profile?.work_url) return false;
  const last = Number(profile.last_synced_at) || 0;
  return !last || now - last >= Math.max(60_000, Number(maxAgeMs) || 6 * 60 * 60 * 1000);
}

export function validatePublicationProfile(input = {}) {
  const stage = String(input.recommendationStage ?? input.recommendation_stage ?? 'not_applied');
  if (!RECOMMENDATION_STAGES.has(stage)) throw inputError(`推荐阶段无效：${stage}`);
  const remainingAttempts = integer(input.remainingAttempts ?? input.remaining_attempts, '剩余申请次数', { min: 0, max: 3 });
  const suspectedTurnChapter = integer(input.suspectedTurnChapter ?? input.suspected_turn_chapter, '疑似质量拐点章', { min: 1 });
  let workUrl = input.workUrl ?? input.work_url;
  let externalBookId = input.externalBookId ?? input.external_book_id;
  if (workUrl) {
    const parsed = parseFanqieBookUrl(workUrl);
    workUrl = parsed.url;
    if (externalBookId && String(externalBookId) !== parsed.bookId) throw inputError('链接中的作品 ID 与填写的作品 ID 不一致');
    externalBookId = parsed.bookId;
  }
  return {
    ...input, recommendationStage: stage, remainingAttempts, suspectedTurnChapter,
    workUrl: workUrl || '', externalBookId: externalBookId ? String(externalBookId) : '',
    editorFeedback: boundedText(input.editorFeedback ?? input.editor_feedback, '编辑反馈', 4000),
    authorDiagnosis: boundedText(input.authorDiagnosis ?? input.author_diagnosis, '作者诊断', 4000),
  };
}

export function validateMetricSnapshot(input = {}) {
  const exposureStatus = String(input.exposureStatus ?? input.exposure_status ?? 'not_exposed');
  if (!EXPOSURE_STATUSES.has(exposureStatus)) throw inputError(`曝光状态无效：${exposureStatus}`);
  return {
    ...input, exposureStatus,
    impressions: integer(input.impressions, '曝光数'),
    readers: integer(input.readers, '读者数'),
    bookshelfAdds: integer(input.bookshelfAdds ?? input.bookshelf_adds, '加书架数'),
    readThroughRate: percentage(input.readThroughRate ?? input.read_through_rate, '读完率'),
    followRate: percentage(input.followRate ?? input.follow_rate, '追读率'),
    note: boundedText(input.note, '备注', 2000),
  };
}

function chapterListText(values) {
  return values.map(value => `第${value}章`).join('、');
}

export function buildPublicationFeedbackContext(bookId, { targetChapterIdx } = {}) {
  const profile = store.publicationProfiles.get(bookId);
  if (!profile) return '';
  const latestMetric = store.publicationMetrics.list(bookId)[0];
  const lines = ['# 平台发布与推荐反馈（动态事实；必须服从）'];
  if (profile.recommendation_stage === 'failed') {
    const suspectedTurn = Math.max(1, Number(profile.suspected_turn_chapter) || 7);
    const reviewEnd = Math.max(
      suspectedTurn,
      20,
      Number(profile.published_chapter_count) || 0,
      store.chapters.count(bookId),
      Math.max(0, Number(targetChapterIdx) - 1) || 0,
    );
    const baselineEnd = suspectedTurn - 1;
    const highRiskRange = reviewEnd > suspectedTurn
      ? `第 ${suspectedTurn}—${reviewEnd} 章`
      : `第 ${suspectedTurn} 章`;
    lines.push(`- 风险等级：P0 内容质量事故。推荐评估已失败${profile.remaining_attempts == null ? '' : `，只剩 ${profile.remaining_attempts} 次申请机会`}。这不是“算法没给量”，而是现有正文未获进入推荐验证的资格。`);
    lines.push(`- 返工假设：${baselineEnd >= 1 ? `第 1—${baselineEnd} 章可作为疑似基线，但仍需证据验证（必须引用原文），不能因签约曾通过就自动判为合格；` : ''}${highRiskRange}是质量下坠的高风险区，要提高审查强度，但最终按证据决定保留、微调或重构。`);
    lines.push(`- 楔子只是开篇的独立部件，不能替${highRiskRange}推进不足、冲突衰减、回报拖延或重复注水抵消质量债。继续堆新章节也不算整改旧章节。`);
  }
  if (profile.editor_feedback) lines.push(`- 平台/编辑反馈：${profile.editor_feedback}`);
  if (profile.author_diagnosis) lines.push(`- 作者判断（不是平台原话）：${profile.author_diagnosis}`);
  if (profile.published_chapter_count != null) {
    lines.push(`- 公开边界：已发布 ${profile.published_chapter_count} 章${profile.published_word_count == null ? '' : ` / ${profile.published_word_count} 字`}${profile.latest_chapter_title ? `，末章《${profile.latest_chapter_title}》` : ''}。改动该边界内正文后必须进入线上同步清单，不能宣称线上已自动更新。`);
  }
  if (profile.public_reader_count != null) {
    lines.push(`- 页面公开读者字段：${profile.public_reader_count}。这只是公开页面的辅助观测，不替代作者后台按时间窗口记录的曝光、读完和追读数据。`);
  }
  if (latestMetric?.exposure_status === 'not_exposed') {
    const readers = latestMetric.readers == null ? '未填' : ` ${latestMetric.readers}（包括 0）`;
    lines.push(`- 数据解释：当前记录为“未获曝光”；此阶段读者数${readers}是中性数据，不能据此贬低正文，也不能用它证明正文优秀。`);
  } else if (latestMetric) {
    lines.push(`- 最近真实数据：曝光阶段 ${latestMetric.exposure_status}；曝光 ${latestMetric.impressions ?? '未填'}，读者 ${latestMetric.readers ?? '未填'}，加书架 ${latestMetric.bookshelf_adds ?? '未填'}，读完率 ${latestMetric.read_through_rate ?? '未填'}%，追读率 ${latestMetric.follow_rate ?? '未填'}%。只能据观察窗口作方向性诊断。`);
  }
  if (profile.pending_sync_chapters.length) lines.push(`- 待线上同步：${chapterListText(profile.pending_sync_chapters)}。这些章节本地稿已变化，发布端仍可能是旧稿。`);
  if (targetChapterIdx) lines.push(`- 当前规划第 ${targetChapterIdx} 章：必须说明本章的有效事件、不可逆局势变化、人物代价/选择和章末继续阅读理由，避免重演已暴露的注水模式。`);
  lines.push('- 证据边界：禁止虚构番茄审核阈值、推荐成功概率、编辑未说过的具体理由或数据因果；不确定就明确标注未知。');
  return lines.join('\n');
}

/**
 * 将动态平台事实追加到当前任务（L4）。调用方必须把返回值放在最后一条 user 消息，
 * 不能写入 materials/history 的稳定前缀，否则每次数据变化都会击穿缓存并污染创作记忆。
 */
export function appendPublicationFeedback(instruction, bookId, options = {}) {
  const base = String(instruction || '');
  const feedback = buildPublicationFeedbackContext(bookId, options);
  return feedback ? `${base}\n\n${feedback}` : base;
}

export function publicationDashboard(bookId) {
  const book = store.books.get(bookId);
  if (!book) throw inputError('作品不存在', 'NOT_FOUND');
  const profile = store.publicationProfiles.get(bookId);
  const localChapterCount = store.chapters.count(bookId);
  const recoveryRuns = store.recommendationRecoveryRuns.list(bookId).slice(0, 10).map((run) => {
    const candidates = Array.isArray(run.result?.candidates) ? run.result.candidates : [];
    // 验证层级判定只有 recovery_contract 一处；驾驶舱只是它的一个视图。
    const stats = candidateValidationStats(candidates);
    const pick = state => stats[state] || 0;
    return {
      ...run,
      // 驾驶舱只传状态摘要；局部通过与整段通过必须分开，不能把 global_rejected 叫“已验证”。
      candidateStats: {
        localPassed: pick('local_passed'),
        globalPassed: pick('global_passed'),
        globalRejected: pick('global_rejected'),
        legacyUntrusted: pick('legacy_untrusted'),
        applied: pick('applied'),
        rejected: pick('rejected'),
        frozen: pick('frozen'),
        total: candidates.length,
      },
      result: {
        applied: (run.result?.applied || []).map(item => ({ chapter: item.chapter, title: item.title, code: item.code })),
        rejected: (run.result?.rejected || []).map(item => ({ chapter: item.chapter, code: item.code, reason: item.reason })),
        globalReview: run.result?.globalReview || null,
        snapshotId: run.result?.snapshotId || run.snapshot_id || null,
        completion: run.result?.completion || null,
        unresolvedChapters: run.result?.unresolvedChapters || [],
        candidateStatsByValidation: run.result?.candidateStatsByValidation || {},
        // 诊断指纹要透出（仅哈希，无正文）——可续性标注靠它判断"正文/反馈未变化"。
        diagnosis_fingerprint: run.result?.diagnosis_fingerprint || null,
        // 全范围因果计划必须透出：可续性标注靠它区分"有整体方案可直接执行"与
        // "旧版逐章拼接工单必须重新诊断"。它只有弧、目标与证据，不含正文，
        // 裁掉它会导致生产链路永远判 stale、界面永远不出现"直接执行工单"。
        repair_plan: run.result?.repair_plan || null,
        // 计划正文和计划合同版本必须成对透出；否则新计划经过驾驶舱投影后也会被
        // 误判成旧计划，用户只能重复综合规划而无法直接执行。
        repair_plan_contract_version: run.result?.repair_plan_contract_version || null,
      },
    };
  });
  return {
    profile: profile || null,
    reviews: store.recommendationReviews.list(bookId),
    metrics: store.publicationMetrics.list(bookId),
    recoveryRuns,
    localChapterCount,
    unpublishedChapterCount: profile?.published_chapter_count == null
      ? null
      : Math.max(0, localChapterCount - profile.published_chapter_count),
  };
}
