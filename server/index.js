// server/index.js —— HTTP 入口：静态服务 + REST/SSE API（零依赖，node:http）
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process'; // 保留：供极少数平台调用（V0.61 起不再用于自动打开浏览器）
import { fileURLToPath } from 'node:url';
import { PORT, ROOT, DATA_DIR, getGlobal, saveGlobal, resolveRoute, DEFAULT_ROUTES, PROVIDER_PRESETS, providerInfo, resolvedRouteModels, writingModelPresetsFor, resolveModelName, pickTestModel, resolveBackupRoute } from './config.js';
import { APP_VERSION } from './version.js';
import * as store from './db/store.js';
import { historyStats, budgetCheck, materialsInfo, archiveInjectionText } from './llm/cache.js';
import { peakHint } from './llm/cost.js';
import { generateBookOutline, generateVolumeOutline, generateChapterOutline, ensureHistory, rebuildHistory, generateBookContract } from './engine/outline.js';
import { tidyPendingEntities, migrateMisplacedCharacters } from './engine/pending.js'; // V0.40 待登记自动治理
import { autoReviewVolumes } from './engine/volumereview.js'; // V0.41 卷级整体审阅
import { buildBookExport } from './engine/export.js';
import { generateBookSettings } from './engine/settings.js';
import { logApi } from './util/oplog.js';
import { writeScene } from './engine/write.js';
import { auditChapter, coverageCheck, reviseScene } from './engine/audit.js';
import { settleChapter } from './engine/settle.js';
import { runChapterFlow } from './engine/pipeline.js';
import { runBookPilot } from './engine/pilot.js';
import { runPolish, rebuildHistoryFromChapters, applyValidatedSceneRewrite } from './engine/polish.js';
import { runArchive, checkArchiveNeed, archiveSearch } from './engine/archive.js';
import { detectDrift, autoRecover } from './engine/recovery.js';
import { forgottenList } from './engine/foreshadow.js';
import { auditPleasure, planBookPleasure, pleasureStatus, registerHooksFromOutline, schedulerCheck } from './engine/pleasure.js';
import { healthSnapshot } from './llm/resilience.js';
import { generateIdeaSeeds, amplifyIdea, applyIdeaOption, scoreContract, generateBookTitle } from './engine/idea.js';
import { initEmbedding, embeddingStatus } from './memory/embedding.js';
import { indexBook } from './memory/indexer.js';
import { semanticSearch } from './memory/vectorstore.js';
import { acquireBookLease } from './jobs/book-lease.js';
import { recoveryJobs, writeJobs } from './jobs/recovery-jobs.js';
import { batchQualityScan } from './engine/batch_scan.js'; // V0.96：引擎概览（批次自检现场跑）
import { resolveCraftProfile, formatCraftProfileLine } from './engine/craft_profile.js';
import { snapshotDiffOverview, snapshotChapterDiff } from './engine/data_safety.js'; // V0.96.4：快照 diff 对比
import { hasExplicitCompletedStatus, transitionChapterStatus, isCompletedChapter } from './engine/chapter_status.js'; // V0.93.1：完成态单一真源 // V0.93.2：状态写入单一真源
import {
  storyPromiseStatus, buildStoryPromiseProfile, ensureStoryPromiseProfile,
  lockStoryPromiseFields, unlockStoryPromiseFields,
} from './engine/story_promise.js';
import { openingDiagnosisStatus, diagnoseOpening } from './engine/opening_diagnosis.js';
import {
  composeOpeningCandidates, compareOpeningCandidates, compareDraftOpeningCandidates,
  auditOpeningAsset, selectOpeningAsset,
  applySelectedOpeningAsset, retireOpeningAsset, currentOpeningPublishPatch,
  recordOpeningFeedback, openingAssetFreshness, removeOpeningAsset,
} from './engine/opening_intervention.js';
import {
  publicationDashboard, syncFanqiePublication, validateMetricSnapshot, validatePublicationProfile,
} from './engine/publication_feedback.js';
import {
  diagnoseRecommendationRecovery, executeRecommendationRecovery, annotateRecoveryRunsResumability,
} from './engine/recommendation_recovery.js';
import {
  markNarrativeStateStale, narrativeStateStatus, prepareAndCommitNarrativeRevision,
} from './engine/narrative_state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

// ================= 小工具 =================
function sendJSON(res, code, obj) {
  // V0.28 操作日志：API 完成钩子（SSE 路由 end 也走这里）
  if (res._oplog) {
    try {
      logApi({
        method: res._oplog.method, path: res._oplog.path, status: code,
        durationMs: Date.now() - res._oplog.started,
        bookId: res._oplog.params?.id || null,
        detail: code >= 400 ? (obj?.error || '') : '',
      });
    } catch { /* ignore */ }
    res._oplog = null;
  }
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function requestError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function applySecurityHeaders(res, { api = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (api) res.setHeader('Cache-Control', 'no-store');
}

function validateApiRequest(req, method) {
  const rawHost = req.headers.host || '';
  let hostname = '';
  try { hostname = new URL(`http://${rawHost}`).hostname.toLowerCase(); } catch { /* invalid below */ }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw requestError('仅允许从本机访问', 'LOCAL_ONLY', 403);
  }
  if (method === 'GET' || method === 'HEAD') return;

  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw requestError('拒绝跨站请求', 'CROSS_SITE_REQUEST', 403);
  }
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host.toLowerCase() === rawHost.toLowerCase(); } catch { /* invalid */ }
    if (!sameOrigin) throw requestError('拒绝跨源请求', 'CROSS_ORIGIN_REQUEST', 403);
  }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  if (method === 'DELETE' && !hasBody) return;
  if (!contentType.startsWith('application/json')) {
    throw requestError('写请求必须使用 application/json', 'UNSUPPORTED_MEDIA_TYPE', 415);
  }
}

function maskApiKey(value) {
  const key = String(value || '');
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 10 * 1024 * 1024) { reject(new Error('body too large')); req.pause(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

function sseStart(res) {
  res._sse = true; // V0.33：标记 SSE 响应，asyncWrap 出错时发 error 事件而非静默断开
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (res._closed) return; // 客户端已断开，不再写入
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* 忽略写入错误 */ }
  };
  const end = (data) => {
    if (res._closed) return;
    try { send('done', data || {}); res.end(); } catch { /* ignore */ }
  };
  return { send, end };
}

/**
 * 把一条 SSE 响应附着为后台任务的观察者。响应断开只解除订阅；任务 Promise、
 * AbortController 与作品租约都由作业注册器持有，只有显式 cancel 路由会中止它。
 */
async function attachJobStream(registry, req, res, bookId, jobId, { failLabel = '后台任务失败' } = {}) {
  const { send, end } = sseStart(res);
  let detach = () => false;
  let resolveObserverClosed;
  const observerClosed = new Promise(resolve => { resolveObserverClosed = resolve; });
  const detachOnClose = () => {
    detach();
    resolveObserverClosed(null);
  };
  res.once('close', detachOnClose);
  try {
    detach = registry.subscribe(jobId, event => send(event.type, event), {
      replay: true,
      bookId,
    });
    const terminal = await Promise.race([
      registry.wait(jobId, { bookId }),
      observerClosed,
    ]);
    if (!terminal || res._closed) return terminal;
    if (terminal.status === 'completed') {
      end({ ok: true, job: terminal, ...(terminal.output || {}) });
    } else if (terminal.status === 'cancelled') {
      end({ ok: false, cancelled: true, job: terminal });
    } else {
      send('error', {
        message: terminal.error?.message || failLabel,
        error: terminal.error?.message || failLabel,
        code: terminal.error?.code || 'ERROR',
        jobId,
      });
      try { res.end(); } catch { /* 客户端可能已断开 */ }
    }
    return terminal;
  } finally {
    detach();
    res.off('close', detachOnClose);
  }
}

async function attachRecoveryJobStream(req, res, bookId, jobId) {
  return attachJobStream(recoveryJobs, req, res, bookId, jobId, { failLabel: '返工后台任务失败' });
}

async function attachWriteJobStream(req, res, bookId, jobId) {
  return attachJobStream(writeJobs, req, res, bookId, jobId, { failLabel: '自动创作失败' });
}

function abortOnDisconnect(req, res) {
  const controller = new AbortController();
  const abort = () => { try { controller.abort(); } catch { /* already aborted */ } };
  req.once('aborted', abort);
  res.once('close', abort);
  return controller;
}

// V0.50 修复：handler 同步抛错也会被接住（此前 Promise.resolve(fn(...)) 的参数求值同步抛错
// 时 .catch 未建立，异常冒泡到 node 直接崩溃进程——Bug2'点设定伏笔后端崩溃'的根因）
function asyncWrap(fn) {
  return (req, res, params) => Promise.resolve().then(() => fn(req, res, params)).catch(e => {
    try {
      if (!res.headersSent && !res._closed) sendJSON(res, e.statusCode || (e.code === 'AUTH_ERROR' ? 401 : 400), { error: e.message, code: e.code || 'ERROR' });
      // V0.33：SSE 响应中途出错 → 发送 error 事件（此前静默 res.end()，前端 sse() 无 done 只能报 TypeError）
      else if (res._sse && !res._closed) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
        res.end();
      }
      else if (!res._closed) res.end();
    } catch { /* 响应已销毁则忽略 */ }
  });
}

/** 后端版 safeJsonParse（前端 ui.js 也有同名函数；V0.50：characters 接口曾误用前端函数导致崩溃） */
function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// 简单 URL 匹配：/api/books/:id/chapters/:cid
function match(pattern, pathname) {
  const ps = pattern.split('/').filter(Boolean);
  const ss = pathname.split('/').filter(Boolean);
  if (ps.length !== ss.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(':')) {
      try { params[ps[i].slice(1)] = decodeURIComponent(ss[i]); } catch { return null; }
    } else if (ps[i] !== ss[i]) return null;
  }
  return params;
}

const routes = [];
function requireOwnedResource(bookId, resourceId, rule) {
  const resource = rule.get?.(resourceId);
  const owns = rule.owns
    ? rule.owns(bookId, resourceId, resource)
    : !!resource && (rule.bookIdOf ? rule.bookIdOf(resource) : resource.book_id) === bookId;
  if (!owns) throw requestError(`${rule.label || '资源'}不存在`, 'NOT_FOUND', 404);
  return resource;
}

function owned(param, label, get, bookIdOf) {
  return { param, label, get, bookIdOf };
}

const OWNED = {
  volume: owned('vid', '卷', id => store.volumes.get(id)),
  chapter: owned('cid', '章节', id => store.chapters.get(id)),
  scene: owned('sid', '场景', id => store.scenes.get(id), scene => store.chapters.get(scene.chapter_id)?.book_id),
  snapshot: owned('sid', '快照', id => store.snapshots.get(id)),
  character: owned('cid', '角色', id => store.characters.get(id)),
  location: owned('lid', '地点', id => store.locations.get(id)),
  item: owned('eid', '物品', id => store.items.get(id)),
  faction: owned('eid', '势力', id => store.factions.get(id)),
  foreshadow: owned('fid', '伏笔', id => store.foreshadows.get(id)),
  fact: owned('fid', '事实', id => store.facts.get(id)),
  hook: owned('hid', '钩子', id => store.pleasureHooks.get(id)),
  arc: owned('aid', '弧线', id => store.storyArcs.get(id)),
  worldbook: owned('wid', '世界书条目', id => store.worldbook.get(id)),
  openingAsset: owned('assetId', '开篇候选', id => store.openingAssets.get(id)),
  recoveryRun: owned('runId', '推荐返工运行', id => store.recommendationRecoveryRuns.get(id)),
  pending: {
    param: 'pid', label: '待登记实体',
    owns: (bookId, id) => store.pendingEntities.listAll(bookId, { limit: 1_000_000 }).some(row => String(row.id) === String(id)),
  },
  conflict: {
    param: 'cid', label: '冲突',
    owns: (bookId, id) => store.conflicts.list(bookId).some(row => String(row.id) === String(id)),
  },
};

