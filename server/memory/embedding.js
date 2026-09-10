// server/memory/embedding.js —— 本地 embedding（transformers.js + bge-small-zh-v1.5）
// 懒加载；失败自动降级（embeddingAvailable=false），业务不中断。
'use strict';
import { getGlobal } from '../config.js';

let extractor = null;
let status = { ready: false, loading: false, progress: 0, error: null, model: null };

/**
 * 初始化 embedding 提取器（幂等，懒加载）。
 * @param {object} [opts] { force: boolean, onProgress: function({progress:number, file:string}) }
 */
export async function initEmbedding(opts = {}) {
  if (extractor && !opts.force) return extractor;
  if (status.loading) return null; // 已在加载
  const g = getGlobal();
  if (!g.embedding?.enabled) {
    status = { ready: false, loading: false, progress: 0, error: 'embedding 已在设置中禁用', model: null };
    return null;
  }
  const model = g.embedding.model || 'Xenova/bge-small-zh-v1.5';
  const quantized = g.embedding.quantized !== false;
  status = { ready: false, loading: true, progress: 0, error: null, model };
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = true;
    // 按顺序尝试模型源：配置项 → 官方 → hf-mirror 镜像（国内网络友好）
    const hosts = [
      g.embedding.remoteHost,
      'https://huggingface.co',
      'https://hf-mirror.com',
    ].filter(Boolean);
    let lastErr = null;
    for (const host of hosts) {
      try {
        env.remoteHost = host;
        extractor = await pipeline('feature-extraction', model, {
          quantized,
          progress_callback: p => {
            if (p?.status === 'progress' && typeof p.progress === 'number') {
              // transformers.js 的 progress 为 0-100；兼容 0-1 的旧实现
              status.progress = p.progress > 1 ? Math.round(p.progress) : Math.round(p.progress * 100);
            }
            opts.onProgress?.({ progress: status.progress, file: p?.file || '' });
          },
        });
        status = { ready: true, loading: false, progress: 100, error: null, model, host };
        return extractor;
      } catch (e) {
        lastErr = e;
        console.warn(`[embedding] 从 ${host} 加载失败，尝试下一个源：`, e.message);
      }
    }
    throw lastErr || new Error('所有模型源均不可用');
  } catch (e) {
    extractor = null;
    status = { ready: false, loading: false, progress: 0, error: e.message || String(e), model };
    console.error('[embedding] 初始化失败，降级为关键词检索：', e.message);
    return null;
  }
}

export function embeddingStatus() {
  return { ...status };
}

/**
 * 文本 → 归一化向量。
 * @param {string|string[]} texts
 * @returns {Promise<number[][]|null>} 失败返回 null
 */
export async function embed(texts) {
  if (!extractor) await initEmbedding();
  if (!extractor) return null;
  try {
    const arr = Array.isArray(texts) ? texts : [texts];
    const out = await extractor(arr, { pooling: 'mean', normalize: true });
    // out 可能是 Tensor 或 Array
    if (Array.isArray(out)) return out.map(t => Array.from(t.data || t));
    const data = out.data || out.tolist?.() || [];
    const dim = out.dims?.[1] || (Array.isArray(data[0]) ? data[0].length : 0);
    if (!dim) return null;
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      result.push(Array.from(data.slice(i * dim, (i + 1) * dim)));
    }
    return result;
  } catch (e) {
    console.error('[embedding] 推理失败：', e.message);
    return null;
  }
}

/** 一次性 embed 单个文本（检索用） */
export async function embedOne(text) {
  const v = await embed(text);
  return v ? v[0] : null;
}
