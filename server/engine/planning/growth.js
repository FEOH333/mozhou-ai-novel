// server/engine/planning/growth.js —— V0.74 成长线偏离检测与补救桥段引擎
// 问题：主角成长线与书契约/题材包承诺严重偏离（如 100+ 章主角仍在最低阶段），读者流失。
// 方案：检测偏离 → LLM 生成"前文积累兑现 + 有代价的阶段突破"补救桥段 → 落 materials(kind='growth_remedy')，
//       续卷生成时注入；同时压缩主角 state_json（丢弃过时叙事键，防字段无限堆积）。
// 原则：只做规划、不重写已写正文；growth_remedy 材料不进公共缓存前缀（与 foreshadow_plan 同模式）。
'use strict';
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { assembleMessages } from '../../llm/cache.js';
import { extractJSON } from '../../util/json.js';
import { growthStatus } from '../narrative/characters.js';
import { growthSystemFor, genrePack } from '../../data/creative_packs.js';
import { growthRemedyInstruction } from '../prompts.js';
import { isCompletedChapter } from '../pipeline/chapter_status.js';
import { lastChapterTail, extractVolumeTitle } from '../../util/text.js'; // V0.93.1：收编重复实现

/**
 * V0.74 从书契约/题材包提取成长节奏承诺（纯本地，零 LLM）。
 * @param {string} contractText 书契约文本
 * @param {string} genre 题材
 * @returns {{everyChapters:number, source:string}|null} 每 N 章一次成长突破
 */
export function parseGrowthPace(contractText, genre) {
  const text = contractText || '';
  // 契约式："每10章至少一次境界突破/成长/升级/重大收获"
  const m = text.match(/每\s*(\d+)\s*章[^。；\n]{0,14}(?:至少一次|一次|一)(?:境界|成长|突破|升级|实力|进展|收获)/);
  if (m) return { everyChapters: parseInt(m[1], 10), source: '契约' };
  // 题材包 rewardRhythm 式："每 5-8 章一次境界突破/大场面"
  // V0.74 修复：只匹配含"突破/升级/成长/进展"语义的段（题材包 rewardRhythm 里小爽点也是
  // "每 1-2 章一次小打脸"，若取第一个会误得 everyChapters=1 → 严重误判）
  const g = genrePack(genre);
  const rhythm = g?.rewardRhythm || '';
  // V0.81：成长词扩为含"跃迁/转折/挫折"（历史 rewardRhythm 用"每 6-10 章一次官位跃迁"）
  const m2 = rhythm.match(/每\s*(\d+)\s*-\s*(\d+)\s*章一次[^，。；]{0,8}(?:突破|升级|成长|进展|真相|里程碑|跃迁|转折|挫折)/);
  if (m2) return { everyChapters: parseInt(m2[1], 10), source: '题材包' };
  // 兜底：若题材包有"每 N 章一次境界突破/成长"（无区间），取之
  const m3 = rhythm.match(/每\s*(\d+)\s*章一次[^，。；]{0,8}(?:突破|升级|成长|进展|真相|里程碑|跃迁|转折|挫折)/);
  if (m3) return { everyChapters: parseInt(m3[1], 10), source: '题材包' };
  return null;
}

/**
 * V0.74 成长线偏离检测：对比主角成长维度位置 vs 章节进度/契约承诺。
 * @returns {{deviated:boolean, severity:string, reason:string, doneChapters:number,
 *            stageIndex:number, stageLabel:string|null, expectedStages:number,
 *            promisedEveryChapters:number, dimension:string, stagnant:boolean, growthText:string}}
 */
