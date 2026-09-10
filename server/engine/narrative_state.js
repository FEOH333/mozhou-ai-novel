// V0.100 正文/派生状态同版本门：候选先在 shadow projection 中逐章验真，
// 全部通过后才把正文、摘要、事实、人物、时间线、伏笔、记忆与大纲一次性切换。
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { extractJSON } from '../util/json.js';
import { isCompletedChapter, transitionChapterStatus } from './chapter_status.js';
import { applyFacts } from './factbook.js';
import { applyForeshadowActions } from './foreshadow.js';
import { applySettlementMemories } from './narrative_memory.js';
import { appendRollingRecent } from './rolling.js';
import { registerHooksFromOutline, reconcileStoryArcsForChapter } from './pleasure.js';
import { recordChapterDiversityFeatures } from './chapter_diversity.js';
import { applyValidatedChapterRewrite } from './polish.js';
import { ensureHistory } from './outline.js';
import { isPlanningMetaPhase, sanitizeReconcileSeed } from './historical_guardrails.js';

const sha256 = value => createHash('sha256').update(String(value || '')).digest('hex');
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function manuscriptSourceHash(bookId, { overrides = new Map(), throughChapter = null } = {}) {
  const parts = store.chapters.list(bookId)
    .filter(isCompletedChapter)
    .filter(chapter => throughChapter == null || Number(chapter.idx) <= Number(throughChapter))
    .map(chapter => {
      const text = overrides.get(chapter.id) ?? store.chapters.fullText(chapter.id);
      return `${chapter.idx}:${chapter.id}:${sha256(text)}`;
    });
  return sha256(parts.join('\n'));
}

export function markNarrativeStateStale(bookId, {
  fromChapter,
  throughChapter = null,
  reason = '完成章正文发生变化',
  changedChapters = [],
  sourceHash = null,
} = {}) {
  const start = Math.max(1, Number(fromChapter) || 1);
  const completed = store.chapters.list(bookId).filter(isCompletedChapter);
  const through = Math.max(start, Number(throughChapter)
    || completed.reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), start));
  const previous = store.narrativeRevisions.current(bookId);
  const existing = store.narrativeRevisions.blocking(bookId);
  if (existing?.status === 'stale') {
    const changed = [...new Set([
      ...(existing.manifest?.changed_chapters || []),
      ...(changedChapters || []),
    ].map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    return store.narrativeRevisions.update(existing.id, {
      fromChapter: Math.min(start, Number(existing.from_chapter) || start),
      throughChapter: Math.max(through, Number(existing.through_chapter) || through),
      sourceHash: sourceHash || manuscriptSourceHash(bookId),
      reason,
      manifest: {
        ...(existing.manifest || {}),
        changed_chapters: changed,
        requires: ['summaries', 'facts', 'characters', 'timeline', 'foreshadows', 'memory', 'outlines', 'vectors'],
      },
    });
  }
  return store.narrativeRevisions.create(bookId, {
    parentId: previous?.id || null,
    fromChapter: start,
    throughChapter: through,
    status: 'stale',
    sourceHash: sourceHash || manuscriptSourceHash(bookId),
    reason,
    manifest: {
      changed_chapters: [...new Set((changedChapters || []).map(Number).filter(Number.isInteger))],
      requires: ['summaries', 'facts', 'characters', 'timeline', 'foreshadows', 'memory', 'outlines', 'vectors'],
    },
  });
}

export function assertNarrativeStateReady(bookId) {
  const blocking = store.narrativeRevisions.blocking(bookId);
  if (!blocking) {
    const current = store.narrativeRevisions.current(bookId) || null;
    if (current) {
      const completed = store.chapters.list(bookId).filter(isCompletedChapter);
      const currentThrough = current.manifest?.empty_baseline ? 0 : Number(current.through_chapter);
      const beyondRevision = completed.filter(chapter => Number(chapter.idx) > currentThrough);
      if (beyondRevision.length) {
        const error = new Error(
          `最后一个有效叙事版本只覆盖到第 ${currentThrough} 章，但本书另有 ${beyondRevision.length} 个完成章未进入同版账本；`
            + '自动创作已暂停，请先重建派生状态。',
        );
        error.code = 'NARRATIVE_STATE_COVERAGE_GAP';
        error.revisionId = current.id;
        error.fromChapter = beyondRevision[0].idx;
        error.throughChapter = beyondRevision.at(-1).idx;
        throw error;
      }
      const actualHash = manuscriptSourceHash(bookId, { throughChapter: current.through_chapter });
      if (actualHash !== current.source_hash) {
        const error = new Error('当前完成章正文指纹与最后一次有效叙事版本不一致；为防旧摘要和旧规划污染，自动写作已暂停，请先重建派生状态。');
        error.code = 'NARRATIVE_SOURCE_MISMATCH';
        error.revisionId = current.id;
        error.fromChapter = current.from_chapter;
        throw error;
      }
    } else {
      const completed = store.chapters.list(bookId).filter(isCompletedChapter);
      if (completed.length) {
        const error = new Error(
          `本书已有 ${completed.length} 个完成章，但尚未建立正文与派生状态的同版账本；`
            + '为防旧摘要、旧人物状态、旧伏笔和旧大纲污染后续创作，请先重建派生状态。',
        );
        error.code = 'NARRATIVE_STATE_LEGACY';
        error.fromChapter = completed[0].idx;
        error.throughChapter = completed.at(-1).idx;
        throw error;
      }
    }
    return { ok: true, revision: current };
  }
  const changed = blocking.manifest?.changed_chapters || [];
  const error = new Error(
    `正文已换版，但摘要、人物、伏笔、时间线与大纲投影尚未完成同版本重建`
      + `${changed.length ? `（涉及第${changed.join('、')}章）` : `（从第${blocking.from_chapter}章起）`}；`
      + '为防旧状态污染后续创作，自动写作已暂停。',
  );
  error.code = 'NARRATIVE_STATE_STALE';
  error.revisionId = blocking.id;
  error.fromChapter = blocking.from_chapter;
  throw error;
}

const HEALABLE_NARRATIVE_CODES = new Set([
  'NARRATIVE_SOURCE_MISMATCH',
  'NARRATIVE_STATE_STALE',
  'NARRATIVE_STATE_COVERAGE_GAP',
  'NARRATIVE_STATE_LEGACY',
]);

/**
 * 自动写章入口：同版失配/陈旧/覆盖缺口必须按当前正文重建派生状态，不得把 need_human 当终态。
 * 结算闸仍走 assertNarrativeStateReady——重建完成后指纹必须对齐，否则继续失败关闭。
 */
export async function ensureNarrativeStateReady(bookId, {
  signal, onEvent, projectionImpl, planImpl, projectionCache, reindex,
} = {}) {
  try {
    return assertNarrativeStateReady(bookId);
  } catch (error) {
    if (!HEALABLE_NARRATIVE_CODES.has(error.code)) throw error;
    onEvent?.({
      type: 'stage',
      stage: 'narrative_rebuild',
      message: `派生状态与正文不同版（${error.code}），按当前正文重建摘要/事实/规划…`,
    });
    await prepareAndCommitNarrativeRevision(bookId, {
      reason: `自动创作前同版重建（${error.code}）`,
      signal,
      onEvent,
      allowDegradedProjection: true,
      allowDegradedPlan: true,
      allowStaleHashReuse: true,
      ...(projectionImpl ? { projectionImpl } : {}),
      ...(planImpl ? { planImpl } : {}),
      ...(projectionCache != null ? { projectionCache } : {}),
      ...(reindex != null ? { reindex } : {}),
    });
    return assertNarrativeStateReady(bookId);
  }
}

/** 给界面/API 使用的只读同版状态；不在读取过程中偷偷创建或修复任何记录。 */
export function narrativeStateStatus(bookId) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const blocking = store.narrativeRevisions.blocking(bookId);
  const current = store.narrativeRevisions.current(bookId) || null;
  const actualHash = current
    ? manuscriptSourceHash(bookId, { throughChapter: current.through_chapter })
    : manuscriptSourceHash(bookId);
  const sourceMismatch = Boolean(current && current.source_hash !== actualHash);
  const completed = store.chapters.list(bookId).filter(isCompletedChapter);
  const currentThrough = current
    ? (current.manifest?.empty_baseline ? 0 : Number(current.through_chapter))
    : 0;
  const unversionedCompleted = current
    ? completed.filter(chapter => Number(chapter.idx) > currentThrough)
    : [];
  const coverageGap = unversionedCompleted.length > 0;
  const legacyNeedsRebuild = !current && !blocking && completed.length > 0;
  const requiresRebuild = Boolean(blocking || sourceMismatch || coverageGap || legacyNeedsRebuild);
  const status = blocking ? 'stale' : (sourceMismatch || coverageGap) ? 'mismatch' : current ? 'ready' : 'legacy';
  const lessons = store.narrativeLessons.list(bookId);
  const compact = revision => revision ? {
    id: revision.id,
    parentId: revision.parent_id,
    fromChapter: revision.from_chapter,
    throughChapter: revision.manifest?.empty_baseline ? 0 : revision.through_chapter,
    status: revision.status,
    sourceHash: revision.source_hash,
    reason: revision.reason,
    error: revision.error,
    changedChapters: revision.manifest?.changed_chapters || [],
    aligned: revision.manifest?.aligned || [],
    createdAt: revision.created_at,
    completedAt: revision.completed_at,
  } : null;
  return {
    status,
    ready: !requiresRebuild,
    requiresRebuild,
    completedChapters: completed.length,
    sourceMismatch,
    coverageGap,
    coverageFromChapter: coverageGap ? unversionedCompleted[0].idx : null,
    coverageThroughChapter: coverageGap ? unversionedCompleted.at(-1).idx : null,
    actualHash,
    current: compact(current),
    blocking: compact(blocking),
    plan: store.books.settings(bookId).narrativePlan || null,
    lessons: {
      active: lessons.filter(lesson => lesson.status === 'active').length,
      provisional: lessons.filter(lesson => lesson.status === 'provisional').length,
      retired: lessons.filter(lesson => lesson.status === 'retired').length,
      uses: lessons.reduce((sum, lesson) => sum + (Number(lesson.usage_count) || 0), 0),
    },
  };
}

