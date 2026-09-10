// V0.100 创作上下文规划器：固定前缀 + 小型正文窗口，禁止把整本正文无限累加进每次创作。
'use strict';

import * as store from '../db/store.js';
import { isCompletedChapter } from '../engine/chapter_status.js';
import { archiveInjectionText } from './cache.js';

function fixedPrefixMessages(bookId) {
  const rows = store.history.list(bookId);
  const system = rows.find(row => row.role === 'system');
  const fixed = rows.find(row => row.role === 'user');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system.content });
  if (fixed) messages.push({ role: 'user', content: fixed.content });
  return messages;
}

/** 从最新块向前保留，单块过长时保留靠近当前剧情的一端。 */
export function trimNewestBlocks(blocks = [], maxChars = 16_000) {
  const budget = Math.max(1_000, Number(maxChars) || 16_000);
  const kept = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = String(blocks[index] || '').trim();
    if (!block) continue;
    const remaining = budget - used;
    if (remaining <= 0) break;
    if (block.length <= remaining) {
      kept.unshift(block);
      used += block.length;
      continue;
    }
    // 对旧章只保留末尾，保证最近因果/情绪和衔接比开头布景更靠近当前任务。
    kept.unshift(`【窗口前部已裁剪】\n${block.slice(-remaining)}`);
    used += remaining;
    break;
  }
  return kept;
}

function mergeCreativeContext(tailMessages, contextText, archiveText) {
  const tails = (tailMessages || []).map(message => ({ role: message.role, content: String(message.content || '') }));
  const additions = [contextText, archiveText].filter(Boolean).join('\n\n');
  if (!additions) return tails;
  const firstUser = tails.findIndex(message => message.role === 'user');
  if (firstUser >= 0) {
    tails[firstUser].content = `${additions}\n\n【当前创作任务】\n${tails[firstUser].content}`;
  } else {
    tails.unshift({ role: 'user', content: additions });
  }
  return tails;
}

/**
 * 组装正文/章纲创作请求。
 * - system 与固定公共材料仍保持缓存前缀；
 * - 只给最近 N 个完成章全文和本章已写场景；
 * - 更早信息由滚动摘要、事实、叙事记忆和语义召回在任务指令中按需提供。
 */
export function assembleCreativeMessages(bookId, tailMessages = [], {
  chapterId,
  sceneId = null,
  recentChapterCount = 2,
  maxProseChars = 16_000,
} = {}) {
  const fixed = fixedPrefixMessages(bookId);
  const chapter = store.chapters.get(chapterId);
  if (!chapter || chapter.book_id !== bookId) {
    // 书级创作仍可使用固定前缀，但绝不退化为整本历史堆。
    return [...fixed, ...mergeCreativeContext(tailMessages, '', archiveInjectionText(bookId))];
  }
  const count = Math.max(0, Math.min(4, Number(recentChapterCount) || 0));
  const priorBlocks = store.chapters.list(bookId)
    .filter(item => item.idx < chapter.idx && isCompletedChapter(item))
    .slice(-count)
    .map(item => `【第${item.idx}章正文】\n${store.chapters.fullText(item.id)}`);

  const currentScene = sceneId ? store.scenes.get(sceneId) : null;
  const currentBlocks = store.scenes.list(chapterId)
    .filter(scene => String(scene.content || '').trim()
      && (!currentScene || scene.idx < currentScene.idx))
    .map(scene => `【本章已写场景 ${scene.idx}】\n${scene.content}`);
  const visible = trimNewestBlocks([...priorBlocks, ...currentBlocks], maxProseChars);
  const contextText = visible.length
    ? `【近期正文窗口】（只含最靠近当前任务的正文；更早事实以结构化记忆为准）\n${visible.join('\n\n')}`
    : '';
  return [...fixed, ...mergeCreativeContext(tailMessages, contextText, archiveInjectionText(bookId))];
}