export function detectGrowthDeviation(bookId) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const doneCount = store.chapters.list(bookId)
    .filter(isCompletedChapter).length;
  const g = growthStatus(bookId);
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const gs = growthSystemFor(book.genre);
  // V0.81 历史成长波动：蛰伏期（白身/小校+藏拙蓄力）不判偏离；stageWeights 阶段权重调整预期
  const isHistory = book.genre === '历史';
  const longStageActive = (gs.longStages || []).some(s => g.stageLabel && g.stageLabel.includes(s));
  const cultivatingHidden = isHistory && longStageActive && g.hiddenPower; // 白身/小校 + 藏拙/隐忍 = 扮猪吃老虎蓄力期
  const stageWeight = gs.stageWeights?.[Math.max(0, g.stageIndex)] ?? 1;
  const pace = parseGrowthPace(contract, book.genre);
  const promisedEvery = pace?.everyChapters || (isHistory ? 15 : 10); // 默认：历史 15 章（身份跃迁慢）其他 10 章
  const expectedStages = doneCount >= promisedEvery ? Math.floor(doneCount / promisedEvery / stageWeight) : 0;
  const stageIndex = g.stageIndex; // -1=无匹配（视作最低阶段）
  const atBase = stageIndex <= 0;
  const progressVerb = g && g.dimension ? g.progressVerbs?.[0] || '成长' : '成长';

  // V0.75：前 20 章是铺垫期（转生/入门/建立冲突），成长慢属正常，不判偏离（防误伤新书）
  if (doneCount < 20) {
    return {
      deviated: false, severity: 'none', reason: '铺垫期（<20章）不判定成长偏离',
      doneChapters: doneCount, stageIndex, stageLabel: g.stageLabel,
      expectedStages, promisedEveryChapters: promisedEvery,
      dimension: g.dimension, stagnant: g.stagnant, growthText: g.text,
    };
  }
  let severity = 'none';
  let reason = '';
  const hasAnyStage = !!g.stageLabel; // 是否已进入成长体系（练气三层=已入门；完全无匹配=未入门）
  if (doneCount >= 100 && atBase && !hasAnyStage && !cultivatingHidden) {
    // V0.75：100+ 章仍完全未入门（无任何成长维度状态）→ 严重
    severity = 'severe';
    reason = `已写 ${doneCount} 章，主角仍完全未进入${g.dimension}体系（${g.stageLabel || '无匹配'}）——成长线严重滞后，读者必流失`;
  } else if (doneCount >= 100 && atBase && hasAnyStage && g.stagnant && !cultivatingHidden) {
    // 100+ 章已入门但长期停滞 → 严重
    severity = 'severe';
    reason = `已写 ${doneCount} 章，主角停留在${g.dimension}「${g.stageLabel}」且长期停滞——成长线严重滞后`;
  } else if (expectedStages >= 2 && atBase && !hasAnyStage && !cultivatingHidden) {
    severity = 'severe';
    reason = `按契约"每 ${promisedEvery} 章一次${progressVerb}"，${doneCount} 章应已完成约 ${expectedStages} 次突破，主角却仍未进入${g.dimension}体系`;
  } else if (expectedStages >= 1 && (g.stagnant || (atBase && (!hasAnyStage || (isHistory && !cultivatingHidden)))) && !cultivatingHidden) {
    severity = 'mild';
    reason = `成长节奏偏慢：${doneCount} 章按契约应有 ${expectedStages} 次${progressVerb}，主角当前${g.stageLabel ? `在「${g.stageLabel}」` : '未入门'}且${g.stagnant ? '状态停滞' : '进展缓慢'}`;
  }
  return {
    deviated: severity !== 'none', severity, reason,
    doneChapters: doneCount, stageIndex, stageLabel: g.stageLabel,
    expectedStages, promisedEveryChapters: promisedEvery,
    dimension: g.dimension, stagnant: g.stagnant, growthText: g.text,
  };
}

/**
 * V0.77 生成成长补救桥段：LLM 规划有铺垫、有代价的相邻阶段突破。
 * 幂等：已有 growth_remedy 则跳过（防重复生成）。data 可注入（测试友好，同 settleChapter 模式）。
 * @returns {{planned:number, deviation:object, note:string, cleanup?:object}}
 */
export async function planRemedyBridge(bookId, { onEvent, signal, data } = {}) {
  const dev = detectGrowthDeviation(bookId);
  if (!dev.deviated) return { planned: 0, deviation: dev, note: '成长线无明显偏离，无需补救' };
  if (store.materials.get(bookId, 'growth_remedy')?.content) {
    return { planned: 1, deviation: dev, note: '已有补救桥段材料，跳过生成' };
  }
  const book = store.books.get(bookId);
  const protag = store.characters.list(bookId).find(c => c.tier === 'protagonist') || store.characters.list(bookId)[0];
  const currentState = protag ? formatKeyState(protag.state_json, 12) : '（无）';
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const completed = store.chapters.list(bookId).filter(isCompletedChapter).sort((a, b) => a.idx - b.idx);
  const lastTail = lastChapterTail(completed, id => store.summaries.get(id)?.summary || '');
  const outline = store.materials.get(bookId, 'outline')?.content || '';
  const nextVolumeIdx = store.volumes.list(bookId).reduce((max, volume) => Math.max(max, volume.idx || 0), 0) + 1;
  const nextVol = extractVolumeTitle(outline, nextVolumeIdx);

  const tail = [{
    role: 'user',
    content: growthRemedyInstruction({
      bookTitle: book.title, genre: book.genre,
      growthText: dev.growthText, deviation: dev.reason,
      currentState, contract, lastTail, nextVolumeTitle: nextVol,
    }),
  }];
  const messages = assembleMessages(bookId, tail);
  const res = data ? { content: JSON.stringify(data) } : await runTask({ task: 'growth_remedy', bookId, messages, jsonMode: true, signal });
  const parsed = extractJSON(res.content) || {};
  if (!parsed.breakthrough || !parsed.breakthrough.toStage) {
    return { planned: 0, deviation: dev, note: '补救桥段解析失败（缺 breakthrough.toStage）' };
  }
  const text = formatRemedy(parsed, dev.doneChapters, nextVolumeIdx);
  store.materials.set(bookId, 'growth_remedy', text);
  // 同步压缩主角 state_json（丢弃过时叙事键，保留关键维度字段）
  const cl = compressProtagonistState(bookId, {});
  onEvent?.({ type: 'growth_remedy', planned: 1, note: `成长补救：${parsed.breakthrough.fromStage || '?'}→${parsed.breakthrough.toStage}（清理 ${cl.dropped.length} 个过时状态键）` });
  return { planned: 1, deviation: dev, note: `已生成成长补救桥段（${parsed.breakthrough.fromStage || '?'}→${parsed.breakthrough.toStage}）`, cleanup: cl };
}