function normalizedEvidence(value) {
 // 双侧同构剥除空白与全/半角引号（V0.100.1 实测 ch6 实证：正文全角「“安”」，模型引半角「'安'」，
  // 引号风格差异不改变逐字语义，不剥除会把 100% 逐字的引文误判废）；引号之外的内容差异仍判废。
  return String(value || '').replace(/[\s“”‘’「」『』'"]/g, '').trim();
}

/**
 * V0.100.1：模型常把被“说话人标签/省略号”隔开的两段真实原句拼成一条 evidence
 * （实测 ch1 实证：正文「“……若真到那一步，”是父亲的声音，“你带两个孩子先走，我断后。”」
 * 模型引「若真到那一步，你带两个孩子先走，我断后。」，逐字 includes 误判废——V0.99.1 同类裂口）。
 * 确定性分段对齐兜底：按标点切段，每段 ≥2 字，全部按序命中且总跨度受控。
 * 至少一段 ≥6 字（强锚点）时允许插入说话人标签/语气词；全为短段时（实测 ch2 实证：
 * 正文「“翻青林坳，”父亲说，“走大路，别回头。”」，模型引「翻青林坳，走大路，别回头。」，
 * 全为 3-4 字段）须段总长 ≥8 且跨度贴段长（≤总长+12，只容极短说话人标签）；
 * 幻觉引文、乱序拼接、远距离碰巧按序出现的碎片仍判废。
 */
function segmentedGrounding(evidence, normalizedText) {
  const segments = normalizedEvidence(evidence)
    .split(/[，。！？；：、…—·,.!?;:~～]+/)
    .filter(segment => segment.length >= 2);
  if (segments.length < 2) return false;
  let from = 0;
  let start = -1;
  let end = -1;
  for (const segment of segments) {
    const at = normalizedText.indexOf(segment, from);
    if (at < 0) return false;
    if (start < 0) start = at;
    end = at + segment.length;
    from = end;
  }
  const grounded = segments.reduce((total, segment) => total + segment.length, 0);
  const span = end - start;
  if (segments.some(segment => segment.length >= 6)) return span <= grounded * 3 + 60;
  return grounded >= 8 && span <= grounded + 12;
}

/**
 * 分段对齐对外入口（返工链路共用同一实现，防第三套校验漂移）：双侧剥引号与空白后
 * 按标点切段有序命中，跨度护栏与投影侧一致。返回布尔，不回指切片。
 */
export function segmentedEvidenceGrounded(evidence, text) {
  return segmentedGrounding(evidence, normalizedEvidence(text));
}

function assertEvidence(item, text, label, chapterIdx) {
  const evidence = normalizedEvidence(item?.evidence);
  const normalizedText = normalizedEvidence(text);
  // 正常完成章要求至少 4 字；极短的显式测试/维护 fixture 不可能提供 4 字原句，
  // 仍必须逐字命中其全部可用正文，不能用虚构补齐。
  const minimum = Math.max(1, Math.min(4, normalizedText.length));
  const grounded = normalizedText.includes(evidence) || segmentedGrounding(item?.evidence, normalizedText);
 // V0.100.15 句尾虚词容错：模型摘引偶发“病倒/病倒了”一字之差（实测 ch5 返工实证）。
  // 只容句尾“了/着/过/呢/吗/么/的”这类虚词增删；句首代词替换（“她”→“母亲”）仍判废，
  // 那是实质改写，必须反馈重答（v100_narrative_state 实证）。
  const trimmedEvidence = String(evidence || '').replace(/[了着过呢吗么的]+$/, '');
  const trimmedGrounded = !grounded && trimmedEvidence.length >= minimum
    ? normalizedText.includes(trimmedEvidence)
    : false;
  if (evidence.length < minimum || !(grounded || trimmedGrounded)) {
    throw codedError(
      'PROJECTION_EVIDENCE_MISSING',
      `第${chapterIdx}章${label}缺少可在当前正文逐字定位的证据：${item?.evidence || '未提供'}`,
      { chapterIdx, field: label, evidence: item?.evidence || '' },
    );
  }
}

/** 严格验证单章影子投影；事实性条目必须携带当前正文中的逐字证据。 */
export function validateNarrativeProjection(rawPayload, text, chapter = {}) {
  const payload = typeof rawPayload === 'string' ? extractJSON(rawPayload) : rawPayload;
  const idx = Number(chapter.idx) || 0;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('PROJECTION_INVALID', `第${idx}章影子投影不是 JSON 对象`, { chapterIdx: idx });
  }
  if (!nonEmpty(payload.summary)) {
    throw codedError('PROJECTION_INVALID', `第${idx}章影子投影缺少摘要`, { chapterIdx: idx, field: 'summary' });
  }
  const actual = payload.outline_actual;
  const requiredActual = [
    'goal', 'conflict', 'dramatic_question', 'counterforce', 'turn', 'irreversible_change',
    'choice_cost', 'reader_gain', 'reader_pull',
  ];
  if (!actual || typeof actual !== 'object') {
    throw codedError('PROJECTION_INVALID', `第${idx}章影子投影缺少 outline_actual`, { chapterIdx: idx, field: 'outline_actual' });
  }
  const missingActual = requiredActual.filter(field => !nonEmpty(actual[field]));
  if (missingActual.length) {
    throw codedError('PROJECTION_INVALID', `第${idx}章实际章纲缺少：${missingActual.join('、')}`, {
      chapterIdx: idx, field: 'outline_actual', missing: missingActual,
    });
  }
 // V0.100.1：证据失效聚合上报（实测 ch2 实证"打地鼠"——逐条即抛时反馈只提第一条，
  // 模型修一条又踩一条）。结构性错误（PROJECTION_INVALID）仍即抛；证据失效全部收集后一次抛出，
  // 供唯一一次反馈重答整体修正。
  const evidenceFailures = [];
  const check = (item, label) => {
    try {
      assertEvidence(item, text, label, idx);
    } catch (error) {
      if (error?.code !== 'PROJECTION_EVIDENCE_MISSING') throw error;
      evidenceFailures.push(error.message);
    }
  };
  check(actual, '实际章纲');
  const scenes = Array.isArray(actual.scenes) ? actual.scenes : [];
  if (!scenes.length) {
    throw codedError('PROJECTION_INVALID', `第${idx}章实际章纲缺少场景结果`, { chapterIdx: idx, field: 'outline_actual.scenes' });
  }
  scenes.forEach((scene, index) => check(scene, `实际场景${index + 1}`));

  const arrays = [
    ['facts', '事实'], ['character_updates', '人物状态'], ['character_notes', '人物注记'],
    ['character_emotional', '人物情绪'], ['timeline', '时间线'], ['foreshadow_actions', '伏笔动作'],
    ['memory_entries', '叙事记忆'], ['new_entities', '新实体'],
  ];
  const normalized = { ...payload, outline_actual: { ...actual, scenes: scenes.map(scene => ({ ...scene })) } };
  for (const [field, label] of arrays) {
    const values = payload[field] == null ? [] : payload[field];
    if (!Array.isArray(values)) {
      throw codedError('PROJECTION_INVALID', `第${idx}章${label}必须是数组`, { chapterIdx: idx, field });
    }
    values.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw codedError('PROJECTION_INVALID', `第${idx}章${label}第${index + 1}项格式无效`, { chapterIdx: idx, field });
      }
      check(item, `${label}第${index + 1}项`);
    });
    normalized[field] = values.map(item => ({ ...item }));
  }
  if (evidenceFailures.length) {
    throw codedError(
      'PROJECTION_EVIDENCE_MISSING',
      evidenceFailures.join('\n'),
      { chapterIdx: idx, failures: evidenceFailures },
    );
  }
  normalized.rolling_update = nonEmpty(payload.rolling_update) ? payload.rolling_update.trim() : payload.summary.trim();
  normalized.summary = payload.summary.trim();
  return normalized;
}

function groundedEvidenceClip(text, min = 4, max = 40) {
  const src = String(text || '');
  const parts = src.split(/[。！？\n]/).map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    const clip = part.slice(0, max);
    if (clip.length >= min && src.includes(clip)) return clip;
  }
  const fallback = src.replace(/\s+/g, ' ').trim().slice(0, max);
  if (fallback.length >= min && src.includes(fallback)) return fallback;
  return src.slice(0, Math.min(max, Math.max(min, src.length)));
}

/** 取证两轮仍无证据时的本地确定性投影：所有 evidence 都从当前正文截取，不沿用旧摘要幻觉。 */
export function deterministicChapterProjection(text, chapter = {}) {
  const evidence = groundedEvidenceClip(text);
  const title = chapter.title || `第${chapter.idx || '?'}章`;
  const stored = chapter.id ? (store.summaries.get(chapter.id)?.summary || '').trim() : '';
  const summary = (stored && text.includes(stored.slice(0, Math.min(12, stored.length))) ? stored : `${title}已按当前正文发生，后续必须承接其不可逆后果。`).slice(0, 150);
  return {
    summary,
    rolling_update: summary,
    outline_actual: {
      goal: '按当前正文已经发生的事继续',
      conflict: '人物必须处理本章已经造成的后果',
      dramatic_question: '人物如何承担本章已经做出的选择',
      counterforce: '局面不允许无成本回到章前',
      turn: '本章正文已经改变原有办法',
      irreversible_change: '本章已发生之事不可当作未发生',
      choice_cost: '人物已在正文中付出代价',
      reader_gain: '读者看见本章明确发生的行动',
      reader_pull: '本章后果仍需后续处理',
      evidence,
      scenes: [{ id: 's1', beat: '本章正文已发生', evidence }],
    },
    facts: [],
    character_updates: [],
    character_notes: [],
    character_emotional: [],
    timeline: [{ event: '本章关键行动已发生', evidence }],
    foreshadow_actions: [],
    memory_entries: [],
    new_entities: [],
  };
}

function evidenceAnchorHint(text, limit = 6) {
  const clips = [];
  const seen = new Set();
  for (const part of String(text || '').split(/[。！？\n]/).map(s => s.trim())) {
    const clip = part.slice(0, 40);
    if (clip.length < 4 || seen.has(clip) || !String(text || '').includes(clip)) continue;
    seen.add(clip);
    clips.push(clip);
    if (clips.length >= limit) break;
  }
  if (!clips.length) return '';
  return `\n\n当前正文里已经逐字出现、可直接复制为 evidence 的片段：\n${clips.map(c => `- ${c}`).join('\n')}`;
}

