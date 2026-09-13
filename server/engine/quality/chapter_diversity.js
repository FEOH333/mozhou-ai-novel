// V0.103.0 章级多样性合同：近窗换轴，不把每章写成同一张考卷。
// 机械地板（字数/证据/未登记角色）仍每章通用；文学闸只点名近章已占用的轴。
'use strict';

import * as store from '../../db/store.js';
import { OPENER_TIC_PATTERNS } from '../../data/redlines.js';
import { isClicheOnlyType } from '../../data/issue_types.js'; // V0.109.3：类型语义单一真源
import { narrativePatternFeatures, narrativePatternSignature } from './narrative_patterns.js';

export const PATTERN_AXES = ['opening', 'initiative', 'counterforce', 'resolution', 'artifact', 'ending'];
/** 细纲期可分类、不依赖正文开篇/收束的轴；与写后六轴同一把尺，只是比较窗口不同。 */
export const OUTLINE_COMPARE_AXES = ['initiative', 'counterforce', 'resolution', 'artifact'];

export const EVENT_CLASS_PATTERNS = [
  ['interrogation', /审讯|逼问|拷问|盘问|招供|再审/g],
  ['inspection', /验工|勘线|核账|验看|验收|量墙|查渗|核对应验/g],
  ['intercept', /截获|密信|降书草稿|通敌信|油布包/g],
  ['defection', /正式降|降元|献城|献出.{0,8}(?:图|城)|投诚/g],
  ['report_ledger', /禀报|请示|落册|记入工册|记入.{0,6}册/g],
  ['pursuit', /追截|追捕|追逃|追杀|截击|沿.{0,8}追/g],
  ['battle', /攻城|守城|交战|接战|白刃|会战/g],
  ['council', /廷议|会商|议事|朝堂|廷争/g],
  ['revelation', /揭开|真相|身份败露|拆穿/g],
  ['valley', /低谷|代价章/g],
  ['travel', /赶路|上路|启程|避雨|山道过夜/g],
  ['daily', /市井|买米|吃饭|歇息|闲话|邻里/g],
];

const AXIS_LABEL = {
  opening: '开篇', initiative: '主动者', counterforce: '阻力',
  resolution: '转折后果', artifact: '物件', ending: '收束',
  event_class: '事件类', opener_family: '开篇族', hook_type: '钩型',
  scene_mix: '场景组合', pace: '节奏', pov_name: '视角',
};

function blobOf(outline = {}, text = '') {
  const scenes = Array.isArray(outline.scenes) ? outline.scenes : [];
  const beats = scenes.map(s => s.beat || '').join(' ');
  return [
    outline.goal, outline.conflict, outline.dramatic_question, outline.counterforce,
    outline.turn, outline.irreversible_change, outline.choice_cost, outline.reader_gain,
    outline.reader_pull, beats, text,
  ].map(v => String(v || '')).join(' ');
}

function countHits(src, re) {
  const copy = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (String(src || '').match(copy) || []).length;
}

export function classifyEventClass(outline = {}, text = '') {
  const head = [outline.title, outline.goal, outline.conflict, outline.dramatic_question]
    .map(v => String(v || '')).join(' ');
  const rest = blobOf({
    ...outline,
    title: '', goal: '', conflict: '', dramatic_question: '',
  }, text);
  if (!`${head} ${rest}`.trim()) return 'other';
  const defectionRe = EVENT_CLASS_PATTERNS.find(([name]) => name === 'defection')?.[1];
  const interceptRe = EVENT_CLASS_PATTERNS.find(([name]) => name === 'intercept')?.[1];
  // 细纲任一处已写正式降城，且标题/目标不是截获核时，场景残留密信/油布包不得盖过降城
  if (defectionRe && interceptRe
      && countHits(`${head} ${rest}`, defectionRe) > 0
      && countHits(head, interceptRe) === 0) {
    return 'defection';
  }
  let best = ['other', 0];
  for (const [name, re] of EVENT_CLASS_PATTERNS) {
    const n = countHits(head, re) * 3 + countHits(rest, re);
    if (n > best[1]) best = [name, n];
  }
  return best[1] > 0 ? best[0] : 'other';
}

