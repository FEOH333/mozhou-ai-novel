// server/engine/quality/plot_ai.js —— V0.80 剧情发展层去AI味
// 用户洞察：AI 味最深的危害不在词汇（缓缓/微微），而在"剧情发展"——因果过规整、冲突解决
// 太干净、配角太懂规矩、升级太线性、巧合过多、情绪变化模式化。这些让读者觉得"假"、弃书。
// 方案：①PLOT_DEAI_TEXT 静态文本注入正文写作指令（硬要求，非软提示）②detectPlotAiMarkers 本地检测
//      ③detectLinearAscension/detectEmotionPattern 供漂移/卷体检（读 growthStatus/情绪序列）
'use strict';
import * as store from '../../db/store.js';
import { isCompletedChapter } from '../pipeline/chapter_status.js';

/**
 * 剧情发展去AI味硬要求（注入 writeSceneInstruction 尾部，纯静态文本）
 * 6 条反模式 + 修正指令——不是口语化，是让剧情发展"有毛刺、有意外、有代价、有层次"。
 */
export const PLOT_DEAI_TEXT = `【剧情发展去AI味（硬要求）】AI 写作的通病是"一切都太顺、太干净、太懂规矩"，读者会觉得假。本章必须自查并避免：
1. 因果别太顺：主角遇险不能被"恰好"的巧合救场（恰好遇到、恰好发现、恰好赶上）。救援/转机必须有来由、有代价，或允许失败率——让读者担心"这次可能真的会输"。
2. 冲突别一次解决干净：反派认输/被压制后要留暗手、留漏算的尾巴，冲突有反复、有纠缠，禁止一交手就"彻底解决、再无后患"。
3. 配角别都懂事：给配角私心、误判、越界、私下的盘算。禁止全员围着主角转、个个都无条件帮主角。让配角有自己的欲望和顾虑。
4. 升级别太线性：突破要有瓶颈、失败、退步的可能，禁止每章一个台阶地"实力+1"。让主角为成长付出代价（失去、取舍、被反噬）。
5. 巧合要限流：一章至多 1 个关键巧合，且最好前文埋过伏笔。禁止"偏偏、恰好、正好"满天飞。
6. 情绪别模板化：同一"紧张→爆发→余韵"的循环不要每章照搬。本章的情绪节奏要与上一章错开（上章燃这章就冷/憋/悬）。
以上 6 条是剧情设计约束，不是要你删内容；保持情节推进的同时，给发展留出不规整、不完美的真实感。`;

/** 本地检测"剧情AI味"痕迹（零成本；返回 [{type:'剧情AI味', severity, quote, issue, fix}]） */
export function detectPlotAiMarkers(text) {
  if (!text || typeof text !== 'string') return [];
  const issues = [];
  // 1) 巧合/因果过规整词密度（恰好/正好/偏偏/刚巧/碰巧/恰在此时）
  const coincidences = (text.match(/恰好|正好|偏偏|刚巧|碰巧|恰在此时|说时迟那时快|竟恰好/g) || []).length;
  if (coincidences >= 3) {
    issues.push({
      type: '剧情AI味', severity: 'low',
      quote: text.slice(0, 40) + '…',
      issue: `巧合词（恰好/正好/偏偏等）出现 ${coincidences} 次——因果过规整，AI 味浓，读者会觉"假"`,
      fix: '削减巧合，给转机补上来由/代价，或改为主角主动争取/预判',
    });
  }
  // 2) 冲突解决太干净（彻底/一劳永逸/再无后患/全部解决/一了百了/从此太平）
  const clean = (text.match(/彻底解决|一劳永逸|再无后患|全部解决|一了百了|从此太平|彻底除根|永绝后患/g) || []).length;
  if (clean >= 2) {
    issues.push({
      type: '剧情AI味', severity: 'low',
      quote: text.slice(0, 40) + '…',
      issue: `"彻底解决/一劳永逸"式收尾 ${clean} 处——冲突解决太干净，缺反复与纠缠`,
      fix: '给反派留暗手/漏算的尾巴，或让解决付出未预期的代价',
    });
  }
  // 3) 情绪标签化堆叠（"他的内心充满了愤怒与不甘"类）
  const emotionLabels = (text.match(/内心充满了|心中充满了|满心的|满怀的|充斥着/g) || []).length;
  if (emotionLabels >= 2) {
    issues.push({
      type: '剧情AI味', severity: 'low',
      quote: text.slice(0, 40) + '…',
      issue: `"内心充满了…"式情绪标签 ${emotionLabels} 处——情绪直述而非具象化`,
      fix: '用动作/感官细节替代情绪概括（指节发麻/喉头滚动/攥紧的拳）',
    });
  }
  return issues;
}

/** 升级过密过线性检测（读近 N 章成长进展；供漂移检测/卷体检，不逐章硬判） */
export function detectLinearAscension(bookId, window = 3) {
  try {
    const chapters = store.chapters.list(bookId).filter(isCompletedChapter).sort((a, b) => b.idx - a.idx).slice(0, window);
    if (chapters.length < window) return { linear: false, note: '章节不足，不判定' };
    // 读近 N 章摘要，看是否每章都有"突破/升级/进展"字样且无挫折
    let advances = 0, setbacks = 0;
    for (const c of chapters) {
      const s = store.summaries.get(c.id)?.summary || '';
      if (/突破|晋升|进阶|突破|升级|大获|大胜/.test(s)) advances++;
      if (/受挫|失败|重伤|损失|退步|被压制/.test(s)) setbacks++;
    }
    const linear = advances >= window && setbacks === 0;
    return { linear, note: linear ? `近${window}章均快速突破且无挫折——升级过密过线性，缺代价` : '' };
  } catch { return { linear: false, note: '' }; }
}

/** 情绪模式化检测（读 chapter_health.notes 情绪序列；3 连重复 2 次 → 模式化） */
export function detectEmotionPattern(bookId) {
  try {
    const seq = [];
    for (const ch of store.chapters.list(bookId).sort((a, b) => a.idx - b.idx)) {
      const health = store.chapterHealth.getByChapter(ch.id);
      if (!health?.notes) continue;
      try {
        const notes = JSON.parse(health.notes);
        if (notes.emotion?.type) seq.push(notes.emotion.type);
      } catch { /* ignore */ }
    }
    if (seq.length < 8) return { patterned: false, note: '情绪样本不足' };
    // 滑窗：找重复的 3 连子序列
    const seen = new Map();
    let repeated = null;
    for (let i = 0; i + 3 <= seq.length; i++) {
      const key = seq.slice(i, i + 3).join('→');
      if (seen.has(key) && i - seen.get(key) >= 3) { repeated = key; break; }
      seen.set(key, i);
    }
    return repeated
      ? { patterned: true, note: `情绪序列 "${repeated}" 出现 2 次以上——情绪节奏模式化，下一章须换情绪/节奏` }
      : { patterned: false, note: '' };
  } catch { return { patterned: false, note: '' }; }
}
