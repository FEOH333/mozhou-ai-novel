// server/engine/quality/polish.js —— 全书打磨（借鉴 show-me-the-story 工单化 polish）
// 流程：诊断(P0/P1/P2) → 五维一致性核查 → 工单合并（同章合并）→ 逐章最小化修订 → 历史堆重建
'use strict';
import { createHash } from 'node:crypto';
import * as store from '../../db/store.js';
import { assembleMessages } from '../../llm/cache.js';
import { runTask } from '../../llm/router.js';
import { extractJSON } from '../../util/json.js';
import { estimateChineseChars } from '../../llm/tokenizer.js';
import {
  polishDiagnoseInstruction, polishConsistencyInstruction, polishExecuteInstruction, smoothTransitionInstruction,
  midStoryReviewInstruction, // V0.71：创作中期审阅指令（过程打磨）
  CREATIVE_AI_FLAVOR_BRIEF, // V0.109.3：AI 腔简报（打磨同源）
} from '../prompts.js';
import { styleRulesText } from '../../data/creative_packs.js'; // V0.83：打磨注入文风（防修订漂移）
import { buildLifecycleContext, lifecyclePromptText } from '../longform/longform_lifecycle.js'; // V0.92 阶段型前瞻审阅
import { isCompletedChapter, hasExplicitCompletedStatus, transitionChapterStatus } from '../pipeline/chapter_status.js'; // V0.93.2：状态写入单一真源
import { appendPublicationFeedback } from './publication_feedback.js'; // V0.99：终审/修订同源消费推流反馈
import { REDLINES } from '../../data/redlines.js';

const FULL_TEXT_LIMIT = 150000; // 超长书按 15 万字分卷提供

export function shouldRunMidStoryReview({
  written = 0, totalWords = 0, lastReviewWritten = 0, lastReviewWords = 0,
} = {}) {
  const count = Number(written) || 0;
  const words = Number(totalWords) || 0;
  const lastCount = Number(lastReviewWritten) || 0;
  const lastWords = Number(lastReviewWords) || 0;
  if (count < 5) return false;
  const chapterTick = count % 10 === 0 && lastCount !== count;
  const gate = REDLINES.midStoryWordGate || 100000;
  const wordTick = Math.floor(words / gate) > Math.floor(lastWords / gate);
  return chapterTick || wordTick;
}

export function readMidStoryCursor(bookId) {
  try {
    return JSON.parse(store.materials.get(bookId, 'mid_story_review_cursor')?.content || '{}') || {};
  } catch {
    return {};
  }
}

export function writeMidStoryCursor(bookId, { written = 0, words = 0 } = {}) {
  store.materials.set(bookId, 'mid_story_review_cursor', JSON.stringify({
    written: Number(written) || 0,
    words: Number(words) || 0,
  }));
}

const TRUNCATED_FINISH_REASONS = new Set([
  'length', 'max_tokens', 'max_output_tokens', 'incomplete', 'content_filter',
]);

// V0.100.16：分段防线阈值——与 doctor DEFAULTS.paragraphBreakLostMinChars 同一把尺。
// 正常中文正文单场景 300 字以上必然多段（两书实测最密场景 521 字 12 段）；
// 零换行超长场景是落盘链路剥离换行的形态损坏指纹。
const PARAGRAPH_FLATTEN_MIN_CHARS = 300;
// 确定性重分段的目标段长：本书正文实测段长集中在 50-160 字，取中位偏上，
// 对话句独立成段后叙述句按累计长度组段。
const PARAGRAPH_TARGET_CHARS = 120;
const PARAGRAPH_OPENING_QUOTES = new Set(['“', '‘', '「', '『', '《']);
const PARAGRAPH_CLOSING_QUOTES = new Set(['”', '’', '」', '』', '》']);

/**
 * V0.100.16：把零换行的超长文本按中文正文习惯确定性重分段。
 * 事故指纹：绕过引擎的落盘把整章候选剥掉换行后写入，每场景成 800-1350 字一坨。
 * 已有换行或未超阈值的文本原样返回（不动好稿）；重分段只插入换行，
 * 不增删任何字符；对话句（引号起止）独立成段。
 */
export function normalizeChapterParagraphs(text) {
  const source = String(text || '').trim();
  if (!source) return source;
  if (/[\r\n]/.test(source)) return source;
  if (source.length <= PARAGRAPH_FLATTEN_MIN_CHARS) return source;

  // 按句末标点切句，闭引号跟随句尾，防止 “……。” 的 ” 被切进下一句。
  const sentences = source.match(/[^。！？!?；;…]*[。！？!?；;…]+[”’」』》]*|[^。！？!?；;…]+$/g) || [source];
  const paragraphs = [];
  let buffer = [];
  let insideDialogue = false;
  const flushNarrative = () => {
    if (buffer.length) {
      paragraphs.push(buffer.join(''));
      buffer = [];
    }
  };
  for (const sentence of sentences) {
    const head = sentence[0];
    const tail = sentence[sentence.length - 1];
    if (insideDialogue) {
      buffer.push(sentence);
      if (PARAGRAPH_CLOSING_QUOTES.has(tail)) {
        paragraphs.push(buffer.join(''));
        buffer = [];
        insideDialogue = false;
      }
      continue;
    }
    if (PARAGRAPH_OPENING_QUOTES.has(head)) {
      flushNarrative();
      buffer.push(sentence);
      if (PARAGRAPH_CLOSING_QUOTES.has(tail)) {
        paragraphs.push(buffer.join(''));
        buffer = [];
      } else {
        insideDialogue = true;
      }
      continue;
    }
    buffer.push(sentence);
    if (buffer.join('').length >= PARAGRAPH_TARGET_CHARS) flushNarrative();
  }
  if (buffer.length) paragraphs.push(buffer.join(''));
  const normalized = paragraphs.filter(Boolean).join('\n\n');
  // 保真校验：重分段只能加换行；万一切句器异常则原样返回，绝不改动正文内容。
  return normalized.replace(/[\r\n]+/g, '') === source ? normalized : source;
}

/** 句末合法收尾：句末标点、闭引号（对话“走了”省略句号是网文常态，防误裁）、破折号悬置。 */
const SENTENCE_TERMINALS = new Set(['。', '！', '？', '!', '?', '…', '；', ';']);
const CLOSING_QUOTE_CHARS = new Set(['”', '’', '」', '』', '》']);

/**
 * V0.105.5：末句完整性收口——把被输出预算掐断的半句裁到最后一个完整句边界。
 * 事故指纹：超长场景在字数达标区间（minWords ≤ words ≤ maxWords）被 maxTokens 掐断，
 * 长度自愈只看字数不看末句 →「…回荡在合州」式半句话直接落库（实测 ch45-50 实证，
 * doctor.proseStructure 报 boundaryFragments）。
 * 只裁尾部残余、不动其余字符；防误裁优先：闭引号/破折号结尾视为完整；整段找不到
 * 句末标点时原样返回（异常文本交给审校，不把正文删光）。
 */