export function openerStructureTemplate(text = '') {
  const para = String(text || '').split(/\n+/).map(p => p.trim()).find(Boolean) || '';
  const head = para.split(/[。！？]/)[0].trim() || para.slice(0, 80);
  if (!head) return 'unknown';
  if (/^[“「『"]/.test(head)) return 'dialogue';
  const slice = head.slice(0, 80);
  if (/的风/.test(slice) && /刀/.test(slice)) return 'place_wind_knife';
  for (const fam of OPENER_TIC_PATTERNS) {
    if (fam.re.test(slice)) return fam.id;
  }
  if (/[冲扑砸撞抓拔推奔跑拽]/.test(head.slice(0, 30))) return 'action';
  return 'other';
}

function sceneMixOf(outline = {}) {
  const types = (Array.isArray(outline.scenes) ? outline.scenes : [])
    .map(s => String(s.scene_type || '').trim())
    .filter(Boolean);
  return [...new Set(types)].sort().join('+');
}

function hookTypeOf(outline = {}) {
  const hook = outline.ending_hook;
  if (hook == null || hook === '') return 'none';
  if (typeof hook === 'object') return String(hook.type || hook.desc || '').trim() || 'none';
  const s = String(hook).trim();
  if (!s) return 'none';
  if (/钩/.test(s) && s.length <= 20) return s;
  return 'desc';
}

function isHumanForce(counterforce) {
  return counterforce === 'human_opponent' || counterforce === 'authority';
}

function povMode(outline = {}) {
  const names = (Array.isArray(outline.scenes) ? outline.scenes : [])
    .map(s => String(s.pov || '').trim())
    .filter(Boolean);
  if (!names.length) return '';
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function outlineHasBody(outline = {}) {
  return Boolean(String(outline.goal || outline.conflict || '').trim()
    || (Array.isArray(outline.scenes) && outline.scenes.some(s => String(s.beat || '').trim())));
}

export function diversityFeatures({ outline = {}, text = '', stored = {} } = {}) {
  const axes = narrativePatternFeatures({ outline, text });
  const hasBody = outlineHasBody(outline) || String(text || '').trim();
  return {
    ...axes,
    ...(stored && typeof stored === 'object' ? stored : {}),
    ...axes,
    event_class: hasBody ? classifyEventClass(outline, text) : (stored.event_class || 'other'),
    scene_mix: sceneMixOf(outline) || stored.scene_mix || '',
    pace: String(outline.pace || stored.pace || ''),
    hook_type: hookTypeOf(outline) || stored.hook_type || 'none',
    pov_name: povMode(outline) || stored.pov_name || '',
    opener_family: String(text || '').trim()
      ? openerStructureTemplate(text)
      : (stored.opener_family || 'unknown'),
  };
}

function isUnknownAxis(value) {
  const v = String(value || '').trim();
  return !v || v === 'unknown' || v.startsWith('unknown_');
}

const WEAK_AXIS = {
  opening: new Set(['unknown_open']),
  initiative: new Set(['react']),
  counterforce: new Set(['weak_counterforce']),
  resolution: new Set(['soft_resolution']),
  artifact: new Set(['none']),
  ending: new Set(['aftermath_pull']),
};

export function sameAxisCount(a = {}, b = {}, keys = PATTERN_AXES) {
  return keys.filter(key => {
    if (isUnknownAxis(a[key]) || isUnknownAxis(b[key])) return false;
    if (WEAK_AXIS[key]?.has(a[key]) && WEAK_AXIS[key]?.has(b[key])) return false;
    return a[key] === b[key];
  }).length;
}

function occupiedValues(recent, key) {
  const last = recent[0];
  const counts = new Map();
  for (const row of recent) {
    const value = String(row?.[key] || '').trim();
    if (!value || value === 'other' || value === 'none' || isUnknownAxis(value)) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const out = [];
  for (const [value, n] of counts) {
    if (n >= 2 || (last && String(last[key] || '') === value)) out.push(value);
  }
  return out;
}

export function compileDiversityContract(recentFeatures = [], { lastN = 5 } = {}) {
  const recent = (Array.isArray(recentFeatures) ? recentFeatures : []).slice(0, lastN)
    .filter(Boolean);
  if (!recent.length) {
    return { text: '', occupied: {}, last: null, recent: [], lastTwo: [] };
  }
  const last = recent[0];
  const lastTwo = recent.slice(0, 2);
  const occupied = {};
  const keys = [...PATTERN_AXES, 'event_class', 'opener_family', 'hook_type', 'scene_mix', 'pace', 'pov_name'];
  for (const key of keys) occupied[key] = occupiedValues(recent, key);

  const lines = ['【近窗换轴】（只列已占用项；换轴即可，不必补全清单）'];
  const push = (key, extra = '') => {
    const values = occupied[key];
    if (!values?.length) return;
    lines.push(`- ${AXIS_LABEL[key] || key}已占用：${values.join(', ')}${extra}`);
  };
  const lastClass = last.event_class;
  if (lastClass && lastClass !== 'other') {
    lines.push(`- 事件类已占用：${occupied.event_class.join(', ') || lastClass} → 本章不得再用 ${lastClass}`);
  } else {
    push('event_class');
  }
  push('opener_family', occupied.opener_family?.includes('place_wind_knife')
    ? ' → 首句不得再写「X的风 / 刀子」结构' : '');
  push('initiative');
  push('counterforce');
  push('resolution');
  push('ending', occupied.ending?.includes('distant_signal')
    ? ' → reader_pull 不得再用远处烟火/犬吠' : '');
  push('hook_type');
  push('scene_mix');
  push('pace');
  push('opening');
  push('artifact');
  push('pov_name');

  if (lastTwo.length >= 2 && lastTwo.every(row => isHumanForce(row.counterforce))) {
    lines.push('- 近两章阻力已是人对人 → 本章不得以审讯/对质作主事件（配角对话仍可）');
  } else if (lastTwo.length >= 2 && lastTwo.every(row => !isHumanForce(row.counterforce))) {
    lines.push('- 近两章无人与人的反作用力 → 本章须出现人对人阻力');
  }

  if (lastClass && lastClass !== 'other') {
    lines.push('本章须改变：event_class（不得与上章连用）。换事件类后不再用主动者/阻力/转折/物件四词同轴废细纲；未换事件类则须另改其中至少两项。');
  } else {
    lines.push('本章须改变：细纲可分类的主动者、阻力、转折机制或物件中仍占用的至少两项。');
  }
  return { text: lines.join('\n'), occupied, last, recent, lastTwo };
}

export function diversityContractIssues(outline = {}, contract = {}, { text = '' } = {}) {
  const issues = [];
  const recent = contract?.recent || [];
  if (!recent.length) return issues;
  const candidate = diversityFeatures({ outline, text });
  const lastRaw = contract.last || recent[0];
  const outlineOnly = !String(text || '').trim();
  const last = (outlineOnly && lastRaw?.outline_axes) ? lastRaw.outline_axes : lastRaw;

  if (candidate.event_class !== 'other' && last?.event_class === candidate.event_class) {
    issues.push({
      code: 'OUTLINE_EVENT_CLASS_REPEATED', hard: true,
      issue: `本章事件类「${candidate.event_class}」与上章相同。必须换事件类；只换地点和形容词不算新结构`,
    });
  }

  const classCount = recent.filter(row => row.event_class === candidate.event_class).length;
  if (candidate.event_class !== 'other' && classCount >= 3) {
    issues.push({
      code: 'OUTLINE_EVENT_CLASS_SATURATED', hard: true,
      issue: `近窗已有 ${classCount} 章事件类为「${candidate.event_class}」，本章不得再写同一类。请换成未占用的事件类`,
    });
  }

  const axisKeys = outlineOnly ? OUTLINE_COMPARE_AXES : PATTERN_AXES;
  const axisSame = sameAxisCount(last || {}, candidate, axisKeys);
  const classChanged = candidate.event_class !== 'other' && last?.event_class
    && last.event_class !== 'other' && candidate.event_class !== last.event_class;
  // 细纲期未换事件类须改至少两轴。已换事件类则事件核已变，选择/主事/失守/信四词同轴不再 hard
 //（实测 ch47：换降城后四轴仍被收成与截获章相同，3/3 最后一版因此被废）。
  const axisLimit = outlineOnly ? 3 : 5;
  if (axisSame >= axisLimit && !classChanged) {
    issues.push({
      code: 'OUTLINE_AXIS_ISOMORPHIC', hard: true,
      issue: outlineOnly
        ? `本章细纲因果轴与上章相同 ${axisSame} 项。必须改变主动者、阻力、转折机制或物件中的至少两项`
        : `本章因果六轴与上章相同 ${axisSame} 项。必须改变主动者、阻力、转折机制、不可逆后果或收束中的至少两项`,
    });
  }

  const lastTwo = (contract.lastTwo && contract.lastTwo.length ? contract.lastTwo : recent.slice(0, 2));
  if (lastTwo.length >= 2) {
    const allHuman = lastTwo.every(row => isHumanForce(row.counterforce));
    const noneHuman = lastTwo.every(row => !isHumanForce(row.counterforce));
    if (allHuman && candidate.event_class === 'interrogation') {
      issues.push({
        code: 'OUTLINE_OPPONENT_WINDOW_BLOCKED', hard: true,
        issue: '近两章阻力已是人对人，本章不得再以审讯/对质作主事件；可保留配角对话，主事件须换类',
      });
    }
    if (noneHuman && !isHumanForce(candidate.counterforce)) {
      issues.push({
        code: 'OUTLINE_OPPONENT_WINDOW_MISSING', hard: true,
        issue: '近两章没有人与人的反作用力，本章必须出现人对人阻力（冲突/博弈/对峙）；天气、时限、自我失误不算',
      });
    }
  }

  if (lastTwo.length >= 2
    && lastTwo[0].scene_mix && lastTwo[0].scene_mix === lastTwo[1].scene_mix
    && lastTwo[0].pace === 'advance' && lastTwo[1].pace === 'advance'
    && candidate.scene_mix === lastTwo[0].scene_mix
    && (candidate.pace || 'advance') === 'advance') {
    issues.push({
      code: 'OUTLINE_SCENE_MIX_REPEATED', hard: false,
      issue: `近两章场景组合「${candidate.scene_mix}」且节奏均为 advance，本章应换 scene_type 组合或 pace`,
    });
  }

  return issues;
}

function clicheOnlyIssues(issues = []) {
  if (!Array.isArray(issues) || !issues.length) return false;
  return issues.every(issue => {
    const type = String(issue?.type || '');
    const blob = `${issue?.issue || ''}${issue?.quote || ''}`;
    // V0.109.3：类型判定改查 issue_types 注册表（新增 AI 腔类文本问题自动纳入）
    if (isClicheOnlyType(type)) return true;
    return /似乎|缓缓|微微|顿了顿|一股/.test(blob);
  });
}

export function diversityRegression(beforeText = '', afterText = '', contract = {}, { issues = [], sceneIdx = 1, isLastScene = false } = {}) {
  if (!clicheOnlyIssues(issues)) return { reject: false };
  const lastOpener = contract.last?.opener_family || contract.occupied?.opener_family?.[0];
  if (Number(sceneIdx) === 1 && lastOpener && lastOpener !== 'other' && lastOpener !== 'unknown') {
    const beforeT = openerStructureTemplate(beforeText);
    const afterT = openerStructureTemplate(afterText);
    const beforeClose = beforeT === lastOpener;
    const afterClose = afterT === lastOpener;
    if (afterClose && !beforeClose) {
      return { reject: true, reason: `修订把开篇改成近章占用族「${lastOpener}」，套话修订不得改开篇结构` };
    }
  }
  const lastEnding = contract.last?.ending;
  if (isLastScene && lastEnding && lastEnding !== 'aftermath_pull') {
    const afterFeat = diversityFeatures({ text: afterText });
    const beforeFeat = diversityFeatures({ text: beforeText });
    if (afterFeat.ending === lastEnding && beforeFeat.ending !== lastEnding) {
      return { reject: true, reason: `修订把收束改成近章占用的「${lastEnding}」` };
    }
  }
  return { reject: false };
}

export function recordChapterDiversityFeatures(bookId, chapterId, {
  revisionId = '', sourceHash = '', outline, text,
} = {}) {
  const ol = outline || store.chapters.outline(chapterId) || {};
  const body = text ?? (store.chapters.fullText(chapterId) || '');
  store.narrativePatterns.upsert(bookId, chapterId, {
    revisionId, sourceHash,
    signature: narrativePatternSignature({ outline: ol, text: body }),
    features: diversityFeatures({ outline: ol, text: body }),
  });
}

export function loadRecentDiversityFeatures(bookId, beforeChapter, { limit = 5 } = {}) {
  const rows = store.narrativePatterns.list(bookId, { beforeChapter, limit });
  return rows.map(row => {
    const stored = row.features || {};
    let outline = {};
    let chapterText = '';
    try { outline = store.chapters.outline(row.chapter_id) || {}; } catch { /* ignore */ }
    try { chapterText = store.chapters.fullText(row.chapter_id) || ''; } catch { /* ignore */ }
    const full = diversityFeatures({ outline, text: chapterText, stored });
    return { ...full, outline_axes: diversityFeatures({ outline, text: '' }) };
  });
}

export function compileBookDiversityContract(bookId, chapterIdx) {
  return compileDiversityContract(loadRecentDiversityFeatures(bookId, chapterIdx, { limit: 5 }));
}