function projectionInstruction(chapter, text) {
  const outline = store.chapters.outline(chapter.id) || {};
  return `你是小说叙事状态取证员。只依据下面“当前版本正文”抽取，不得沿用旧摘要、旧章纲或常识补全。

任务：生成可回放的单章状态投影。每一条事实性记录都必须带 evidence；evidence 必须是当前正文中连续出现的 4—40 个字原句。正文没有明确写出的内容不要推断，数组可留空。
引用对白时只取连续的一段：若原句被“是父亲的声音”这类说话人标签或省略号隔开，只引用其中一段，不得把标签两侧拼成一句。

旧章纲仅用于理解原计划，不是已发生事实：
${JSON.stringify(outline).slice(0, 5000)}

只输出 JSON：
{
  "summary":"仅概括正文明确发生的事情，150字内",
  "rolling_update":"本章对全书局面的真实增量，200字内",
  "outline_actual":{
    "goal":"本章人物实际追求","conflict":"实际不可兼得的冲突",
    "dramatic_question":"正文实际提出并推进的核心追问","counterforce":"实际反作用力",
    "turn":"实际转折","irreversible_change":"章末不可逆变化",
    "choice_cost":"人物实际选择与代价","reader_gain":"读者本章获得的新信息/情绪/结果",
    "reader_pull":"自然延续到后文的未完力量，不要写平台术语","evidence":"正文原句",
    "scenes":[{"id":"s1","beat":"这一段实际发生什么","evidence":"正文原句"}]
  },
  "facts":[{"subject":"主语","predicate":"关系/动作/属性","object":"宾语","evidence":"正文原句"}],
  "character_updates":[{"name":"角色名","changes":["位置=地点","状态=状态"],"evidence":"正文原句"}],
  "character_notes":[{"name":"角色名","note":"正文可证的性格/关键行为","evidence":"正文原句"}],
  "character_emotional":[{"name":"角色名","mood":"章末心境","relation_delta":"关系变化或无","evidence":"正文原句"}],
  "timeline":[{"event":"按发生顺序写关键事件","evidence":"正文原句"}],
  "foreshadow_actions":[{"desc":"稳定的伏笔描述","action":"plant|advance|payoff|abandon","note":"本章变化","evidence":"正文原句"}],
  "memory_entries":[{"category":"voice|promise|detail|scene|relation","name":"关联名可空","content":"值得长期保留的具体细节","evidence":"正文原句"}],
  "new_entities":[{"type":"character|location|item|faction","name":"实体名","context":"正文可证的简述","evidence":"正文原句"}]
}

【当前版本正文｜第${chapter.idx}章《${chapter.title || ''}》】
${text}`;
}

async function extractProjection({ bookId, chapter, text, signal, feedback }) {
  const messages = [
    { role: 'system', content: '你只做可核验的信息抽取。不得创作、润色或补全正文没有写出的事实。' },
    { role: 'user', content: projectionInstruction(chapter, text) },
  ];
  if (feedback?.error) {
    // V0.99.1 语义失败范式：把本地原错误连同被拒输出退回模型重答一次（只准一次，见下方调用方）
    const correction = feedback.kind === 'invalid'
      ? `本地确定性校验拒绝了上一版输出：${feedback.error}\n\n`
        + '只重新输出一个完整合法的 JSON 对象：schema 要求的字段全部齐全（summary、outline_actual 及其九个子字段与 scenes、'
        + 'facts、character_updates、character_notes、character_emotional、timeline、foreshadow_actions、memory_entries、new_entities），'
        + '不得截断，不得加 markdown 围栏，不得输出任何解释文字。内容立场与取材不变，只修结构。'
      : `本地确定性校验拒绝了上一版输出，以下每一处都需修正：\n${feedback.error}\n\n`
        + 'evidence 必须是当前正文中逐字连续出现的原句（4—40 字，可省略标点引号，但每个汉字都必须与正文一致——'
        + '不得把“母亲”改写成“她”，不得拼接被说话人标签隔开的对白，不得把相隔两段的句子拼成一句，不得凭记忆复述大意）。'
        + '逐字找不到原句支撑的条目直接删除，其余字段保持不变，重新输出完整 JSON。'
        + evidenceAnchorHint(text);
    messages.push(
      { role: 'assistant', content: String(feedback.badContent || '(上一版输出为空)').slice(0, 20000) },
      { role: 'user', content: correction },
    );
  }
  const res = await runTask({
    task: 'settle', bookId, chapterId: chapter.id, jsonMode: true, signal,
    messages,
  });
  if (res.finishReason === 'length') {
    throw codedError('PROJECTION_INVALID', `第${chapter.idx}章影子投影输出被截断`, {
      chapterIdx: chapter.idx, rawContent: String(res.content || '').slice(0, 20000),
    });
  }
  const parsed = extractJSON(res.content);
  if (!parsed) {
    throw codedError('PROJECTION_INVALID', `第${chapter.idx}章影子投影不是有效 JSON`, {
      chapterIdx: chapter.idx, rawContent: String(res.content || '').slice(0, 20000),
    });
  }
  return parsed;
}

function projectionEvidence(payload = {}) {
  const entries = [
    payload.outline_actual,
    ...(payload.outline_actual?.scenes || []),
    ...(payload.facts || []),
    ...(payload.character_updates || []),
    ...(payload.character_notes || []),
    ...(payload.character_emotional || []),
    ...(payload.timeline || []),
    ...(payload.foreshadow_actions || []),
    ...(payload.memory_entries || []),
    ...(payload.new_entities || []),
  ];
  return [...new Set(entries.map(item => String(item?.evidence || '').trim()).filter(value => value.length >= 4))]
    .slice(0, 8);
}

function volumeNarrativeStatus(bookId, volume) {
  const chapters = store.chapters.listByVolume(volume.id);
  const completed = chapters.filter(isCompletedChapter);
  if (!completed.length) return 'future';
  return completed.length === chapters.length ? 'completed' : 'in_progress';
}

function planInputOf(bookId, chapters, projections) {
  const payloadByChapter = new Map(projections.map(row => [row.chapter_id, row.payload]));
  const volumeById = new Map(store.volumes.list(bookId).map(volume => [volume.id, volume]));
  const completedRows = chapters.map(chapter => {
    const payload = payloadByChapter.get(chapter.id) || {};
    return {
      chapter: chapter.idx,
      volume_idx: volumeById.get(chapter.volume_id)?.idx ?? null,
      title: chapter.title || '',
      summary: payload.summary || '',
      actual: payload.outline_actual || {},
      evidence: projectionEvidence(payload),
    };
  });
  const allChapters = store.chapters.list(bookId);
  const nextChapters = allChapters.filter(chapter => !isCompletedChapter(chapter)).slice(0, 3).map(chapter => ({
    chapter: chapter.idx,
    volume_idx: volumeById.get(chapter.volume_id)?.idx ?? null,
    title: chapter.title || '',
    old_outline: store.chapters.outline(chapter.id) || {},
  }));
  const volumes = store.volumes.list(bookId).map(volume => {
    const volumeChapters = store.chapters.listByVolume(volume.id);
    return {
      volume_idx: volume.idx,
      title: volume.title || '',
      status: volumeNarrativeStatus(bookId, volume),
      old_goal: volume.goal || '',
      old_outline: (() => { try { return JSON.parse(volume.outline_json || '{}'); } catch { return {}; } })(),
      chapter_indexes: volumeChapters.map(chapter => chapter.idx),
      completed_indexes: volumeChapters.filter(isCompletedChapter).map(chapter => chapter.idx),
    };
  });
  return {
    actual_through_chapter: chapters.at(-1)?.idx || 0,
    chapters: completedRows,
    volumes,
    next_chapters: nextChapters,
  };
}

function planReconciliationInstruction(book, input) {
  const contract = store.materials.get(book.id, 'contract')?.content || '';
  const bookOutline = store.materials.get(book.id, 'outline')?.content || '';
  return `你是长篇小说规划校准员。已写正文刚完成一次同版本取证。请根据“实际发生”校准书级状态、每卷剩余方向和最近三个待写章的因果种子；不得改写作者锁、书契约、历史硬节点，不得把旧计划当成已发生事实。

规则：
1. actual_story_state/actual_summary/actual_arc 只能概括输入中已验真的章节状态；每个已写层级至少给一条 evidence，quote 必须从对应章节 evidence 候选中逐字选取。
2. future_direction/remaining_direction/next_chapters 是从当前实际状态通向原书契约的后续规划；如果旧计划与实际状态冲突，以实际状态为起点，但保留作者长期承诺。
3. next_chapters 只覆盖输入列出的最近待写章，逐章写清承接、目标、冲突、阅读回报和下一步动力；不要生成 scenes，正式细纲会在写前另行生成。
4. 卷 status 必须原样使用输入的 completed|in_progress|future，不得伪造完成状态。

【书契约（不可擅改）】
${contract.slice(0, 3000) || '（无）'}

【原书纲（只作长期方向参考）】
${bookOutline.slice(0, 5000) || '（无）'}

【PLAN_INPUT_JSON】
${JSON.stringify(input)}

只输出 JSON：
{
  "book_state":{
    "actual_through_chapter":1,
    "actual_story_state":"已写事实形成的当前局面",
    "future_direction":"从当前局面继续履行书契约的主方向",
    "next_reader_gain":"下一阶段最应给读者的具体回报",
    "evidence":[{"chapter":1,"quote":"输入 evidence 中的逐字原句"}]
  },
  "volumes":[{
    "volume_idx":1,"status":"completed|in_progress|future",
    "actual_summary":"本卷已写部分实际摘要；纯未来卷可写尚未开始",
    "actual_arc":"本卷已写人物/局势弧；纯未来卷可写尚未开始",
    "remaining_direction":"本卷余下部分或下一阶段的方向",
    "evidence":[{"chapter":1,"quote":"逐字原句"}]
  }],
  "next_chapters":[{
    "chapter":2,"goal":"下一章目标","conflict":"不可兼得的冲突",
    "bridge_from_actual":"怎样承接已写结果","reader_gain":"具体阅读回报",
    "reader_pull":"由本章因果自然产生的下一步动力"
  }]
}`;
}

