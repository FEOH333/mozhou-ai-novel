// server/memory/embedding.js —— 本地 embedding（transformers.js + bge-small-zh-v1.5）
// 懒加载；失败自动降级（embeddingAvailable=false），业务不中断。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGlobal } from '../config.js';

let extractor = null;
let status = { ready: false, loading: false, progress: 0, error: null, model: null };

/**
 * 本地模型文件被解析失败的判据。
 *
 * transformers.js 无论失败原因是「磁盘上的缓存文件损坏」还是「下载不下来」，
 * 抛出的都是同一句 "Load model from <本地路径> failed: ..."。典型错误串：
 *   - Protobuf parsing failed            （ONNX 文件被截断/写坏）
 *   - file does not exist                （上次下载中断，只留了 .tmp）
 *   - Deserialize tensor ... failed      （权重损坏）
 *
 * 这个区分很重要：缓存损坏时**换多少模型源都没用**——所有源都读同一个本地
 * 文件，必然同样失败（实测损坏缓存会让三个源依次报同一条 Protobuf 错误，
 * 耗时 164ms 就放弃，用户只看到"降级"却不知道为什么）。必须删掉坏文件，
 * 下一次才会真正重新下载。
 */
const CORRUPT_CACHE_PATTERN = /Protobuf parsing failed|Deserialize tensor|Unsupported model IR version|file does not exist/i;

/**
 * 定位 transformers 的本地模型缓存目录。
 * 用模块自身位置推导（不硬编码绝对路径），失败返回 null。
 */
function resolveCacheDir(moduleUrl) {
  try {
    return path.resolve(path.join(
      path.dirname(fileURLToPath(moduleUrl || import.meta.url)),
      '..', '..', 'node_modules', '@huggingface', 'transformers', '.cache',
    ));
  } catch {
    return null;
  }
}

/**
 * 从错误与调用上下文中尽力推断出损坏的本地模型文件路径。
 *
 * 只做「删自己缓存目录里的文件」这一件事，且必须满足：
 *   1. 路径确实来自错误信息（不猜、不拼）；
 *   2. 路径位于 transformers 缓存目录内（防止极端情况下删到别的东西）。
 * 任一条件不满足就放弃自愈——宁可让用户看到"降级"，也不能误删用户文件。
 */
function tryRemoveCorruptCacheFile(message, cacheDirOverride) {
  const m = /Load model from (.+?) failed/i.exec(String(message || ''));
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;

  const root = cacheDirOverride ? path.resolve(cacheDirOverride) : resolveCacheDir();
  if (!root) return null;

  // 缓存根目录本身必须真实存在，否则「路径在缓存内」这个判断毫无护栏意义：
  // 只要目标是以该字符串开头就会被放行。目录不存在 ⇒ 无从判断 ⇒ 拒删。
  if (!fs.existsSync(root)) return null;

  const target = path.resolve(raw);
  // 必须是缓存目录内的路径，且扩展名是模型文件——双重护栏
  const inside = target.startsWith(root + path.sep) || target.startsWith(root + '/');
  if (!inside) return null;
  if (!/\.(onnx|bin|safetensors|json)$/i.test(target)) return null;

  // 只删真实存在的文件：file does not exist 这类错误说明本就没有可删的东西，
  // 此时返回 null 让调用方照常走"下一个模型源"，避免把"没删任何东西"谎报成自愈。
  if (!fs.existsSync(target)) return null;

  try {
    fs.rmSync(target, { force: true });
    return target;
  } catch {
    return null;
  }
}

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
    // 缓存自愈至多触发一次：本轮一旦删掉坏文件，就让下一个 host 去重新下载；
    // 不禁用整个 hosts 循环，避免"删了文件后连重试机会都没有"。
    let healedCorruptCache = false;
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
        // 若本轮还没自愈过，且错误签名指向本地缓存损坏，则删掉坏文件再让下一个源重下。
        // 这是把「永久降级」变成「一次自愈」的关键——否则用户只能手工去 node_modules 里删文件。
        if (!healedCorruptCache && CORRUPT_CACHE_PATTERN.test(String(e.message || ''))) {
          const removed = tryRemoveCorruptCacheFile(e.message);
          if (removed) {
            healedCorruptCache = true;
            status.progress = 0;
            console.warn(`[embedding] 检测到本地模型缓存损坏，已删除并重新下载：${removed}`);
          }
        }
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

/**
 * 缓存自愈的内部实现，导出仅供测试。
 * 生产调用路径是 initEmbedding 内部的自动重试，使用者无需直接调用。
 */
export const embeddingSelfHeal = {
  tryRemoveCorruptCacheFile,
  cacheDir: resolveCacheDir,
  isCorruptCacheError: message => CORRUPT_CACHE_PATTERN.test(String(message || '')),
};
