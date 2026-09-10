// V0.101 章级红线的场景余量——破折号已按场景分预算，动作母题/高频套话此前每场各写到上限，
// 整章必然破线（本作扫描单章蹲 23 次是结构结果）。本模块纯函数，写时注入、写后仍走章级检测。
'use strict';

import { REDLINES, STRICT_MOTIFS } from '../data/redlines.js';

/** 与 detectClichés 同词上限对齐的短套话：场景无视野时最容易每场各写两次。 */
export const QUOTA_CLICHES = ['顿了顿', '一股', '缓缓', '微微'];

export function countMotifHits(text, motif) {
  const src = String(text || '');
  const variants = Array.isArray(motif) ? motif : [motif];
  let n = 0;
  for (const v of variants) {
    if (!v) continue;
    let idx = 0;
    while ((idx = src.indexOf(v, idx)) >= 0) {
      n++;
      idx += v.length;
    }
  }
  return n;
}

/**
 * @param {number} used 本章已写次数
 * @param {number} chapterMax 章级合法上限（与指令红线同一数字）
 * @param {number} scenesLeft 含本场在内的未写场景数
 */
export function sceneMotifCap(used, chapterMax, scenesLeft) {
  const remaining = Math.max(0, Number(chapterMax) - Number(used));
  const left = Math.max(1, Number(scenesLeft) || 1);
  if (remaining <= 0) return 0;
  if (left <= 1) return remaining;
  return Math.max(1, Math.floor(remaining / left));
}

function motifLabel(motif) {
  return Array.isArray(motif) ? motif.join('/') : String(motif);
}

/**
 * 只点名已经动用或用满的条目，避免把整张母题表每场重复灌进指令。
 */
export function buildCraftQuotaText(chapterTextSoFar = '', remainingSceneCount = 1) {
  const left = Math.max(1, Number(remainingSceneCount) || 1);
  const lines = [];
  const push = (label, used, max, cap) => {
    if (used <= 0 && cap > 0) return;
    if (cap <= 0) lines.push(`「${label}」本章已用 ${used}/${max}，本场景禁止再写`);
    else lines.push(`「${label}」本章已用 ${used}/${max}，本场景最多 ${cap} 次`);
  };

  for (const motif of STRICT_MOTIFS) {
    const used = countMotifHits(chapterTextSoFar, motif);
    const cap = sceneMotifCap(used, REDLINES.motifSameWordMax, left);
    push(motifLabel(motif), used, REDLINES.motifSameWordMax, cap);
  }
  for (const word of QUOTA_CLICHES) {
    const used = countMotifHits(chapterTextSoFar, word);
    const cap = sceneMotifCap(used, REDLINES.clicheSameWordMax, left);
    push(word, used, REDLINES.clicheSameWordMax, cap);
  }

  const head = `【本章动作配额】特征动作与高频套话按章计数、余量分给未写场景（含本场 ${left} 场）。禁止本场把章配额用完。`;
  if (!lines.length) return head;
  return `${head}\n${lines.join('\n')}`;
}