function route(method, pattern, handler, { owned: ownership = [] } = {}) {
  const bookScoped = pattern.startsWith('/api/books/:id');
  const rules = Array.isArray(ownership) ? ownership : [ownership];
  routes.push({
    method,
    pattern,
    handler: asyncWrap((req, res, params) => {
      if (bookScoped) {
        if (!store.books.get(params.id)) throw requestError('作品不存在', 'NOT_FOUND', 404);
        for (const rule of rules) requireOwnedResource(params.id, params[rule.param], rule);
      }
      return handler(req, res, params);
    }),
  });
}

// ================= API =================
// 健康检查
route('GET', '/api/health', (_req, res) => {
  sendJSON(res, 200, { ok: true, time: Date.now(), peak: peakHint(resolveModelName('write', 'deepseek-v4-pro', getGlobal())), version: APP_VERSION });
});

// 设置
route('GET', '/api/settings', (_req, res) => {
  const g = getGlobal();
  const { apiKey: _secret, ...publicGlobal } = g;
  const info = providerInfo();
  // V0.98.4：设置页展示真源——任务模型显示当前服务商解析后的实际名（不显示 deepseek 原始默认名），
  // 正文档位文案带真实模型名，峰谷提示按当前计价感知免费模型。
  const writingPresets = writingModelPresetsFor(g);
  const effectiveWritingModel = writingPresets[g.writingModel] ? g.writingModel : 'flash';
  sendJSON(res, 200, {
    ...publicGlobal,
    _llmHealth: healthSnapshot(),
    // V0.29：服务商预设下发（设置页路由表模型下拉联动）
    providerPresets: PROVIDER_PRESETS,
    providerLabel: info.label,
    keyHint: info.keyHint || 'Key 只保存在本地 data/config.json（不经过任何第三方）。',
    baseUrl: g.baseUrl,
    hasApiKey: !!g.apiKey,
    apiKeyMasked: maskApiKey(g.apiKey),
    // V0.18：服务商预设与模型档位
    provider: g.provider || 'deepseek_official',
    writingModel: effectiveWritingModel,
    deepseekParams: g.deepseekParams !== false,
    // V0.109：备用通道（apiKey 掩码下发；resolved 备用实际模型名供前端显示）
    backup: (() => {
      const b = g.backup || {};
      const { apiKey: _bk, ...publicBackup } = b;
      return publicBackup;
    })(),
    hasBackupApiKey: !!g.backup?.apiKey,
    backupApiKeyMasked: maskApiKey(g.backup?.apiKey || ''),
    backupProviderLabel: (PROVIDER_PRESETS[g.backup?.provider] || PROVIDER_PRESETS.deepseek_official).label,
    backupResolvedModel: resolveBackupRoute('write', resolveModelName('write', 'deepseek-v4-pro', g), g)?.model || '',
    providers: PROVIDER_PRESETS,
    writingModelPresets: writingPresets,
    routes: g.routes || {},
    defaults: DEFAULT_ROUTES,
    resolvedModels: resolvedRouteModels(g),
    contextBudgetTokens: g.contextBudgetTokens,
    autoConfirmOutline: g.autoConfirmOutline,
    maxReviseRounds: g.maxReviseRounds,
    autoHealLength: g.autoHealLength,
    archiveStrategy: g.archiveStrategy,
    archiveRatio: g.archiveRatio,
    keepRecentChapters: g.keepRecentChapters,
    consecutiveFailures: g.consecutiveFailures,
    highIssueThreshold: g.highIssueThreshold,
    maxRecoveryRounds: g.maxRecoveryRounds,
    retrieval: g.retrieval,
    worldbookBudgetTokens: g.worldbookBudgetTokens,
    embedding: g.embedding,
    cacheWarnRatio: g.cacheWarnRatio,
    peakHint: peakHint(resolveModelName('write', 'deepseek-v4-pro', g)),
    embeddingStatus: embeddingStatus(),
  });
});

// V0.28 操作日志：查询（category/level/bookId/limit/offset 过滤）
route('GET', '/api/logs', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams;
  const r = store.operationLogs.list({
    category: q.get('category') || undefined,
    level: q.get('level') || undefined,
    bookId: q.get('bookId') || undefined,
    limit: Math.min(Number(q.get('limit')) || 500, 2000),
    offset: Number(q.get('offset')) || 0,
  });
  sendJSON(res, 200, r);
});
route('DELETE', '/api/logs', (_req, res) => {
  store.operationLogs.clear();
  sendJSON(res, 200, { ok: true });
});
route('PUT', '/api/settings', async (req, res) => {
  const body = await readBody(req);
  const patch = {};
  // V0.25 修复：补入 resilience（此前设置页韧性参数保存被静默丢弃）
  for (const k of ['baseUrl', 'routes', 'contextBudgetTokens', 'autoConfirmOutline', 'maxReviseRounds',
    'retrieval', 'worldbookBudgetTokens', 'embedding', 'cacheWarnRatio', 'autoHealLength',
    'archiveStrategy', 'archiveRatio', 'keepRecentChapters',
    'consecutiveFailures', 'highIssueThreshold', 'maxRecoveryRounds',
    'provider', 'writingModel', 'deepseekParams', 'resilience',
    // V0.82：V0.80 三项开篇吸引力配置补白名单（此前仅 config.js 有默认值、设置页保存被静默丢弃）
    'attractionGate', 'signingReviewCharThreshold', 'openingBlueprintChapters']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  // V0.109：备用通道配置（apiKey 留空 = 保持已存值，与主 Key 语义一致）
  if (body.backup !== undefined && body.backup && typeof body.backup === 'object') {
    const saved = getGlobal().backup || {};
    const incoming = body.backup;
    patch.backup = {
      ...saved,
      enabled: incoming.enabled === true,
      provider: PROVIDER_PRESETS[incoming.provider] ? incoming.provider : saved.provider || 'deepseek_official',
      apiKey: (typeof incoming.apiKey === 'string' && incoming.apiKey.trim() !== '') ? incoming.apiKey.trim() : (saved.apiKey || ''),
      modelMap: (incoming.modelMap && typeof incoming.modelMap === 'object')
        ? {
          flash: String(incoming.modelMap.flash || saved.modelMap?.flash || 'deepseek-v4.1-flash-expires-on-0910'),
          pro: String(incoming.modelMap.pro || saved.modelMap?.pro || 'deepseek-v4.1-flash-expires-on-0910'),
        }
        : (saved.modelMap || { flash: 'deepseek-v4.1-flash-expires-on-0910', pro: 'deepseek-v4.1-flash-expires-on-0910' }),
      stickyMs: incoming.stickyMs ?? saved.stickyMs,
      probeIntervalMs: incoming.probeIntervalMs ?? saved.probeIntervalMs,
      failureThreshold: incoming.failureThreshold ?? saved.failureThreshold,
    };
  }
  if (body.protocol !== undefined) {
    const protocol = String(body.protocol);
    if (!['chat', 'responses', 'messages', 'auto'].includes(protocol)) {
      throw requestError('protocol 必须是 chat/responses/messages/auto', 'INVALID_PROTOCOL', 400);
    }
    patch.protocol = protocol;
  }
  if (body.apiKey !== undefined && body.apiKey !== '') patch.apiKey = body.apiKey.trim();
  // V0.18：切换服务商预设时，未显式给 baseUrl/deepseekParams 则按预设自动补齐
  if (patch.provider && body.baseUrl === undefined && body.deepseekParams === undefined) {
    const preset = PROVIDER_PRESETS[patch.provider] || PROVIDER_PRESETS.custom;
    if (preset) {
      patch.baseUrl = preset.baseUrl;
      patch.deepseekParams = preset.deepseekParams;
    }
  }
  const g = saveGlobal(patch);
  sendJSON(res, 200, { ok: true, hasApiKey: !!g.apiKey, provider: g.provider, writingModel: g.writingModel, protocol: g.protocol });
});

// 测试连接：用当前（或临时传入的）API Key 验证 baseUrl 可达、Key 有效、模型可对话（不持久化任何内容）
// V0.109：body.channel === 'backup' 时按备用通道参数测试（Key 未填时明确提示）
route('POST', '/api/settings/test', async (req, res) => {
  const body = await readBody(req);
  const g = getGlobal();
  let baseUrl;
  let apiKey;
  let testModelsOverride = null;
  if (body.channel === 'backup') {
    const preset = PROVIDER_PRESETS[body.backupProvider || g.backup?.provider] || PROVIDER_PRESETS.deepseek_official;
    baseUrl = (body.baseUrl || preset.baseUrl).replace(/\/+$/, '');
    const explicitBk = typeof body.apiKey === 'string' && body.apiKey.trim() !== '';
    apiKey = (explicitBk && body.apiKey.trim()) || g.backup?.apiKey || '';
    if (!apiKey) {
      return sendJSON(res, 400, { ok: false, error: '备用通道未配置 API Key：请先填写备用 Key（DeepSeek Key 在 platform.deepseek.com 获取）。' });
    }
    // 备用测试优先测备用映射模型（运行时真相）
    const bkModel = (body.backupModel || g.backup?.modelMap?.flash || '').trim();
    if (bkModel) testModelsOverride = [bkModel, 'deepseek-v4-flash'];
  } else {
    baseUrl = (body.baseUrl || g.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    const explicitApiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '';
    if (!explicitApiKey && body.baseUrl) {
      let savedOrigin = '';
      try { savedOrigin = new URL(g.baseUrl).origin; } catch { /* invalid old config */ }
      const t = new URL(baseUrl);
      if (!savedOrigin || t.origin !== savedOrigin) {
        throw requestError('切换 API 主机时必须显式输入对应 API Key', 'API_KEY_REUSE_FORBIDDEN', 400);
      }
    }
    apiKey = (typeof body.apiKey === 'string' && body.apiKey.trim()) || g.apiKey;
  }
  if (!apiKey) {
    return sendJSON(res, 400, { ok: false, error: '未配置 API Key：请在输入框填写 Key 后重试（无需先保存，测试用临时值）。' });
  }
  let targetUrl;
  try { targetUrl = new URL(baseUrl); } catch { throw requestError('API 地址无效', 'INVALID_BASE_URL', 400); }
  if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) {
    throw requestError('API 地址必须是无账号信息的 http/https URL', 'INVALID_BASE_URL', 400);
  }
  const started = Date.now();
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  try {
    // 1) 列出模型：验证 Key 有效 + 地址可达
    const mres = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    if (!mres.ok) {
      const text = await mres.text().catch(() => '');
      const reason = mres.status === 401 || mres.status === 403
        ? 'API Key 无效或无权限（401/403）——请检查 Key 是否正确、是否已开通对应模型'
        : `HTTP ${mres.status}${text ? `：${text.slice(0, 200)}` : ''}`;
      return sendJSON(res, 200, { ok: false, stage: 'models', status: mres.status, error: reason, latencyMs: Date.now() - started });
    }
    const data = await mres.json();
    const models = (data.data || []).map(m => m.id).filter(id => typeof id === 'string');
    // 2) 最小对话：验证模型实际可用（成本可忽略）
    let chatOk = false;
    let chatErr = '';
    try {
      // V0.100.1：测当前服务商实际运行的模型（运行时真相），DeepSeek 名单仅作历史回退——
      // 旧逻辑找不到 DeepSeek 裸名就误测 models[0] 无关模型（OpenRouter 上触发数据政策 404 误报）。
      // V0.109：备用通道测试优先测备用映射模型（testModelsOverride）。
      const model = testModelsOverride?.find(m => models.includes(m)) || pickTestModel(models, g);
      const cres = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers, signal: AbortSignal.timeout(15000),
        redirect: 'manual',
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }),
      });
      if (cres.ok) chatOk = true;
      else chatErr = `HTTP ${cres.status}：${(await cres.text().catch(() => '')).slice(0, 150)}`;
    } catch (e) { chatErr = e.message; }
    return sendJSON(res, 200, {
      ok: true, stage: 'chat', latencyMs: Date.now() - started,
      models: models.slice(0, 30), modelCount: models.length,
      chatOk, chatErr: chatErr || undefined,
      message: chatOk ? '连接成功，模型可正常对话' : '连接成功，但对话测试失败（可能模型未开通）',
    });
  } catch (e) {
    return sendJSON(res, 200, {
      ok: false, stage: 'network', error: e.name === 'TimeoutError' ? '连接超时（15 秒）——请检查网络或 API 地址' : `网络错误：${e.message}`,
      latencyMs: Date.now() - started,
    });
  }
});

