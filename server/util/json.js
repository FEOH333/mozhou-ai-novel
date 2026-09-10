// server/util/json.js —— JSON 解析容错工具
'use strict';

/**
 * 从模型输出文本中提取 JSON 对象/数组。
 * 容错：去除 markdown 代码围栏、围栏外的杂散文字、截断 JSON 的尾随逗号。
 * V0.85 强化（修复"卷大纲解析失败"根因）：
 *  - 对象根（文本以 { 开头）：只接受"根对象"解析成功——截断时内层对象/数组被提出
 *    是"外层未闭合的中段"，此前会解析成数组/孤立对象静默返回 → 调用方判"解析失败"；
 *    现在返回 null 让调用方走重试/降级（不再静默返回错误结构）。
 *  - thinking 文本混入（推理含花括号在 content 前）：整体解析失败时枚举所有 { 起点，
 *    取第一个能解析成功的完整对象——此前从 thinking 的花括号截取 → 解析出垃圾对象。
 * @param {string} text
 * @param {{expect?: 'object'|'array'}} [opts] 期望顶层类型（不符返回 null）
 * @returns {any|null} 解析成功返回对象，失败返回 null
 */
export function extractJSON(text, { expect } = {}) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  // 去除 ```json ... ``` 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // V0.98.9：字符串内裸控制字符修复——免费模型常把 JSON 字符串（尤其长正文 content）里的
  // 换行写成裸 \n，JSON.parse 报 "Bad control character"（ox-alpha-free 开篇候选实证：
  // 正文质量完好、仅序列化非法）。只把字符串字面量内部的裸控制字符替换为合法转义，
  // 不增删任何其他字符——确定性修复，不可能捏造内容。
  t = repairRawControlChars(t);
  const ok = (v) => {
    if (v === undefined) return false;
    if (expect === 'object') return v && typeof v === 'object' && !Array.isArray(v);
    if (expect === 'array') return Array.isArray(v);
    return true;
  };
  // 1) 整体解析
  let parsed = tryParseWithClose(t);
  if (ok(parsed)) return parsed;
  const root = t.trimStart()[0];
  if (root === '{' || root === '[') {
    // 对象/数组根：只接受根级解析成功——内层候选（截断中段的数组/孤立对象）一律视为失败
    const fromRoot = tryParseFrom(t, 0);
    return ok(fromRoot) ? fromRoot : null;
  }
  // 2) 非 JSON 根（thinking/解释文本混入）：枚举所有 { / [ 起点，取第一个能解析成功的完整根
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '{' && t[i] !== '[') continue;
    const cand = tryParseFrom(t, i);
    if (!ok(cand)) continue;
    // 候选解析结束后，若其后仍有 JSON 结构残留（, { [ 等）→ 说明候选是"截断数组中的元素/中段"，
    // 不是完整根对象（如 thinking 混入+正文截断时，内层章节对象会先被枚举到）→ 拒绝，继续找更大候选
    const end = closingIndex(t, i);
    if (end < 0) continue; // 未闭合 = 截断
    const rest = t.slice(end + 1).trim();
    if (/[\[{,，；;]/.test(rest)) continue;
    return cand;
  }
  return null;
}

/** V0.98.9：把 JSON 字符串字面量内部的裸控制字符（\r \n \t 及其他 <0x20）替换为合法转义。
 *  只在字符串内部生效（引号外的新行/缩进是合法空白，保持原样）；转义序列原样保留。 */
function repairRawControlChars(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      if (code === 92) { esc = true; out += ch; continue; } // 反斜杠
      if (code === 34) { inStr = false; out += ch; continue; } // 引号闭合
      if (code < 0x20) {
        out += code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t'
          : '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch; continue;
    }
    if (ch.charCodeAt(0) === 34) inStr = true;
    out += ch;
  }
  return out;
}

/** 从 start 起做括号匹配，返回闭合符位置（未闭合/截断返回 -1） */
function closingIndex(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 从 start 位置尝试解析（先整体，再截断回溯找闭合） */
function tryParseFrom(s, start) {
  const slice = s.slice(start);
  let p = tryParseWithClose(slice);
  if (p !== undefined) return p;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let cut = s.lastIndexOf(close);
  while (cut > start) {
    p = tryParseWithClose(s.slice(start, cut + 1));
    if (p !== undefined) return p;
    cut = s.lastIndexOf(close, cut - 1);
  }
  return undefined;
}

/** 解析，若因截断缺闭合括号则尝试补全 */
function tryParseWithClose(s) {
  const direct = tryParse(s);
  if (direct !== undefined) return direct;
  for (const close of ['}', ']', '"}', '"]']) {
    const p = tryParse(s + close);
    if (p !== undefined) return p;
  }
  return undefined;
}

function tryParse(s) {
  if (!s) return undefined;
  try {
    // 去除尾随逗号（常见于模型输出截断）
    const cleaned = s.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

/**
 * 安全 JSON.parse（容错 NaN/Infinity/undefined）
 */
export function safeParse(s, fallback = null) {
  if (s === null || s === undefined || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/**
 * 把对象序列化为 JSON 字符串（容错循环引用等）
 */
export function safeStringify(obj, fallback = '{}') {
  try {
    return JSON.stringify(obj);
  } catch {
    return fallback;
  }
}

/**
 * 深度合并（用于配置合并：作品设置覆盖全局设置）
 */
export function deepMerge(base, override) {
  if (!override) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
