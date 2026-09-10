// server/engine/chapter_status.js —— 章节完成态单一真源
//
// done/settled 是明确终态；revised/planned 只是过程状态，只有“正文场景完整 +
// 摘要或结算指纹存在”时才兼容认定为历史完成章。所有会决定跳写、卷审、归档、
// 生命周期推进的模块都必须复用此处，避免同一章在不同流程里一会儿完成、一会儿未完成。
'use strict';

import * as store from '../db/store.js';

export const EXPLICIT_COMPLETED_STATUSES = Object.freeze(['done', 'settled']);

export function hasExplicitCompletedStatus(chapter) {
  return !!chapter && EXPLICIT_COMPLETED_STATUSES.includes(chapter.status);
}

/**
 * 判断章节是否已完成。
 *
 * 兼容旧库：部分升级/人工精修后的章节可能残留 planned/revised，但只要所有场景
 * 都有定稿正文，且摘要或结算指纹可以证明章结算已执行，就不能让自动创作重写它。
 * 反过来，裸 revised 绝不能推进卷审、归档或生命周期，也不能被一键流程跳过。
 */
export function isCompletedChapter(chapter) {
  if (!chapter) return false;
  if (hasExplicitCompletedStatus(chapter)) return true;
  if (!chapter.id) return false;

  try {
    const scenes = store.scenes.list(chapter.id);
    if (!scenes.length) return false;
    if (!scenes.every(scene =>
      (scene.status === 'done' || scene.status === 'revised')
      && String(scene.content || '').trim().length > 0)) return false;
    return Boolean(store.summaries.get(chapter.id)?.summary)
      || Boolean(store.chapterSettlements.get(chapter.id));
  } catch {
    return false;
  }
}

export function isCompletedVolume(volume) {
  if (!volume?.id) return false;
  const chapters = store.chapters.listByVolume(volume.id);
  return chapters.length > 0 && chapters.every(isCompletedChapter);
}

// ==================== V0.93.2 状态写入单一真源 ====================
//
// 章状态（chapters.status）只能经 transitionChapterStatus 写入。此前状态写入权分散在
// settle/pipeline/write/outline/recovery/signing/HTTP 各层，任何一层都可能绕过完成态
// 语义伪造终态或误降级。本状态机把 V0.70 的"完成章不得降级 drafted"保护硬编码进迁移表：
// 非法迁移一律抛错（fail-closed）。

/** 目标状态 → 允许的来源状态集合；null 表示重置语义（任意来源可回退到 planned）。 */
const CHAPTER_TRANSITIONS = Object.freeze({
  planned: null,
  // outlined 允许完成态降级：细纲手工编辑不抹除正文与结算证据（isCompletedChapter 仍真），
  // 不会触发重写循环；真正的重写风险是 done/settled → drafted，被下表硬性拒绝。
  outlined: new Set(['planned', 'outlined', 'writing', 'drafted', 'partial', 'quality_blocked', 'revised', 'done', 'settled']),
  writing: new Set(['planned', 'outlined', 'drafted']),
  drafted: new Set(['planned', 'outlined', 'writing', 'drafted', 'revised', 'partial', 'quality_blocked']),
  revised: new Set(['drafted', 'done', 'settled']),
  partial: new Set(['planned', 'outlined', 'writing', 'drafted']),
  quality_blocked: new Set(['planned', 'outlined', 'writing', 'drafted', 'revised', 'partial', 'quality_blocked']),
  done: new Set(['planned', 'outlined', 'writing', 'drafted', 'revised', 'partial', 'quality_blocked', 'settled', 'done']),
  // V0.102.11：quality_blocked 是自动修复过程态，修复成功必须能 settled（与 done 同源）。
  settled: new Set(['planned', 'outlined', 'writing', 'drafted', 'revised', 'quality_blocked', 'done', 'settled']),
});

/**
 * 章状态写入单一入口。同步执行（可在事务内调用）。
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} status 目标状态（必须是 CHAPTER_TRANSITIONS 的键）
 * @param {{reason?:string}} [opts] 拒绝时附加到错误信息的说明
 * @returns 更新后的章节行
 */
export function transitionChapterStatus(bookId, chapterId, status, { reason = '' } = {}) {
  const chapter = store.chapters.get(chapterId);
  if (!chapter) throw Object.assign(new Error(`章节不存在：${chapterId}`), { code: 'CHAPTER_MISSING' });
  if (chapter.book_id !== bookId) throw Object.assign(new Error(`章节不属于本书：${chapterId}`), { code: 'BOOK_MISMATCH' });
  const allowed = Object.prototype.hasOwnProperty.call(CHAPTER_TRANSITIONS, status)
    ? CHAPTER_TRANSITIONS[status]
    : undefined;
  if (allowed === undefined) {
    throw Object.assign(new Error(`非法目标状态：${status}`), { code: 'INVALID_TARGET' });
  }
  if (allowed && !allowed.has(chapter.status || 'planned')) {
    throw Object.assign(
      new Error(`状态迁移被拒：${chapter.status} → ${status}（第${chapter.idx}章《${chapter.title}》${reason ? `，${reason}` : ''}）`),
      { code: 'TRANSITION_REJECTED' },
    );
  }
  store.chapters.update(chapterId, { status });
  return store.chapters.get(chapterId);
}