// 作品 CRUD
route('GET', '/api/books', (_req, res) => {
  const blocked = new Set(['quality_blocked', 'partial', 'failed']);
  const writing = new Set(['writing', 'drafted', 'outlined']);
  sendJSON(res, 200, store.books.list().map(b => {
    const chapters = store.chapters.list(b.id);
    return {
      ...b,
      chapterCount: chapters.length,
      blockedCount: chapters.filter(c => blocked.has(c.status)).length,
      writingCount: chapters.filter(c => writing.has(c.status)).length,
      activeWriteJob: writeJobs.findActiveByBook(b.id),
      activeRecoveryJob: recoveryJobs.findActiveByBook(b.id),
      history: historyStats(b.id),
    };
  }));
});
route('POST', '/api/books', async (req, res) => {
  const body = await readBody(req);
  // V0.26（用户方向）：书名留空 → 先不取名（"未命名"占位 + 前端"待自动命名"徽章），
  // 自动创作生成书级大纲后，按大纲 title/logline 自动命名（质量最好、零额外 API 调用）。
  // 此前创建时即时 AI 起名依赖服务商稳定，opencode/ds 卡顿时必然失败且拖慢创建。
  const title = body.title?.trim() || '未命名';
  const book = store.books.create({
    title, genre: body.genre || '玄幻', blurb: body.blurb || '',
    platform: body.platform || '通用', settings: body.settings || {},
    perspective: body.perspective === 'first' ? 'first' : 'third', // V0.42 叙述视角
    era: body.era || '{}', // V0.82 朝代配置（历史题材）
  });
  ensureHistory(book.id);
  sendJSON(res, 200, book);
});
// V0.42：更新叙述视角（仅影响后续章节；更新 system 公共材料 + 历史堆前缀 → 一次性缓存重建）
route('PUT', '/api/books/:id/perspective', async (req, res, p) => {
  const body = await readBody(req);
  const perspective = body.perspective === 'first' ? 'first' : 'third';
  const cur = store.books.get(p.id);
  if (!cur) return sendJSON(res, 404, { error: '作品不存在' });
  // V0.84：视角未变化 → 不更新 system、不 rebuild（此前无条件重建 → 一次空操作全量前缀失效）
  if ((cur.perspective || 'third') === perspective) {
    return sendJSON(res, 200, { ok: true, perspective, note: '视角未变化，无需重建缓存' });
  }
  const book = store.books.update(p.id, { perspective });
  const { buildSystemPrompt } = await import('./engine/prompts.js');
  store.materials.set(p.id, 'system', buildSystemPrompt(store.books.get(p.id)));
  const { rebuildHistory } = await import('./engine/outline.js');
  rebuildHistory(p.id);
  sendJSON(res, 200, { ok: true, perspective, note: '已更新，仅影响后续章节' });
});
route('GET', '/api/books/:id', (req, res, p) => {
  const book = store.books.get(p.id);
  if (!book) return sendJSON(res, 404, { error: '作品不存在' });
  sendJSON(res, 200, {
    ...book,
    chapters: store.chapters.list(p.id),
    volumes: store.volumes.list(p.id),
    materials: materialsInfo(p.id),
    history: historyStats(p.id),
    budget: budgetCheck(p.id),
    foreshadows: store.foreshadows.list(p.id),
    forgotten: forgottenList(p.id, store.chapters.count(p.id)),
    worldbook: store.worldbook.list(p.id),
    pending: store.pendingEntities.list(p.id),
    facts: store.facts.list(p.id, { status: 'active' }).slice(0, 50),
    timeline: store.timeline.list(p.id),
    activeWriteJob: writeJobs.findActiveByBook(p.id),
    activeRecoveryJob: recoveryJobs.findActiveByBook(p.id),
    // V0.29：冲突带章节序号（chapter_id 是 UUID，前端直接显示会乱）
    conflicts: store.conflicts.list(p.id).slice(0, 30).map(c => ({ ...c, chapter_idx: c.chapter_id ? (store.chapters.get(c.chapter_id)?.idx ?? null) : null })),
  });
});
route('PATCH', '/api/books/:id', async (req, res, p) => {
  const body = await readBody(req);
  const before = store.books.get(p.id);
  const book = store.books.update(p.id, body);
  if (!book) return sendJSON(res, 404, { error: '作品不存在' });
  // V0.73：书名/题材/简介/视角变化会进 system 前缀（buildSystemPrompt），必须重建历史堆，
  // 否则 LLM 上下文里的书名/题材仍是旧的（此前 PATCH 只更新 DB，不重建缓存）
  // V0.84：只对"值实际变化"的字段重建——此前 body 含字段即重建，改回原值/重复保存也全量失效前缀
  const changed = ['title', 'genre', 'blurb', 'perspective'].some(k =>
    body[k] !== undefined && before && String(body[k]) !== String(before[k] ?? ''));
  if (changed) {
    try { rebuildHistory(p.id, '作品信息更新'); } catch { /* ignore */ }
  }
  if (body.era !== undefined && (book.genre === '历史')) {
    try {
      const { ensureEraContext } = await import('./engine/history.js');
      // 幂等跳过已存在卡 → force 强制按新朝代重生成
      await ensureEraContext(p.id, { force: true });
    } catch { /* 时代卡重生成失败由 pilot 兜底 */ }
  }
  sendJSON(res, 200, book);
});
route('DELETE', '/api/books/:id', (req, res, p) => {
  store.books.remove(p.id);
  sendJSON(res, 200, { ok: true });
});

// 公共材料（缓存前缀！）
route('PUT', '/api/books/:id/settings', async (req, res, p) => {
  const body = await readBody(req);
  const book = store.books.get(p.id);
  if (!book) return sendJSON(res, 404, { error: '作品不存在' });
  const cur = store.books.settings(p.id);
  store.books.update(p.id, { settings: { ...cur, ...(body.settings || {}) } });
  sendJSON(res, 200, { ok: true, settings: store.books.settings(p.id) });
});
route('GET', '/api/books/:id/public-materials', (req, res, p) => {
  sendJSON(res, 200, store.materials.all(p.id).map(m => ({ kind: m.kind, content: m.content, version: m.version, updatedAt: m.updated_at })));
});
route('PUT', '/api/books/:id/public-materials', async (req, res, p) => {
  const body = await readBody(req);
  const { kind, content } = body;
  if (!kind || content === undefined) return sendJSON(res, 400, { error: '需要 kind 与 content' });
  const r = store.materials.set(p.id, kind, content);
  // V0.84：仅内容实际变化才重建前缀（store.materials.set 已返回 cacheRebuilt）——
  // 此前无条件 rebuild：用户重复保存相同内容也全量失效缓存前缀（"忽高忽低"直接推手）
  if (r.cacheRebuilt) {
    rebuildHistory(p.id); // 公共材料变化 → 重建前缀（缓存重建）
    sendJSON(res, 200, { ...r, cacheRebuilt: true, note: '公共材料已更新，历史堆前缀已重建（下一次请求将重新构建缓存）' });
  } else {
    sendJSON(res, 200, { ...r, cacheRebuilt: false, note: '内容未变化，前缀缓存保持不变（命中率不受影响）' });
  }
});

// 大纲
route('GET', '/api/books/:id/volumes', (req, res, p) => {
  sendJSON(res, 200, store.volumes.list(p.id));
});
route('POST', '/api/books/:id/volumes', async (req, res, p) => {
  const body = await readBody(req);
  const vols = store.volumes.list(p.id);
  const idx = body.idx || vols.length + 1;
  sendJSON(res, 200, store.volumes.create(p.id, idx, body));
});
route('PATCH', '/api/books/:id/volumes/:vid', async (req, res, p) => {
  const body = await readBody(req);
  const v = store.volumes.update(p.vid, body);
  if (!v) return sendJSON(res, 404, { error: '卷不存在' });
  sendJSON(res, 200, v);
}, { owned: OWNED.volume });
route('DELETE', '/api/books/:id/volumes/:vid', (req, res, p) => {
  store.volumes.remove(p.vid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.volume });
// V0.73：书籍一键导出（纯文本，按卷分组，网文排版，方便复制粘贴/下载）
// V0.74：支持 ?chapterIds=id1,id2 选择章节导出；响应附 chapterList 供前端勾选
route('GET', '/api/books/:id/export', (req, res, p) => {
  const book = store.books.get(p.id);
  if (!book) return sendJSON(res, 404, { error: '作品不存在' });
  const volumes = store.volumes.list(p.id);
  const chapters = store.chapters.list(p.id);
  // 每章全文只取一次（避免 fullText 重复查 scenes）
  const fullTexts = new Map(chapters.map(c => [c.id, (store.chapters.fullText(c.id) || '').trim()]));
  // 选择章节过滤（逗号分隔 chapterId）
  const selParam = new URL(req.url, 'http://x').searchParams.get('chapterIds');
  let selected = null;
  if (selParam) {
    selected = new Set(selParam.split(',').map(s => s.trim()).filter(Boolean));
  }
  const openingAsset = store.openingAssets.active(p.id) || null;
  sendJSON(res, 200, buildBookExport({ book, volumes, chapters, fullTexts, selected, openingAsset }));
});

// ================= V0.98 书级承诺驱动的开篇创作与可回退干预 =================
route('GET', '/api/books/:id/story-promise', (_req, res, p) => {
  sendJSON(res, 200, storyPromiseStatus(p.id));
});
route('POST', '/api/books/:id/story-promise/rebuild', async (req, res, p) => {
  const body = await readBody(req);
  const profile = await buildStoryPromiseProfile(p.id, { force: true, data: body.data });
  sendJSON(res, 200, { ok: true, profile, status: storyPromiseStatus(p.id) });
});
route('POST', '/api/books/:id/story-promise/locks', async (req, res, p) => {
  const body = await readBody(req);
  if (Array.isArray(body.unlock)) {
    const locks = unlockStoryPromiseFields(p.id, body.unlock);
    return sendJSON(res, 200, { ok: true, locks, profile: storyPromiseStatus(p.id).profile });
  }
  const profile = lockStoryPromiseFields(p.id, body.locks || body.patch || {});
  sendJSON(res, 200, { ok: true, profile, locks: storyPromiseStatus(p.id).locks });
});

route('GET', '/api/books/:id/opening-diagnosis', (_req, res, p) => {
  sendJSON(res, 200, openingDiagnosisStatus(p.id));
});
route('POST', '/api/books/:id/opening-diagnosis/run', async (req, res, p) => {
  const body = await readBody(req);
  const result = await diagnoseOpening(p.id, { data: body.data });
  sendJSON(res, 200, result);
});

route('GET', '/api/books/:id/opening-assets', (_req, res, p) => {
  const assets = store.openingAssets.list(p.id).map(asset => ({
    ...asset,
    contract: safeJsonParse(asset.contract_json, {}),
    audit: safeJsonParse(asset.audit_json, {}),
    rank: safeJsonParse(asset.rank_json, {}),
    freshness: openingAssetFreshness(p.id, asset),
  }));
  sendJSON(res, 200, { assets, active: store.openingAssets.active(p.id)?.id || null });
});

async function openingComposeRoute(req, res, p) {
  const lease = acquireBookLease(p.id, 'opening-compose');
  try {
    const body = await readBody(req);
    const { send, end } = sseStart(res);
    const ctrl = abortOnDisconnect(req, res);
    const onEvent = event => send(event.type || 'opening_stage', event);
    if (body.autoPrepare === true) {
      const promised = await ensureStoryPromiseProfile(p.id, { signal: ctrl.signal, onEvent });
      if (!promised.ok) throw new Error(`创作宪章未完成：${promised.error}`);
      if (body.mode !== 'create') {
        const diagnosis = openingDiagnosisStatus(p.id);
        if (!diagnosis.exists || diagnosis.stale) {
          try {
            await diagnoseOpening(p.id, { signal: ctrl.signal, onEvent });
          } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
            onEvent({ type: 'opening_stage', step: 'unreviewed', detail: `正文诊断未完成：${error?.message || error}；继续生成候选，不伪报诊断通过` });
          }
        }
      }
    }
    const result = await composeOpeningCandidates(p.id, {
      mode: body.mode === 'create' ? 'create' : 'repair',
      allowStandalonePrologue: body.allowStandalonePrologue === true,
      onEvent,
      signal: ctrl.signal,
    });
    let comparison = null;
    if (body.autoCompare === true) {
      try {
        if (body.mode === 'create') {
          comparison = await compareDraftOpeningCandidates(p.id, result.candidates, { signal: ctrl.signal, onEvent });
        } else {
          const assetIds = result.candidates.map(item => item.asset_id).filter(Boolean);
          comparison = await compareOpeningCandidates(p.id, assetIds, { signal: ctrl.signal, onEvent });
        }
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
        comparison = { status: 'unreviewed', auto_safe: false, error: error?.message || String(error) };
        onEvent({ type: 'opening_stage', step: 'unreviewed', detail: `匿名比较未完成：${comparison.error}；保留原稿供作者决定` });
      }
    }
    if (!res._closed) end({
      ok: true, mode: result.mode, candidates: result.candidates.length,
      items: result.candidates, generator_model: result.generator_model, comparison,
    });
  } finally { lease.release(); }
}
route('POST', '/api/books/:id/opening-compose', openingComposeRoute);
route('POST', '/api/books/:id/opening-assets/generate', openingComposeRoute);