export function closeTrailingSentence(text) {
  const source = String(text || '').trimEnd();
  if (!source) return String(text || '');
  const last = source[source.length - 1];
  if (SENTENCE_TERMINALS.has(last)) return source;
  if (CLOSING_QUOTE_CHARS.has(last)) return source; // 对话闭引号收尾（句号可省略）
  if (source.endsWith('——')) return source; // 破折号悬置是合法文学收尾
  // 裁到最后一个完整句边界（句末标点 + 跟随的闭引号）
  const m = source.match(/[\s\S]*[。！？!?…；;][”’」』》]*/);
  if (!m || !m[0].trim()) return source; // 全文无句末标点：异常，不裁
  const closed = m[0].trimEnd();
  return closed === source ? source : closed;
}

/**
 * V0.100.16：从含换行的候选存档逐字找回被剥离换行的场景正文。
 * 维护脚本主修复路径：模板（返工候选原文，\n\n 分段完好）是唯一真源，
 * 每个无换行场景文本在模板剥换行版上顺序定位连续区间，再映射回原始
 * 模板区间找回分段。任一场景定位失败立即整体返回 null（失败关闭，
 * 绝不按句重切猜分段）；恢复结果与原文剥换行后逐字一致才放行。
 */
export function restoreSceneParagraphBreaks(template, sceneTexts) {
  const tpl = String(template || '').trim();
  const slots = Array.isArray(sceneTexts) ? sceneTexts : [];
  if (!tpl || !slots.length) return null;
  const strip = (value) => String(value || '').replace(/[\r\n]+/g, '');
  const tplStripped = strip(tpl);
  if (!tplStripped) return null;
  // rev[k] = 剥换行版第 k 个字符在模板中的偏移。
  const rev = [];
  for (let i = 0; i < tpl.length; i++) {
    if (!/[\r\n]/.test(tpl[i])) rev.push(i);
  }
  if (rev.length !== tplStripped.length) return null;

  let cursor = 0;
  const restored = [];
  for (const rawScene of slots) {
    const flat = strip(rawScene).trim();
    if (!flat) return null;
    const pos = tplStripped.indexOf(flat, cursor);
    if (pos < 0 || pos + flat.length > tplStripped.length) return null;
    const tplStart = rev[pos];
    const tplEnd = rev[pos + flat.length - 1] + 1;
    const piece = tpl.slice(tplStart, tplEnd).replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
    if (!piece) return null;
    restored.push(piece);
    cursor = pos + flat.length;
  }
  if (restored.map(strip).join('') !== slots.map(strip).join('')) return null;
  return restored;
}

/**
 * 终审正文按完整章节分块。旧实现直接 fullText.slice(0, 150000)，导致长书后半部
 * 永远不会进入诊断或一致性核查；这里宁可多跑几轮，也不从章节中间截断。
 */
export function chunkPolishChapters(chapters, {
  limit = FULL_TEXT_LIMIT,
  getText = chapter => store.chapters.fullText(chapter.id),
} = {}) {
  const safeLimit = Math.max(1, Number(limit) || FULL_TEXT_LIMIT);
  const chunks = [];
  let current = [];
  let blocks = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push({ chapters: current, fullText: blocks.join('\n\n') });
    current = [];
    blocks = [];
    length = 0;
  };
  for (const chapter of chapters || []) {
    const block = `【第${chapter.idx}章 ${chapter.title || ''}】\n${String(getText(chapter) || '')}`;
    const separator = current.length ? 2 : 0;
    if (current.length && length + separator + block.length > safeLimit) flush();
    current.push(chapter);
    blocks.push(block);
    length += (current.length > 1 ? 2 : 0) + block.length;
    // 单章可能本身超过限制；仍完整交给一次终审，绝不静默砍掉章尾。
    if (block.length >= safeLimit) flush();
  }
  flush();
  return chunks;
}

function parsePolishGate(response, field, code, label) {
  const finishReason = String(response?.finishReason || '').toLowerCase();
  const parsed = extractJSON(response?.content);
  if (TRUNCATED_FINISH_REASONS.has(finishReason)
    || !parsed || typeof parsed !== 'object' || !Array.isArray(parsed[field])) {
    const error = new Error(`${label}返回截断或结构无效，已停止打磨`);
    error.code = code;
    throw error;
  }
  return parsed;
}

function compactText(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, '');
}

