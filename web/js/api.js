// web/js/api.js —— fetch 封装 + SSE 流式客户端
'use strict';

/** JSON API 调用 */
export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.code = data.code;
    throw err;
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

/**
 * SSE POST：流式读取服务端事件。
 * @param {string} path
 * @param {object} body
 * @param {(event:string, data:object)=>void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function sse(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  if (!res.body) throw new Error('当前浏览器不支持流式响应');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let dataLines = [];
  let doneData = null;      // V0.33：记录 done 事件数据并作为 resolve 值（此前 sse() 恒返回 undefined，
                            // 调用方 `const r = await sse(...)` 后 r.title 必抛 TypeError → "生成失败"）
  let errorMsg = null;      // 后端 error 事件 → reject

  const flush = () => {
    if (event && dataLines.length) {
      const raw = dataLines.join('\n');
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
      if (event === 'done') doneData = parsed;
      else if (event === 'error') errorMsg = parsed.message || parsed.error || '服务端错误';
      onEvent(event, parsed);
    }
    event = 'message';
    dataLines = [];
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') { flush(); continue; }
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) { dataLines.push(line.slice(5).trim()); continue; }
      }
    }
    flush();
  } finally {
    // V0.20：无论正常/异常结束都释放 reader，避免连接悬挂
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  // V0.33：错误事件优先 reject；有 done 数据返回它；流中断（无 done）明确报错而不是返回 undefined
  if (errorMsg) throw new Error(errorMsg);
  if (doneData) return doneData;
  throw new Error('生成中断：未收到完成信号，请重试');
}

/** V0.98 开篇创作决策台统一 API；视图不自行猜后端状态。 */
export const openingApi = {
  storyPromise: bookId => get(`/api/books/${bookId}/story-promise`),
  rebuildStoryPromise: (bookId, body = {}) => post(`/api/books/${bookId}/story-promise/rebuild`, body),
  lockStoryPromise: (bookId, locks) => post(`/api/books/${bookId}/story-promise/locks`, { locks }),
  unlockStoryPromise: (bookId, unlock) => post(`/api/books/${bookId}/story-promise/locks`, { unlock }),
  diagnosis: bookId => get(`/api/books/${bookId}/opening-diagnosis`),
  runDiagnosis: (bookId, body = {}) => post(`/api/books/${bookId}/opening-diagnosis/run`, body),
  assets: bookId => get(`/api/books/${bookId}/opening-assets`),
  compose: (bookId, body, onEvent, signal) => sse(`/api/books/${bookId}/opening-compose`, body || {}, onEvent, signal),
  compareOpeningAssets: (bookId, assetIds) => post(`/api/books/${bookId}/opening-assets/compare`, { assetIds }),
  auditOpeningAsset: (bookId, assetId) => post(`/api/books/${bookId}/opening-assets/${assetId}/audit`, {}),
  selectOpeningAsset: (bookId, assetId) => post(`/api/books/${bookId}/opening-assets/${assetId}/select`, {}),
  applyOpeningAsset: (bookId, assetId) => post(`/api/books/${bookId}/opening-assets/${assetId}/apply`, {}),
  retireOpeningAsset: (bookId, assetId) => post(`/api/books/${bookId}/opening-assets/${assetId}/retire`, {}),
  removeOpeningAsset: (bookId, assetId) => del(`/api/books/${bookId}/opening-assets/${assetId}`),
  publishPatch: bookId => get(`/api/books/${bookId}/opening-publish-patch`),
  recordFeedback: (bookId, body) => post(`/api/books/${bookId}/opening-feedback`, body || {}),
};

/** V0.99 推流质量驾驶舱统一 API。 */
export const publicationApi = {
  status: bookId => get(`/api/books/${bookId}/publication`),
  saveProfile: (bookId, body) => put(`/api/books/${bookId}/publication`, body || {}),
  sync: bookId => post(`/api/books/${bookId}/publication/sync`, {}),
  addReview: (bookId, body) => post(`/api/books/${bookId}/publication/reviews`, body || {}),
  addMetric: (bookId, body) => post(`/api/books/${bookId}/publication/metrics`, body || {}),
  diagnoseRecovery: (bookId, body, onEvent, signal) => sse(
    `/api/books/${bookId}/recommendation-recovery/diagnose`, body || {}, onEvent, signal,
  ),
  executeRecovery: (bookId, runId, body, onEvent, signal) => sse(
    `/api/books/${bookId}/recommendation-recovery/${runId}/execute`, body || {}, onEvent, signal,
  ),
  observeRecoveryJob: (bookId, jobId, onEvent, signal) => sse(
    `/api/books/${bookId}/recommendation-recovery/jobs/${jobId}/observe`, {}, onEvent, signal,
  ),
  cancelRecoveryJob: (bookId, jobId) => post(
    `/api/books/${bookId}/recommendation-recovery/jobs/${jobId}/cancel`, {},
  ),
  confirmPendingSync: (bookId, chapters) => post(
    `/api/books/${bookId}/publication/pending-sync/confirm`, { chapters },
  ),
};

/** V0.104：自动创作 / 全书打磨后台作业。断线只断观察，显式 cancel 才停。 */
export const writeApi = {
  startPilot: (bookId, body, onEvent, signal) => sse(`/api/books/${bookId}/pilot`, body || {}, onEvent, signal),
  startPolish: (bookId, body, onEvent, signal) => sse(`/api/books/${bookId}/polish`, body || {}, onEvent, signal),
  observeWriteJob: (bookId, jobId, onEvent, signal) => sse(
    `/api/books/${bookId}/write-jobs/${jobId}/observe`, {}, onEvent, signal,
  ),
  cancelWriteJob: (bookId, jobId) => post(`/api/books/${bookId}/write-jobs/${jobId}/cancel`, {}),
  activeJobs: bookId => get(`/api/books/${bookId}/jobs/active`),
};

/** V0.100 正文与派生状态的版本门。 */
export const narrativeApi = {
  status: bookId => get(`/api/books/${bookId}/narrative-state`),
  rebuild: (bookId, onEvent, signal) => sse(
    `/api/books/${bookId}/narrative-state/rebuild`, {}, onEvent, signal,
  ),
};
