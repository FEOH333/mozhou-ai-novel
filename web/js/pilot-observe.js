/**
 * 自动创作观察面纯函数：目标网格尺寸、从作业事件提取章号。
 * 不碰 DOM，便于 node:test 直接断言。
 */
'use strict';

/** 进度网格应对齐「目标章数」与已有章数的较大者，避免写到 48 却只显示 42 格。 */
export function pilotGridSize(targetChapters, chapterCount) {
  const n = Math.max(0, Number(chapterCount) || 0);
  const t = Math.max(0, Number(targetChapters) || 0);
  return Math.max(t, n);
}

/**
 * 从作业事件取当前章号。
 * 只认「第 N 章」；「章细纲第 1/3 版」和「第1章[YEAR_OUTSIDE_PHASE]」不得误打成第 1 章。
 */
export function chapterIdxFromEvent(data = {}) {
  const direct = Number(data.idx ?? data.chapterIdx ?? data.chapter);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const msg = String(data.message || '');
  const re = /第\s*(\d+)\s*章(?!\[)/g;
  let last = 0;
  let match;
  while ((match = re.exec(msg))) last = Number(match[1]);
  return last || 0;
}

/** V0.105.3：把「再写 N 章」翻译成全书绝对目标章数。
 * 输入语义 = 相对增量（用户直觉"帮我再写 3 章"）；旧语义"全书写到第 N 章"对
 * 存量书永远立即完成（实测：48 章书填 3 → 100ms 空跑结束）。新书 0 完成 → 目标 N，
 * 行为不变；pilot/后端 targetChapters 绝对语义不动。 */
export function resolvePilotTarget(input, chapters = []) {
  const n = parseInt(input, 10);
  if (Number.isNaN(n) || n <= 0) return undefined;
  const completed = (chapters || []).filter(c => ['done', 'settled', 'revised'].includes(c?.status)).length;
  return completed + n;
}
