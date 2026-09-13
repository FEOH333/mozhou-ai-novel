// V0.100 经验证的叙事经验：只把正向目标、有限作用域和置信度带回创作提示。
'use strict';

import * as store from '../../db/store.js';

export function lessonsForChapter(bookId, chapterIdx, { limit = 4, minConfidence = 0.6 } = {}) {
  const current = Number(chapterIdx) || 0;
  const max = Math.max(1, Math.min(8, Number(limit) || 4));
  return store.narrativeLessons.list(bookId, { status: 'active' })
    .filter(lesson => Number(lesson.confidence) >= minConfidence)
    .filter(lesson => (lesson.scope_start == null || current >= Number(lesson.scope_start))
      && (lesson.scope_end == null || current <= Number(lesson.scope_end)))
    .sort((a, b) => Number(b.confidence) - Number(a.confidence) || Number(b.updated_at) - Number(a.updated_at))
    .slice(0, max);
}

export function narrativeLessonsText(bookId, chapterIdx, opts = {}) {
  const lessons = lessonsForChapter(bookId, chapterIdx, opts);
  if (!lessons.length) return '';
  const lines = lessons.map(lesson => {
    const scope = lesson.scope_end == null ? '' : `（验证窗口至第${lesson.scope_end}章）`;
    return `- ${String(lesson.positive_target || '').trim()}${scope}`;
  });
  return `【已验证的创作经验】（来自已通过整体复核的历史返工；只执行正向目标，不复刻旧稿坏句）\n${lines.join('\n')}`;
}

export function markNarrativeLessonsUsed(bookId, chapterIdx) {
  const ids = lessonsForChapter(bookId, chapterIdx).map(lesson => lesson.id);
  if (ids.length) store.narrativeLessons.markUsed(ids);
  return ids;
}