async function extractPlanReconciliation({ bookId, book, chapters, projections, signal, feedback }) {
  const input = planInputOf(bookId, chapters, projections);
  const messages = [
    { role: 'system', content: '你只校准小说规划。已写事实必须有逐字证据；作者锁和书契约不可改写。' },
    { role: 'user', content: planReconciliationInstruction(book, input) },
  ];
  if (feedback?.error) {
    // V0.100.1：与逐章投影同一语义失败范式——本地原错误连同被拒输出退回模型重答一次（只准一次）
    messages.push(
      { role: 'assistant', content: String(feedback.badContent || '(上一版输出为空)').slice(0, 20000) },
      {
        role: 'user',
        content: `本地确定性校验拒绝了上一版输出：${feedback.error}\n\n`
          + 'quote 必须是所标 chapter 那一章当前正文中逐字连续出现的原句（可省略标点引号，但每个汉字都必须与正文一致；'
          + '找不准就换成该章里你能逐字确认的另一句，或直接复用输入 PLAN_INPUT_JSON 中该章已有的 evidence）。'
          + '结构必须完整：书级、每卷、每个待写章字段齐全，不截断、不加 markdown 围栏、不输出解释。'
          + '其余内容立场不变，只修校验点出的问题，重新输出完整 JSON。',
      },
    );
  }
  const res = await runTask({
    task: 'narrative_plan_reconcile', bookId, jsonMode: true, signal,
    messages,
  });
  if (res.finishReason === 'length') {
    throw codedError('PLAN_RECONCILE_INVALID', '叙事规划校准输出被截断', {
      rawContent: String(res.content || '').slice(0, 20000),
    });
  }
  const parsed = extractJSON(res.content);
  if (!parsed) {
    throw codedError('PLAN_RECONCILE_INVALID', '叙事规划校准不是有效 JSON', {
      rawContent: String(res.content || '').slice(0, 20000),
    });
  }
  return parsed;
}

/**
 * V0.100.1：规划校准与逐章投影同权——34 章投影全部通过后，规划校准的一条幻觉引文/结构残缺
 * 不得直接杀死整批重建（实测："第1卷实际状态证据无法在第5章定位"在 34/34 取证完成
 * 后抛错）。PLAN_RECONCILE_INVALID 统一带反馈重答一次，第二次仍错 fail-closed；
 * 取消、正文源变化等其他错误不开口子。
 */
async function extractValidatedPlanReconciliation({
  implementation, bookId, book, chapters, projectionRows, prospectiveTextById, signal, revisionId, emit,
  allowDegradedPlan = false,
}) {
  const invoke = feedback => implementation({
    bookId, book, chapters, projections: projectionRows, prospectiveTextById, signal, revisionId, feedback,
  });
  let failure = null;
  let badContent = '';
  let first;
  try {
    first = await invoke(null);
    return validateNarrativePlanReconciliation(first, bookId, chapters, prospectiveTextById);
  } catch (error) {
    if (error?.code !== 'PLAN_RECONCILE_INVALID') throw error;
    failure = error;
    badContent = String(error?.rawContent || '').slice(0, 20000);
    if (!badContent && first !== undefined) {
      badContent = (typeof first === 'string' ? first : JSON.stringify(first)).slice(0, 20000);
    }
  }
  emit?.('narrative_plan_retry', { reason: failure.message });
  try {
    const corrected = await invoke({ kind: 'plan', error: failure.message, badContent });
    return validateNarrativePlanReconciliation(corrected, bookId, chapters, prospectiveTextById);
  } catch (error) {
    if (!allowDegradedPlan) throw error;
    if (error?.code !== 'PLAN_RECONCILE_INVALID') throw error;
    emit?.('narrative_plan_degraded', { reason: String(error.message || '').slice(0, 160) });
    return validateNarrativePlanReconciliation(
      deterministicPlanReconciliation(bookId, chapters, projectionRows, prospectiveTextById),
      bookId, chapters, prospectiveTextById,
    );
  }
}

/** 规划校准两轮仍错时的本地确定性规划：quote 必从当前正文/已验投影截取，不沿用幻觉引文。 */
export function deterministicPlanReconciliation(bookId, chapters, projectionRows, prospectiveTextById = new Map()) {
  const input = planInputOf(bookId, chapters, projectionRows);
  const textByIdx = new Map(chapters.map(chapter => [
    Number(chapter.idx),
    String(prospectiveTextById.get(chapter.id) ?? store.chapters.fullText(chapter.id)),
  ]));
  const quoteFor = (chapterIdx) => {
    const idx = Number(chapterIdx);
    const text = textByIdx.get(idx) || '';
    const row = input.chapters.find(item => Number(item.chapter) === idx);
    for (const candidate of row?.evidence || []) {
      const quote = String(candidate || '').trim();
      if (quote.length >= 4 && normalizedEvidence(text).includes(normalizedEvidence(quote))) {
        return { chapter: idx, quote: quote.slice(0, 40) };
      }
    }
    return { chapter: idx, quote: groundedEvidenceClip(text) };
  };
  const last = chapters.at(-1);
  const lastRow = input.chapters.find(item => Number(item.chapter) === Number(last?.idx));
  const lastSummary = String(lastRow?.summary || last?.title || `第${last?.idx || '?'}章已发生`).slice(0, 150);
  const outlineHint = String(store.materials.get(bookId, 'outline')?.content || '').trim().slice(0, 80);
  const volumes = store.volumes.list(bookId).map(volume => {
    const status = volumeNarrativeStatus(bookId, volume);
    const completedIdx = store.chapters.listByVolume(volume.id)
      .filter(isCompletedChapter).map(chapter => Number(chapter.idx));
    const lastCompleted = completedIdx.length
      ? input.chapters.find(item => Number(item.chapter) === completedIdx.at(-1))
      : null;
    return {
      volume_idx: Number(volume.idx),
      status,
      actual_summary: String(lastCompleted?.summary || (status === 'future' ? '尚未开始' : `${volume.title || '本卷'}已按当前正文发生`)).slice(0, 150),
      actual_arc: String(lastCompleted?.actual?.irreversible_change || lastCompleted?.actual?.turn
        || (status === 'future' ? '尚未开始' : '本卷已写章节的不可逆变化必须被后续承接')).slice(0, 150),
      remaining_direction: String(volume.goal || '继续履行书契约，承接已发生正文').slice(0, 150),
      evidence: completedIdx.length ? [quoteFor(completedIdx.at(-1))] : [],
    };
  });
  const expectedNext = store.chapters.list(bookId).filter(chapter => !isCompletedChapter(chapter)).slice(0, 3);
  const nextChapters = expectedNext.map(chapter => {
    const outline = store.chapters.outline(chapter.id) || {};
    return {
      chapter: Number(chapter.idx),
      goal: String(outline.goal || chapter.title || `承接第${last.idx}章已发生之事`).slice(0, 120),
      conflict: String(outline.conflict || '必须处理上一章已经造成的后果，不能无成本回到章前').slice(0, 120),
      bridge_from_actual: `承接第${last.idx}章：${lastSummary}`.slice(0, 160),
      reader_gain: String(outline.reader_gain || '看见上一章选择的即时后果').slice(0, 120),
      reader_pull: String(outline.reader_pull || '局面不允许停在观察-记录').slice(0, 120),
    };
  });
  return {
    book_state: {
      actual_through_chapter: Number(last?.idx || 0),
      actual_story_state: lastSummary,
      future_direction: outlineHint || '继续履行书契约，承接已发生正文的不可逆后果',
      next_reader_gain: '让上一章已经发生的选择立刻产生代价与新信息',
      evidence: last ? [quoteFor(last.idx)] : [],
    },
    volumes,
    next_chapters: nextChapters,
  };
}

function assertPlanEvidence(entries, chapterTextByIdx, label, { required = true, allowedChapters = null } = {}) {
  if (!Array.isArray(entries) || (required && !entries.length)) {
    throw codedError('PLAN_RECONCILE_INVALID', `${label}缺少正文证据`);
  }
  for (const entry of entries || []) {
    const chapterIdx = Number(entry?.chapter);
    const quote = normalizedEvidence(entry?.quote);
    const text = chapterTextByIdx.get(chapterIdx);
    if ((allowedChapters && !allowedChapters.has(chapterIdx))
        || !text || quote.length < 4 || !normalizedEvidence(text).includes(quote)) {
      throw codedError('PLAN_RECONCILE_INVALID', `${label}证据无法在第${chapterIdx || '?'}章当前正文定位：${entry?.quote || '未提供'}`);
    }
  }
}

export function validateNarrativePlanReconciliation(raw, bookId, chapters, prospectiveTextById = new Map()) {
  const payload = typeof raw === 'string' ? extractJSON(raw) : raw;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('PLAN_RECONCILE_INVALID', '叙事规划校准不是 JSON 对象');
  }
  const textByIdx = new Map(chapters.map(chapter => [
    Number(chapter.idx),
    String(prospectiveTextById.get(chapter.id) ?? store.chapters.fullText(chapter.id)),
  ]));
  const actualThrough = chapters.at(-1)?.idx || 0;
  const bookState = payload.book_state;
  if (!bookState || Number(bookState.actual_through_chapter) !== Number(actualThrough)) {
    throw codedError('PLAN_RECONCILE_INVALID', `书级实际进度必须为第${actualThrough}章`);
  }
  for (const field of ['actual_story_state', 'future_direction', 'next_reader_gain']) {
    if (!nonEmpty(bookState[field])) throw codedError('PLAN_RECONCILE_INVALID', `书级规划缺少 ${field}`);
  }
  assertPlanEvidence(bookState.evidence, textByIdx, '书级实际状态');

  const expectedVolumes = store.volumes.list(bookId);
  const rows = Array.isArray(payload.volumes) ? payload.volumes : [];
  if (rows.length !== expectedVolumes.length) {
    throw codedError('PLAN_RECONCILE_INVALID', `卷规划覆盖不完整：${rows.length}/${expectedVolumes.length}`);
  }
  const seenVolumes = new Set();
  const volumes = rows.map(row => {
    const idx = Number(row?.volume_idx);
    const volume = expectedVolumes.find(item => Number(item.idx) === idx);
    if (!volume || seenVolumes.has(idx)) throw codedError('PLAN_RECONCILE_INVALID', `卷规划编号无效或重复：${idx || '?'}`);
    seenVolumes.add(idx);
    const expectedStatus = volumeNarrativeStatus(bookId, volume);
    if (row.status !== expectedStatus) throw codedError('PLAN_RECONCILE_INVALID', `第${idx}卷状态应为 ${expectedStatus}`);
    for (const field of ['actual_summary', 'actual_arc', 'remaining_direction']) {
      if (!nonEmpty(row[field])) throw codedError('PLAN_RECONCILE_INVALID', `第${idx}卷缺少 ${field}`);
    }
    const completedIndexes = new Set(store.chapters.listByVolume(volume.id)
      .filter(isCompletedChapter).map(chapter => Number(chapter.idx)));
    const hasCompleted = completedIndexes.size > 0;
    assertPlanEvidence(row.evidence, textByIdx, `第${idx}卷实际状态`, {
      required: hasCompleted,
      allowedChapters: hasCompleted ? completedIndexes : null,
    });
    return {
      volume_idx: idx, status: row.status,
      actual_summary: row.actual_summary.trim(), actual_arc: row.actual_arc.trim(),
      remaining_direction: row.remaining_direction.trim(), evidence: row.evidence || [],
    };
  });

  const expectedNext = store.chapters.list(bookId).filter(chapter => !isCompletedChapter(chapter)).slice(0, 3);
  const nextRows = Array.isArray(payload.next_chapters) ? payload.next_chapters : [];
  if (nextRows.length !== expectedNext.length) {
    throw codedError('PLAN_RECONCILE_INVALID', `最近待写章规划覆盖不完整：${nextRows.length}/${expectedNext.length}`);
  }
  const expectedNextIdx = new Set(expectedNext.map(chapter => Number(chapter.idx)));
  const seenNext = new Set();
  const nextChapters = nextRows.map(row => {
    const idx = Number(row?.chapter);
    if (!expectedNextIdx.has(idx) || seenNext.has(idx)) throw codedError('PLAN_RECONCILE_INVALID', `待写章规划编号无效或重复：${idx || '?'}`);
    seenNext.add(idx);
    for (const field of ['goal', 'conflict', 'bridge_from_actual', 'reader_gain', 'reader_pull']) {
      if (!nonEmpty(row[field])) throw codedError('PLAN_RECONCILE_INVALID', `第${idx}章规划种子缺少 ${field}`);
    }
    return {
      chapter: idx, goal: row.goal.trim(), conflict: row.conflict.trim(),
      bridge_from_actual: row.bridge_from_actual.trim(), reader_gain: row.reader_gain.trim(),
      reader_pull: row.reader_pull.trim(),
    };
  });
  return {
    book_state: {
      actual_through_chapter: actualThrough,
      actual_story_state: bookState.actual_story_state.trim(),
      future_direction: bookState.future_direction.trim(),
      next_reader_gain: bookState.next_reader_gain.trim(),
      evidence: bookState.evidence,
    },
    volumes,
    next_chapters: nextChapters,
  };
}

