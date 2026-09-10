// server/llm/cost.js —— 计价与成本统计（元 / 1M tokens）
'use strict';

/**
 * DeepSeek V4 官方定价（2026-08 核实，单位：元/百万 tokens）
 * 峰谷时段（北京时间 9:00-12:00、14:00-18:00）所有计费项 ×2。
 */
export const PRICES = {
  'deepseek-v4-flash': { hit: 0.02, miss: 1.0, output: 2.0, peak: true, label: 'DeepSeek V4 Flash' },
  'deepseek-v4-pro':   { hit: 0.025, miss: 3.0, output: 6.0, peak: true, label: 'DeepSeek V4 Pro' },
  // V0.109：DeepSeek V4.1 Flash 内测（2026-09-08 公告：计费与 V4 Flash 保持一致；模型 ID 0910 到期后换正式名）
  'deepseek-v4.1-flash-expires-on-0910': { hit: 0.02, miss: 1.0, output: 2.0, peak: true, label: 'DeepSeek V4.1 Flash（内测）' },
  // V0.98.3：OpenCode Go 限时免费模型——计 0 价，防止 UNKNOWN_PRICE 保守估价把成本页刷成虚高假象
  'ox-alpha-free':     { hit: 0, miss: 0, output: 0, label: 'Ox Alpha Free（OpenCode Go 限时免费）' },
  // V0.100.1：OpenRouter 限时免费 stealth 模型（pricing 实测 prompt/completion 均 0）
  'stealth/ox-alpha':  { hit: 0, miss: 0, output: 0, label: 'Ox Alpha（OpenRouter 限时免费）' },
  // V0.100.2：阿里云百炼 qwen3.8-flash——按 qwen3.7-flash 公价估算（输入 0.2/命中 0.04/输出 0.8，
  // 阿里云帮助中心 2026-08；qwen3.8 公价未发布，实际以用户控制台为准）。阿里云无峰谷时段价（peak 不标）。
  'qwen3.8-flash':     { hit: 0.04, miss: 0.2, output: 0.8, label: 'qwen3.8-flash（阿里云百炼，公价估算）' },
};

/** 未知模型（用户自定义 OpenAI 兼容）的默认价：保守按未命中全价估算 */
const UNKNOWN_PRICE = { hit: 1.0, miss: 1.0, output: 2.0 };

export function getPrice(model) {
  return PRICES[model] || UNKNOWN_PRICE;
}

/** 是否处于峰谷时段（本地时间；参数 ts 便于测试） */
export function isPeakHour(ts = Date.now()) {
  const d = new Date(ts);
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 计算一次请求的费用（元）
 * @param {string} model
 * @param {number} hitTokens  缓存命中输入
 * @param {number} missTokens 未命中输入
 * @param {number} completionTokens 输出
 * @param {number} [ts] 时间戳（峰谷判定）
 * @returns {{cost:number, costIfMiss:number, saving:number, savingRatio:number, peak:boolean}}
 */
export function computeCost(model, hitTokens, missTokens, completionTokens, ts = Date.now()) {
  const p = getPrice(model);
  // 峰谷翻倍只对声明了峰时价的服务商生效（DeepSeek 官方）；阿里云等无峰谷价差不得误翻倍
  const peak = isPeakHour(ts) && p.peak === true;
  const mult = peak ? 2 : 1;
  const hit = (hitTokens || 0) / 1e6;
  const miss = (missTokens || 0) / 1e6;
  const comp = (completionTokens || 0) / 1e6;
  const cost = (hit * p.hit + miss * p.miss + comp * p.output) * mult;
  // 若全部未命中（无缓存）会是多少
  const costIfMiss = ((hit + miss) * p.miss + comp * p.output) * mult;
  const saving = Math.max(0, costIfMiss - cost);
  const savingRatio = costIfMiss > 0 ? saving / costIfMiss : 0;
  return { cost: round4(cost), costIfMiss: round4(costIfMiss), saving: round4(saving), savingRatio, peak };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** 峰谷时段提示文案（V0.98.4：免费模型无峰谷价差，不误报 DeepSeek 峰时翻倍） */
export function peakHint(model = 'deepseek-v4-flash') {
  const p = getPrice(model);
  if (!(p.hit || p.miss || p.output)) {
    return '当前模型为免费档，无峰谷价差，随时可写。';
  }
  if (p.peak !== true) {
    return '当前模型无峰谷时段价差，随时可写。';
  }
  return isPeakHour()
    ? '⚠️ 当前处于 DeepSeek 高峰时段（9-12 / 14-18 点），价格为平时 2 倍。批量写作建议错峰。'
    : '当前非高峰时段，价格为平时 1 倍。';
}
