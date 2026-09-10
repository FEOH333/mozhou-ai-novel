// server/engine/batch_scan.js —— V0.95 三章一轮批次自检（novel-writing-framework 制度化）
// 依据：500+ 章实战方法论——"写完 3 章立即自检，不达标当场修，绝不攒到 51 章"
//（663 次"不是X是Y"清洗教训：后期修复成本是初稿 10 倍）。
// 与逐章检测的分工：逐章检测拦单章超标；本模块拦"每章都只超一点/踩线"的系统性纪律失守
//（修仙书解剖实证：ch22 起破折号从 7→14→18→22 的爬坡式失守，单章视角永远慢一拍）。
'use strict';
import * as store from '../db/store.js';
import { detectMotifRepetition, detectDialogueBalance, detectDashDensity } from './rules.js';
import { isCompletedChapter } from './chapter_status.js';

/**
 * 批次质量扫描（零 LLM）：取最近 N 个完成章，聚合本地质量信号；
 * 任一信号连续 N 章踩线/超线 → 产出纪律约束文本（由调用方落 constraints 反哺后续写作）。
 * @param {number} chapterIdx 当前章（供事件回报）
 * @param {number} window 批次窗口（默认 3 章）
 * @returns {{signals: Array<{signal:string, detail:string}>, constraints: string[], scanned: number}}
 */
export function batchQualityScan(bookId, chapterIdx, window = 3) {
  const result = { signals: [], constraints: [], scanned: 0 };
  const chapters = store.chapters.list(bookId)
    .filter(c => c.idx <= Number(chapterIdx) && isCompletedChapter(c))
    .sort((a, b) => b.idx - a.idx)
    .slice(0, window);
  if (chapters.length < window) return result; // 不足一批不扫（新书前 2 章）
  result.scanned = chapters.length;

  const stats = chapters.map(c => {
    const text = store.chapters.fullText(c.id);
    const dashes = (text.match(/——/g) || []).length;
    const paras = text.split(/\n+/).filter(p => p.trim());
    const dialogueLines = paras.filter(p => /[“「『"]/.test(p)).length;
    // 段落太少（片段/极短章）占比无统计意义，标 NaN 不参与失衡判定
    const dialogueRatio = paras.length >= 5 ? dialogueLines / paras.length : NaN;
    const motifIssues = detectMotifRepetition(text);
    const dialogueIssues = detectDialogueBalance(text);
    return {
      idx: c.idx,
      dashes,
      dialogueRatio,
      motifHits: motifIssues.length,
      dialogueIssues: dialogueIssues.length,
      dashOver: dashes > 20,
      // 踩线（未超但接近：17-20 个破折号——爬坡式失守的前兆）
      dashNear: dashes >= 17 && dashes <= 20,
    };
  });
  // 对话失衡只统计占比有意义的章（NaN 剔除）
  const dialogueValid = stats.filter(s => Number.isFinite(s.dialogueRatio));

  // 信号 1：破折号——均值超线 或 全部踩线爬坡（修仙 ch22 模式：7→14→18→22）
  const dashAvg = stats.reduce((s, x) => s + x.dashes, 0) / stats.length;
  if (stats.every(s => s.dashOver)) {
    result.signals.push({ signal: `破折号连续 ${stats.length} 章超线（均值 ${dashAvg.toFixed(1)}）`, detail: stats.map(s => `ch${s.idx}:${s.dashes}`).join(' ') });
    result.constraints.push(`【三章一轮·纪律失守】最近 ${stats.length} 章破折号全部超线（${stats.map(s => `ch${s.idx}=${s.dashes}`).join('，')}，红线 ≤20）——这不是单章偶发而是系统性纪律失守，后续每章写作前先数破折号：解释性插入改逗号、破折号只留给语义突转，每章 ≤15 个留缓冲。`);
  } else if (stats.every(s => s.dashNear || s.dashOver)) {
    result.signals.push({ signal: `破折号连续 ${stats.length} 章踩线爬坡（17-20 区间）`, detail: stats.map(s => `ch${s.idx}:${s.dashes}`).join(' ') });
    result.constraints.push(`【三章一轮·趋势预警】最近 ${stats.length} 章破折号持续在 ${stats.map(s => s.dashes).join('→')}（踩线爬坡，红线 20）——照此趋势下批必超线，立即收紧：新章破折号压到 ≤12。`);
  }
  // 信号 2：对话占比——连续全部失衡（修仙 ch43-76 模式）
  const dialogueAllLow = dialogueValid.length >= window && dialogueValid.every(s => s.dialogueRatio < 0.15);
  const dialogueAllHigh = dialogueValid.length >= window && dialogueValid.every(s => s.dialogueRatio > 0.85);
  if (dialogueAllLow) {
    result.signals.push({ signal: `对话占比连续 ${stats.length} 章过低`, detail: stats.map(s => `ch${s.idx}:${(s.dialogueRatio * 100).toFixed(0)}%`).join(' ') });
    result.constraints.push(`【三章一轮·对话空心化】最近 ${stats.length} 章对话占比全部 <15%（${stats.map(s => `ch${s.idx}=${(s.dialogueRatio * 100).toFixed(0)}%`).join('，')}）——独白式推进是长篇中段最可感的质量滑坡（读者没有"人在说话"的临场感），后续每章至少两组有来有回的对手戏（含打断/反问），冲突与信息至少一半通过对话完成。`);
  } else if (dialogueAllHigh) {
    result.signals.push({ signal: `对话占比连续 ${stats.length} 章过高`, detail: stats.map(s => `ch${s.idx}:${(s.dialogueRatio * 100).toFixed(0)}%`).join(' ') });
    result.constraints.push(`【三章一轮·剧本化】最近 ${stats.length} 章对话占比全部 >85%——裸对话缺动作/环境锚定，人物悬空说话；后续为对白穿插动作神态与所在环境的细节。`);
  }
 // 信号 3：动作母题——连续踩线（实测 ch19-26 衰减信号形态）
  if (stats.every(s => s.motifHits > 0)) {
    result.signals.push({ signal: `动作母题连续 ${stats.length} 章踩线`, detail: stats.map(s => `ch${s.idx}:${s.motifHits}项`).join(' ') });
    result.constraints.push(`【三章一轮·动作库过窄】最近 ${stats.length} 章每章都有动作母题超标（蹲下/转身/站起类高频动作重复）——动作库系统性过窄，写新章前先列 5 个未用过的替代动作（换身体部位/换物件/换节奏），特征母题每章 ≤2 次。`);
  }
  return result;
}
