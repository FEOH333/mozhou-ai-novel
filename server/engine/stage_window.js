// V0.105 卷内阶段窗口：从已有卷纲编译关卡占用，不新开阶段细纲 LLM。
'use strict';

export function normalizeStageTask(beat = '') {
  return String(beat || '').replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '');
}

function grams(text) {
  const value = normalizeStageTask(text);
  const set = new Set();
  for (let i = 0; i <= value.length - 3; i += 1) set.add(value.slice(i, i + 3));
  return set;
}

export function stageTasksSimilar(a, b) {
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union ? shared / union >= 0.10 : false;
}

export function compileStageWindow(volumeChapters = [], chapterIdx = 0) {
  const sorted = [...(volumeChapters || [])]
    .filter(row => Number.isFinite(Number(row?.idx)))
    .sort((a, b) => Number(a.idx) - Number(b.idx));
  if (!sorted.length) {
    return {
      members: [], usedTasks: [], currentTask: '', conflictFocus: '', previousFocus: '', stageStart: false,
    };
  }
  const offset = Number(sorted[0].idx);
  const stageSize = sorted.length <= 10 ? sorted.length : 8;
  const stageIndex = Math.max(0, Math.floor((Number(chapterIdx) - offset) / stageSize));
  const start = offset + stageIndex * stageSize;
  const members = sorted.filter(row => Number(row.idx) >= start && Number(row.idx) < start + stageSize);
  const usedTasks = members
    .filter(row => Number(row.idx) < Number(chapterIdx))
    .map(row => row.task || row.beat)
    .filter(Boolean);
  const current = members.find(row => Number(row.idx) === Number(chapterIdx)) || null;
  const prevStage = sorted.filter(row => Number(row.idx) >= start - stageSize && Number(row.idx) < start);
  const previousFocus = prevStage.at(-1)?.conflict_focus || '';
  return {
    goal: members[0]?.stage_goal || '',
    members,
    usedTasks,
    currentTask: current?.task || current?.beat || '',
    conflictFocus: current?.conflict_focus || '',
    previousFocus,
    stageStart: members[0] && Number(members[0].idx) === Number(chapterIdx),
  };
}

export function formatStageOccupancyText(window = {}) {
  if (window?.usedTasks?.length) {
    return `【本阶段关卡】已用：${window.usedTasks.join('、')}。本章推进未占用关卡。`;
  }
  if (window?.currentTask) return `【本阶段关卡】本章推进：${window.currentTask}`;
  return '';
}

export function stageTaskIssues(outline = {}, window = {}) {
  const current = outline.beat || outline.goal || window.currentTask || '';
  if (!current || !window?.usedTasks?.length) return [];
  const repeated = window.usedTasks.some(task => stageTasksSimilar(current, task));
  if (!repeated) return [];
  return [{
    code: 'OUTLINE_STAGE_TASK_REPEATED',
    hard: true,
    issue: '本阶段关卡签名与已用关卡重复。每章只承担一个未占用关卡，换地点或形容词不算新关卡',
  }];
}

export function fourElementIssues(outline = {}) {
  const fields = ['goal', 'conflict', 'turn', 'reader_pull'];
  const missing = fields.filter(field => !String(outline?.[field] || '').trim());
  if (missing.length !== 4) return [];
  if (!Array.isArray(outline?.scenes) || !outline.scenes.length) return [];
  return [{
    code: 'OUTLINE_FOUR_ELEMENT_VOID',
    hard: true,
    issue: '细纲目标、冲突、转折、结尾悬念全部空缺，没有可写的章节结构',
  }];
}

export function conflictFocusIssues(currentFocus, previousFocus, { stageStart = false } = {}) {
  if (!stageStart) return [];
  const current = String(currentFocus || '').trim();
  const previous = String(previousFocus || '').trim();
  if (!current || !previous || current !== previous) return [];
  return [{
    code: 'OUTLINE_CONFLICT_FOCUS_REPEATED',
    hard: true,
    issue: `上一阶段冲突焦点仍是「${previous}」，本阶段须换核心冲突，不能换地图继续同一套打脸升级`,
  }];
}