route('POST', '/api/books/:id/opening-assets/compare', async (req, res, p) => {
  const body = await readBody(req);
  const result = await compareOpeningCandidates(p.id, body.assetIds || [], {});
  sendJSON(res, 200, result);
});
route('POST', '/api/books/:id/opening-assets/:assetId/audit', async (req, res, p) => {
  const body = await readBody(req);
  sendJSON(res, 200, await auditOpeningAsset(p.id, p.assetId, { data: body.data }));
}, { owned: OWNED.openingAsset });
route('POST', '/api/books/:id/opening-assets/:assetId/select', async (_req, res, p) => {
  sendJSON(res, 200, selectOpeningAsset(p.id, p.assetId));
}, { owned: OWNED.openingAsset });
route('POST', '/api/books/:id/opening-assets/:assetId/apply', async (_req, res, p) => {
  const result = applySelectedOpeningAsset(p.id, p.assetId);
  if (!result.ok) return sendJSON(res, 409, { ...result, error: result.message });
  sendJSON(res, 200, result);
}, { owned: OWNED.openingAsset });
route('POST', '/api/books/:id/opening-assets/:assetId/retire', async (_req, res, p) => {
  sendJSON(res, 200, retireOpeningAsset(p.id, p.assetId));
}, { owned: OWNED.openingAsset });
route('DELETE', '/api/books/:id/opening-assets/:assetId', async (_req, res, p) => {
  try {
    sendJSON(res, 200, removeOpeningAsset(p.id, p.assetId));
  } catch (error) {
    if (error?.code === 'OPENING_ASSET_APPLIED') {
      return sendJSON(res, 409, { ok: false, code: 'OPENING_ASSET_APPLIED', error: error.message });
    }
    throw error;
  }
}, { owned: OWNED.openingAsset });
route('GET', '/api/books/:id/opening-publish-patch', (_req, res, p) => {
  sendJSON(res, 200, currentOpeningPublishPatch(p.id));
});
route('POST', '/api/books/:id/opening-feedback', async (req, res, p) => {
  const body = await readBody(req);
  sendJSON(res, 200, recordOpeningFeedback(p.id, body));
});

// V0.28：生成进度 SSE（阶段实时推送，不再静默等待）
route('POST', '/api/books/:id/outline/generate', async (req, res, p) => {
  const body = await readBody(req);
  const { send, end } = sseStart(res);
  const ctrl = abortOnDisconnect(req, res);
  const onEvent = (ev) => send('stage', ev);
  const outline = await generateBookOutline(p.id, body, { onEvent, signal: ctrl.signal });
  end({ ok: true, title: outline.title, volumes: outline.volumes?.length || 0 });
});

// V0.28：书级设定自动生成（SSE 进度；force=true 供设定页"重新生成"）
route('POST', '/api/books/:id/settings/generate', async (req, res, p) => {
  const { send, end } = sseStart(res);
  const ctrl = abortOnDisconnect(req, res);
  const onEvent = (ev) => send('stage', ev);
  const r = await generateBookSettings(p.id, { onEvent, force: true, signal: ctrl.signal });
  end(r);
});
route('POST', '/api/books/:id/volumes/:vid/generate', async (req, res, p) => {
  const body = await readBody(req);
  const { send, end } = sseStart(res);
  const ctrl = abortOnDisconnect(req, res);
  const onEvent = (ev) => send('stage', ev);
  const outline = await generateVolumeOutline(p.id, p.vid, body, { onEvent, signal: ctrl.signal });
  end({ ok: true, title: outline.title, chapters: outline.chapters?.length || 0 });
}, { owned: OWNED.volume });
route('POST', '/api/books/:id/chapters/:cid/outline', async (req, res, p) => {
  const { send, end } = sseStart(res);
  const ctrl = abortOnDisconnect(req, res);
  const onEvent = (ev) => send('stage', ev);
  const outline = await generateChapterOutline(p.id, p.cid, { onEvent, signal: ctrl.signal });
  end({ ok: true, outline, note: '细纲已生成' });
}, { owned: OWNED.chapter });
route('POST', '/api/books/:id/chapters/:cid/confirm', async (req, res, p) => {
  const ch = store.chapters.get(p.cid);
  if (!ch) return sendJSON(res, 404, { error: '章节不存在' });
  try {
    transitionChapterStatus(p.id, p.cid, 'outlined', { reason: '细纲确认' });
  } catch (e) {
    return sendJSON(res, 409, { error: e.message });
  }
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.chapter });

// V0.82：手动章节改名（AI 改名；历史题材自动带时代风格约束）——前端大纲页/写作台"改名"按钮
route('POST', '/api/books/:id/chapters/:cid/rename', async (req, res, p) => {
  try {
    const { adjustChapterTitle } = await import('./engine/alignment.js');
    const r = await adjustChapterTitle(p.id, p.cid);
    if (!r) return sendJSON(res, 200, { ok: false, error: '改名失败（可能 AI 返回重名/空名），请重试' });
    sendJSON(res, 200, { ok: true, oldTitle: r.oldTitle, newTitle: r.newTitle });
  } catch (e) {
    sendJSON(res, 200, { ok: false, error: e.message });
  }
}, { owned: OWNED.chapter });

// V0.85：章节重写（打回 planned，清场景/摘要/结算 + 快照可回滚）——作者对已写章不满意时大胆重写
// body: { toIdx?: number } 默认只重写本章；可传 toIdx 重写 ch..toIdx 范围
route('POST', '/api/books/:id/chapters/:cid/rewrite', async (req, res, p) => {
  try {
    const body = await readBody(req);
    const ch = store.chapters.get(p.cid);
    if (!ch) return sendJSON(res, 404, { error: '章节不存在' });
    const { rewriteChapterRange } = await import('./engine/signing.js');
    const toIdx = Number(body?.toIdx) || ch.idx;
    const r = rewriteChapterRange(p.id, { fromIdx: ch.idx, toIdx, label: '手动章节重写' });
    if (!r.ok) return sendJSON(res, 200, r);
    sendJSON(res, 200, {
      ok: true,
      rewritten: r.rewritten,
      snapshot: r.snapshot,
      requiresStateRebuild: r.requiresStateRebuild,
      note: r.requiresStateRebuild
        ? `已打回 ch${ch.idx}..ch${toIdx}（快照已存）。请先在“叙事版本安全门”重建干净基线，再从第${ch.idx}章顺序创作。`
        : `已重置 ch${ch.idx}..ch${toIdx} 的未完成草稿（快照已存），可重新创作。`,
    });
  } catch (e) {
    sendJSON(res, 200, { ok: false, error: e.message });
  }
}, { owned: OWNED.chapter });

// 写作（SSE）
route('POST', '/api/books/:id/chapters/:cid/write', async (req, res, p) => {
  const lease = acquireBookLease(p.id, 'write');
  try {
    const body = await readBody(req);
    const scene = requireOwnedResource(p.id, body.sceneId, OWNED.scene);
    if (scene.chapter_id !== p.cid) throw requestError('场景不存在', 'NOT_FOUND', 404);
    const { send, end } = sseStart(res);
    const ctrl = abortOnDisconnect(req, res);
    const r = await writeScene(p.id, p.cid, body.sceneId, {
      onDelta: d => send('delta', { delta: d }),
      onUsage: u => send('usage', u),
      onProgress: pr => send('progress', pr),
      signal: ctrl.signal,
    });
    if (!res._closed) end({ sceneId: r.scene.id, wordCount: r.content.length, usage: r.usage, cost: r.cost });
  } catch (e) {
    if (e.name === 'AbortError') { try { res.end(); } catch { /* ignore */ } return; }
    if (!res._closed && res._sse) { try { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message, code: e.code })}\n\n`); res.end(); } catch { /* ignore */ } }
    else if (!res._closed) throw e;
  } finally { lease.release(); }
}, { owned: OWNED.chapter });

// 一键写一章（SSE：细纲→正文→审校→修订→结算）
route('POST', '/api/books/:id/chapters/:cid/flow', async (req, res, p) => {
  const lease = acquireBookLease(p.id, 'flow');
  try {
    const body = await readBody(req);
    const { send, end } = sseStart(res);
    const ctrl = abortOnDisconnect(req, res);
    const r = await runChapterFlow(p.id, p.cid, {
      autoConfirm: body.autoConfirm,
      onEvent: ev => send(ev.type, ev),
      signal: ctrl.signal,
    });
    if (!res._closed) end(r);
  } catch (e) {
    if (e.name === 'AbortError') { try { res.end(); } catch { /* ignore */ } return; }
    if (!res._closed && res._sse) { try { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message, code: e.code })}\n\n`); res.end(); } catch { /* ignore */ } }
    else if (!res._closed) throw e;
  } finally { lease.release(); }
}, { owned: OWNED.chapter });