const ALIGNMENT_SECTION_RE = /\n*【当前叙事版本对齐｜[^】]*】[\s\S]*?【叙事版本对齐结束】\n*/g;

function withoutPreviousAlignmentSection(content) {
  return String(content || '').replace(ALIGNMENT_SECTION_RE, '\n').trim();
}

// 未来章换版时只保留作者明确锁定、不会因前文返工而失效的坐标。
// goal/beat/conflict/scenes/checkpoints/continuity 等动态设计必须丢弃，否则“标 stale”仍会污染下一轮细纲。
const FUTURE_OUTLINE_STATIC_FIELDS = new Set([
  'year', 'era_year', 'protagonist_age', 'phase', 'reward_mode', 'emotion',
  'obligations', 'forbidden', 'author_locks', 'authorLocks', 'locked_fields',
  'historical_anchor', 'historical_anchors', 'era_event', 'era_events', 'era_event_ids',
  'must_include', 'must_not', 'constraints', 'contract_promises', 'volume_contract',
  'lifecycle_stage', 'opening_blueprint', 'opening_slot', 'opening_contract',
  'time', 'date', 'location_lock', 'pov_lock', 'perspective', 'genre_constraints', 'world_rules',
]);

export function futureOutlineBase(outline = {}) {
  return Object.fromEntries(Object.entries(outline || {})
    .filter(([key, value]) => {
      if (!FUTURE_OUTLINE_STATIC_FIELDS.has(key)) return false;
      if (key === 'phase' && isPlanningMetaPhase(value)) return false;
      return true;
    }));
}

function projectionActualFor(projections, chapterId) {
  const row = projections.find(item => item.chapter_id === chapterId);
  return row?.payload?.outline_actual || {};
}

function reconciledVolumeChapters(volume, projections, seedByChapter) {
  const volumeChapters = store.chapters.listByVolume(volume.id).sort((a, b) => a.idx - b.idx);
  let oldOutline = {};
  try { oldOutline = JSON.parse(volume.outline_json || '{}'); } catch { oldOutline = {}; }
  const oldRows = Array.isArray(oldOutline.chapters) ? oldOutline.chapters : [];
  return volumeChapters.map((chapter, position) => {
    const staticPlan = futureOutlineBase(oldRows[position] || {});
    if (isCompletedChapter(chapter)) {
      const projection = projections.find(item => item.chapter_id === chapter.id)?.payload || {};
      const actual = projection.outline_actual || {};
      return {
        ...staticPlan,
        idx: position + 1,
        chapter_idx: chapter.idx,
        title: chapter.title || oldRows[position]?.title || '',
        status: 'actual',
        summary: projection.summary || '',
        beat: actual.scenes?.map(scene => scene.beat).filter(Boolean).join('；') || actual.turn || '',
        goal: actual.goal || '', conflict: actual.conflict || '',
        irreversible_change: actual.irreversible_change || '', reader_gain: actual.reader_gain || '',
      };
    }
    const seed = seedByChapter.get(Number(chapter.idx));
    return {
      ...staticPlan,
      idx: position + 1,
      chapter_idx: chapter.idx,
      title: chapter.title || oldRows[position]?.title || '',
      status: 'reconcile_pending',
      ...(seed ? { reconcile_seed: seed } : {}),
    };
  });
}

/**
 * 把书纲、卷纲、未来章与设置校准到同一叙事版本。
 * 仅在正文与全部 projection 已通过校验后的外层事务中调用。
 */
function applyNarrativePlanReconciliation(bookId, revisionId, plan, projections) {
  const state = plan.book_state;
  const oldMaterial = store.materials.get(bookId, 'outline')?.content || '';
  const baseMaterial = withoutPreviousAlignmentSection(oldMaterial);
  const alignment = `【当前叙事版本对齐｜${revisionId}】
已写至：第${state.actual_through_chapter}章
当前实际局面：${state.actual_story_state}
后续主方向：${state.future_direction}
下一阶段阅读回报：${state.next_reader_gain}
【叙事版本对齐结束】`;
  store.materials.set(bookId, 'outline', [baseMaterial, alignment].filter(Boolean).join('\n\n'));

  const volumePlanByIdx = new Map(plan.volumes.map(row => [Number(row.volume_idx), row]));
  const seedByChapter = new Map(plan.next_chapters.map(row => [Number(row.chapter), row]));
  for (const volume of store.volumes.list(bookId)) {
    const volumePlan = volumePlanByIdx.get(Number(volume.idx));
    if (!volumePlan) throw codedError('PLAN_RECONCILE_INVALID', `缺少第${volume.idx}卷校准结果`);
    let oldOutline = {};
    try { oldOutline = JSON.parse(volume.outline_json || '{}'); } catch { oldOutline = {}; }
    const nextOutline = {
      ...oldOutline,
      actual_summary: volumePlan.actual_summary,
      actual_arc: volumePlan.actual_arc,
      remaining_direction: volumePlan.remaining_direction,
      chapters: reconciledVolumeChapters(volume, projections, seedByChapter),
      _narrative_revision: { id: revisionId, state: 'aligned' },
    };
    store.volumes.update(volume.id, {
      outline: nextOutline,
      summary: volumePlan.actual_summary,
      goal: volumePlan.remaining_direction,
    });
  }

  for (const chapter of store.chapters.list(bookId).filter(item => !isCompletedChapter(item))) {
    const oldOutline = store.chapters.outline(chapter.id) || {};
    const seed = seedByChapter.get(Number(chapter.idx));
    store.chapters.update(chapter.id, {
      outline: {
        ...futureOutlineBase(oldOutline),
        ...(seed ? { reconcile_seed: seed } : {}),
        _narrative_revision: {
          id: revisionId,
          state: 'stale',
          seeded: Boolean(seed),
          reason: seed
            ? '前文已换版；必须以同版规划种子重新生成正式细纲'
            : '前文已换版；旧动态细纲已隔离，写作前必须重新生成正式细纲',
        },
      },
    });
  }

  const settings = store.books.settings(bookId);
  settings.narrativePlan = {
    revisionId,
    actualThroughChapter: state.actual_through_chapter,
    actualStoryState: state.actual_story_state,
    futureDirection: state.future_direction,
    nextReaderGain: state.next_reader_gain,
    updatedAt: Date.now(),
  };
  settings.narrativeRevision = {
    ...(settings.narrativeRevision || {}),
    id: revisionId,
    sourceHash: manuscriptSourceHash(bookId),
    planState: 'aligned',
    futureOutlines: 'reconciled_stale',
    updatedAt: Date.now(),
  };
  store.books.update(bookId, { settings });
}

function appendBoundedState(previous, summary, maxChars = 900) {
  const parts = [String(previous || '').trim(), String(summary || '').trim()].filter(Boolean);
  const unique = parts.filter((value, index) => !index || value !== parts[index - 1]);
  const joined = unique.join('；');
  return joined.length <= maxChars ? joined : joined.slice(joined.length - maxChars);
}

/**
 * 正常自动创作完成一章后，把上一有效版本延伸到新章。
 * 不额外调用模型：章节已经过细纲、审校和结算；这里只更新版本指纹、实际进度、
 * 卷内实际摘要与“下一章必须重生成”的同版种子，防止返工闭环在续写一章后失效。
 * 调用方必须位于章结算事务内，任何对账失败都会连同结算一起回滚。
 */
