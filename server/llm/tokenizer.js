// server/llm/tokenizer.js —— 本地 token 估算（不调 API，用于上下文预算与缓存测算）
'use strict';

/**
 * 估算文本 token 数。
 * 经验值（DeepSeek/V4 系 BPE，中文为主场景）：
 *  - CJK 字符 ≈ 1.05 token/字
 *  - ASCII 字母/数字 ≈ 0.3 token/字符（≈1.5 token/词）
 *  - 空白/换行 ≈ 0.25 token/字符
 *  - 安全系数 1.1（宁可高估，避免上下文超限）
 * 说明：这是预算控制用的近似值，实际计费以 API 返回 usage 为准。
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
      tokens += 0.25;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 1.05; // CJK 统一表意文字
    } else if ((code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
      tokens += 0.9; // CJK 标点/全角符号
    } else if (code >= 0x20 && code <= 0x7e) {
      tokens += 0.3; // ASCII
    } else {
      tokens += 1.0; // 其他（emoji 等）
    }
  }
  return Math.max(1, Math.ceil(tokens * 1.1));
}

/** 估算中文字数（用于 UI 显示"约 X 字"） */
export function estimateChineseChars(text) {
  if (!text) return 0;
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) count++;
  }
  return count;
}
