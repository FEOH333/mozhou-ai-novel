// server/engine/pipeline/export.js —— 纯文本导出组装（章节全局顺序优先于可能损坏的卷归属）
'use strict';
import { composeOpeningAsset } from '../planning/opening_intervention.js';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export function buildBookExport({ book, volumes = [], chapters = [], fullTexts = new Map(), selected = null, openingAsset = null }) {
  const ordered = [...chapters].sort((a, b) => Number(a.idx) - Number(b.idx) || String(a.id).localeCompare(String(b.id)));
  const volumeById = new Map(volumes.map(volume => [volume.id, volume]));
  const wanted = selected ? ordered.filter(chapter => selected.has(chapter.id)) : ordered;
  const chapterList = ordered
    .filter(chapter => fullTexts.get(chapter.id))
    .map(chapter => ({
      id: chapter.id,
      idx: chapter.idx,
      title: chapter.title || '',
      volume_id: chapter.volume_id,
    }));

  const parts = [`《${book?.title || '未命名'}》`, '', '——————', ''];
  let written = 0;
  let activeVolumeId = Symbol('none');
  for (const chapter of wanted) {
    let chapterText = String(fullTexts.get(chapter.id) || '').trim();
    if (!chapterText) continue;

    if (chapter.volume_id !== activeVolumeId) {
      activeVolumeId = chapter.volume_id;
      const volume = volumeById.get(activeVolumeId);
      if (volume) parts.push(SEP, volume.title || `第${volume.idx}卷`, SEP, '');
    }
    if (Number(chapter.idx) === 1 && openingAsset) {
      const composed = composeOpeningAsset(openingAsset, chapterText);
      if (composed.beforeBook) parts.push(composed.beforeBook, '');
      chapterText = composed.firstChapterText;
    }
    written++;
    parts.push(`第${chapter.idx}章 ${chapter.title || ''}`, '', chapterText, '');
  }

  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { title: book?.title || '', text, chapters: written, chars: text.length, chapterList };
}