export function recordSettledNarrativeExtension(bookId, chapterId, {
  parentRevisionId = null,
  summary = '',
  projection = null,
} = {}) {
  const chapter = store.chapters.get(chapterId);
  if (!chapter || chapter.book_id !== bookId) throw codedError('NARRATIVE_EXTENSION_CHAPTER_MISSING', '叙事版本延伸章节不存在');
  let parent = parentRevisionId
    ? store.narrativeRevisions.get(parentRevisionId)
    : store.narrativeRevisions.current(bookId);
  const bootstrap = !parent && Number(chapter.idx) === 1
    && !store.chapters.list(bookId).some(item => item.id !== chapter.id && isCompletedChapter(item));
  if (!parent && !bootstrap) return null; // 存量中途升级不伪造不完整父版本，等待一次全面重建。
  if (parent && parent.status !== 'valid') throw codedError('NARRATIVE_EXTENSION_PARENT_INVALID', '叙事版本延伸的父版本不是有效版本');
  const parentThrough = parent
    ? (parent.manifest?.empty_baseline ? 0 : Number(parent.through_chapter))
    : 0;
  if (Number(chapter.idx) !== parentThrough + 1) {
    throw codedError(
      'NARRATIVE_EXTENSION_OUT_OF_ORDER',
      `叙事版本只允许顺序延伸：当前有效至第${parentThrough}章，不能直接结算第${chapter.idx}章`,
    );
  }
  const parentHash = manuscriptSourceHash(bookId, { throughChapter: parentThrough });
  if (parent && parentHash !== parent.source_hash) {
    throw codedError('NARRATIVE_SOURCE_MISMATCH', '父版本正文指纹已变化，拒绝用正常结算掩盖旧状态污染');
  }
  const targetHash = manuscriptSourceHash(bookId, { throughChapter: chapter.idx });
  const revision = store.narrativeRevisions.create(bookId, {
    parentId: parent?.id || null,
    fromChapter: chapter.idx,
    throughChapter: chapter.idx,
    status: 'building',
    sourceHash: targetHash,
    reason: bootstrap ? '首章结算，建立同版状态账本' : `正常创作结算第${chapter.idx}章，延伸同版状态`,
    manifest: { extension_chapter: chapter.idx, parent_through_chapter: parentThrough, bootstrap },
  });

  // 复制父版本已有的可核验证据缓存；新章没有伪造 evidence，下一次全面回放时会单独取证。
  const inheritedProjections = parent ? store.chapterProjections.list(parent.id) : [];
  for (const projection of inheritedProjections) {
    store.chapterProjections.set(revision.id, bookId, projection.chapter_id, {
      chapterIdx: projection.chapter_idx,
      sourceHash: projection.source_hash,
      payload: projection.payload,
    });
  }
  if (projection) {
    const text = store.chapters.fullText(chapter.id);
    const verified = validateNarrativeProjection(projection, text, chapter);
    store.chapterProjections.set(revision.id, bookId, chapter.id, {
      chapterIdx: chapter.idx,
      sourceHash: sha256(text),
      payload: verified,
    });
  }

  const currentOutline = store.chapters.outline(chapter.id) || {};
  store.chapters.update(chapter.id, {
    outline: {
      ...currentOutline,
      actual_outcome: {
        ...(currentOutline.actual_outcome || {}),
        summary: String(summary || '').trim(),
      },
      _narrative_revision: {
        id: revision.id,
        state: 'aligned',
        source_hash: sha256(store.chapters.fullText(chapter.id)),
      },
    },
  });

  const future = store.chapters.list(bookId).filter(item => Number(item.idx) > Number(chapter.idx));
  const immediate = future[0] || null;
  let immediateSeed = null;
  if (immediate) {
    const oldOutline = store.chapters.outline(immediate.id) || {};
    const oldSeed = oldOutline.reconcile_seed || {};
    immediateSeed = sanitizeReconcileSeed({
      chapter: immediate.idx,
      goal: oldSeed.goal || oldOutline.goal || oldOutline.beat || '',
      conflict: oldSeed.conflict || oldOutline.conflict || '推进目标与承担上一章后果不可兼得',
      bridge_from_actual: String(summary || '').trim() || `承接第${chapter.idx}章实际结果`,
      reader_gain: oldSeed.reader_gain || oldOutline.reader_gain || '让上一章选择的后果具体落地',
      reader_pull: oldSeed.reader_pull || oldOutline.reader_pull || '由人物的新选择自然推进下一步',
    }, { title: immediate.title || '' });
    store.chapters.update(immediate.id, {
      outline: {
        ...futureOutlineBase(oldOutline),
        reconcile_seed: immediateSeed,
        _narrative_revision: {
          id: revision.id,
          state: 'stale',
          seeded: true,
          reason: `第${chapter.idx}章已经结算，必须按实际结果重新生成正式细纲`,
        },
      },
    });
  }
  for (const later of immediate ? future.slice(1) : future) {
    const outline = store.chapters.outline(later.id) || {};
    store.chapters.update(later.id, {
      outline: {
        ...outline,
        _narrative_revision: {
          ...(outline._narrative_revision || {}),
          id: revision.id,
          state: outline.reconcile_seed ? 'seeded' : (outline._narrative_revision?.state || 'planned'),
        },
      },
    });
  }

  const volume = chapter.volume_id ? store.volumes.get(chapter.volume_id) : null;
  if (volume) {
    let volumeOutline = {};
    try { volumeOutline = JSON.parse(volume.outline_json || '{}'); } catch { volumeOutline = {}; }
    const volumeChapters = store.chapters.listByVolume(volume.id).sort((a, b) => a.idx - b.idx);
    const position = volumeChapters.findIndex(item => item.id === chapter.id);
    const rows = Array.isArray(volumeOutline.chapters) ? [...volumeOutline.chapters] : [];
    if (position >= 0) {
      rows[position] = {
        ...futureOutlineBase(rows[position] || {}),
        idx: position + 1,
        chapter_idx: chapter.idx,
        title: chapter.title || rows[position]?.title || '',
        status: 'actual',
        summary: String(summary || '').trim(),
        beat: (currentOutline.scenes || []).map(scene => scene.beat).filter(Boolean).join('；') || currentOutline.turn || '',
        goal: currentOutline.goal || '',
        conflict: currentOutline.conflict || '',
        irreversible_change: currentOutline.irreversible_change || '',
        reader_gain: currentOutline.reader_gain || '',
      };
    }
    const actualSummary = appendBoundedState(volumeOutline.actual_summary || volume.summary, summary, 1200);
    store.volumes.update(volume.id, {
      summary: actualSummary,
      outline: {
        ...volumeOutline,
        actual_summary: actualSummary,
        chapters: rows,
        _narrative_revision: { id: revision.id, state: 'aligned' },
      },
    });
  }

  const settings = store.books.settings(bookId);
  const previousPlan = settings.narrativePlan || {};
  const actualStoryState = appendBoundedState(previousPlan.actualStoryState, summary);
  const futureDirection = previousPlan.futureDirection
    || volume?.goal
    || '从当前实际结果继续推进人物目标与长期承诺';
  const nextReaderGain = immediateSeed?.reader_gain
    || previousPlan.nextReaderGain
    || '兑现当前行动后果并推进新的有效事件';
  settings.narrativePlan = {
    ...previousPlan,
    revisionId: revision.id,
    actualThroughChapter: chapter.idx,
    actualStoryState,
    futureDirection,
    nextReaderGain,
    updatedAt: Date.now(),
  };
  settings.narrativeRevision = {
    ...(settings.narrativeRevision || {}),
    id: revision.id,
    sourceHash: targetHash,
    planState: 'incremental_aligned',
    futureOutlines: immediate ? 'next_chapter_reconciled_stale' : 'none',
    extendedByChapter: chapter.idx,
    updatedAt: Date.now(),
  };
  store.books.update(bookId, { settings });

  const oldMaterial = store.materials.get(bookId, 'outline')?.content || '';
  const alignment = `【当前叙事版本对齐｜${revision.id}】
已写至：第${chapter.idx}章
当前实际局面：${actualStoryState || String(summary || '').trim()}
后续主方向：${futureDirection}
下一阶段阅读回报：${nextReaderGain}
【叙事版本对齐结束】`;
  store.materials.set(bookId, 'outline', [withoutPreviousAlignmentSection(oldMaterial), alignment]
    .filter(Boolean).join('\n\n'));

  store.narrativeRevisions.complete(revision.id, {
    sourceHash: targetHash,
    manifest: {
      extension_chapter: chapter.idx,
      parent_revision_id: parent?.id || null,
      inherited_projections: inheritedProjections.length,
      projection_pending_for_chapter: projection ? null : chapter.idx,
      projection_coverage: projection ? chapter.idx : parentThrough,
      aligned: ['prose', 'settlement', 'summary', 'facts', 'characters', 'timeline', 'foreshadows', 'memory', 'chapter_outline', 'volume_outline', 'book_outline', 'settings'],
      future_outlines: immediate ? 'next_chapter_reconciled_stale' : 'none',
    },
  });
  return store.narrativeRevisions.get(revision.id);
}

function parseState(row) {
  try { return JSON.parse(row?.state_json || '{}'); } catch { return {}; }
}

function applyChanges(state, changes) {
  const next = { ...state };
  for (const change of Array.isArray(changes) ? changes : []) {
    if (typeof change !== 'string') continue;
    const at = change.indexOf('=');
    if (at > 0) next[change.slice(0, at).trim()] = change.slice(at + 1).trim();
  }
  return next;
}