/** V0.74 读取成长补救桥段材料（供续卷注入） */
export function growthRemedyText(bookId) {
  return store.materials.get(bookId, 'growth_remedy')?.content || '';
}

/** V0.74 主角 state_json 关键字段白名单（过时叙事键删除；物/能力天然在 abilities_json 保留） */
export const PROTAGONIST_KEEP_KEYS = [
  '位置', '状态', '职业', '计划', '决定', '行动', '目标', '身份', '关系', '伤势', '伤势状态',
  '心境', '情绪', '实力', '修为', '境界', '丹田微流', '微流', '修炼进度', '引气', '灵力', '灵气',
  '阶层', '地位', '真相层', '情感阶段', '等级', '持有', '持有物', '获得物品', '物品', '装备', '技能',
  // V0.98.13：战争残酷印记（近战血与痛的成长协同载体——首次搏杀/杀敌数/伤疤不得被状态压缩误删）
  '战历', '杀敌', '伤疤', '首次搏杀',
];

/**
 * V0.74 压缩主角 state_json：键数 >30 时收敛到关键字段（题材 growthSystem keyFields + 白名单 + keepExtra）。
 * 过时叙事键（"发现骨片内黑丝"等）信息已由伏笔表/事实库/滚动摘要承载，删除不丢关键设定。
 * @returns {{before:number, after:number, dropped:string[]}}
 */
export function compressProtagonistState(bookId, { keepExtra = [] } = {}) {
  const chars = store.characters.list(bookId);
  const protag = chars.find(c => c.tier === 'protagonist') || chars[0];
  if (!protag) return { before: 0, after: 0, dropped: [] };
  let state = {};
  try { state = JSON.parse(protag.state_json || '{}'); } catch { return { before: 0, after: 0, dropped: [] }; }
  const before = Object.keys(state).length;
  if (before <= 30) return { before, after: before, dropped: [] }; // 阈值保护，不频繁压缩
  const gs = growthSystemFor(store.books.get(bookId)?.genre);
  const keepSet = new Set([...PROTAGONIST_KEEP_KEYS, ...(gs.keyFields || []), ...keepExtra]);
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(state)) {
    if (keepSet.has(k)) kept[k] = v;
    else dropped.push(k);
  }
  try { store.characters.update(protag.id, { state: kept }); } catch { /* 压缩失败不阻塞 */ }
  return { before, after: Object.keys(kept).length, dropped };
}

// ==================== 私有辅助 ====================

/** 取 state_json 前 limit 个键值（LLM 上下文用） */
function formatKeyState(stateJson, limit = 12) {
  let state = {};
  try { state = JSON.parse(stateJson || '{}'); } catch { return '（无）'; }
  return Object.entries(state).slice(0, limit).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join('\n');
}

/** 补救桥段 JSON → 注入文本 */
function formatRemedy(parsed, doneChapters, nextVolumeIdx) {
  const parts = [`【成长补救桥段】（第${doneChapters}章生成，第${nextVolumeIdx}卷及后续必须落实）`];
  if (Array.isArray(parsed.reinterpretation) && parsed.reinterpretation.length) {
    parts.push('【重新定义前文】' + parsed.reinterpretation.map(r => `${r?.意象 || '?'}=${r?.重新定义 || '?'}`).join('；'));
  }
  const bt = parsed.breakthrough || {};
  if (bt.toStage) {
    const steps = Array.isArray(bt.steps) && bt.steps.length
      ? bt.steps.map(s => `第${s?.chapter || '?'}章：${s?.stage || '?'}（${s?.trigger || ''}）${s?.beat ? '——' + s.beat : ''}`).join('\n')
      : '';
    parts.push(`【阶段突破】第${bt.startChapter || doneChapters + 1}章起：${bt.fromStage || '?'}→${bt.toStage}${steps ? '\n' + steps : ''}`);
  }
  if (parsed.volume_plan) parts.push(`【本卷规划】${parsed.volume_plan}`);
  const sc = parsed.state_cleanup || {};
  if (Array.isArray(sc.keep) && sc.keep.length) parts.push(`【状态清理】保留：${sc.keep.join('、')}${Array.isArray(sc.drop_examples) && sc.drop_examples.length ? `；丢弃示例：${sc.drop_examples.slice(0, 5).join('、')}` : ''}`);
  return parts.join('\n');
}
