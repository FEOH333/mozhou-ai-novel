// 历史长篇的章节年代帧 → 主角当前状态同步。
// 年代帧是规划层的确定性数据，人物 state_json 只是模型抽取的投影；两者冲突时以前者为准。
'use strict';
import * as store from '../../db/store.js';
import { isHistoricalSampleBook, protagonistAgeInYear } from './historical_longform.js';

function protagonistNameFromOutline(bookId) {
  const text = store.materials.get(bookId, 'outline')?.content || '';
  return text.match(/主角[：:]\s*([\p{Script=Han}·]{2,12})/u)?.[1] || '';
}

function findProtagonist(bookId) {
  const chars = store.characters.list(bookId);
  const plannedName = protagonistNameFromOutline(bookId);
  return chars.find(character => character.name === plannedName)
    || chars.find(character => character.tier === 'protagonist')
    || chars[0]
    || null;
}

export function historicalChapterFrame(bookId, chapterId) {
  const book = store.books.get(bookId);
  if (!book || book.genre !== '历史') return null;
  const outline = store.chapters.outline(chapterId) || {};
  const year = Number(outline.year);
  if (!Number.isInteger(year)) return null;
  const age = Number(outline.protagonist_age);
  return {
    year,
    eraYear: String(outline.era_year || '').trim(),
    age: Number.isInteger(age)
      ? age
      : (isHistoricalSampleBook(book) ? protagonistAgeInYear(year) : null),
  };
}

export function syncHistoricalProtagonistState(bookId, chapterId) {
  const frame = historicalChapterFrame(bookId, chapterId);
  if (!frame || !Number.isInteger(frame.age)) return { updated: false, reason: 'no_frame' };
  const protagonist = findProtagonist(bookId);
  if (!protagonist) return { updated: false, reason: 'no_protagonist' };

  let state = {};
  try { state = JSON.parse(protagonist.state_json || '{}'); } catch { state = {}; }
  const ageText = `${frame.age}岁${frame.eraYear ? `（${frame.eraYear}）` : ''}`;
  const next = {
    ...state,
    年龄: ageText,
    公元年: `${frame.year}年`,
    ...(frame.eraYear ? { 当前纪年: frame.eraYear } : {}),
  };
  if (JSON.stringify(next) === JSON.stringify(state)) {
    return { updated: false, characterId: protagonist.id, frame };
  }
  store.characters.update(protagonist.id, { state: next });
  return { updated: true, characterId: protagonist.id, frame };
}