/** 在同一个外层同步事务内把一个已验真的 projection 投射到工作表。 */
function materializeProjection(bookId, chapter, text, payload, revisionId) {
  const factResult = applyFacts(bookId, payload.facts || [], chapter.idx);
  let characterCount = 0;
  for (const update of payload.character_updates || []) {
    const name = String(update.name || '').trim();
    if (!name) continue;
    const existing = store.characters.list(bookId).find(item => item.name === name);
    if (existing) {
      store.characters.update(existing.id, {
        state: applyChanges(parseState(existing), update.changes),
        firstChapter: existing.first_chapter ?? chapter.idx,
        lastChapter: chapter.idx,
      });
    } else {
      store.characters.create(bookId, {
        name, card: { role: '（由正文取证，待完善）' },
        state: applyChanges({}, update.changes), firstChapter: chapter.idx,
      });
      const created = store.characters.list(bookId).find(item => item.name === name);
      if (created) store.characters.update(created.id, { lastChapter: chapter.idx });
    }
    characterCount++;
  }

  for (const note of payload.character_notes || []) {
    const row = store.characters.list(bookId).find(item => item.name === String(note.name || '').trim());
    if (!row || !nonEmpty(note.note)) continue;
    let card = {};
    try { card = JSON.parse(row.card_json || '{}'); } catch { card = {}; }
    const notes = Array.isArray(card.narrative_notes) ? card.narrative_notes : [];
    card.narrative_notes = [...new Set([...notes, note.note.trim()])].slice(-8);
    store.characters.update(row.id, { card });
  }
  for (const emotional of payload.character_emotional || []) {
    const row = store.characters.list(bookId).find(item => item.name === String(emotional.name || '').trim());
    if (!row) continue;
    const patch = {};
    if (nonEmpty(emotional.mood) && emotional.mood.trim() !== '无') {
      patch.state = { ...parseState(row), 心境: emotional.mood.trim().slice(0, 30) };
    }
    if (nonEmpty(emotional.relation_delta) && emotional.relation_delta.trim() !== '无') {
      patch.relation = [row.relation, emotional.relation_delta.trim()].filter(Boolean).join('；').slice(0, 240);
    }
    if (Object.keys(patch).length) store.characters.update(row.id, patch);
  }

  let timelineCount = 0;
  for (const entry of payload.timeline || []) {
    const event = String(entry.event || '').trim();
    if (!event) continue;
    store.timeline.add(bookId, { chapterId: chapter.id, event });
    timelineCount++;
  }
  const foreshadows = applyForeshadowActions(bookId, payload.foreshadow_actions || [], chapter.idx, {
    chapterText: store.chapters.fullText(chapter.id) || '',
  });
  store.summaries.set(chapter.id, bookId, payload.summary);
  appendRollingRecent(bookId, chapter.idx, payload.rolling_update || payload.summary);
  const memories = applySettlementMemories(bookId, chapter.id, chapter.idx, payload.memory_entries || []);

  let entityCount = 0;
  const entityMap = { character: 'characters', location: 'locations', item: 'items', faction: 'factions' };
  for (const entity of payload.new_entities || []) {
    const apiName = entityMap[String(entity.type || '').toLowerCase()];
    const name = String(entity.name || '').trim();
    if (!apiName || !name) continue;
    const api = store[apiName];
    const existing = api.list(bookId).find(item => item.name === name);
    const card = { source: 'narrative_projection', detail: String(entity.context || '').trim() };
    let oldCard = {};
    try { oldCard = JSON.parse(existing?.card_json || '{}'); } catch { oldCard = {}; }
    if (existing) api.update(existing.id, { card: { ...oldCard, ...card }, lastChapter: chapter.idx });
    else api.create(bookId, { name, card, firstChapter: chapter.idx, lastChapter: chapter.idx });
    entityCount++;
  }

  const outline = store.chapters.outline(chapter.id) || {};
  try { registerHooksFromOutline(bookId, outline, chapter.idx); } catch { /* 伏笔动作仍是权威恢复路径 */ }
  try { reconcileStoryArcsForChapter(bookId, chapter.idx, { chapterText: text, summary: payload.summary }); } catch { /* 不阻断回放 */ }
  transitionChapterStatus(bookId, chapter.id, 'settled', { reason: '叙事版本原子回放' });
  const contentHash = sha256(store.chapters.fullText(chapter.id));
  const result = {
    facts: factResult, characters: characterCount, timeline: timelineCount, foreshadows,
    newEntities: entityCount, memories, summary: payload.summary, narrativeRevision: revisionId,
  };
  store.chapterSettlements.set(bookId, chapter.id, { contentHash, result });
  recordChapterDiversityFeatures(bookId, chapter.id, {
    revisionId, sourceHash: contentHash,
    outline: { ...outline, ...(payload.outline_actual || {}) },
    text,
  });
  return result;
}

function compactHistoryFromCurrentChapters(bookId) {
  ensureHistory(bookId);
  store.history.truncateFrom(bookId, 3, '叙事版本切换：按当前正文重建动态历史');
  for (const chapter of store.chapters.list(bookId)) {
    for (const scene of store.scenes.list(chapter.id)) store.scenes.update(scene.id, { historySeq: null });
    if (!isCompletedChapter(chapter)) continue;
    for (const scene of store.scenes.list(chapter.id)) {
      if (!String(scene.content || '').trim()) continue;
      const historySeq = store.history.append(bookId, 'assistant', scene.content);
      store.scenes.update(scene.id, { historySeq });
    }
  }
  return store.history.count(bookId);
}

function normalizedRewriteMap(rewrites) {
  if (rewrites instanceof Map) return new Map(rewrites);
  if (Array.isArray(rewrites)) return new Map(rewrites.map(item => [item.chapterId || item.chapter_id || item.id, item.text || item.content]));
  if (rewrites && typeof rewrites === 'object') return new Map(Object.entries(rewrites));
  return new Map();
}

/**
 * 全部完成章已经被作者显式打回时，没有正文可交给模型取证。这里建立一个可追踪的
 * “第 0 章”空白基线：清掉旧正文派生投影与动态纲要，只保留作者锁和历史坐标，
 * 使第一章可以按顺序重新创作；绝不拿旧摘要伪装成新版本。
 */
function commitEmptyNarrativeBaseline(bookId, { reason, onEvent } = {}) {
  const sourceHash = manuscriptSourceHash(bookId);
  const previous = store.narrativeRevisions.current(bookId);
  const revision = store.narrativeRevisions.create(bookId, {
    parentId: previous?.id || null,
    fromChapter: 1,
    throughChapter: 1,
    status: 'building',
    sourceHash,
    reason: reason || '全部完成章已打回，建立干净的空白叙事基线',
    manifest: { empty_baseline: true, actual_through_chapter: 0, changed_chapters: [] },
  });
  const emit = (type, data = {}) => onEvent?.({ type, revisionId: revision.id, ...data });
  emit('narrative_projection_started', { total: 0, emptyBaseline: true });
  try {
    store.transaction(() => {
      store.narrativeRevisions.update(revision.id, { status: 'applying' });
      store.resetNarrativeProjectionState(bookId, { throughChapter: Number.MAX_SAFE_INTEGER });

      const oldMaterial = store.materials.get(bookId, 'outline')?.content || '';
      store.materials.set(bookId, 'outline', withoutPreviousAlignmentSection(oldMaterial));

      for (const volume of store.volumes.list(bookId)) {
        let oldOutline = {};
        try { oldOutline = JSON.parse(volume.outline_json || '{}'); } catch { oldOutline = {}; }
        const cleanOutline = { ...oldOutline };
        delete cleanOutline.actual_summary;
        delete cleanOutline.actual_arc;
        delete cleanOutline.remaining_direction;
        cleanOutline.chapters = store.chapters.listByVolume(volume.id)
          .sort((a, b) => a.idx - b.idx)
          .map((chapter, position) => ({
            ...futureOutlineBase((Array.isArray(oldOutline.chapters) ? oldOutline.chapters[position] : {}) || {}),
            idx: position + 1,
            chapter_idx: chapter.idx,
            title: chapter.title || oldOutline.chapters?.[position]?.title || '',
            status: 'reconcile_pending',
          }));
        cleanOutline._narrative_revision = { id: revision.id, state: 'empty_baseline' };
        store.volumes.update(volume.id, {
          outline: cleanOutline,
          summary: '',
          goal: oldOutline.goal || oldOutline.volume_goal || volume.goal || '',
        });
      }

      for (const chapter of store.chapters.list(bookId)) {
        const oldOutline = store.chapters.outline(chapter.id) || {};
        store.chapters.update(chapter.id, {
          outline: {
            ...futureOutlineBase(oldOutline),
            _narrative_revision: {
              id: revision.id,
              state: 'stale',
              seeded: false,
              reason: '旧动态细纲已清除；请从空白叙事基线重新生成正式细纲',
            },
          },
        });
      }

      const settings = store.books.settings(bookId);
      settings.narrativePlan = {
        revisionId: revision.id,
        actualThroughChapter: 0,
        actualStoryState: '',
        futureDirection: store.volumes.list(bookId)[0]?.goal || '从第一章重新建立人物目标与因果链',
        nextReaderGain: '第一章必须产生可见选择、状态变化与继续阅读理由',
        updatedAt: Date.now(),
      };
      settings.narrativeRevision = {
        ...(settings.narrativeRevision || {}),
        id: revision.id,
        sourceHash,
        planState: 'empty_baseline',
        futureOutlines: 'cleared_stale',
        updatedAt: Date.now(),
      };
      store.books.update(bookId, { settings });
      compactHistoryFromCurrentChapters(bookId);
      store.narrativeRevisions.complete(revision.id, {
        sourceHash,
        manifest: {
          empty_baseline: true,
          actual_through_chapter: 0,
          changed_chapters: [],
          chapters: [],
          projections: 0,
          aligned: [
            'empty_prose', 'summaries', 'facts', 'characters', 'timeline', 'foreshadows',
            'memory', 'chapter_outlines', 'volume_outlines', 'settings', 'history', 'patterns',
          ],
          future_outlines: 'cleared_stale',
          vectors: 'cleared',
        },
      });
    });
  } catch (error) {
    store.narrativeRevisions.fail(revision.id, `${error.code || 'ERROR'}: ${error.message}`);
    emit('narrative_revision_failed', { code: error.code || 'ERROR', error: error.message });
    throw error;
  }
  emit('narrative_revision_committed', { total: 0, changed: [], emptyBaseline: true, vectorFailures: [] });
  return {
    status: 'valid',
    revisionId: revision.id,
    sourceHash,
    chapters: 0,
    changedChapters: [],
    vectorFailures: [],
    plan: null,
    emptyBaseline: true,
  };
}

/**
 * V0.100.1：逐章取证的证据定位失败（PROJECTION_EVIDENCE_MISSING）与结构残缺（PROJECTION_INVALID：
 * 非法 JSON、截断、缺字段）都按 V0.99.1 语义失败范式有反馈地纠正一次——把本地校验错误与被拒输出
 * 退回模型重答；第二次仍错立即 fail-closed。弱网/免费档下这两类是中断主因，重答一次成本远低于
 * 整批重跑。其他错误（取消、正文源变化等）不加重试，沿用原失败路径。
 */
async function extractValidatedProjection({
  implementation, bookId, book, chapter, text, signal, revisionId, emit, allowDegraded = false,
}) {
  const invoke = feedback => implementation({ bookId, book, chapter, text, signal, revisionId, feedback });
  let failure = null;
  let badContent = '';
  let first;
  try {
    first = await invoke(null);
    return validateNarrativeProjection(first, text, chapter);
  } catch (error) {
    if (error?.code !== 'PROJECTION_EVIDENCE_MISSING' && error?.code !== 'PROJECTION_INVALID') throw error;
    failure = error;
    badContent = String(error?.rawContent || '').slice(0, 20000);
    if (!badContent && first !== undefined) {
      badContent = (typeof first === 'string' ? first : JSON.stringify(first)).slice(0, 20000);
    }
  }
  emit?.('narrative_projection_retry', { chapter: chapter.idx, reason: failure.message });
  try {
    const corrected = await invoke({
      kind: failure.code === 'PROJECTION_INVALID' ? 'invalid' : 'evidence',
      error: failure.message,
      badContent,
    });
    return validateNarrativeProjection(corrected, text, chapter);
  } catch (error) {
    if (!allowDegraded) throw error;
    if (error?.code !== 'PROJECTION_EVIDENCE_MISSING' && error?.code !== 'PROJECTION_INVALID') throw error;
    emit?.('narrative_projection_degraded', {
      chapter: chapter.idx,
      reason: String(error.message || '').slice(0, 160),
    });
    return validateNarrativeProjection(deterministicChapterProjection(text, chapter), text, chapter);
  }
}

