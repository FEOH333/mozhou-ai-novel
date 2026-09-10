// server/util/diff.js —— V0.96.4 段落级 diff（借鉴 DeepWrite「可审阅的文稿修改」）
// 快照对比视图的算法底座：LCS 锚定公共段，输出 删(-)/增(+)/同(=) 三类块。
// 段落级（非字符级）是刻意取舍：修订审阅看"换了哪段"，成本比字符级低一个量级。
'use strict';

/** 正文切段：按换行切、去空段（快照/当前正文都以换行分段存储） */
export function splitParagraphs(text) {
  return String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
}

function pushBlock(blocks, type, text) {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) last.text += '\n' + text; // 相邻同类型合并（防碎片）
  else blocks.push({ type, text });
}

/**
 * 段落级 diff（LCS 动态规划）。一章段落量级（几十段）下 O(n·m) 无压力。
 * @param {string} oldText 旧文本（快照侧）
 * @param {string} newText 新文本（当前侧）
 * @returns {{type:'='|'-'|'+', text:string}[]} 块序列；全同时仅一个 '=' 块
 */
export function diffParagraphs(oldText, newText) {
  const a = splitParagraphs(oldText);
  const b = splitParagraphs(newText);
  const n = a.length, m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const blocks = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pushBlock(blocks, '=', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { pushBlock(blocks, '-', a[i]); i++; }
    else { pushBlock(blocks, '+', b[j]); j++; }
  }
  while (i < n) { pushBlock(blocks, '-', a[i]); i++; }
  while (j < m) { pushBlock(blocks, '+', b[j]); j++; }
  return blocks;
}