function textShingles(text, size = 10) {
  const compact = compactText(text).replace(/[，。！？；：、“”‘’（）《》【】\[\]{}…—,.!?;:'"()<>]/g, '');
  if (!compact) return new Set();
  if (compact.length <= size) return new Set([compact]);
  const out = new Set();
  // 每个起点都取样，避免一次插入/删除改变奇偶位置后把本应相同的全文误判成零交集。
  for (let i = 0; i <= compact.length - size; i++) out.add(compact.slice(i, i + size));
  return out;
}

function overlapRatio(left, right, denominator = 'left') {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  const divisor = denominator === 'min' ? Math.min(left.size, right.size) : left.size;
  return divisor ? overlap / divisor : 0;
}

function repetitionRatio(text) {
  const raw = String(text || '');
  const blocks = raw
    .split(/(?:\r?\n){1,}/)
    .map(compactText)
    .filter((block) => block.length >= 12);
  let blockRatio = 0;
  if (blocks.length >= 3) {
    const counts = new Map();
    for (const block of blocks) counts.set(block, (counts.get(block) || 0) + 1);
    const totalChars = blocks.reduce((sum, block) => sum + block.length, 0) || 1;
    let duplicateChars = 0;
    for (const [block, count] of counts) {
      if (count > 1) duplicateChars += block.length * (count - 1);
    }
    blockRatio = duplicateChars / totalChars;
  }

  // 有些模型会把同一句连续粘贴几十次且不分段；用较长滑窗识别周期性复读。
  const compact = compactText(raw);
  let windowRatio = 0;
  if (compact.length >= 320) {
    const windows = [];
    for (let i = 0; i <= compact.length - 48; i += 4) windows.push(compact.slice(i, i + 48));
    const unique = new Set(windows).size;
    windowRatio = windows.length ? (windows.length - unique) / windows.length : 0;
  }
  return Math.max(blockRatio, windowRatio);
}

function rejected(code, message, metrics, extra = {}) {
  return { ok: false, unchanged: false, code, message, metrics, ...extra };
}

/**
 * 校验整章重写是否足够安全，可以覆盖原正文。
 *
 * 这是卷审与全书打磨共用的最后一道写入闸门：模型即使正常返回 HTTP 200，
 * 只要正文疑似截断、缩水、复读或串章，也只返回诊断，绝不交给写库函数。
 */
export function validateChapterRewrite({
  before,
  after,
  finishReason = '',
  targetChars = 0,
  chapterIdx = 0,
  peerChapters = [],
} = {}) {
  const source = String(before || '');
  const candidate = String(after || '').trim();
  const beforeChars = compactText(source).length;
  const afterChars = compactText(candidate).length;
  const target = Math.max(0, Number(targetChars) || 0);
  const metrics = {
    beforeChars,
    afterChars,
    targetChars: target,
    lengthRatio: beforeChars ? Number((afterChars / beforeChars).toFixed(3)) : null,
  };

  if (!candidate || afterChars === 0) {
    return rejected('REWRITE_EMPTY', '模型没有返回可用的完整章节正文', metrics);
  }

  const normalizedFinishReason = String(finishReason || '').toLowerCase();
  if (TRUNCATED_FINISH_REASONS.has(normalizedFinishReason)) {
    return rejected('REWRITE_TRUNCATED', `模型输出未完整结束（finishReason=${finishReason}）`, metrics, { finishReason });
  }

  // 原样返回不会产生覆盖动作；旧稿本身即使有重复/短小，也不能归咎为本轮新损伤。
  if (candidate === source.trim()) {
    return {
      ok: true, unchanged: true, code: 'REWRITE_UNCHANGED',
      message: '模型原样返回正文，无需覆盖', metrics,
    };
  }

  // 模型偶尔会把另一章的标题连同正文一起返回；这种错章信号优先于其他统计判断。
  const heading = candidate.match(/(?:^|\n)\s*(?:#{1,6}\s*)?第\s*(\d+)\s*章(?:\s|[：:、《])/);
  if (heading && chapterIdx && Number(heading[1]) !== Number(chapterIdx)) {
    return rejected(
      'REWRITE_WRONG_CHAPTER',
      `模型返回了第${heading[1]}章，当前工单目标是第${chapterIdx}章`,
      { ...metrics, declaredChapter: Number(heading[1]) },
      { matchedChapter: Number(heading[1]) },
    );
  }

  const beforeRepeatRatio = repetitionRatio(source);
  const repeatRatio = repetitionRatio(candidate);
  metrics.beforeRepetitionRatio = Number(beforeRepeatRatio.toFixed(3));
  metrics.repetitionRatio = Number(repeatRatio.toFixed(3));
  // 局部修订不能因为“未触碰的旧段落本来就复读”而永远无法落地；门禁负责阻止
  // 本轮制造或加重损伤。旧稿已经越线时，只要候选没有继续恶化，允许逐场景治理。
  if (afterChars >= 240 && repeatRatio >= 0.45
    && (beforeRepeatRatio < 0.45 || repeatRatio > beforeRepeatRatio + 0.03)) {
    return rejected('REWRITE_REPETITIVE', '模型输出包含异常高比例的重复段落', metrics);
  }

  // 很短的旧测试/微型章节不套用成书阈值；成书章节从 300 字起同时看旧文和场景目标。
  const relativeFloor = beforeChars >= 300
    ? Math.ceil(beforeChars * 0.68)
    : 0;
  const targetFloor = beforeChars >= 300 && target >= 500 ? Math.ceil(target * 0.5) : 0;
  const minimumChars = Math.max(relativeFloor, targetFloor);
  metrics.minimumChars = minimumChars;
  if (minimumChars && afterChars < minimumChars) {
    return rejected(
      'REWRITE_TOO_SHORT',
      `修订正文仅 ${afterChars} 字，低于安全下限 ${minimumChars} 字（原文 ${beforeChars} 字，目标 ${target || '未设置'} 字）`,
      metrics,
    );
  }

  // 长度尚未跌破硬下限，但以逗号、冒号、开括号等结束且明显缩水，也按半截输出处理。
  const suspiciousEnd = /[，,:：;；、—\-（(\[【“‘]$/.test(candidate);
  const materiallyShorter = beforeChars >= 300 && afterChars < beforeChars * 0.92;
  const belowTarget = beforeChars >= 200 && target >= 500 && afterChars < target * 0.8;
  if (suspiciousEnd && (materiallyShorter || belowTarget)) {
    return rejected('REWRITE_TRUNCATED', '修订正文结尾疑似被截断，未形成完整句段', metrics, { finishReason });
  }

  const candidateShingles = textShingles(candidate);
  let closestPeer = null;
  for (const peer of Array.isArray(peerChapters) ? peerChapters : []) {
    if (!peer || Number(peer.idx) === Number(chapterIdx)) continue;
    const peerText = String(peer.text || '');
    if (afterChars < 240 || compactText(peerText).length < 240) continue;
    const similarity = overlapRatio(candidateShingles, textShingles(peerText), 'left');
    if (!closestPeer || similarity > closestPeer.similarity) {
      closestPeer = { idx: peer.idx, similarity };
    }
  }
  if (closestPeer) metrics.closestPeerSimilarity = Number(closestPeer.similarity.toFixed(3));
  if (closestPeer?.similarity >= 0.86) {
    return rejected(
      'REWRITE_WRONG_CHAPTER',
      `修订正文与第${closestPeer.idx}章高度相同，疑似串章`,
      metrics,
      { matchedChapter: closestPeer.idx },
    );
  }

  // “最小化修订”必须保留一部分原章锚点；同长度却几乎零交集，通常是模型答了别章。
  if (beforeChars >= 500 && afterChars >= 500 && afterChars <= beforeChars * 1.5) {
    const anchorCoverage = overlapRatio(textShingles(source), candidateShingles, 'left');
    metrics.originalAnchorCoverage = Number(anchorCoverage.toFixed(3));
    if (anchorCoverage < 0.08) {
      return rejected('REWRITE_WRONG_CHAPTER', '修订正文与原章几乎没有内容锚点，疑似生成了错误章节', metrics);
    }
  }

  return {
    ok: true,
    unchanged: false,
    code: 'REWRITE_ACCEPTED',
    message: '修订正文通过安全校验',
    metrics,
  };
}

function chapterRewriteContext(bookId, chapter) {
  const scenes = store.scenes.list(chapter.id);
  return {
    targetChars: scenes.reduce((sum, scene) => sum + (Number(scene.target_words) || 0), 0),
    peerChapters: store.chapters.list(bookId)
      .filter((item) => item.id !== chapter.id)
      .map((item) => ({ idx: item.idx, text: store.chapters.fullText(item.id) })),
  };
}

function rewriteFailure(chapter, validation, finishReason) {
  return {
    chapter: chapter.idx,
    chapterId: chapter.id,
    code: validation.code,
    message: validation.message,
    finishReason: finishReason || '',
    metrics: validation.metrics,
    ...(validation.matchedChapter ? { matchedChapter: validation.matchedChapter } : {}),
  };
}

function logRewriteRejection(bookId, failure, source) {
  try {
    store.operationLogs.add({
      ts: Date.now(), category: 'flow', level: 'warn', op: 'rewrite_rejected', bookId,
      detail: `${source} 第${failure.chapter}章 ${failure.code}: ${failure.message}`.slice(0, 500),
      result: 'rejected',
    });
  } catch { /* 诊断日志失败不能反过来破坏正文保护 */ }
}

function sha256(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function currentManuscriptHash(bookId) {
  return sha256(store.chapters.list(bookId)
    .filter(isCompletedChapter)
    .map(chapter => `${chapter.idx}:${chapter.id}:${sha256(store.chapters.fullText(chapter.id))}`)
    .join('\n'));
}

/** 非影子事务内的完成章换版只登记陈旧状态，不尝试猜测哪些旧投影还能沿用。 */
function markUnmanagedRewriteStale(bookId, chapterIdx, chapterHash) {
  const completed = store.chapters.list(bookId).filter(isCompletedChapter);
  const through = completed.reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), chapterIdx);
  const blocking = store.narrativeRevisions.blocking(bookId);
  const changed = [...new Set([...(blocking?.manifest?.changed_chapters || []), chapterIdx])].sort((a, b) => a - b);
  const sourceHash = currentManuscriptHash(bookId);
  if (blocking?.status === 'stale' && Number(blocking.from_chapter) <= chapterIdx) {
    return store.narrativeRevisions.update(blocking.id, {
      sourceHash,
      reason: '完成章正文发生编辑换版，等待全书派生状态回放',
      manifest: {
        ...blocking.manifest,
        changed_chapters: changed,
        chapter_hashes: { ...(blocking.manifest?.chapter_hashes || {}), [chapterIdx]: chapterHash },
      },
    });
  }
  return store.narrativeRevisions.create(bookId, {
    parentId: store.narrativeRevisions.current(bookId)?.id || null,
    fromChapter: Math.min(chapterIdx, Number(blocking?.from_chapter) || chapterIdx),
    throughChapter: through,
    status: 'stale', sourceHash,
    reason: '完成章正文发生编辑换版，等待全书派生状态回放',
    manifest: {
      changed_chapters: changed,
      chapter_hashes: { ...(blocking?.manifest?.chapter_hashes || {}), [chapterIdx]: chapterHash },
      requires: ['summaries', 'facts', 'characters', 'timeline', 'foreshadows', 'memory', 'outlines', 'vectors'],
    },
  });
}

/**
 * 将完整章节安全映射回既有场景槽位。只允许在段落或完整句末切分；如果候选短到
 * 无法给每个场景找到安全边界就返回 null，由写入闸门失败关闭，绝不按字符硬切句子。
 */
export function splitChapterTextForScenes(text, scenes = []) {
  const source = String(text || '').trim();
  const slots = Array.isArray(scenes) ? scenes : [];
  if (!source || !slots.length) return null;
  if (slots.length === 1) return [source];

  const boundaries = new Set();
  for (const match of source.matchAll(/[。！？!?；;](?:[”’」』】）])?/g)) {
    const position = match.index + match[0].length;
    if (position > 0 && position < source.length) boundaries.add(position);
  }
  for (const match of source.matchAll(/(?:\r?\n){2,}/g)) {
    if (match.index > 0 && match.index < source.length) boundaries.add(match.index);
  }
  const candidates = [...boundaries].sort((left, right) => left - right);
  if (candidates.length < slots.length - 1) return null;

  const weights = slots.map(slot => Math.max(1,
    String(slot?.content || '').trim().length || Number(slot?.target_words) || 1));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const minSegment = Math.max(4, Math.min(80, Math.floor(source.length / (slots.length * 8))));
  const cuts = [];
  let previous = 0;
  let cumulativeWeight = 0;
  for (let index = 0; index < slots.length - 1; index++) {
    cumulativeWeight += weights[index];
    const target = Math.round(source.length * cumulativeWeight / totalWeight);
    const remainingSegments = slots.length - index - 1;
    const valid = candidates.filter(position => position > previous + minSegment
      && position < source.length - minSegment * remainingSegments
      && !cuts.includes(position));
    if (!valid.length) return null;
    const cut = valid.reduce((best, position) => (
      Math.abs(position - target) < Math.abs(best - target) ? position : best
    ), valid[0]);
    cuts.push(cut);
    previous = cut;
  }
  cuts.sort((left, right) => left - right);
  const pieces = [];
  let cursor = 0;
  for (const cut of [...cuts, source.length]) {
    const piece = source.slice(cursor, cut).trim();
    if (!piece) return null;
    pieces.push(piece);
    cursor = cut;
  }
  return pieces.length === slots.length ? pieces : null;
}

/**
 * 写入已经通过 validateChapterRewrite 的编辑修订。
 *
 * 正文只要换过字，就不能继续“祝福”旧摘要/事实/人物投影。非受管换版会删除本章
 * 结算与摘要并登记 stale 版本，后续自动创作立即暂停；受管换版由影子回放事务统一
 * 重建全书派生状态。旧结算本来就与正文失配时仍失败关闭，绝不覆盖。
 */
export function applyValidatedChapterRewrite(bookId, chapter, newText, { managedRevisionId = null } = {}) {
  const current = store.chapters.get(chapter?.id);
  if (!current || current.book_id !== bookId) {
    return { ok: false, code: 'REWRITE_CHAPTER_MISSING', message: '待修订章节不存在' };
  }
  const before = store.chapters.fullText(current.id);
  // V0.100.16：零换行超长候选在落库前本地愈合重分段——返工候选被上游剥掉换行时
  // 场景会成 800+ 字一坨；splitChapterTextForScenes 只切场景不恢复段内换行。
  // V0.105.5：末句完整性收口同闸——修订/返工候选尾句被掐时确定性裁到完整句边界。
  const after = closeTrailingSentence(normalizeChapterParagraphs(String(newText || '').trim()));
  if (!after) return { ok: false, code: 'REWRITE_EMPTY', message: '修订正文为空' };
  const blockingRevision = store.narrativeRevisions.blocking(bookId);
  if (!managedRevisionId && blockingRevision && blockingRevision.status !== 'stale') {
    return { ok: false, code: 'NARRATIVE_REVISION_BUSY', message: '叙事状态正在构建或提交，暂不能同时改写完成章' };
  }

  const beforeHash = sha256(before);
  const settlement = store.chapterSettlements.get(current.id);
  if (settlement && settlement.content_hash !== beforeHash) {
    return {
      ok: false,
      code: 'REWRITE_SETTLEMENT_STALE',
      message: '当前正文与旧结算指纹已不一致，已拒绝覆盖；需先做派生状态专项修复',
    };
  }

  const scenes = store.scenes.list(current.id);
  if (!scenes.length) {
    return { ok: false, code: 'REWRITE_SCENES_MISSING', message: '章节没有可安全映射的场景' };
  }
  const sceneTexts = splitChapterTextForScenes(after, scenes);
  if (!sceneTexts) {
    return {
      ok: false,
      code: 'REWRITE_SCENE_BOUNDARY_UNSAFE',
      message: `候选正文无法在完整句边界安全映射到 ${scenes.length} 个场景，已拒绝按字符硬切`,
    };
  }

  const normalizedStatus = hasExplicitCompletedStatus(current)
    ? current.status
    : (settlement ? 'settled' : 'done');
  store.transaction(() => {
    scenes.forEach((scene, index) => {
      store.scenes.update(scene.id, { content: sceneTexts[index], status: 'revised' });
    });
    store.chapters.update(current.id, {
      wordCount: estimateChineseChars(after),
    });
    transitionChapterStatus(bookId, current.id, normalizedStatus, { reason: '编辑修订落库' });

    // fullText 会按场景插入空行；指纹必须以实际落库全文为准，不能用模型原始字符串。
    const storedText = store.chapters.fullText(current.id);
    const storedHash = sha256(storedText);
    // 受管换版刚刚清过派生表，稍后在同一外层事务逐章回放；非受管换版必须
    // 让旧结算/摘要失效，不能只把 hash 改成新稿而保留旧 result。
    store.chapterSettlements.remove(current.id);
    store.summaries.remove(current.id);
    store.conflicts.resolveRecoveredChapter(current.id, after);
    // 健康快照的证据来自旧正文；精修后保留 verdict/issues 会制造陈旧失败信号。
    store.chapterHealth.removeByChapter(current.id);
    const publishedBoundary = store.publicationProfiles.get(bookId)?.published_chapter_count || 0;
    if (current.idx <= publishedBoundary) store.publicationProfiles.markPendingSync(bookId, [current.idx]);

    if (!managedRevisionId) markUnmanagedRewriteStale(bookId, current.idx, storedHash);
  });
  return {
    ok: true,
    beforeHash,
    afterHash: sha256(store.chapters.fullText(current.id)),
    status: normalizedStatus,
    requiresStateRebuild: !managedRevisionId,
  };
}

/**
 * 全书打磨
 * @param {string} bookId
 * @param {object} [opts] { onEvent, signal, skipDiagnose }
 * @returns {Promise<{workorders:number, executed:number, skipped:number, failed:number, failures:Array, diffs:Array}>}
 */
export async function runPolish(bookId, opts = {}) {
  const { onEvent, signal } = opts;
  const emit = (type, data) => onEvent?.({ type, ...data });
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  // V0.73：打磨排除已归档章节——归档章正文已压缩进归档记忆（scenes 表仅是冻结快照），
  // 修订它们会与历史堆分歧（rebuildHistoryFromChapters 跳过归档章），属无效功。
  const lastArchive = store.archives.last(bookId);
  const archivedUpTo = lastArchive ? lastArchive.range_end : 0;
  const publishedBoundary = store.publicationProfiles.get(bookId)?.published_chapter_count || 0;
  const includePublished = opts.includePublished === true;
  const chapters = store.chapters.list(bookId)
    .filter(c => isCompletedChapter(c) && c.idx > archivedUpTo)
    .filter(c => includePublished || c.idx > publishedBoundary);
  if (!chapters.length) {
    if (!includePublished && publishedBoundary > 0) {
      throw new Error(`可打磨章节均已发布（公开边界第${publishedBoundary}章）；请使用推荐失败专用前20章返工闭环并明确确认`);
    }
    throw new Error('还没有可打磨的章节（已归档章节不参与打磨），先写几章再打磨');
  }

  // V0.22：打磨前自动快照（storyforge 版本快照思路）——打磨不满意可一键回滚
  const snapshot = store.snapshots.add(bookId, {
    label: `打磨前自动快照（${chapters.length} 章）`,
    source: 'auto',
    data: store.snapshotBook(bookId),
  });
  emit('snapshot_created', { snapshotId: snapshot.id, label: snapshot.label, message: '已自动创建打磨前快照（可回滚）' });

  // ---- 1) 诊断 ----
  emit('stage', { stage: 'polish', message: `全书诊断（${chapters.length} 章）…` });
  const settings = [
    store.materials.get(bookId, 'world')?.content || '',
    store.materials.get(bookId, 'characters')?.content || '',
    store.materials.get(bookId, 'contract')?.content || '',
  ].join('\n').slice(0, 3000);
  const outlineIndex = chapters.map(c => {
    const o = store.chapters.outline(c.id);
    const s = store.summaries.get(c.id)?.summary || '';
    return `第${c.idx}章《${c.title}》：${s || o?.goal || ''}`;
  }).join('\n');
  const chunks = chunkPolishChapters(chapters);
  const priorities = [];
  const checks = [];
  const overall = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) break;
    const chunk = chunks[i];
    const first = chunk.chapters[0]?.idx;
    const last = chunk.chapters.at(-1)?.idx;
    const allowedChapters = new Set(chunk.chapters.map(chapter => Number(chapter.idx)));
    emit('stage', {
      stage: 'polish',
      message: `全书诊断 ${i + 1}/${chunks.length}（第${first}-${last}章）…`,
    });
    const diagnoseRes = await runTask({
      task: 'audit', bookId, messages: assembleMessages(bookId, [{
        role: 'user',
        content: appendPublicationFeedback(polishDiagnoseInstruction({
          bookTitle: book.title, settings, outlines: outlineIndex, summaries: '', fullText: chunk.fullText,
        }), bookId),
      }]), jsonMode: true, signal,
    });
    const diagnose = parsePolishGate(diagnoseRes, 'priorities', 'POLISH_DIAG_INVALID', '全书诊断');
    if (diagnose.overall) overall.push(String(diagnose.overall));
    priorities.push(...diagnose.priorities.filter(item => allowedChapters.has(Number(item?.chapter))));

    emit('stage', {
      stage: 'polish',
      message: `一致性核查 ${i + 1}/${chunks.length}（第${first}-${last}章）…`,
    });
    const consistRes = await runTask({
      task: 'audit', bookId, messages: assembleMessages(bookId, [{
        role: 'user',
        content: appendPublicationFeedback(polishConsistencyInstruction({
          bookTitle: book.title, outlines: outlineIndex, summaries: '', fullText: chunk.fullText,
        }), bookId),
      }]), jsonMode: true, signal,
    });
    const consist = parsePolishGate(consistRes, 'checks', 'POLISH_CONSISTENCY_INVALID', '一致性核查');
    checks.push(...consist.checks.filter(item => allowedChapters.has(Number(item?.chapter))));
    emit('polish_chunk_done', { current: i + 1, total: chunks.length, from: first, to: last });
  }
  emit('diagnose_done', { overall: overall.join('\n'), priorities: priorities.length, chunks: chunks.length });
  emit('consistency_done', { checks: checks.length, chunks: chunks.length });

  // ---- 3) 工单合并（同章问题合并为一条，优先级排序） ----
  const byChapter = new Map();
  for (const p of priorities) {
    const chNum = p.chapter;
    if (!byChapter.has(chNum)) byChapter.set(chNum, []);
    byChapter.get(chNum).push({ priority: p.priority || 'P2', type: p.type || 'polish', feedback: p.feedback || p.issue || '' });
  }
  for (const c of checks) {
    const chNum = c.chapter;
    if (!byChapter.has(chNum)) byChapter.set(chNum, []);
    byChapter.get(chNum).push({ priority: c.severity === 'high' ? 'P0' : (c.severity === 'medium' ? 'P1' : 'P2'), type: 'logic', feedback: `【一致性】${c.dimension}：${c.issue}。最小改法：${c.fix || ''}` });
  }
  const order = { P0: 0, P1: 1, P2: 2 };
  const workorders = [...byChapter.entries()]
    .map(([chNum, items]) => ({
      chapterNum: chNum,
      items: items.sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3)),
      feedback: items.map(i => `[${i.priority}][${i.type}] ${i.feedback}`).join('\n'),
    }))
    .sort((a, b) => a.chapterNum - b.chapterNum);
  emit('workorders', { total: workorders.length });

  // ---- 4) 逐章执行（最小化修订） ----
  const diffs = [];
  const failures = [];
  const pendingRewrites = new Map();
  const pendingChapters = new Map();
  let executed = 0, skipped = 0, failed = 0;
  for (const wo of workorders) {
    if (signal?.aborted) break;
    const ch = chapters.find(c => c.idx === wo.chapterNum);
    if (!ch) continue;
    emit('stage', { stage: 'polish', message: `打磨第${ch.idx}章…` });
    const chapterText = store.chapters.fullText(ch.id);
    const prevCh = chapters.find(c => c.idx === ch.idx - 1);
    const prevChapterTail = prevCh ? store.chapters.fullText(prevCh.id).slice(-300) : '';
    const before = chapterText;
    const res = await runTask({
      task: 'revise', bookId, chapterId: ch.id, messages: assembleMessages(bookId, [{
        role: 'user',
        content: appendPublicationFeedback(polishExecuteInstruction({
          bookTitle: book.title, chapterIdx: ch.idx, chapterTitle: ch.title, chapterText, feedback: wo.feedback, prevChapterTail,
          // V0.83：打磨注入文风（防修订漂移回默认）
          styleRules: styleRulesText(store.books.settings(bookId).styleProfile, store.books.settings(bookId).styleSample, {
            isHistory: book.genre === '历史', compact: true,
          }),
          // V0.109.3：打磨同样注入 AI 腔简报（与写作/审校同一把尺，写审同源）
          aiFlavorBrief: CREATIVE_AI_FLAVOR_BRIEF,
        }), bookId, { targetChapterIdx: ch.idx }),
      }]), signal,
    });
    const after = String(res.content || '').trim();
    const safety = validateChapterRewrite({
      before,
      after,
      finishReason: res.finishReason,
      chapterIdx: ch.idx,
      ...chapterRewriteContext(bookId, ch),
    });
    if (!safety.ok) {
      const failure = rewriteFailure(ch, safety, res.finishReason);
      failures.push(failure);
      failed++;
      skipped++;
      logRewriteRejection(bookId, failure, '全书打磨');
      emit('chapter_rewrite_rejected', {
        chapterId: ch.id, idx: ch.idx, source: 'polish',
        code: failure.code, error: failure.message, metrics: failure.metrics,
        ...(failure.matchedChapter ? { matchedChapter: failure.matchedChapter } : {}),
      });
      continue;
    }
    if (safety.unchanged) { skipped++; continue; }
    // 候选先留在内存，不逐章覆盖。全部候选生成完后由叙事版本引擎统一取证、
    // 校准书纲/卷纲/未来章并原子切换；任一投影失败时所有旧正文原样保留。
    pendingRewrites.set(ch.id, after);
    pendingChapters.set(ch.id, ch);
    diffs.push({
      chapter: ch.idx,
      before: before.slice(0, 500),
      after: after.slice(0, 500),
      feedback: wo.feedback.slice(0, 200),
    });
  }

  // ---- 5) 全批影子取证 + 原子换版 ----
  if (pendingRewrites.size > 0) {
    emit('stage', {
      stage: 'polish',
      message: `正在影子环境核验 ${pendingRewrites.size} 章，并同步摘要、人物、伏笔与各层大纲…`,
    });
    try {
      const { prepareAndCommitNarrativeRevision } = await import('../narrative/narrative_state.js');
      const revision = await prepareAndCommitNarrativeRevision(bookId, {
        rewrites: pendingRewrites,
        reason: `全书打磨原子换版（${pendingRewrites.size}章）`,
        signal,
        onEvent: event => emit(event.type, event),
      });
      executed = pendingRewrites.size;
      for (const [chapterId, ch] of pendingChapters) {
        emit('chapter_polished', {
          chapterId, idx: ch.idx, changed: true, revisionId: revision.revisionId,
        });
      }
    } catch (error) {
      for (const [chapterId, ch] of pendingChapters) {
        const failure = {
          chapter: ch.idx,
          chapterId,
          code: error.code || 'NARRATIVE_REVISION_FAILED',
          message: `打磨候选未通过同版取证，整批未落盘：${error.message}`,
        };
        failures.push(failure);
        logRewriteRejection(bookId, failure, '全书打磨原子换版');
        emit('chapter_rewrite_rejected', {
          chapterId, idx: ch.idx, source: 'polish',
          code: failure.code, error: failure.message,
        });
      }
      failed += pendingRewrites.size;
      skipped += pendingRewrites.size;
    }
  }

  emit('done', { executed, skipped, failed, failures, diffs: diffs.length });
  return { workorders: workorders.length, executed, skipped, failed, failures, diffs };
}

/**
 * 从已定稿章节重建历史堆正文部分（polish 后调用；前缀 system+公共材料保持不变）。
 * 注意：这是整书级缓存重建操作，调用前应提示用户。
 */
export function rebuildHistoryFromChapters(bookId) {
  try { store.operationLogs.add({ ts: Date.now(), category: 'cache', level: 'info', op: 'rebuild', detail: '打磨/卷审修订后整书重建', bookId }); } catch { /* ignore */ }
  const chapters = store.chapters.list(bookId);
  // V0.20 修复：跳过已归档章节（用归档记忆代替，避免撤销归档成果、历史堆瞬间膨胀再次触发归档）
  const lastArchive = store.archives.last(bookId);
  const archivedUpTo = lastArchive ? lastArchive.range_end : 0;
  for (const ch of chapters) {
    if (ch.idx <= archivedUpTo) continue;
    const scenes = store.scenes.list(ch.id);
    for (const sc of scenes) {
      if (!sc.content) continue;
      // V0.72 缓存优化：有 history_seq 的场景 → replace 原位更新（前缀从该场景起最小化断裂，
      // 该场景之前的历史全部保持命中）；无 seq（新增场景/补写）→ append。不再 truncateFrom(3) 整书重灌
      if (sc.history_seq && store.history.replace(bookId, sc.history_seq, 'assistant', sc.content) > 0) {
        // replace 成功，seq 不变
      } else {
        const newSeq = store.history.append(bookId, 'assistant', sc.content);
        store.scenes.update(sc.id, { historySeq: newSeq });
      }
    }
  }
  return store.history.count(bookId);
}

/**
 * 场景级门禁写入（V0.93.2）：手工/平滑修订只改一个场景时使用。
 * 与 applyValidatedChapterRewrite 同源同闸：先按"整章候选"过 validateChapterRewrite
 * （空文/截断/复读/错章/锚点全查），再在同一事务内原子落库——
 * 场景正文 + 历史上下文 + 章节字数 + 状态机流转 + 结算指纹重算 + 陈旧健康核销。
 * 只改目标场景，不按比例重切其他场景（保持手工编辑意图）。
 */
export function applyValidatedSceneRewrite(bookId, sceneId, newContent, {
  preserveExistingLength = false,
  managedRevisionId = null,
} = {}) {
  const scene = store.scenes.get(sceneId);
  if (!scene) return { ok: false, code: 'REWRITE_SCENE_MISSING', message: '场景不存在' };
  const current = store.chapters.get(scene.chapter_id);
  if (!current || current.book_id !== bookId) {
    return { ok: false, code: 'REWRITE_CHAPTER_MISSING', message: '待修订章节不存在' };
  }
  // V0.100.16：与 applyValidatedChapterRewrite 同源同闸——零换行超长场景
  // 内容在落库前本地愈合重分段，防止手工/返工修订把场景写成整坨。
  // V0.105.5：末句完整性收口同闸（写侧 autoHealSceneLength 之后的落库兜底）。
  const next = closeTrailingSentence(normalizeChapterParagraphs(String(newContent || '').trim()));
  if (!next) return { ok: false, code: 'REWRITE_EMPTY', message: '场景正文为空' };
  const wasCompleted = isCompletedChapter(current);
  const blockingRevision = store.narrativeRevisions.blocking(bookId);
  if (wasCompleted && !managedRevisionId && blockingRevision && blockingRevision.status !== 'stale') {
    return { ok: false, code: 'NARRATIVE_REVISION_BUSY', message: '叙事状态正在构建或提交，暂不能同时改写完成章' };
  }

  const before = store.chapters.fullText(current.id);
  if (next === String(scene.content || '').trim()) {
    return { ok: true, unchanged: true, code: 'REWRITE_UNCHANGED', message: '场景正文未变化' };
  }

  const scenes = store.scenes.list(current.id);
  const candidate = scenes
    .map(s => (s.id === sceneId ? next : String(s.content || '')))
    .filter(Boolean)
    .join('\n\n');

  const { targetChars, peerChapters } = chapterRewriteContext(bookId, current);
  // V0.97：未完成章（如 drafted 残章）不适用整章目标字数下限——后续场景还没写，
  // 现状必然低于目标，目标下限会把残章的所有最小修订误拦（ch34 精修实证）；
  // 残章只保留 0.68 相对下限防空文/腰斩。完成章照旧守目标下限。
  const validation = validateChapterRewrite({
    before, after: candidate, chapterIdx: current.idx,
    targetChars: preserveExistingLength ? 0 : (isCompletedChapter(current) ? targetChars : 0), peerChapters,
  });
  if (!validation.ok || validation.unchanged) {
    return { ok: false, code: validation.code || 'REWRITE_REJECTED', message: validation.message, metrics: validation.metrics };
  }

  const beforeHash = sha256(before);
  const settlement = store.chapterSettlements.get(current.id);
  if (settlement && settlement.content_hash !== beforeHash) {
    return {
      ok: false,
      code: 'REWRITE_SETTLEMENT_STALE',
      message: '当前正文与旧结算指纹已不一致，已拒绝覆盖；需先做派生状态专项修复',
    };
  }

  const normalizedStatus = wasCompleted
    ? (hasExplicitCompletedStatus(current) ? current.status : (settlement ? 'settled' : 'done'))
    : (current.status === 'writing' ? 'drafted' : (current.status || 'drafted'));
  store.transaction(() => {
    // V0.97.2：正文与历史堆必须在同一事务内原子换版。此前该门禁只改 scenes，
    // history 仍保留旧稿，后续 assembleMessages 会把已经修掉的矛盾重新喂给模型，
    // 形成“精修后复发”。悬空 seq 与无 seq 场景统一回退 append 并回写新序号。
    let historySeq = scene.history_seq;
    if (!(historySeq && store.history.replace(bookId, historySeq, 'assistant', next) > 0)) {
      historySeq = store.history.append(bookId, 'assistant', next);
    }
    store.scenes.update(sceneId, { content: next, status: 'revised', historySeq });
    const storedText = store.chapters.fullText(current.id);
    store.chapters.update(current.id, { wordCount: estimateChineseChars(storedText) });
    // V0.105.7 幂等：目标态等于当前态时跳过迁移（revised→revised 被状态机拒——
    // 断句修复脚本对 revised 章做场景级维护修订时实测炸出，事务全回滚）。
    if ((store.chapters.get(current.id)?.status || '') !== normalizedStatus) {
      transitionChapterStatus(bookId, current.id, normalizedStatus, { reason: '场景级编辑修订' });
    }
    const storedHash = sha256(storedText);
    if (wasCompleted) {
      store.chapterSettlements.remove(current.id);
      store.summaries.remove(current.id);
      if (!managedRevisionId) markUnmanagedRewriteStale(bookId, current.idx, storedHash);
    }
    store.conflicts.resolveRecoveredChapter(current.id, storedText);
    store.chapterHealth.removeByChapter(current.id);
  });
  const publishedBoundary = store.publicationProfiles.get(bookId)?.published_chapter_count || 0;
  if (current.idx <= publishedBoundary) store.publicationProfiles.markPendingSync(bookId, [current.idx]);
  return {
    ok: true,
    sceneId,
    chapterIdx: current.idx,
    beforeHash,
    afterHash: sha256(store.chapters.fullText(current.id)),
    requiresStateRebuild: wasCompleted && !managedRevisionId,
  };
}

/**
 * V0.98 精确开篇片段闸门：哈希确认是同一版场景，字符范围再确认是同一段原文。
 * 任何一项不匹配都在进入正文写事务前失败，不做模糊搜索或“差不多替换”。
 */
export function applyValidatedScenePatch(bookId, patch = {}) {
  const sceneId = patch.sceneId || patch.anchorSceneId || patch.anchor_scene_id;
  const scene = store.scenes.get(sceneId);
  if (!scene) return { ok: false, code: 'REWRITE_SCENE_MISSING', message: '目标场景不存在' };
  const chapter = store.chapters.get(scene.chapter_id);
  if (!chapter || chapter.book_id !== bookId) return { ok: false, code: 'REWRITE_CHAPTER_MISSING', message: '目标场景不属于当前作品' };
  const source = String(scene.content || '');
  const sourceHash = patch.sourceHash || patch.source_hash || '';
  if (sha256(source) !== sourceHash) {
    return { ok: false, code: 'OPENING_PATCH_STALE', message: '源场景已变化，开篇候选失效' };
  }
  const start = Number(patch.start ?? patch.anchorStart ?? patch.anchor_start);
  const end = Number(patch.end ?? patch.anchorEnd ?? patch.anchor_end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) {
    return { ok: false, code: 'OPENING_PATCH_ANCHOR_MISMATCH', message: '目标字符范围无效' };
  }
  const expected = String(patch.expected ?? patch.sourceExcerpt ?? patch.source_excerpt ?? '');
  if (source.slice(start, end) !== expected) {
    return { ok: false, code: 'OPENING_PATCH_ANCHOR_MISMATCH', message: '目标字符范围与原文不一致' };
  }
  const next = source.slice(0, start) + String(patch.replacement ?? patch.content ?? '') + source.slice(end);
  return applyValidatedSceneRewrite(bookId, sceneId, next, { preserveExistingLength: true });
}

/** 章间过渡平滑检查（可选优化：逐章检查开头衔接） */
export async function smoothTransitions(bookId, { onEvent, signal } = {}) {
  const book = store.books.get(bookId);
  const chapters = store.chapters.list(bookId).filter(isCompletedChapter);
  const rewrites = [];
  const pendingRewrites = new Map();
  for (let i = 1; i < chapters.length; i++) {
    const ch = chapters[i];
    const prev = chapters[i - 1];
    const prevTail = store.chapters.fullText(prev.id).slice(-300);
    const nextHead = store.chapters.fullText(ch.id).slice(0, 300);
    const res = await runTask({
      task: 'coverage', bookId, chapterId: ch.id, messages: assembleMessages(bookId, [{
        role: 'user',
        content: smoothTransitionInstruction({ bookTitle: book.title, chapterIdx: ch.idx, prevTail, nextHead }),
      }]), jsonMode: true, signal,
    });
    const parsed = extractJSON(res.content);
    if (parsed && parsed.smooth === false && parsed.rewrite_head) {
      // 候选沿用 applyValidatedSceneRewrite 的同一整章安全口径，但先不写库；
      // 所有过渡候选最终由同版引擎一次性取证并原子提交。
      const scenes = store.scenes.list(ch.id);
      if (scenes.length) {
        const head = String(parsed.rewrite_head).trim();
        const first = scenes[0];
        const nextFirst = head + (first.content ? '\n' + String(first.content).slice(head.length) : '');
        const candidate = scenes.map(scene => scene.id === first.id ? nextFirst : String(scene.content || ''))
          .filter(Boolean).join('\n\n');
        const safety = validateChapterRewrite({
          before: store.chapters.fullText(ch.id),
          after: candidate,
          chapterIdx: ch.idx,
          ...chapterRewriteContext(bookId, ch),
        });
        if (safety.ok && !safety.unchanged) {
          pendingRewrites.set(ch.id, candidate);
        } else if (!safety.ok) {
          logRewriteRejection(bookId, { chapter: ch.idx, chapterId: ch.id, code: safety.code, message: safety.message }, 'smoothTransitions');
          onEvent?.({ type: 'transition_rejected', chapter: ch.idx, code: safety.code, message: safety.message });
        }
      }
    }
    onEvent?.({ type: 'transition_done', chapter: ch.idx, candidate: pendingRewrites.has(ch.id), rewritten: false });
  }
  let revisionId = '';
  if (pendingRewrites.size) {
    try {
      const { prepareAndCommitNarrativeRevision } = await import('../narrative/narrative_state.js');
      const revision = await prepareAndCommitNarrativeRevision(bookId, {
        rewrites: pendingRewrites,
        reason: `章间过渡平滑原子换版（${pendingRewrites.size}章）`,
        signal,
        onEvent,
      });
      revisionId = revision.revisionId;
      for (const chapterId of pendingRewrites.keys()) {
        const chapter = store.chapters.get(chapterId);
        rewrites.push(chapter.idx);
        onEvent?.({ type: 'transition_done', chapter: chapter.idx, rewritten: true, revisionId });
      }
    } catch (error) {
      for (const chapterId of pendingRewrites.keys()) {
        const chapter = store.chapters.get(chapterId);
        logRewriteRejection(bookId, {
          chapter: chapter.idx, chapterId,
          code: error.code || 'NARRATIVE_REVISION_FAILED', message: error.message,
        }, 'smoothTransitions 原子换版');
        onEvent?.({
          type: 'transition_rejected', chapter: chapter.idx,
          code: error.code || 'NARRATIVE_REVISION_FAILED',
          message: `过渡候选整批未落盘：${error.message}`,
        });
      }
    }
  }
  return { rewrites, revisionId };
}


/**
 * V0.71 创作中期过程打磨（与卷体检/漂移检测/完本打磨分工明确）：
 * - 卷体检 = 已写卷的事后检查（修订已写内容）
 * - 漂移检测 = 紧急纠偏（只处理严重偏离）
 * - midStoryReview = 前瞻检查（每 10 完成章或跨 10 万字一次、同一关只跑一次，只输出后续规划调整建议，不改已写章节）
 * - 完本打磨 = 全书终审（全面修订）
 * 输出落 materials(kind='polish_feedback')（动态材料，不进公共前缀——不破坏缓存）；
 * 后续卷大纲/续卷/细纲生成时读取注入。
 */
export async function midStoryReview(bookId, opts = {}) {
  const { onEvent, signal } = opts;
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const chapters = store.chapters.list(bookId).filter(isCompletedChapter);
  if (chapters.length < 5) return { issues: 0, adjustments: 0, note: '章节太少（<5），暂不中期审阅' };

  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const outline = store.materials.get(bookId, 'outline')?.content || '';
  const recent = chapters.slice(-5).map(c => {
    const sm = store.summaries.get(c.id);
    return `第${c.idx}章《${c.title}》：${(sm?.summary || '').slice(0, 100)}`;
  }).join('\n');
  const open = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
  const openText = open.length ? open.map(f => `${(f.desc || '').slice(0, 50)}（种于第${f.planted_chapter || '?'}章）`).join('；') : '（无）';
  const protagonist = store.characters.list(bookId).find(c => c.tier === 'protagonist');
  const arcText = protagonist ? `主角《${protagonist.name}》：${(protagonist.arc || '').slice(0, 120)}` : '（未定）';
  let pleasure = '';
  try {
    const hooks = store.pleasureHooks.list(bookId);
    const paid = hooks.filter(h => h.status === 'paid').length;
    pleasure = `快感钩子 ${hooks.length} 条，已兑现 ${paid} 条`;
  } catch { /* ignore */ }
  const lifecycle = buildLifecycleContext(bookId);
  const payoffDebt = lifecycle.stageBlockers.length
    ? lifecycle.stageBlockers.slice(0, 16).map(item => `[${item.type}] ${item.label}`).join('；')
    : '（当前无硬性兑付债务）';

  const tail = [{
    role: 'user',
    content: midStoryReviewInstruction({
      bookTitle: book.title, contract: contract.replace(/【书契约】/g, '').slice(0, 600),
      outline: outline.slice(0, 600), recent, openText, arcText, pleasure, chapterCount: chapters.length,
      lifecycleText: lifecyclePromptText(lifecycle), payoffDebt,
    }),  }];
  const messages = assembleMessages(bookId, tail);
  const res = await runTask({ task: 'mid_story_review', bookId, messages, jsonMode: true });
  const data = extractJSON(res.content) || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const adjustments = Array.isArray(data.adjustments) ? data.adjustments : [];

  if (adjustments.length) {
    const text = adjustments.map(a => `[${a.type || '调整'}] ${a.target || ''}：${a.action || ''}`).join('\n');
    store.materials.set(bookId, 'polish_feedback', `【中期审阅反馈｜${lifecycle.stage.label}阶段】（第${chapters.length}章时生成，阶段ID=${lifecycle.stage.id}；供后续卷大纲/续卷/细纲参考）\n${text}`);
    // V0.83：中期审阅反馈同时写入全局约束（book_constraints）——持续注入后续所有章写作/细纲，
    // 不再只进下一卷规划（当前卷内"越写越偏"时约束也能即时生效）
    try {
      const issueText = issues.map(i => `[${i.severity || 'P2'}] ${i.issue || ''}`).join('；').slice(0, 400);
      const constraintText = `【创作中期审阅（第${chapters.length}章）】${text.slice(0, 400)}${issueText ? `｜待解决问题：${issueText}` : ''}`;
      store.constraints.add(bookId, {
        content: constraintText.slice(0, 600), source: 'polish', key: 'mid-story-review',
        scopeStart: chapters.length + 1, scopeEnd: chapters.length + 8,
      });
    } catch { /* 约束写入失败不阻断 */ }
  }
  onEvent?.({ type: 'mid_review_done', issues: issues.length, adjustments: adjustments.length, note: `中期审阅：${issues.length} 个问题、${adjustments.length} 条规划调整` });
  writeMidStoryCursor(bookId, {
    written: chapters.length,
    words: chapters.reduce((sum, ch) => sum + (Number(ch.word_count) || 0), 0),
  });
  return { issues: issues.length, adjustments: adjustments.length, note: `中期审阅完成：${issues.length} 个问题、${adjustments.length} 条规划调整（已写入后续规划参考）` };
}