/**
 * V0.100.1 断点续跑：依次从当前有效版本与最近一次同指纹失败版本读取已验证投影。
 * 缓存只是优化不是权威——复用前必须对当前正文重新过一遍完整校验；校验器升级后旧缓存
 * 自动失效（验证抛错即回退重新取证），逐章正文指纹不同也直接回退。失败版本保持 failed
 * 原状，复用的 payload 会重新存进新版本并在提交事务里再全量校验一次，闭环不污染。
 */
function readReusableProjection({
  chapter, text, sourceHash, previous, resumeFrom, useCache, allowStaleHashReuse = false,
}) {
  if (!useCache) return null;
  for (const source of [previous, resumeFrom]) {
    if (!source) continue;
    const cached = store.chapterProjections.get(source.id, chapter.id);
    if (!cached) continue;
    if (cached.source_hash !== sourceHash && !allowStaleHashReuse) continue;
    try {
      return validateNarrativeProjection(cached.payload, text, chapter);
    } catch { /* 缓存验证失败：回退到重新取证，不得让旧缓存杀死整批重建 */ }
  }
  return null;
}

/** 建造并原子提交一个完整叙事版本。LLM 取证全部发生在同步事务外。 */
export async function prepareAndCommitNarrativeRevision(bookId, {
  rewrites = new Map(),
  reason = '正文换版后重建派生状态',
  projectionImpl = null,
  planImpl = null,
  projectionCache = null,
  signal,
  onEvent,
  reindex = projectionImpl == null,
  allowDegradedProjection = false,
  allowDegradedPlan = false,
  allowStaleHashReuse = false,
} = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const rewriteMap = normalizedRewriteMap(rewrites);
  const chapters = store.chapters.list(bookId).filter(isCompletedChapter).sort((a, b) => a.idx - b.idx);
  if (!chapters.length) {
    if (rewriteMap.size) throw codedError('REWRITE_CHAPTER_MISSING', '没有可承载返工候选的完成章');
    return commitEmptyNarrativeBaseline(bookId, { reason, onEvent });
  }
  const byId = new Map(chapters.map(chapter => [chapter.id, chapter]));
  for (const [chapterId, text] of rewriteMap) {
    if (!byId.has(chapterId)) throw codedError('REWRITE_CHAPTER_MISSING', `返工章节不存在或尚未完成：${chapterId}`);
    if (!nonEmpty(text)) throw codedError('REWRITE_EMPTY', `第${byId.get(chapterId).idx}章候选正文为空`);
  }
  const changed = chapters.filter(chapter => rewriteMap.has(chapter.id)).map(chapter => chapter.idx);
  const fromChapter = changed.length ? Math.min(...changed) : 1;
  const throughChapter = chapters.at(-1).idx;
  const baseHash = manuscriptSourceHash(bookId);
  const targetHash = manuscriptSourceHash(bookId, { overrides: rewriteMap });
  const previous = store.narrativeRevisions.current(bookId);
  const useProjectionCache = projectionCache ?? !projectionImpl;
  const resumeFrom = useProjectionCache ? store.narrativeRevisions.latestFailedForBase(bookId, baseHash) : null;
  const revision = store.narrativeRevisions.create(bookId, {
    parentId: previous?.id || null, fromChapter, throughChapter, status: 'building',
    sourceHash: targetHash, reason,
    manifest: { changed_chapters: changed, total_chapters: chapters.length, base_source_hash: baseHash },
  });
  const emit = (type, data = {}) => onEvent?.({ type, revisionId: revision.id, ...data });
  const implementation = projectionImpl || extractProjection;
  const planImplementation = planImpl || extractPlanReconciliation;
  let plan = null;

  try {
    emit('narrative_projection_started', { total: chapters.length });
    for (let index = 0; index < chapters.length; index++) {
      if (signal?.aborted) throw codedError('ABORTED', '叙事状态重建已取消');
      const chapter = chapters[index];
      const text = String(rewriteMap.get(chapter.id) ?? store.chapters.fullText(chapter.id)).trim();
      const sourceHash = sha256(text);
      const reused = readReusableProjection({
        chapter, text, sourceHash, previous, resumeFrom, useCache: useProjectionCache,
        allowStaleHashReuse,
      });
      const payload = reused ?? await extractValidatedProjection({
        implementation, bookId, book, chapter, text, signal, revisionId: revision.id, emit,
        allowDegraded: allowDegradedProjection,
      });
      store.chapterProjections.set(revision.id, bookId, chapter.id, { chapterIdx: chapter.idx, sourceHash, payload });
      // V0.100.1：resumed 标志让前端区分"取证"与"断点复用"，同一章只发一条进度行
      emit('narrative_projection_progress', { current: index + 1, total: chapters.length, chapter: chapter.idx, resumed: !!reused });
    }
    const projectionRows = store.chapterProjections.list(revision.id);
    const prospectiveTextById = new Map(chapters.map(chapter => [
      chapter.id,
      String(rewriteMap.get(chapter.id) ?? store.chapters.fullText(chapter.id)).trim(),
    ]));
    emit('narrative_plan_started', { volumes: store.volumes.list(bookId).length });
    plan = await extractValidatedPlanReconciliation({
      implementation: planImplementation, bookId, book, chapters,
      projectionRows, prospectiveTextById, signal, revisionId: revision.id, emit,
      allowDegradedPlan,
    });
    emit('narrative_plan_validated', {
      volumes: plan.volumes.length,
      nextChapters: plan.next_chapters.map(row => row.chapter),
    });
    store.narrativeRevisions.update(revision.id, {
      status: 'ready',
      manifest: {
        ...revision.manifest,
        changed_chapters: changed,
        total_chapters: chapters.length,
        base_source_hash: baseHash,
        plan_reconciliation: plan,
      },
    });
    if (manuscriptSourceHash(bookId) !== baseHash) {
      throw codedError('NARRATIVE_SOURCE_CHANGED', '影子投影构建期间正文发生变化，已拒绝覆盖，请重新开始');
    }

    emit('narrative_commit_started', { total: chapters.length });
    store.transaction(() => {
      store.narrativeRevisions.update(revision.id, { status: 'applying' });
      store.resetNarrativeProjectionState(bookId, { throughChapter });
      for (const chapter of chapters) {
        if (!rewriteMap.has(chapter.id)) continue;
        const applied = applyValidatedChapterRewrite(bookId, chapter, rewriteMap.get(chapter.id), {
          managedRevisionId: revision.id,
        });
        if (!applied.ok) throw codedError(applied.code || 'REWRITE_APPLY_FAILED', applied.message || `第${chapter.idx}章返工落库失败`);
      }

      const projections = store.chapterProjections.list(revision.id);
      if (projections.length !== chapters.length) {
        throw codedError('PROJECTION_INCOMPLETE', `影子投影数量不完整：${projections.length}/${chapters.length}`);
      }
      for (const projection of projections) {
        const chapter = store.chapters.get(projection.chapter_id);
        const text = store.chapters.fullText(chapter.id);
        const payload = validateNarrativeProjection(projection.payload, text, chapter);
        const actual = payload.outline_actual;
        const outline = store.chapters.outline(chapter.id) || {};
        store.chapters.update(chapter.id, {
          outline: {
            ...outline,
            goal: actual.goal, conflict: actual.conflict,
            dramatic_question: actual.dramatic_question, counterforce: actual.counterforce,
            turn: actual.turn, irreversible_change: actual.irreversible_change,
            choice_cost: actual.choice_cost, reader_gain: actual.reader_gain, reader_pull: actual.reader_pull,
            actual_outcome: actual,
            _narrative_revision: { id: revision.id, state: 'aligned', source_hash: sha256(text) },
          },
        });
        store.chapterProjections.set(revision.id, bookId, chapter.id, {
          chapterIdx: chapter.idx, sourceHash: sha256(text), payload,
        });
        materializeProjection(bookId, store.chapters.get(chapter.id), text, payload, revision.id);
      }

      applyNarrativePlanReconciliation(bookId, revision.id, plan, projections);
      const settings = store.books.settings(bookId);
      settings.narrativeRevision = {
        ...(settings.narrativeRevision || {}),
        changedChapters: changed,
      };
      store.books.update(bookId, { settings });
      compactHistoryFromCurrentChapters(bookId);
      const finalHash = manuscriptSourceHash(bookId);
      store.narrativeRevisions.complete(revision.id, {
        sourceHash: finalHash,
        manifest: {
          changed_chapters: changed, chapters: chapters.map(chapter => chapter.idx), projections: projections.length,
          aligned: [
            'prose', 'summaries', 'facts', 'characters', 'timeline', 'foreshadows', 'memory',
            'chapter_outlines', 'book_outline', 'volume_outlines', 'future_chapter_seeds',
            'settings', 'history', 'patterns',
          ],
          plan_reconciliation: plan,
          future_outlines: 'reconciled_stale', vectors: reindex ? 'pending' : 'skipped',
        },
      });
    });
  } catch (error) {
    store.narrativeRevisions.fail(revision.id, `${error.code || 'ERROR'}: ${error.message}`);
    emit('narrative_revision_failed', { code: error.code || 'ERROR', error: error.message });
    throw error;
  }

  const vectorFailures = [];
  if (reindex) {
    try {
      const { indexChapter } = await import('../memory/indexer.js');
      for (const chapter of chapters) {
        try { await indexChapter(bookId, chapter.id); } catch (error) { vectorFailures.push({ chapter: chapter.idx, error: error.message }); }
      }
    } catch (error) {
      vectorFailures.push({ chapter: null, error: error.message });
    }
  }
  const completed = store.narrativeRevisions.get(revision.id);
  store.narrativeRevisions.update(revision.id, {
    manifest: {
      ...completed.manifest,
      vectors: vectorFailures.length ? 'degraded' : (reindex ? 'rebuilt' : 'skipped'),
      vector_failures: vectorFailures,
    },
  });
  emit('narrative_revision_committed', { total: chapters.length, changed, vectorFailures });
  return {
    status: 'valid', revisionId: revision.id,
    sourceHash: store.narrativeRevisions.get(revision.id).source_hash,
    chapters: chapters.length, changedChapters: changed, vectorFailures, plan,
  };
}