// V0.99：推流质量驾驶舱（审核历史、作品数据、番茄公开边界、前 20 章返工）。
route('GET', '/api/books/:id/publication', (_req, res, p) => {
  const dashboard = publicationDashboard(p.id);
  // 标注每条返工运行的可续性（直接执行/断点续跑/已过期），供前端"选择进度"弹窗使用
  dashboard.recoveryRuns = annotateRecoveryRunsResumability(p.id, dashboard.recoveryRuns);
  dashboard.activeRecoveryJob = recoveryJobs.findActiveByBook(p.id);
  sendJSON(res, 200, dashboard);
});

route('PUT', '/api/books/:id/publication', async (req, res, p) => {
  const body = await readBody(req);
  const current = store.publicationProfiles.get(p.id);
  const validated = validatePublicationProfile({
    ...body,
    recommendationStage: body.recommendationStage ?? body.recommendation_stage ?? current?.recommendation_stage ?? 'not_applied',
    remainingAttempts: body.remainingAttempts ?? body.remaining_attempts ?? current?.remaining_attempts,
    suspectedTurnChapter: body.suspectedTurnChapter ?? body.suspected_turn_chapter ?? current?.suspected_turn_chapter,
    workUrl: body.workUrl ?? body.work_url ?? current?.work_url ?? '',
    externalBookId: body.externalBookId ?? body.external_book_id ?? current?.external_book_id ?? '',
    editorFeedback: body.editorFeedback ?? body.editor_feedback ?? current?.editor_feedback ?? '',
    authorDiagnosis: body.authorDiagnosis ?? body.author_diagnosis ?? current?.author_diagnosis ?? '',
  });
  const profile = store.publicationProfiles.upsert(p.id, validated);
  sendJSON(res, 200, { profile });
});

route('POST', '/api/books/:id/publication/reviews', async (req, res, p) => {
  const body = await readBody(req);
  const checked = validatePublicationProfile({
    recommendationStage: body.stage,
    remainingAttempts: body.remainingAttempts ?? body.remaining_attempts,
    editorFeedback: body.feedback,
  });
  const review = store.recommendationReviews.add(p.id, {
    ...body, stage: checked.recommendationStage, remainingAttempts: checked.remainingAttempts,
    feedback: checked.editorFeedback,
  });
  const profilePatch = {
    recommendationStage: checked.recommendationStage,
    remainingAttempts: checked.remainingAttempts,
    editorFeedback: body.feedback || '',
    reviewedAt: review.reviewed_at,
  };
  if (checked.recommendationStage === 'failed') profilePatch.recoveryStatus = 'needs_plan';
  const profile = store.publicationProfiles.upsert(p.id, profilePatch);
  sendJSON(res, 200, { review, profile });
});

route('POST', '/api/books/:id/publication/metrics', async (req, res, p) => {
  const body = validateMetricSnapshot(await readBody(req));
  const metric = store.publicationMetrics.add(p.id, body);
  sendJSON(res, 200, { metric });
});

route('POST', '/api/books/:id/publication/sync', async (req, res, p) => {
  await readBody(req);
  const result = await syncFanqiePublication(p.id);
  sendJSON(res, 200, result);
});

route('POST', '/api/books/:id/publication/pending-sync/confirm', async (req, res, p) => {
  const body = await readBody(req);
  if (body.chapters !== undefined && !Array.isArray(body.chapters)) throw requestError('chapters 必须是数组', 'INVALID_PUBLICATION_INPUT', 400);
  const profile = store.publicationProfiles.clearPendingSync(p.id, body.chapters);
  sendJSON(res, 200, { profile: profile || null });
});

// V0.100：正文与摘要/人物/伏笔/规划的同版状态；手工改稿留下 stale 时由作者显式重建。
route('GET', '/api/books/:id/narrative-state', (_req, res, p) => {
  sendJSON(res, 200, narrativeStateStatus(p.id));
});

route('POST', '/api/books/:id/narrative-state/rebuild', async (req, res, p) => {
  const lease = acquireBookLease(p.id, 'narrative-state-rebuild');
  try {
    await readBody(req);
    const { send, end } = sseStart(res);
    const ctrl = abortOnDisconnect(req, res);
    const result = await prepareAndCommitNarrativeRevision(p.id, {
      reason: '作者显式触发完成章派生状态与各层规划同版重建',
      signal: ctrl.signal,
      onEvent: event => send(event.type, event),
    });
    if (!res._closed) end({ ok: true, result, state: narrativeStateStatus(p.id) });
  } catch (error) {
    if (error.name === 'AbortError') { try { res.end(); } catch { /* ignore */ } return; }
    if (!res._closed && res._sse) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: error.message, code: error.code })}\n\n`); res.end(); } catch { /* ignore */ }
    } else if (!res._closed) throw error;
  } finally { lease.release(); }
});

route('POST', '/api/books/:id/recommendation-recovery/diagnose', async (req, res, p) => {
  const body = await readBody(req);
  const startChapter = Number(body.startChapter) || 1;
  const endChapter = Number(body.endChapter) || 20;
  const resumeRunId = body.resumeRunId || null;
  const taskKey = `diagnose:${resumeRunId || 'auto'}:${startChapter}-${endChapter}:${body.forceFresh === true ? 'fresh' : 'resume'}`;
  const job = recoveryJobs.start({
    bookId: p.id,
    taskKey,
    type: 'recommendation-recovery-diagnose',
    runId: resumeRunId,
    task: async ({ signal, emit }) => {
      const run = await diagnoseRecommendationRecovery(p.id, {
        startChapter,
        endChapter,
        forceFresh: body.forceFresh === true,
        resumeRunId,
        onEvent: emit,
        signal,
      });
      return { run };
    },
  });
  await attachRecoveryJobStream(req, res, p.id, job.id);
});

route('POST', '/api/books/:id/recommendation-recovery/:runId/execute', async (req, res, p) => {
  const body = await readBody(req);
  const job = recoveryJobs.start({
    bookId: p.id,
    taskKey: `execute:${p.runId}`,
    type: 'recommendation-recovery-execute',
    runId: p.runId,
    task: async ({ signal, emit }) => {
      const result = await executeRecommendationRecovery(p.id, p.runId, {
        confirmedPublishedRewrite: body.confirmedPublishedRewrite === true,
        reusePriorCandidates: body.reusePriorCandidates !== false,
        onEvent: emit,
        signal,
      });
      return { result, run: store.recommendationRecoveryRuns.get(p.runId) };
    },
  });
  await attachRecoveryJobStream(req, res, p.id, job.id);
}, { owned: OWNED.recoveryRun });

route('POST', '/api/books/:id/recommendation-recovery/jobs/:jobId/observe', async (req, res, p) => {
  await readBody(req);
  await attachRecoveryJobStream(req, res, p.id, p.jobId);
});

route('POST', '/api/books/:id/recommendation-recovery/jobs/:jobId/cancel', async (req, res, p) => {
  await readBody(req);
  const job = recoveryJobs.cancel(p.jobId, { bookId: p.id });
  sendJSON(res, 202, { ok: true, job });
});

route('GET', '/api/books/:id/jobs/active', (_req, res, p) => {
  sendJSON(res, 200, {
    write: writeJobs.findActiveByBook(p.id),
    recovery: recoveryJobs.findActiveByBook(p.id),
  });
});

// AI 本位：一键自动全书。作业由 writeJobs 持有；浏览器只观察，断开不取消。
route('POST', '/api/books/:id/pilot', async (req, res, p) => {
  const body = await readBody(req);
  const job = writeJobs.start({
    bookId: p.id,
    taskKey: 'pilot',
    type: 'pilot',
    task: async ({ signal, emit }) => runBookPilot(p.id, {
      targetChapters: body.targetChapters,
      idea: body.idea,
      polish: body.polish === true,
      onEvent: ev => emit(ev),
      signal,
    }),
  });
  await attachWriteJobStream(req, res, p.id, job.id);
});

// 全书打磨。作业由 writeJobs 持有；浏览器只观察，断开不取消。
route('POST', '/api/books/:id/polish', async (req, res, p) => {
  await readBody(req);
  const job = writeJobs.start({
    bookId: p.id,
    taskKey: 'polish',
    type: 'polish',
    task: async ({ signal, emit }) => runPolish(p.id, {
      onEvent: ev => emit(ev),
      signal,
    }),
  });
  await attachWriteJobStream(req, res, p.id, job.id);
});

route('POST', '/api/books/:id/write-jobs/:jobId/observe', async (req, res, p) => {
  await readBody(req);
  await attachWriteJobStream(req, res, p.id, p.jobId);
});

route('POST', '/api/books/:id/write-jobs/:jobId/cancel', async (req, res, p) => {
  await readBody(req);
  const job = writeJobs.cancel(p.jobId, { bookId: p.id });
  sendJSON(res, 202, { ok: true, job });
});

// 生成书契约（AI 本位：灵感→顶层合同）
route('POST', '/api/books/:id/contract', async (req, res, p) => {
  const body = await readBody(req);
  const contract = await generateBookContract(p.id, { idea: body.idea });
  sendJSON(res, 200, contract);
});

// V0.16：上下文归档与健康恢复
route('POST', '/api/books/:id/archive', async (req, res, p) => {
  const body = await readBody(req);
  const r = await runArchive(p.id, { force: body.force === true });
  sendJSON(res, 200, r || { skipped: true });
});
route('GET', '/api/books/:id/archive/status', (req, res, p) => {
  sendJSON(res, 200, {
    need: checkArchiveNeed(p.id),
    archives: store.archives.list(p.id).map(a => ({ batch: a.batch, range: [a.range_start, a.range_end], tokensSaved: a.tokens_saved, createdAt: a.created_at })),
    injectionPreview: archiveInjectionText(p.id).slice(0, 200),
  });
});
route('GET', '/api/books/:id/archive/search', (req, res, p) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  sendJSON(res, 200, { query: q, results: archiveSearch(p.id, q) });
});
route('GET', '/api/books/:id/health', (req, res, p) => {
  sendJSON(res, 200, {
    drift: detectDrift(p.id),
    recent: store.chapterHealth.recent(p.id, 5),
    archives: store.archives.list(p.id).length,
    constraints: store.constraints.list(p.id, { activeOnly: true }),
  });
});
route('POST', '/api/books/:id/recover', async (req, res, p) => {
  const r = await autoRecover(p.id, {});
  sendJSON(res, 200, r);
});
// V0.96：引擎能力概览（只读聚合）——V0.95 的叙事记忆库/滚动摘要/物品卡/批次自检此前纯引擎内部，
// 前端零可见。本端点把这些内部状态聚合给前端「书务台·引擎概览」展示。零 LLM 成本，全部本地即时计算。
route('GET', '/api/books/:id/engine', (req, res, p) => {
  try {
    // 叙事记忆库：按类别计数（voice/promise/detail/scene/relation）
    const mem = store.memoryEntries.list(p.id);
    const byCategory = {};
    for (const m of mem) byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    // 批次自检：对最近完成章现场跑一轮（纯本地规则，零 LLM）
    let batchScan = null;
    const lastDone = store.chapters.list(p.id)
      .filter(c => isCompletedChapter(c))
      .sort((a, b) => b.idx - a.idx)[0];
    if (lastDone) {
      const r = batchQualityScan(p.id, lastDone.idx);
      batchScan = { chapterIdx: lastDone.idx, scanned: r.scanned, signals: r.signals, constraints: r.constraints.length };
    }
    const rolling = store.rollingSummaries.get(p.id);
    const book = store.books.get(p.id);
    sendJSON(res, 200, {
      memory: { total: mem.length, byCategory, latest: mem.slice(0, 8).map(m => ({ category: m.category, name: m.name, content: m.content, chapter: m.chapter })) },
      rolling: { chars: rolling.length, preview: rolling.slice(0, 160) },
      items: store.items.list(p.id).length,
      vectors: store.vectors.count(p.id),
      batchScan,
      craftProfile: formatCraftProfileLine(resolveCraftProfile(book, store.books.settings(p.id))),
    });
  } catch (e) { sendJSON(res, 200, { error: e.message }); }
});

// 审校 / 覆盖 / 修订 / 结算
route('POST', '/api/books/:id/chapters/:cid/audit', async (req, res, p) => {
  const r = await auditChapter(p.id, p.cid);
  sendJSON(res, 200, r);
}, { owned: OWNED.chapter });
route('POST', '/api/books/:id/chapters/:cid/coverage', async (req, res, p) => {
  const r = await coverageCheck(p.id, p.cid);
  sendJSON(res, 200, r);
}, { owned: OWNED.chapter });
route('POST', '/api/books/:id/chapters/:cid/revise', async (req, res, p) => {
  const body = await readBody(req);
  const scene = requireOwnedResource(p.id, body.sceneId, OWNED.scene);
  if (scene.chapter_id !== p.cid) throw requestError('场景不存在', 'NOT_FOUND', 404);
  const r = await reviseScene(p.id, p.cid, body.sceneId, { issues: body.issues || [], extraNote: body.extraNote });
  sendJSON(res, 200, { ...r, note: '场景已重写，该场景起的历史已重建（后续请求缓存将重新构建）' });
}, { owned: OWNED.chapter });
route('POST', '/api/books/:id/chapters/:cid/settle', async (req, res, p) => {
  const body = await readBody(req);
  const ch = store.chapters.get(p.cid);
  if (!ch) return sendJSON(res, 404, { error: '章节不存在' });
  if (hasExplicitCompletedStatus(ch) && body.force !== true) {
    return sendJSON(res, 409, { error: '本章已结算，重复结算会重复落事实/时间线。如需重算请传 force:true。' });
  }
  const r = await settleChapter(p.id, p.cid);
  sendJSON(res, 200, r);
}, { owned: OWNED.chapter });

// 章节/场景手工管理
route('POST', '/api/books/:id/chapters', async (req, res, p) => {
  const body = await readBody(req);
  if (body.volumeId) requireOwnedResource(p.id, body.volumeId, OWNED.volume);
  const ch = store.chapters.create(p.id, body.volumeId || null, body.idx || store.chapters.count(p.id) + 1, body);
  sendJSON(res, 200, ch);
});
route('GET', '/api/books/:id/chapters/:cid', (req, res, p) => {
  const ch = store.chapters.get(p.cid);
  if (!ch) return sendJSON(res, 404, { error: '章节不存在' });
  sendJSON(res, 200, {
    ...ch,
    outline: store.chapters.outline(p.cid),
    scenes: store.scenes.list(p.cid),
    fullText: store.chapters.fullText(p.cid),
    summary: store.summaries.get(p.cid)?.summary || '',
  });
}, { owned: OWNED.chapter });
route('PATCH', '/api/books/:id/chapters/:cid', async (req, res, p) => {
  const body = await readBody(req);
  // V0.93.2：章状态只能经正式管线流转（状态机单一真源）；手工编辑仅允许回退到
  // outlined/planned（细纲编辑），终态/过程态伪造一律拒绝。
  const { status, ...rest } = (body && typeof body === 'object') ? body : {};
  const ch = store.chapters.update(p.cid, rest);
  if (!ch) return sendJSON(res, 404, { error: '章节不存在' });
  if (status !== undefined) {
    if (status !== 'outlined' && status !== 'planned') {
      return sendJSON(res, 422, { error: '章状态只能经正式管线流转；手工编辑仅允许 outlined/planned。' });
    }
    try {
      transitionChapterStatus(p.id, p.cid, status, { reason: '手工细纲编辑' });
    } catch (e) {
      return sendJSON(res, 409, { error: e.message });
    }
  }
  sendJSON(res, 200, store.chapters.get(p.cid));
}, { owned: OWNED.chapter });
route('DELETE', '/api/books/:id/chapters/:cid', (req, res, p) => {
  const chapter = store.chapters.get(p.cid);
  const completed = isCompletedChapter(chapter);
  store.transaction(() => {
    store.chapters.remove(p.cid);
    if (completed) {
      markNarrativeStateStale(p.id, {
        fromChapter: chapter.idx,
        reason: `删除了完成章第${chapter.idx}章，等待同版派生状态重建`,
        changedChapters: [chapter.idx],
      });
    }
  });
  sendJSON(res, 200, { ok: true, requiresStateRebuild: completed });
}, { owned: OWNED.chapter });
route('PATCH', '/api/books/:id/scenes/:sid', async (req, res, p) => {
  const body = await readBody(req);
  const { content, ...meta } = (body && typeof body === 'object') ? body : {};
  const sc = store.scenes.get(p.sid);
  if (!sc) return sendJSON(res, 404, { error: '场景不存在' });
  let rewrite = null;
  // V0.93.2：正文内容修改必须过门禁（validateChapterRewrite + 指纹同步 + 状态机），
  // 元数据（beat/pov/location/target_words/status）直改不受限。
  if (content !== undefined && String(content).trim() !== String(sc.content || '').trim()) {
    rewrite = applyValidatedSceneRewrite(p.id, p.sid, content);
    if (!rewrite.ok) return sendJSON(res, 422, { error: rewrite.code, message: rewrite.message });
  }
  const updated = store.scenes.update(p.sid, meta);
  sendJSON(res, 200, {
    ...(updated || store.scenes.get(p.sid)),
    requiresStateRebuild: rewrite?.requiresStateRebuild === true,
    narrativeRevisionBlocked: rewrite?.requiresStateRebuild === true,
  });
}, { owned: OWNED.scene });

// 伏笔
route('GET', '/api/books/:id/foreshadows', (req, res, p) => {
  const status = new URL(req.url, 'http://localhost').searchParams.get('status');
  sendJSON(res, 200, store.foreshadows.list(p.id, { status }));
});
route('POST', '/api/books/:id/foreshadows', async (req, res, p) => {
  const body = await readBody(req);
  const f = store.foreshadows.create(p.id, body);
  sendJSON(res, 200, f);
});
route('PATCH', '/api/books/:id/foreshadows/:fid', async (req, res, p) => {
  const body = await readBody(req);
  const f = store.foreshadows.update(p.fid, body);
  if (!f) return sendJSON(res, 404, { error: '伏笔不存在' });
  sendJSON(res, 200, f);
}, { owned: OWNED.foreshadow });
route('DELETE', '/api/books/:id/foreshadows/:fid', (req, res, p) => {
  store.foreshadows.remove(p.fid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.foreshadow });

// 事实/冲突/待登记
route('GET', '/api/books/:id/facts', (req, res, p) => {
  // V0.25 修复：node:http 原生 req 无 query 属性，此前 status 过滤恒失效
  const status = new URL(req.url, 'http://localhost').searchParams.get('status');
  sendJSON(res, 200, status ? store.facts.list(p.id, { status }) : store.facts.list(p.id));
});
route('POST', '/api/books/:id/facts', async (req, res, p) => {
  const body = await readBody(req);
  const f = store.facts.create(p.id, body);
  sendJSON(res, 200, f);
});
route('POST', '/api/books/:id/facts/:fid/resolve', async (req, res, p) => {
  const body = await readBody(req);
  store.facts.setStatus(p.fid, body.status || 'active');
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.fact });
route('POST', '/api/books/:id/pending/:pid/resolve', async (req, res, p) => {
  const body = await readBody(req);
  store.pendingEntities.resolve(p.pid, body.status || 'confirmed');
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.pending });
// V0.40：待登记自动整理（手动触发；类型推断建卡/去重/超期归档/误建迁移）
// V0.78 修复：手动整理须传真实最新章节号——此前默认 999999 使"刚登记未及二次出现"的
// 实体（如老幺）被立即 stale_archived，角色永久丢失。
route('POST', '/api/books/:id/pending/tidy', async (req, res, p) => {
  const migrated = migrateMisplacedCharacters(p.id);
  const maxIdx = store.chapters.list(p.id).reduce((m, c) => Math.max(m, c.idx), 0);
  const tidy = tidyPendingEntities(p.id, { currentChapter: maxIdx || 1 });
  sendJSON(res, 200, { ok: true, migrated, ...tidy });
});
// V0.41：卷级审阅记录查询 + 手动触发
route('GET', '/api/books/:id/volume-reviews', (req, res, p) => {
  sendJSON(res, 200, { reviews: store.volumeReviews.list(p.id) });
});
route('POST', '/api/books/:id/volume-reviews/tidy', async (req, res, p) => {
  const results = await autoReviewVolumes(p.id);
  sendJSON(res, 200, { ok: true, results });
});
route('POST', '/api/books/:id/conflicts/:cid/resolve', async (req, res, p) => {
  const body = await readBody(req);
  store.conflicts.resolve(p.cid, body.resolution || 'accepted');
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.conflict });

// ================= V0.17 快感引擎 =================
// V0.22：作品快照（打磨回滚，借鉴 storyforge 版本历史）
route('GET', '/api/books/:id/snapshots', (req, res, p) => {
  sendJSON(res, 200, store.snapshots.list(p.id));
});
route('POST', '/api/books/:id/snapshots', async (req, res, p) => {
  const body = await readBody(req);
  const s = store.snapshots.add(p.id, { label: body.label || '手动快照', source: 'manual', data: store.snapshotBook(p.id) });
  sendJSON(res, 200, s);
});
route('POST', '/api/books/:id/snapshots/:sid/restore', async (req, res, p) => {
  const snap = store.snapshots.get(p.sid);
  if (!snap) return sendJSON(res, 404, { error: '快照不存在' });
  // 先做 SQLite 一致性备份；任何备份错误都会在 restoreSnapshot 前抛出，保证 fail closed。
  const backupPath = await store.backup({
    directory: path.join(DATA_DIR, 'backups'),
    prefix: 'snapshot_restore_',
    retention: 20,
  });
  const beforeNarrative = new Map(store.chapters.list(p.id).map(chapter => [Number(chapter.idx), {
    text: store.chapters.fullText(chapter.id),
    completed: isCompletedChapter(chapter),
  }]));
  let changedChapters = [];
  const restored = store.transaction(() => {
    const result = store.restoreSnapshot(p.id, snap.data);
    // 快照只保存正文，不保存完整历史堆；清掉旧正文历史与悬空引用后按恢复结果重建。
    store.history.truncateFrom(p.id, 3, '快照恢复');
    for (const chapter of store.chapters.list(p.id)) {
      for (const scene of store.scenes.list(chapter.id)) {
        if (scene.history_seq != null) store.scenes.update(scene.id, { historySeq: null });
      }
    }
    rebuildHistory(p.id, '快照恢复');
    rebuildHistoryFromChapters(p.id);
    const afterNarrative = new Map(store.chapters.list(p.id).map(chapter => [Number(chapter.idx), {
      text: store.chapters.fullText(chapter.id),
      completed: isCompletedChapter(chapter),
    }]));
    changedChapters = [...new Set([...beforeNarrative.keys(), ...afterNarrative.keys()])]
      .filter(idx => {
        const before = beforeNarrative.get(idx);
        const after = afterNarrative.get(idx);
        return before?.text !== after?.text || before?.completed !== after?.completed;
      })
      .sort((a, b) => a - b);
    if (changedChapters.length) {
      markNarrativeStateStale(p.id, {
        fromChapter: changedChapters[0],
        reason: '从作品快照恢复了正文，等待同版派生状态重建',
        changedChapters,
      });
    }
    return result;
  });
  sendJSON(res, 200, {
    ok: true,
    backup: backupPath,
    restored,
    requiresStateRebuild: changedChapters.length > 0,
    changedChapters,
    message: '已创建恢复前备份，并从快照恢复正文、章节状态与历史堆',
  });
}, { owned: OWNED.snapshot });
route('DELETE', '/api/books/:id/snapshots/:sid', async (req, res, p) => {
  store.snapshots.remove(p.sid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.snapshot });
// V0.96.4：快照 diff 对比（借鉴 DeepWrite「可审阅的文稿修改」——重写/打磨前自动快照
// 早已存在，缺的是"改了什么"的可见性；只读端点，无 chapter 参数返回差异章概览）
route('GET', '/api/books/:id/snapshots/:sid/diff', (req, res, p) => {
  const chapterParam = new URL(req.url, 'http://x').searchParams.get('chapter');
  if (chapterParam == null || chapterParam === '') {
    return sendJSON(res, 200, snapshotDiffOverview(p.id, p.sid));
  }
  const idx = parseInt(chapterParam, 10);
  if (!Number.isFinite(idx) || idx < 1) throw requestError('chapter 参数必须是正整数章号', 'BAD_REQUEST', 400);
  sendJSON(res, 200, snapshotChapterDiff(p.id, p.sid, idx));
}, { owned: OWNED.snapshot });
route('GET', '/api/books/:id/pleasure', (req, res, p) => sendJSON(res, 200, pleasureStatus(p.id)));
route('POST', '/api/books/:id/pleasure/plan', async (req, res, p) => {
  const r = await planBookPleasure(p.id);
  sendJSON(res, 200, r);
});
// V0.83：开篇蓝图手动端点（老书/中断书补生成入口——此前只有 pilot 骨架一处触发）
route('POST', '/api/books/:id/opening-blueprint/generate', async (req, res, p) => {
  try {
    const { generateOpeningBlueprint } = await import('./engine/opening.js');
    const r = await generateOpeningBlueprint(p.id, { force: true });
    sendJSON(res, 200, { ok: r.ok, error: r.error, chapters: r.blueprint?.hook_ladder?.length || 0 });
  } catch (e) {
    sendJSON(res, 200, { ok: false, error: e.message });
  }
});
route('POST', '/api/books/:id/pleasure/audit', async (req, res, p) => {
  const body = await readBody(req);
  const chapter = requireOwnedResource(p.id, body.chapterId, OWNED.chapter);
  const r = await auditPleasure(p.id, body.chapterId, chapter?.idx || 0);
  sendJSON(res, 200, r);
});
route('POST', '/api/books/:id/hooks', async (req, res, p) => {
  const body = await readBody(req);
  const h = store.pleasureHooks.create(p.id, body);
  sendJSON(res, 200, h);
});
route('PATCH', '/api/books/:id/hooks/:hid', async (req, res, p) => {
  const body = await readBody(req);
  sendJSON(res, 200, store.pleasureHooks.update(p.hid, body));
}, { owned: OWNED.hook });
route('DELETE', '/api/books/:id/hooks/:hid', (req, res, p) => {
  store.pleasureHooks.remove(p.hid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.hook });
route('POST', '/api/books/:id/arcs', async (req, res, p) => {
  const body = await readBody(req);
  sendJSON(res, 200, store.storyArcs.create(p.id, body));
});
route('PATCH', '/api/books/:id/arcs/:aid', async (req, res, p) => {
  const body = await readBody(req);
  sendJSON(res, 200, store.storyArcs.update(p.aid, body));
}, { owned: OWNED.arc });
route('DELETE', '/api/books/:id/arcs/:aid', (req, res, p) => {
  store.storyArcs.remove(p.aid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.arc });

// ================= V0.19 灵感提级（创意引擎） =================
route('POST', '/api/idea/seeds', async (req, res) => {
  const body = await readBody(req);
  sendJSON(res, 200, { ok: true, seeds: generateIdeaSeeds(body.genre || '', 5) });
});
route('POST', '/api/idea/amplify', async (req, res) => {
  const body = await readBody(req);
  const r = await amplifyIdea(null, { idea: body.idea, genre: body.genre, platform: body.platform });
  sendJSON(res, 200, r);
});
route('POST', '/api/books/:id/idea/seeds', (req, res, p) => {
  const book = store.books.get(p.id);
  sendJSON(res, 200, { ok: true, seeds: generateIdeaSeeds(book?.genre || '', 5) });
});
route('POST', '/api/books/:id/idea/amplify', async (req, res, p) => {
  const body = await readBody(req);
  const r = await amplifyIdea(p.id, { idea: body.idea, genre: body.genre, platform: body.platform });
  sendJSON(res, 200, r);
});
route('POST', '/api/books/:id/idea/apply', async (req, res, p) => {
  const body = await readBody(req);
  const r = applyIdeaOption(p.id, body);
  sendJSON(res, 200, r);
});
route('POST', '/api/books/:id/contract/score', async (req, res, p) => {
  const r = await scoreContract(p.id);
  sendJSON(res, 200, r);
});

// 世界书
route('GET', '/api/books/:id/worldbook', (req, res, p) => sendJSON(res, 200, store.worldbook.list(p.id)));
// V0.49：角色卡列表（性格/目标/秘密/弧线/心境/关系——world 页展示用）
// V0.50：加分级 tier/能力 abilities/退出 exitNote；新增 POST/PATCH（角色库页编辑）
route('GET', '/api/books/:id/characters', (req, res, p) => {
  const chars = store.characters.list(p.id).map(c => ({
    id: c.id, name: c.name, deceased: !!c.deceased, deathChapter: c.death_chapter,
    role: (safeJsonParse(c.card_json, {}) || {}).role || '', // V0.96：身份（card.role 单源）前端可见可编辑
    personality: c.personality, goal: c.goal, fear: c.fear, secret: c.secret, arc: c.arc, relation: c.relation,
    speech: c.speech || '', speechForbid: c.speech_forbid || '',
    tier: c.tier || 'minor', abilities: safeJsonParse(c.abilities_json, []), exitNote: c.exit_note || '',
    state: safeJsonParse(c.state_json, {}), firstChapter: c.first_chapter, lastChapter: c.last_chapter,
  }));
  sendJSON(res, 200, chars);
});
route('POST', '/api/books/:id/characters', async (req, res, p) => {
  const body = await readBody(req);
  if (!body || !(body.name || '').trim()) return sendJSON(res, 400, { error: '角色名必填' });
  const c = store.characters.create(p.id, {
    name: body.name.trim(), personality: body.personality || '', goal: body.goal || '',
    fear: body.fear || '', secret: body.secret || '', arc: body.arc || '', relation: body.relation || '',
    speech: body.speech || '', speechForbid: body.speechForbid || body.speech_forbid || '',
    tier: body.tier || 'minor', abilities: body.abilities || [], exitNote: body.exitNote || '',
    card: { role: body.role || '' }, // V0.96：traits 退役（性格单源=personality 列）
  });
  sendJSON(res, 200, c);
});
route('PATCH', '/api/books/:id/characters/:cid', async (req, res, p) => {
  const body = await readBody(req);
  const patch = {};
  for (const k of ['name', 'personality', 'goal', 'fear', 'secret', 'arc', 'relation', 'speech', 'speechForbid', 'speech_forbid', 'tier', 'abilities', 'exitNote', 'deceased', 'deathChapter', 'card', 'state']) {
    if (body && body[k] !== undefined) patch[k] = body[k];
  }
  // V0.96：顶层 role 字段并入 card.role（保留 card 其他元数据不覆盖）
  if (body && body.role !== undefined) {
    const row = store.characters.get(p.cid);
    const existingCard = safeJsonParse(row?.card_json, {}) || {};
    patch.card = { ...existingCard, ...(patch.card || {}), role: body.role };
  }
  const c = store.characters.update(p.cid, patch);
  if (!c) return sendJSON(res, 404, { error: '角色不存在' });
  sendJSON(res, 200, c);
}, { owned: OWNED.character });
route('DELETE', '/api/books/:id/characters/:cid', (req, res, p) => {
  store.characters.remove(p.cid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.character });
// V0.50：角色库 AI 自动整理（补建/分级/补全）
route('POST', '/api/books/:id/characters/tidy', async (req, res, p) => {  const { tidyRoster } = await import('./engine/roster.js');
  sendJSON(res, 200, await tidyRoster(p.id, {}));
});
// V0.82：角色 AI 取名（历史题材注入命名/避讳规则；前端角色库"AI 取名"按钮）
route('POST', '/api/books/:id/characters/name', async (req, res, p) => {
  try {
    const body = await readBody(req);
    const { generateCharacterNames } = await import('./engine/history.js');
    sendJSON(res, 200, await generateCharacterNames(p.id, {
      hint: body.hint || '', count: Number(body.count) || 5, gender: body.gender || '',
    }));
  } catch (e) {
    sendJSON(res, 200, { ok: false, error: e.message });
  }
});
// V0.71：地点库 API（GET 列表/POST 建卡/PATCH 更新/DELETE 删除/tidy 自动整理）
// V0.82：GET/POST/PATCH 支持行政层级 admin_level 与战略属性 strategic（历史题材）
route('GET', '/api/books/:id/locations', (req, res, p) => {
  const locs = store.locations.list(p.id).map(l => ({
    id: l.id, name: l.name, kind: l.kind || '', desc: l.desc || '',
    stable: !!l.stable, status: l.status || 'normal', note: l.note || '',
    adminLevel: l.admin_level || '', strategic: l.strategic || '',
    firstChapter: l.first_chapter, lastChapter: l.last_chapter,
  }));
  sendJSON(res, 200, locs);
});
route('POST', '/api/books/:id/locations', async (req, res, p) => {
  const body = await readBody(req);
  if (!body || !(body.name || '').trim()) return sendJSON(res, 400, { error: '地点名必填' });
  const l = store.locations.create(p.id, { name: body.name.trim(), card: { desc: body.desc || '' } });
  store.locations.update(l.id, {
    kind: body.kind || '', desc: body.desc || '', status: body.status || 'normal',
    adminLevel: body.admin_level || body.adminLevel || '', strategic: body.strategic || '',
  });
  sendJSON(res, 200, store.locations.get(l.id));
});
route('PATCH', '/api/books/:id/locations/:lid', async (req, res, p) => {
  const body = await readBody(req);
  const patch = {};
  for (const k of ['name', 'kind', 'desc', 'stable', 'status', 'note']) {
    if (body && body[k] !== undefined) patch[k] = body[k];
  }
  // V0.82：行政层级/战略属性（前端传 admin_level 或 adminLevel 均可）
  if (body && body.admin_level !== undefined) patch.adminLevel = body.admin_level;
  else if (body && body.adminLevel !== undefined) patch.adminLevel = body.adminLevel;
  if (body && body.strategic !== undefined) patch.strategic = body.strategic;
  const l = store.locations.update(p.lid, patch);
  if (!l) return sendJSON(res, 404, { error: '地点不存在' });
  sendJSON(res, 200, l);
}, { owned: OWNED.location });
route('DELETE', '/api/books/:id/locations/:lid', (req, res, p) => {
  store.locations.remove(p.lid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.location });
route('POST', '/api/books/:id/locations/tidy', async (req, res, p) => {
  const { tidyLocations } = await import('./engine/locations.js');
  sendJSON(res, 200, await tidyLocations(p.id, {}));
});

// 物品/势力沿用统一实体卡结构；此前只有底层 store，没有 HTTP 管理入口。
function simpleEntityView(entity) {
  return {
    id: entity.id,
    name: entity.name,
    card: safeJsonParse(entity.card_json, {}),
    state: safeJsonParse(entity.state_json, {}),
    firstChapter: entity.first_chapter,
    lastChapter: entity.last_chapter,
  };
}

function registerSimpleEntityRoutes(kind, api, label, ownershipRule) {
  route('GET', `/api/books/:id/${kind}`, (_req, res, p) => {
    sendJSON(res, 200, api.list(p.id).map(simpleEntityView));
  });
  route('POST', `/api/books/:id/${kind}`, async (req, res, p) => {
    const body = await readBody(req);
    const name = String(body?.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: `${label}名必填` });
    sendJSON(res, 200, simpleEntityView(api.create(p.id, {
      name,
      card: body.card || {},
      state: body.state || {},
      firstChapter: body.firstChapter,
    })));
  });
  route('PATCH', `/api/books/:id/${kind}/:eid`, async (req, res, p) => {
    const body = await readBody(req);
    const patch = {};
    for (const key of ['name', 'card', 'state', 'firstChapter', 'lastChapter']) {
      if (body?.[key] !== undefined) patch[key] = body[key];
    }
    sendJSON(res, 200, simpleEntityView(api.update(p.eid, patch)));
  }, { owned: ownershipRule });
  route('DELETE', `/api/books/:id/${kind}/:eid`, (_req, res, p) => {
    api.remove(p.eid);
    sendJSON(res, 200, { ok: true });
  }, { owned: ownershipRule });
}

registerSimpleEntityRoutes('items', store.items, '物品', OWNED.item);
registerSimpleEntityRoutes('factions', store.factions, '势力', OWNED.faction);

// V0.50：全书一键自动整理（AI 本位：待登记→角色库→事实冲突，各司其职汇总）
route('POST', '/api/books/:id/tidy-all', async (req, res, p) => {
  const { tidyRoster } = await import('./engine/roster.js');
  const notes = [];
  // 1) 待登记实体整理（pending → 建卡/去重/归档）
  try {
    const pe = store.pendingEntities.list(p.id);
    if (pe.length) {
      const maxIdx = store.chapters.list(p.id).reduce((m, c) => Math.max(m, c.idx), 0);
      const r = tidyPendingEntities(p.id, { currentChapter: maxIdx || 1 }) || {};
      notes.push(`待登记：处理 ${pe.length} 条（${r.confirmed ? `建卡/确认 ${r.confirmed}` : ''}${r.archived ? `，归档 ${r.archived}` : ''}${r.migrated ? `，迁移 ${r.migrated}` : ''}）`);
    }
  } catch (e) { notes.push(`待登记整理失败：${e.message.slice(0, 40)}`); }
  // 2) 角色库整理（补建/分级/AI 补全）
  try {
    const r = await tidyRoster(p.id, {});
    notes.push(r.note);
  } catch (e) { notes.push(`角色库整理失败：${e.message.slice(0, 40)}`); }
  // 3) 事实库统计（superseded 由结算自动维护；这里只做轻量检查）
  try {
    const facts = store.facts.list(p.id);
    const active = facts.filter(f => f.status !== 'superseded').length;
    const superseded = facts.length - active;
    notes.push(`事实库：${active} 条生效，${superseded} 条已废弃（superseded）`);
  } catch (e) { notes.push(`事实库检查失败：${e.message.slice(0, 40)}`); }
  sendJSON(res, 200, { ok: true, notes });
});
route('POST', '/api/books/:id/worldbook', async (req, res, p) => {
  const body = await readBody(req);
  sendJSON(res, 200, store.worldbook.create(p.id, body));
});
route('PATCH', '/api/books/:id/worldbook/:wid', async (req, res, p) => {
  const body = await readBody(req);
  const w = store.worldbook.update(p.wid, body);
  if (!w) return sendJSON(res, 404, { error: '条目不存在' });
  sendJSON(res, 200, w);
}, { owned: OWNED.worldbook });
route('DELETE', '/api/books/:id/worldbook/:wid', (req, res, p) => {
  store.worldbook.remove(p.wid);
  sendJSON(res, 200, { ok: true });
}, { owned: OWNED.worldbook });

// 时间线 / 检索 / 历史
route('GET', '/api/books/:id/timeline', (req, res, p) => sendJSON(res, 200, store.timeline.list(p.id)));
route('GET', '/api/books/:id/search', async (req, res, p) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  const k = parseInt(new URL(req.url, 'http://x').searchParams.get('k') || '6', 10);
  const semantic = await semanticSearch(p.id, q, k);
  sendJSON(res, 200, { query: q, semantic, available: !!semantic.length });
});
route('GET', '/api/books/:id/history', (req, res, p) => {
  sendJSON(res, 200, {
    stats: historyStats(p.id),
    budget: budgetCheck(p.id),
    messages: store.history.list(p.id).slice(-20),
  });
});

// 成本
route('GET', '/api/books/:id/costs', (req, res, p) => {
  sendJSON(res, 200, {
    aggregate: store.usageLogs.aggregate({ bookId: p.id }), logs: store.usageLogs.list({ bookId: p.id, limit: 100 }),
    // V0.43：缓存重建记录（truncate/rebuild 原因追踪）
    rebuilds: store.operationLogs.list({ category: 'cache', bookId: p.id, limit: 30 }).items,
  });
});
// V0.62：成本聚合缓存（5 秒 TTL）——前端 usage 事件高频调用时避免全表聚合压后端
let costsAggCache = { at: 0, data: null };
route('GET', '/api/costs', (_req, res) => {
  const now = Date.now();
  if (!costsAggCache.data || now - costsAggCache.at > 5000) {
    costsAggCache = { at: now, data: { aggregate: store.usageLogs.aggregate() } };
  }
  sendJSON(res, 200, costsAggCache.data);
});

// embedding
route('POST', '/api/books/:id/embedding/init', async (req, res, p) => {
  const body = await readBody(req);
  try {
    await initEmbedding({ force: !!body.force, onProgress: pr => console.log('[embedding]', pr) });
    sendJSON(res, 200, { status: embeddingStatus() });
  } catch (e) {
    sendJSON(res, 400, { error: e.message, status: embeddingStatus() });
  }
});
route('GET', '/api/books/:id/embedding/status', (req, res, p) => {
  sendJSON(res, 200, {
    status: embeddingStatus(),
    vectors: store.vectors.count(p.id),
  });
});
route('GET', '/api/embedding/status', (_req, res) => {
  sendJSON(res, 200, { status: embeddingStatus() });
});
// V0.29：全局 embedding 初始化（设置页用）
route('POST', '/api/embedding/init', async (req, res) => {
  const body = await readBody(req);
  await initEmbedding({ force: !!body.force, onProgress: pr => console.log('[embedding]', pr) });
  sendJSON(res, 200, { status: embeddingStatus() });
});
route('POST', '/api/books/:id/embedding/index', async (req, res, p) => {
  const r = await indexBook(p.id);
  sendJSON(res, 200, r);
});

// 备份是写磁盘操作，使用 POST，避免跨站页面用简单 GET 反复触发。
route('POST', '/api/backup', async (_req, res) => {
  const dest = await store.backup();
  sendJSON(res, 200, { ok: true, file: dest });
});

// ================= 静态服务 =================
// V0.43：启动时每日数据备份（保留最近 7 份；data/backups/）
async function backupDataIfDue() {
  try {
    const dbPath = path.join(DATA_DIR, 'novel.db');
    if (!fs.existsSync(dbPath)) return null;
    const today = new Date().toISOString().slice(0, 10);
    return await store.backup({
      directory: path.join(DATA_DIR, 'backups'),
      filename: `novel-${today}.db`,
      prefix: 'novel-',
      retention: 7,
      skipIfExists: true,
    });
  } catch (error) {
    // 备份失败不阻塞启动，但必须留下可见诊断，不能静默失去安全网。
    console.error(`[backup] ${error?.message || error}`);
    return null;
  }
}
await backupDataIfDue();

// V0.100.1 启动自愈：进程中断留下的 building/ready/applying 派生版本只在存活进程内推进，
// 悬挂后会把作品永久卡在“重建中”；启动时标记 failed（fail-closed，正文与旧派生状态未被覆盖，可安全重建）。
const orphanedNarrativeRevisions = store.narrativeRevisions.failOrphanedInFlight();
if (orphanedNarrativeRevisions) {
  console.log(`[narrative] 启动自愈：${orphanedNarrativeRevisions} 个中断的派生版本已标记 failed`);
}

// V0.100.1 启动自愈：中断的返工诊断/执行同样只在存活进程内推进；复位后诊断走批次
// 检查点断点续跑、执行回到 planned 可重新发起，不再让用户从第一章从头诊断。
const orphanedRecoveryRuns = store.recommendationRecoveryRuns.healOrphanedInFlight();
if (orphanedRecoveryRuns) {
  console.log(`[recovery] 启动自愈：${orphanedRecoveryRuns} 个中断的返工运行已复位（诊断断点可续跑，执行待重新确认）`);
}

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(WEB_DIR, '.' + p);
  // 路径边界校验：必须位于 WEB_DIR 内（path.relative 不允许以 .. 开头）
  const rel = path.relative(WEB_DIR, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.byteLength,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ================= 服务器 =================
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    return sendJSON(res, 400, { error: 'bad request' });
  }
  const method = req.method.toUpperCase();
  applySecurityHeaders(res, { api: pathname.startsWith('/api/') });
  // 客户端断开时避免向已销毁的响应写入导致进程崩溃
  res.on('close', () => { res._closed = true; });

  if (pathname.startsWith('/api/')) {
    try { validateApiRequest(req, method); }
    catch (error) { return sendJSON(res, error.statusCode || 400, { error: error.message, code: error.code || 'ERROR' }); }
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = match(r.pattern, pathname);
      if (params) {
        // V0.28：API 请求自动入操作日志（记录于 sendJSON 本体；排除日志接口自身）
        if (!(pathname.startsWith('/api/logs') || (pathname === '/api/settings' && method === 'GET'))) {
          res._oplog = { started: Date.now(), method, path: pathname, params };
        }
        return r.handler(req, res, params);
      }
    }
    // /api/embedding/status 之类无 :id 的路由
    return sendJSON(res, 404, { error: `no route: ${method} ${pathname}` });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJSON(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  serveStatic(req, res, pathname);
});

// V0.25：端口占用时给出友好提示而非崩溃堆栈（常见于旧实例未关闭）
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用：可能是旧实例仍在运行。`);
    console.error(`请直接访问 http://localhost:${PORT} ，或先关闭旧实例；也可用 NOVEL_PORT 环境变量指定其他端口。`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('==============================================');
  console.log('  墨舟 · AI 小说写作工具已启动');
  console.log(`  地址: http://localhost:${PORT}`);
  console.log('  首次使用：先在「设置」中填入 DeepSeek API Key');
  console.log('  关闭本窗口即停止服务');
  console.log('  （浏览器请通过 start.bat 打开——V0.61 起服务器不再自动打开，防双开）');
  console.log('==============================================');
});

process.on('SIGINT', () => { console.log('\n正在退出…'); process.exit(0); });

// V0.50：全局异常兜底——任何未捕获异常/拒绝都记录日志并继续服务，
// 防止"偶发崩溃 → 前端 Failed to fetch"（此前无兜底时一个异常就整机退出）
process.on('uncaughtException', (e) => {
  try {
    console.error(`[uncaughtException] ${e?.stack || e?.message || e}`);
    try {
      fs.appendFileSync(path.join(DATA_DIR, 'server-errors.log'), `\n[${new Date().toISOString()}] ${e?.stack || e?.message || e}\n`);
    } catch { /* 日志写失败忽略 */ }
  } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error(`[unhandledRejection] ${reason?.stack || reason?.message || reason}`);
  } catch { /* ignore */ }
});
