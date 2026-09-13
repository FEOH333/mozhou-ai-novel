// server/engine/pipeline/audit.js —— 一致性审校（本地规则 + LLM 审校 + 细纲覆盖校验 + 修订）
'use strict';
import * as store from '../../db/store.js';
import { assembleReviewMessages } from '../../llm/cache.js';
import { runTask } from '../../llm/router.js';
import { extractJSON } from '../../util/json.js';
import { auditInstruction, coverageInstruction, reviseInstruction } from '../prompts.js';
import { runLocalRules, runSceneContinuityRules, detectCrossChapterRepeats, detectCrossChapterMetaphors, detectTitleGap, detectTimelineAnchorConflict, detectSceneTailDuplication, detectWeakEnding, detectMotifRepetition, detectChapterOpenerTic, detectChapterEndingTic, detectTitleDuplication, detectTimePromiseBreak, detectBloodlessCombat, detectOpenerRepeat, detectSpeechForbidHits, detectOpenerStructureSaturation, detectGoldenPhraseRepeats, chapterTitleDeliveryIssues, newCharacterDensityIssues } from '../quality/rules.js';
import { CONTINUITY_CRAFT_TEXT, AI_FLAVOR_TEXT } from '../../data/literary_techniques.js'; // V0.97：细节一致与章法轮换（写审同源）// V0.109.3：AI 腔纪律（写审同源）
import { formatFacts, characterStatesText, relevantFactsSmart } from '../narrative/factbook.js'; // V0.83 语义增强审校事实
import { allForeshadowsText } from '../narrative/foreshadow.js';
import { characterRollCallText, characterCardsText } from '../narrative/characters.js'; // V0.37：已退场角色硬规则 // V0.101：审校注入同场语音卡
import { styleRulesText } from '../../data/creative_packs.js'; // V0.83：修订注入文风（防漂移）
import { isFixableIssue, needsRoundup } from '../../data/issue_types.js'; // V0.109.3：类型语义单一真源
import { estimateChineseChars as estimateWordCount } from '../../llm/tokenizer.js';
import { autoHealSceneLength, stripNewSettingMarkers } from './write.js'; // V0.73：修订后长度自愈 + 新设定标记清理
import { logFlow } from '../../util/oplog.js'; // V0.85：覆盖校验截断重试记录
import { historicalContinuityIssues, historicalYouthAuthorityTextIssues, historicalFigureTimelineIssues, phaseCoveredByText, stampOpeningTimelineProseFix, eraAnchorIssues } from '../longform/historical_guardrails.js'; // V0.93：确定性历史连续性/少年权限硬防线 // V0.93.10：历史人物登场窗 // V0.102.4：开篇时间线不得整章重规划 // V0.105.7：章首年号锚点
import { historicalFiguresFor, eraRedLineCheck } from '../narrative/history.js'; // V0.93.10：历史人物档案读取（DB 优先+内置种子） // V0.105.7：时代器物审侧确定性扫描
import { historicalPhaseForVolume, historicalScaleRegisterText } from '../longform/historical_longform.js'; // V0.95.8 山河尺度纪律（写审同源一把尺）
import { isCompletedChapter } from './chapter_status.js';
import { applyValidatedSceneRewrite } from '../quality/polish.js';
import { openingReaderContractText } from '../planning/opening_intervention.js';
import { appendPublicationFeedback } from '../quality/publication_feedback.js'; // V0.99：写审同源的推流反馈 L4
import { getGlobal } from '../../config.js'; // V0.108：开篇期阈值与全局配置同源（openingBlueprintChapters）
import { resolveCraftProfile, evidenceCertaintyThreshold } from '../quality/craft_profile.js';
import { compileBookDiversityContract, diversityRegression } from '../quality/chapter_diversity.js';
import { compileBookCraftOccupancy, healCraftMorphology, craftRegression } from '../quality/craft_occupancy.js';

function invalidGate(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * V0.105.7 场景 beat 覆盖检测（零 LLM）：场景正文对细纲 beat 各节拍句的词根覆盖。
 * 事故：实测 ch49 s4 beat 要求「软禁偏院/病榻掰算筹」，正文写飞成「第二次对峙+伪造
 * 捷报策划」，与 s3 拼成同一场戏两版（章内结构重复的直接根因），LLM 覆盖检查放行。
 * 判定：beat 按句切（≥6 字内容句），句覆盖 = 与正文存在 ≥2 个互不重叠的 2 字词根命中
 * （人名连续窗只计 1，防「同一人名」假覆盖）；≥2 句零覆盖 → high 大纲偏离（proseFix，
 * 拉回节拍或修订 beat 对齐实际，绝不清场）。单句 beat 不判（LLM 覆盖检查兜底）。
 */
export function sceneBeatCoverageIssues(scenes) {
  const issues = [];
  for (const sc of Array.isArray(scenes) ? scenes : []) {
    const beat = String(sc.beat || '').trim();
    const content = String(sc.content || '');
    if (!beat || content.trim().length < 50) continue;
    const sentences = beat.split(/[。！？!?；;\n]/)
      .map(s => s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ''))
      .filter(s => s.length >= 6);
    if (sentences.length < 2) continue;
    const misses = sentences.filter(sent => {
      let hits = 0;
      for (let i = 0; i + 2 <= sent.length; i++) {
        if (content.includes(sent.slice(i, i + 2))) { hits++; i += 2; }
        if (hits >= 2) return false;
      }
      return true;
    });
    if (misses.length >= 2) {
      issues.push({
        type: '大纲偏离', severity: 'high', proseFix: true,
        quote: misses[0].slice(0, 40),
        issue: `场景 ${sc.idx} 正文偏离细纲节拍：${misses.map(m => m.slice(0, 18)).join('；')}——这些节拍在正文中零词根覆盖，本场景写成了另一场戏`,
        fix: '按 beat 重写本场景（同义词根即可），或确认剧情已改向后修订 beat 使台账与正文一致',
      });
    }
  }
  return issues;
}

/**
 * 完成章的正文与结算摘要已经是事实，旧计划只可追溯、不得再作为“必须写到”的审校合同。
 * 未完成章仍使用 scenes[].beat/checkpoints 约束当次生成。
 */
export function chapterOutlineTextForAudit(outline, { completed = false, summary = '' } = {}) {
  const value = outline && typeof outline === 'object' ? outline : {};
  if (completed) {
    const actualScenes = Array.isArray(value.scenes)
      ? value.scenes.filter(scene => String(scene?.actual_beat || '').trim())
        .map(scene => `- ${scene.pov || ''}@${scene.location || ''}：${scene.actual_beat}`)
      : [];
    if (actualScenes.length) return actualScenes.join('\n');
    if (String(value.actual_beat || '').trim()) return `【实际结果】${String(value.actual_beat).trim()}`;
    if (String(summary || '').trim()) return `【实际摘要】${String(summary).trim()}`;
    return '';
  }
  if (!Array.isArray(value.scenes) || !value.scenes.length) return '';
  return value.scenes.map(scene => `- ${scene.pov || ''}@${scene.location || ''}：${scene.beat || ''}`).join('\n')
    + (value.checkpoints?.length ? `\n【要点】${value.checkpoints.join('；')}` : '');
}

/** V0.93.11：跨章句子复读——读前文正文做本地匹配（不进 LLM 上下文，成本为零）
 *  V0.94.0：窗口 5→8 章 + 跨章比喻复读（精读实证："像一头睡着的东西"ch1→ch7 间隔 6 章超出旧窗口）
 *  V0.95.0：窗口 8→12 章 + 归档卡 key_details 双源比对——审计实证固定 8 章窗口与写作指令
 *  "跨章不得复用前文比喻"的全书承诺脱节：ch8 的金句在 ch30 逐字复读无防线（早期比喻成
 *  "授权复用池"，修仙 ch120-125 跨章复读爆发 0.064 重叠率是终极形态）。归档卡含早期章
 *  key_details（含专名句+对话句），补齐"归档后前文"的比对盲区。 */
function crossChapterRepeatIssues(bookId, chapterIdx, chapterText) {
  try {
    const prevChapters = store.chapters.list(bookId)
      .filter(c => Number(c.idx) < Number(chapterIdx))
      .sort((a, b) => b.idx - a.idx)
      .slice(0, 12)
      .map(c => ({ idx: c.idx, text: store.scenes.list(c.id).map(s => s.content || '').join('\n') }));
    // 归档卡补源：归档批次早于最近 12 章的前文，key_details 是含专名/对话的关键句（本地提取）
    for (const ar of store.archives.list(bookId)) {
      try {
        const cards = ar.summary_json ? (JSON.parse(ar.summary_json).cards || []) : [];
        for (const card of cards) {
          const details = (card.key_details || []).map(d => d.text || '').join('\n');
          if (details) prevChapters.push({ idx: card.chapter, text: details });
        }
      } catch { /* 归档卡解析失败忽略 */ }
    }
    return [
      ...detectCrossChapterRepeats(chapterText, prevChapters),
      // V0.105.8：金句短语级跨章复读（整句检测抓不到嵌在变体长句里的名台词——
 // 本作「墙修得再高」×4 实证）；窗口收窄到 8 章（金句复读比整句更易感知）
      ...detectGoldenPhraseRepeats(chapterText, prevChapters.slice(0, 8)),
      ...detectCrossChapterMetaphors(chapterText, prevChapters),
      // V0.97：章法级跨章查重——起手式同质（S1）与收束意象/句式复读（S2/S3/S4），
      // 复用同一批前文文本（首 80 字/末段），零额外 IO
      ...detectChapterOpenerTic(chapterText, prevChapters.map(c => ({ idx: c.idx, text: String(c.text || '').slice(0, 80) }))),
      ...detectOpenerStructureSaturation(chapterText, prevChapters.map(c => ({ idx: c.idx, text: String(c.text || '').slice(0, 80) }))),
      // V0.98.14：章首句跨章逐字重合（短首句 12 字窗盲区，ch32/ch28「天还没亮透」实证）
      ...detectOpenerRepeat(chapterText, prevChapters.map(c => ({ idx: c.idx, text: String(c.text || '').slice(0, 120) }))),
      ...detectChapterEndingTic(chapterText, prevChapters.map(c => {
        const paras = String(c.text || '').split(/\n+/).filter(p => p.trim());
        return { idx: c.idx, text: paras.at(-1) || '' };
      })),
    ];
  } catch { return []; }
}

/** 严格解析审校响应；坏 JSON、截断和未知枚举一律不得降级为通过。 */
export function parseAuditResponse(response) {
  if (!response || response.finishReason === 'length') {
    throw invalidGate('AUDIT_INVALID', '审校输出被截断，已阻止章节结算');
  }
  const extracted = extractJSON(response.content);
  const source = Array.isArray(extracted) ? { issues: extracted } : extracted;
  if (!source || typeof source !== 'object') {
    throw invalidGate('AUDIT_INVALID', '审校输出格式无效，已阻止章节结算');
  }

  let issues = source.issues ?? source.problems ?? source.findings ?? source['问题'];
  const rawVerdict = source.verdict ?? source.status ?? source.result ?? source['结论'];
  const verdictAliases = new Map([
    ['accept', 'accept'], ['pass', 'accept'], ['passed', 'accept'], ['ok', 'accept'], ['approved', 'accept'],
    ['通过', 'accept'], ['接受', 'accept'], ['无问题', 'accept'],
    ['fix', 'fix'], ['revise', 'fix'], ['revision', 'fix'], ['needs_fix', 'fix'], ['修改', 'fix'], ['修复', 'fix'],
    ['defer', 'defer'], ['deferred', 'defer'], ['延后', 'defer'], ['记债', 'defer'],
    ['replan', 'replan'], ['rewrite', 'replan'], ['重规划', 'replan'], ['重写', 'replan'],
  ]);
  let verdict;
  if (rawVerdict !== undefined && rawVerdict !== null && String(rawVerdict).trim() !== '') {
    verdict = verdictAliases.get(String(rawVerdict).trim().toLowerCase());
    // V0.95.3：verdict 枚举外变体（实测 ch27：思考模型输出"通过，但有建议"式长句，修复器
    // 按"不推断"原则原样保留 → 二次仍无效 → 整章卡死）不再阻塞——落入下方按 issues
    // 严重度推断（裁决仍由 issues 严格驱动 + sanitizeAuditResult 二次清洗伪问题）。
    // issues 结构无效仍 fail-closed（那是真正的不可解析）。
  }
  if (issues && !Array.isArray(issues) && typeof issues === 'object') issues = Object.values(issues);
  if (issues === undefined && verdict === 'accept') issues = [];
  if (!Array.isArray(issues)) {
    throw invalidGate('AUDIT_INVALID', '审校输出格式无效，已阻止章节结算');
  }
  if (!verdict) {
    verdict = issues.some(issue => ['high', 'medium'].includes(String(issue?.severity || '').toLowerCase())) ? 'fix' : 'accept';
  }

  let grade;
  if (source.grade !== undefined) {
    grade = String(source.grade).trim().toUpperCase().match(/[SABCD]/)?.[0];
  }
  // V0.95.3：grade 存在但格式非法（实测 ch27：思考模型输出 "A-"/"中等" 式变体）不再阻塞整章——
  // grade 仅供 UI 质量分档展示，verdict/issues 才是裁决核心；丢弃非法 grade 继续解析
  // （auditChapter 已有按 issues 推断 grade 的兜底）。verdict/issues 结构无效仍 fail-closed。
  return { issues, verdict, ...(grade ? { grade } : {}) };
}

/** 非截断但结构畸形时只允许修复一次；二次仍无效则继续 fail-closed。 */
export async function parseAuditWithRepair(response, repairOnce) {
  try {
    return parseAuditResponse(response);
  } catch (error) {
    if (error.code !== 'AUDIT_INVALID' || response?.finishReason === 'length' || typeof repairOnce !== 'function') throw error;
    const repaired = await repairOnce(response, error);
    return parseAuditResponse(repaired);
  }
}

const AUDIT_SEVERITIES = new Set(['high', 'medium', 'low']);
const AUDIT_OMISSION_TYPES = new Set(['伏笔遗忘', '大纲偏离', '情感连贯性', '环境描写缺失', '心理描写标签化']); // V0.89：3.6 环境/心理软检无 quote 放行

function normalizedEvidence(value) {
  return String(value || '').replace(/\s+/g, '');
}

function quoteExistsInChapter(quote, chapterText) {
  const text = normalizedEvidence(chapterText);
  const evidence = normalizedEvidence(quote);
  if (evidence.length < 4) return false;
  if (text.includes(evidence)) return true;
  const fragments = evidence.split(/(?:…{2,}|\.{3,})/).filter(part => part.length >= 6);
  if (fragments.length >= 2 && fragments.every(part => text.includes(part))) return true;
  // V0.78 修复：宽松匹配——审校模型常改写引用（如正文"书架后那道灰衣身影"、审校引用
  // "那人是灰衣人"），精确子串匹配会误杀真实问题（大纲偏离/事实编造被过滤→误判 accept→
  // 章节状态错乱/死循环）。改为：提取 quote 中的实体关键词（2-6 字连续片段），正文含任一
  // 即视为引用成立；quote 太短(<4字)或无意义才判不存在。
  const textLen = text.length;
  if (textLen < 4) return false;
  // 常见虚词/无信息词（2字片段过滤用）
  const WEAK = /^[的了是就在和他她我你于与及或但所这那们个上下中又还正只便再并不都也把被而已仍更最很挺快稍]+$/;
  // 从 evidence 中滑动提取 6→4→3 字片段，正文包含则成立；
  // 再降级到 2 字实词片段（如"灰衣""老幺"），正文含任一即通过——模型改写引用
  // （"那人是灰衣人" vs 正文"灰衣身影"）不再误杀；但完全无关的伪引用（无共同实词）仍过滤。
  for (let win = 6; win >= 3; win--) {
    for (let i = 0; i + win <= evidence.length; i++) {
      const frag = evidence.slice(i, i + win);
      if (frag.includes('你') || frag.includes('他') || frag.includes('她') || frag.includes('我')) continue;
      if (text.includes(frag)) return true;
    }
  }
  // 2 字实词片段（过滤虚词）
  for (let i = 0; i + 2 <= evidence.length; i++) {
    const frag = evidence.slice(i, i + 2);
    if (WEAK.test(frag)) continue;
    if (text.includes(frag)) return true;
  }
  return false;
}

/**
 * 审校证据闸：客观问题的 quote 必须来自当前章；模型自己声明“暂不报/不构成冲突”的项也丢弃。
 * 清洗后没有 high/medium 问题时，不能继续沿用模型基于伪问题给出的 fix/replan/defer。
 */
export function sanitizeAuditResult(parsed, chapterText) {
  const issues = (Array.isArray(parsed?.issues) ? parsed.issues : []).filter(issue => {
    if (!issue || typeof issue.type !== 'string' || typeof issue.issue !== 'string') return false;
    if (!AUDIT_SEVERITIES.has(issue.severity)) return false;
    if (/(?:暂不报|无需(?:修改|修订)|不构成(?:矛盾|冲突)|并无(?:矛盾|冲突))/.test(issue.issue)) return false;
    if (!issue.quote) return AUDIT_OMISSION_TYPES.has(issue.type);
    return quoteExistsInChapter(issue.quote, chapterText);
  });
  const actionable = issues.some(issue => issue.severity === 'high' || issue.severity === 'medium');
  const verdict = actionable ? parsed.verdict : 'accept';
  return { ...parsed, issues, verdict };
}

/** 严格解析细纲覆盖响应，并校验 missing 与 verdict 的语义一致性。 */
export function parseCoverageResponse(response) {
  if (!response || response.finishReason === 'length') {
    throw invalidGate('COVERAGE_INVALID', '覆盖校验输出被截断，已阻止章节结算');
  }
  const parsed = extractJSON(response.content);
  if (!parsed || !Array.isArray(parsed.coverage) || !Array.isArray(parsed.missing)
      || !['pass', 'fix'].includes(parsed.verdict)) {
    throw invalidGate('COVERAGE_INVALID', '覆盖校验输出格式无效，已阻止章节结算');
  }
  const expected = parsed.missing.length ? 'fix' : 'pass';
  if (parsed.verdict !== expected) {
    throw invalidGate('COVERAGE_INVALID', '覆盖校验 verdict 与 missing 不一致，已阻止章节结算');
  }
  return parsed;
}

/**
 * 章节审校：本地规则（零成本）+ LLM 一致性检查（多档判定 accept/fix/defer/replan）。
 * @returns {Promise<{issues:Array, localIssues:Array, llmIssues:Array, verdict:string}>}
 */
export async function auditChapter(bookId, chapterId, { signal, streamCb } = {}) {
  const chapter = store.chapters.get(chapterId);
  if (!chapter) throw new Error('章节不存在');
  const book = store.books.get(bookId);
  const chapterText = store.chapters.fullText(chapterId);
  if (!chapterText) throw new Error('本章还没有正文');

  const chOutline = store.chapters.outline(chapterId);
  const previousChapter = store.chapters.list(bookId).find(item => item.idx === chapter.idx - 1);
  const previousOutline = previousChapter ? store.chapters.outline(previousChapter.id) : null;
  const craftProfile = resolveCraftProfile(book, store.books.settings(bookId));

  const localIssues = [
    ...runLocalRules(chapterText, { evidenceThreshold: evidenceCertaintyThreshold(craftProfile) }),
    ...runSceneContinuityRules(store.scenes.list(chapterId)),
    // V0.105.7：时代器物审侧确定性扫描（eraRedLineCheck 词表单一真源：辣椒/玉米/烟草/现代词…）。
    // 此前只被吸引力门软消费，ch52「辣椒油」实证穿关落库。命中即 high + proseFix——
    // 词表自带 fix（一处措辞替换），修订路由只走 revise 绝不 replan（isImmediateReplanIssue 认 proseFix）。
    ...(book?.genre === '历史' ? eraRedLineCheck(chapterText).map(r => ({
      type: '史实错误', severity: 'high', proseFix: true,
      quote: r.term, issue: `时代器物/用语穿帮：${r.issue}`, fix: r.fix,
    })) : []),
    // V0.105.7：章首年号锚点（ch52「开庆元年」倒退回 1259 而章纲为景定五年实证）
    ...(book?.genre === '历史' ? eraAnchorIssues(chapterText, {
      era_year: String(chOutline?.era_year || ''),
      year: Number(chOutline?.year) || undefined,
    }) : []),
    ...(book?.genre === '历史' ? historicalContinuityIssues({
      bookTitle: book.title,
      genre: book.genre,
      year: Number(chOutline?.year) || undefined,
      previousYear: Number(previousOutline?.year) || undefined,
      chapterText,
    }) : []),
    ...(book?.genre === '历史' ? historicalYouthAuthorityTextIssues({
      bookTitle: book.title,
      genre: book.genre,
      year: Number(chOutline?.year) || undefined,
      protagonistAge: Number(chOutline?.protagonist_age) || undefined,
      chapterText,
    }) : []),
    // V0.93.10：历史人物登场窗校验（正文提到登场年前/卒年后的历史人物 → 时代错误）
    ...(book?.genre === '历史' ? historicalFigureTimelineIssues({
      bookTitle: book.title,
      genre: book.genre,
      year: Number(chOutline?.year) || undefined,
      chapterText,
      figures: historicalFiguresFor(bookId),
    }) : []),
    // V0.93.11：跨章句子复读检测（本章整句出现在前 8 章 → medium 触发修订；doctor 实证跨章同句复读）
    // V0.94.0：+ 跨章比喻复读（窗口 8 章）
    ...(crossChapterRepeatIssues(bookId, chapter.idx, chapterText)),
    // V0.94.0：场景尾部重演（双版本残留本地形态——场景 i 尾部与后续场景连续复述 ≥18 字 → high）
    ...detectSceneTailDuplication(store.scenes.list(chapterId)),
    // V0.105.7：场景正文对 beat 的词根覆盖（ch49 s4 写飞成第二场对峙的根因闸）
    ...sceneBeatCoverageIssues(store.scenes.list(chapterId)),
    // V0.94.0：章名兑现度（具象章名核心词零出现 → low 提示）
    ...detectTitleGap(chapter.title, chapterText),
    // V0.107：章名↔正文核对闸（detectTitleGap 升级版，词表 TITLE_EVENT_LEXICON 写审同源）——
    // 事件承诺型（章名含决战/驾崩/破城等强事件词而正文词族零在场）→ high+proseFix，
    // ch52「帝星陨落」正文理宗驾崩零着墨即此类题眼级事故；具象 bigram 零命中 → medium+proseFix。
    ...chapterTitleDeliveryIssues(chapter.title, chapterText),
    // V0.94.0：接续时间锚点矛盾（"禁足第三日"+跨年 → high；精读实证 ch23/24 同一次禁足跨三年）
    ...(book?.genre === '历史' ? detectTimelineAnchorConflict({
      headText: chapterText.slice(0, 200),
      year: Number(chOutline?.year) || null,
      prevYear: Number(previousOutline?.year) || null,
    }) : []),
    // V0.94.0b：章末零钩（静态空镜收尾 → medium；卷末章豁免——下一章未建或已属别卷即视为卷界）
    ...detectWeakEnding(chapterText, {
      volumeFinal: (() => {
        const next = store.chapters.list(bookId).find(item => item.idx === chapter.idx + 1);
        return !next || next.volume_id !== chapter.volume_id;
      })(),
    }),
    // V0.94.0b：动作母题配额（同章同一母题 ≥4 次 → medium；写审同源：写作指令动作库拓宽纪律）
    ...detectMotifRepetition(chapterText),
    // V0.97：章名全书查重（ch34《北望》与 ch8 完全重名实证）
    ...detectTitleDuplication(chapter.title, store.chapters.list(bookId).filter(c => c.id !== chapterId).map(c => c.title)),
    // V0.97：时间承诺断链（前章末"明日/三日后"承诺 + 本章跨年 → medium；非历史题材 outline 无 year 时自动不判）
    ...detectTimePromiseBreak({
      prevTailText: previousChapter
        ? store.scenes.list(previousChapter.id).map(s => s.content || '').join('\n').slice(-400)
        : '',
      year: Number(chOutline?.year) || null,
      prevYear: Number(previousOutline?.year) || null,
    }),
    // V0.98.13：战斗章无血肉痕迹（贴身搏杀却全程"干净打斗"=智斗冒险化；写审同源近战残酷纪律）
    ...detectBloodlessCombat(chapterText, { title: chapter.title, outline: JSON.stringify(chOutline || {}) }),
    ...detectSpeechForbidHits(chapterText, store.characters.list(bookId)),
    // V0.108：新具名实体密度（开篇期一章 ≥3 个新名字砸脸 → medium；常规 ≥4 → low）
    ...newCharacterDensityIssues({
      newEntityCount: store.pendingEntities.listAll(bookId, { limit: 1000 })
        .filter(p => Number(p.source_chapter) === Number(chapter.idx)).length,
      chapterIdx: chapter.idx,
      openingChapters: Number(getGlobal()?.openingBlueprintChapters) || 20,
    }),
  ];

  const factsText = formatFacts(await relevantFactsSmart(bookId, `第${chapter.idx}章 ${chapter.title || ''}`, 24), { withStatus: true });
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  // V0.82：历史题材注入时代基准（史实骨架/红线/可改史点 → 审校模型据此核查史实错误）
  let eraContext = '';
  if (book.genre === '历史') {
    try {
      const { eraContextText, eraBoundaryText } = await import('../narrative/history.js');
      eraContext = [eraContextText(bookId, { scope: 'general', maxChars: 600 }), eraBoundaryText(bookId)].filter(Boolean).join('\n');
    } catch { /* 历史基准注入失败不阻断 */ }
  }
  // V0.78 修复：审校注入本章细纲——审校模型此前不知道"老幺"等是细纲要求的人物，
  // 误判为"事实编造"反复报，而正文修订删了它细纲又要写 → 死循环。注入细纲后，
  // 审校能区分"细纲引入的待登记设定"与"纯属编造"。
  const chapterOutlineText = chapterOutlineTextForAudit(chOutline, {
    completed: isCompletedChapter(chapter),
    summary: store.summaries.get(chapterId)?.summary || '',
  });
  // V0.87：战役章审校加战争逻辑核查（无脑冲/降智/无节奏/无代价/无后方联动）
  let warfareCheck = false;
  try {
    const { isWarfareText } = await import('../../data/literary_techniques.js');
    warfareCheck = isWarfareText(chapter.title, chapterOutlineText, chapterText.slice(0, 120));
  } catch { /* 战争逻辑核查失败不阻断 */ }
  // V0.88：朝堂/权谋章审校加权谋核查（对话无双层/皇帝降智/暗线无铺垫/权谋无代价/无前后方传导）
  let courtCheck = false;
  try {
    const { isCourtIntrigueText } = await import('../../data/literary_techniques.js');
    courtCheck = isCourtIntrigueText(chapter.title, chapterOutlineText, chapterText.slice(0, 120));
  } catch { /* 权谋核查失败不阻断 */ }
  const instruction = auditInstruction({
    bookTitle: book.title, chapterTitle: chapter.title,
    chapterText, factsText, contract,
    foreshadowsText: allForeshadowsText(bookId),
    characterStates: characterStatesText(bookId, { chapterIdx: chapter.idx }),
    deceasedText: characterRollCallText(bookId, { limit: 30, chapterIdx: chapter.idx }), // V0.37：退场名单 + 硬规则
    perspective: book.perspective || 'third', // V0.42 叙述视角（人称漂移检查）
    chapterOutline: chapterOutlineText, // V0.78：细纲供审校区分"编造"vs"细纲设定"
    openingContractText: openingReaderContractText(bookId, chapter.idx),
    eraContext, // V0.82：历史时代基准（史实骨架/红线/可改史点）
    warfareCheck, // V0.87：战役章战争逻辑核查
    courtCheck, // V0.88：朝堂/权谋章权谋逻辑核查
    chapterYear: Number(chOutline?.year) || null, // V0.94：时间线量词核查坐标
    prevChapterYear: Number(previousOutline?.year) || null, // V0.94：上一章年份（N年了差值核查）
    // V0.95.8 山河尺度核查：与写作指令同一把尺（配额未达 → medium 文学性 + verdict 至少 fix）
    scaleRegisterText: book.genre === '历史'
      ? historicalScaleRegisterText(
        chapter.volume_id ? store.volumes.get(chapter.volume_id)?.idx : 1,
        historicalPhaseForVolume(book, chapter.volume_id ? store.volumes.get(chapter.volume_id)?.idx : 1),
      )
      : '',
    continuityCraft: CONTINUITY_CRAFT_TEXT, // V0.97：细节一致与章法轮换（3.13/3.14 判定基准，写审同源）
    diversityText: compileBookDiversityContract(bookId, chapter.idx).text,
    craftOccupancyText: compileBookCraftOccupancy(bookId, chapter.idx).text,
    cardText: characterCardsText(bookId, {
      names: store.characters.list(bookId).filter(c => chapterText.includes(c.name)).map(c => c.name),
      limit: 6,
      chapterIdx: chapter.idx,
    }),
  });
  const messages = assembleReviewMessages(bookId, [{
    role: 'user',
    content: appendPublicationFeedback(instruction, bookId, { targetChapterIdx: chapter.idx }),
  }]);
  const res = await runTask({
    task: 'audit', bookId, chapterId, messages, jsonMode: true, signal,
    // V0.95.2：审校开思考（medium）+预算 10000——审校质量=自愈能力，原强制低推理是
    // 6000 预算时代防 reasoning 挤占 JSON 的妥协；预算给足 + audit 已入 PLANNING_TASKS
    // 截断重试集（router），reasoning 耗尽输出导致截断的路径已有兜底。
    routeOverride: { maxTokens: 16000, thinking: 'disabled', reasoningEffort: 'low' }, // V0.95.3：审校思考回退——硬卡点稳定性优先（与 config 同步）
    streamCb: { onUsage: streamCb?.onUsage, onUsageCost: streamCb?.onUsageCost }, // V0.96：审校用量进"本次运行"统计
  });

  let parsed;
  try {
    parsed = await parseAuditWithRepair(res, async invalidResponse => {
      const raw = String(invalidResponse?.content || '').slice(0, 12000);
      return runTask({
        task: 'audit_repair', bookId, chapterId, jsonMode: true, signal,
        messages: [
          {
            role: 'system',
            content: '你是 JSON 格式修复器。只转换已有审校结论，不新增、不删除、不推断任何小说事实。只输出 JSON。',
          },
          {
            role: 'user',
            content: `把下面的审校输出转换为严格 JSON：\n{"issues":[{"type":"类型","severity":"high|medium|low","quote":"原文引用","issue":"问题","fix":"修改方式"}],"grade":"S|A|B|C|D","verdict":"accept|fix|defer|replan"}\n若原输出明确表示没有问题，输出 issues=[]、verdict=accept。不要重新审校正文。\n\n【原输出】\n${raw}`,
          },
        ],
      });
    });
    parsed = sanitizeAuditResult(parsed, chapterText);
  } catch (error) {
    try {
      store.conflicts.create(bookId, {
        chapterId,
        type: '审校异常',
        quote: '',
        issue: `${error.message}；再次自动创作时将从本章重试`,
      });
    } catch { /* ignore */ }
    throw error;
  }
  const llmIssues = parsed.issues;
  // 多档判定：accept | fix | defer | replan（兼容旧值 pass → accept）
  const rawVerdict = parsed.verdict;
  const llmVerdict = rawVerdict === 'pass' ? 'accept' : rawVerdict;
  // V0.73：medium 语句质量（本地规则升级后）也触发 fix 修订——否则整套 AI 味检测形同虚设
  // V0.109.3：类型语义改查 issue_types 注册表（新增纪律如「AI 腔」零成本接入，不再改这里）
  const hasFixable = llmIssues.some(isFixableIssue) || localIssues.some(isFixableIssue);
  const hasHigh = llmIssues.some(i => i.severity === 'high') || localIssues.some(i => i.severity === 'high');
  // V0.22：S/A/B/C/D 质量等级（spark-arc-studio Critic 五档思路）
  const grade = ['S', 'A', 'B', 'C', 'D'].includes(parsed?.grade) ? parsed.grade
    : (llmIssues.length ? (hasHigh ? 'C' : 'B') : (hasFixable ? 'B' : 'A'));
  // V0.73：本地规则命中 medium 可修类型（AI 味确凿）时即使 LLM 判 accept 也强制 fix
  const verdict = (hasHigh || localIssues.some(isFixableIssue))
    && llmVerdict === 'accept' ? 'fix' : llmVerdict;

  // 落冲突记录（V0.60 防屎山：只记"需要后续章节圆场"的问题——
  // 文本级问题一律不落（不需要圆场，直接丢弃）；low 级一律不落；其余 medium+ 才记债务）
  // V0.109.3：是否记债改查 issue_types 注册表（原 NEEDS_ROUNDUP 白名单已迁入其中）
  const existing = new Set(store.conflicts.list(bookId).map(c => `${c.chapter_id}|${c.type}|${c.issue}`));
  const all = [...llmIssues, ...localIssues];
  for (const issue of all) {
    if (!issue.issue) continue;
    if ((issue.severity || 'medium') === 'low') continue; // low 级不记债
    const type = issue.type || '语句质量';
    if (!needsRoundup(type)) continue; // 文本质量问题与仅提示类均不记债
    const key = `${chapterId}|${type}|${issue.issue}`;
    if (existing.has(key)) continue;
    existing.add(key);
    store.conflicts.create(bookId, {
      chapterId,
      type,
      quote: issue.quote || '',
      issue: issue.issue,
    });
  }
  return { issues: stampOpeningTimelineProseFix(all), localIssues, llmIssues, verdict, grade };
}

/**
 * 历史章除了细纲自报的 checkpoints，还必须校验书级阶段任务是否真正落到正文。
 * 这能防止细纲在重规划时悄悄丢掉“安葬与安置”等跨章核心承诺，却仍自检通过。
 */
export function coverageCheckpointsFor(book, outline = {}) {
  const checkpoints = Array.isArray(outline?.checkpoints)
    ? outline.checkpoints.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  if (book?.genre !== '历史') return checkpoints;
  const phase = String(outline?.phase || '').trim();
  if (!phase) return checkpoints;
  const represented = checkpoints.some(item => phaseCoveredByText(phase, item));
  return represented ? checkpoints : [`阶段任务：${phase}`, ...checkpoints];
}

/** 细纲要点覆盖校验 */
export async function coverageCheck(bookId, chapterId, { signal, streamCb } = {}) {
  const chapter = store.chapters.get(chapterId);
  if (!chapter) throw new Error('章节不存在');
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const outline = store.chapters.outline(chapterId);
  const checkpoints = coverageCheckpointsFor(book, outline);
  if (!checkpoints.length) return { verdict: 'pass', coverage: [], missing: [] };
  const chapterText = store.chapters.fullText(chapterId);

  const instruction = coverageInstruction({
    bookTitle: book.title, chapterTitle: chapter.title, checkpoints, chapterText,
  });
  const messages = assembleReviewMessages(bookId, [{
    role: 'user',
    content: appendPublicationFeedback(instruction, bookId, { targetChapterIdx: chapter.idx }),
  }]);
  // V0.85：覆盖校验截断自动重试 1 次（maxTokens 6000 下截断概率极低；重试后仍截断才 fail-closed）
  // V0.96.5：usage 透传（此前覆盖校验 tokens 漏出"本次运行"统计）
  const usageCb = { onUsage: streamCb?.onUsage, onUsageCost: streamCb?.onUsageCost };
  let res = await runTask({ task: 'coverage', bookId, chapterId, messages, jsonMode: true, signal, streamCb: usageCb });
  if (res.finishReason === 'length') {
    logFlow?.({ op: '覆盖校验截断重试', detail: `ch${chapter.idx} 覆盖输出截断，重试 1 次`, bookId });
    res = await runTask({ task: 'coverage', bookId, chapterId, messages, jsonMode: true, signal, streamCb: usageCb, routeOverride: { maxTokens: 8000 } });
  }
  const parsed = parseCoverageResponse(res);
  const missing = parsed.missing;
  return {
    verdict: parsed.verdict,
    coverage: parsed.coverage,
    missing,
  };
}

/**
 * 修订一个场景：重写正文，重建历史堆中该场景之后的部分。
 * 缓存代价：该场景起的历史全部重建（后续请求未命中），调用方需提示用户。
 * V0.73：resetFollowing 选项——文本级问题（语句质量/人称视角/文学性）修订默认
 * 不重置后续场景（避免"修一句人称"级联重写整章 2-6 场景，成本 ×3 且引入新漂移）；
 * 只有事实级/大纲级问题才级联重写后续场景。默认 true（向后兼容）。
 * @param {object} opts { issues, extraNote, signal, streamCb, resetFollowing=true }
 */
export async function reviseScene(bookId, chapterId, sceneId, opts = {}) {
  const { issues = [], extraNote, signal, streamCb, resetFollowing = true } = opts;
  const chapter = store.chapters.get(chapterId);
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const scene = store.scenes.get(sceneId) || store.scenes.list(chapterId).find(row => Number(row.idx) === Number(opts.sceneIdx));
  if (!scene) {
    const error = new Error('场景不存在');
    error.code = 'REWRITE_SCENE_MISSING';
    throw error;
  }
  const wasCompleted = isCompletedChapter(chapter);
  const blockingRevision = store.narrativeRevisions.blocking(bookId);
  if (wasCompleted && blockingRevision && blockingRevision.status !== 'stale') {
    throw invalidGate('NARRATIVE_REVISION_BUSY', '叙事状态正在构建或提交，暂不能同时修订完成章');
  }

  // V0.83：修订注入文风规则（防修订后文风漂移回模型默认）；V0.95：历史书过滤冲突规则
  const bookSettings = store.books.settings(bookId);
  const styleRules = styleRulesText(bookSettings.styleProfile, bookSettings.styleSample, { isHistory: book?.genre === '历史' });
  const diversityContract = compileBookDiversityContract(bookId, chapter.idx);
  const craftOccupancy = compileBookCraftOccupancy(bookId, chapter.idx);
  const instruction = reviseInstruction({
    bookTitle: book.title, chapterTitle: chapter.title,
    scene, issues, extraNote, styleRules,
    continuityCraft: CONTINUITY_CRAFT_TEXT, // V0.97：修订同源注入细节一致/章法轮换纪律（防修一处造一处）
    aiFlavorCraft: AI_FLAVOR_TEXT, // V0.109.3：修订同源注入 AI 腔纪律（审出什么就能按同一把尺改掉）
    diversityText: diversityContract.text,
    craftOccupancyText: craftOccupancy.text,
  });
  // 修订指令已携带原场景、细纲和问题；隔离旧章节 assistant 正文，避免模型把相邻场景
  // 拼进本场景，造成越界续写、事件重复和篇幅失控。
  const messages = assembleReviewMessages(bookId, [{
    role: 'user',
    content: appendPublicationFeedback(instruction, bookId, { targetChapterIdx: chapter.idx }),
  }]);
  const res = await runTask({
    task: 'revise', bookId, chapterId, messages,
    routeOverride: {
      thinking: 'disabled', reasoningEffort: 'low', temperature: 0.4,
      // V0.95.3 终值：effort low + 下限 8000——ch27 连环实证该端点 revise+medium
      // 思考吃满任意预算（4000/8000 两档全思考零正文）；修订按问题清单重写指令精确，low 足够。
      maxTokens: Math.max(8000, Math.min(16000, Math.ceil((scene.target_words || 1000) * 3))),
    },
    streamCb: { onDelta: streamCb?.onDelta, onUsage: streamCb?.onUsage },
    signal,
  });
  let content = res.content.trim();
  // V0.95.3：空结果兜底重试一次（同参数大预算）——端点偶发把全部预算耗在推理上正文为零，
  // 重试一次低成本救回（再空才抛错走管线级重试/人工）
  if (!content) {
    const retry = await runTask({
      task: 'revise', bookId, chapterId, messages,
      routeOverride: {
        thinking: 'disabled', reasoningEffort: 'low', temperature: 0.4,
        maxTokens: Math.max(12000, Math.min(16000, Math.ceil((scene.target_words || 1000) * 3))),
      },
      streamCb: { onDelta: streamCb?.onDelta, onUsage: streamCb?.onUsage },
      signal,
    });
    content = retry.content.trim();
  }
  if (!content) throw new Error('修订结果为空，请重试');

  // V0.73 质量修复：修订后长度自愈——revise 输出常缩水到 200-500 字（原指令无 min/max 硬约束），
  // 不足补写、超限压缩，与 writeScene 同一套自愈逻辑，防 revised 场景字数腰斩。
  const heal = await autoHealSceneLength({
    bookId, chapterId, scene, content, autoHeal: true,
    onProgress: streamCb?.onProgress,
    onDelta: streamCb?.onDelta,
    onUsage: streamCb?.onUsage,
    onUsageCost: streamCb?.onUsageCost,
    signal,
  });
  content = heal.content;
  // V0.73 P0 修复：修订结果同样可能带【新设定:xxx】标记，落库前剥离（与 writeScene 一致）
  content = stripNewSettingMarkers(bookId, content, chapter.idx);
  const morph = healCraftMorphology(content);
  if (morph.healed) content = morph.content;
  const sceneRows = store.scenes.list(chapterId);
  const maxIdx = Math.max(0, ...sceneRows.map(row => Number(row.idx) || 0));
  const regression = diversityRegression(String(scene.content || ''), content, diversityContract, {
    issues,
    sceneIdx: scene.idx,
    isLastScene: Number(scene.idx) === maxIdx,
  });
  const craftReg = craftRegression(String(scene.content || ''), content, craftOccupancy);
  if (regression.reject || craftReg.reject) {
    return {
      content: String(scene.content || ''),
      usage: res.usage,
      cost: res.cost,
      diversityRejected: true,
      diversityReason: regression.reason || craftReg.reason,
      requiresStateRebuild: false,
      narrativeRevisionBlocked: false,
    };
  }

  // 与手工编辑、开篇补丁共用同一正文门禁：先验证整章候选，再原子替换历史、正文、
  // 字数和结算状态。完成章绝不清空后续定稿场景；其旧摘要/结算立即作废并登记同版重建。
  let applied;
  const liveScene = store.scenes.get(scene.id)
    || store.scenes.list(chapterId).find(row => Number(row.idx) === Number(scene.idx));
  if (!liveScene) {
    const error = new Error('场景不存在');
    error.code = 'REWRITE_SCENE_MISSING';
    throw error;
  }
  store.transaction(() => {
    applied = applyValidatedSceneRewrite(bookId, liveScene.id, content, { preserveExistingLength: true });
    if (!applied.ok) {
      throw invalidGate(applied.code || 'REWRITE_REJECTED', applied.message || '修订候选未通过正文门禁');
    }
    if (resetFollowing && !wasCompleted) {
      for (const following of store.scenes.list(chapterId)) {
        if (following.idx > scene.idx) store.scenes.update(following.id, { status: 'planned', content: '' });
      }
      const partialText = store.chapters.fullText(chapterId);
      store.chapters.update(chapterId, { wordCount: partialText ? estimateWordCount(partialText) : 0 });
    }
  });
  const storedContent = store.scenes.get(liveScene.id)?.content || content;
  return {
    content: storedContent,
    usage: res.usage,
    cost: res.cost,
    requiresStateRebuild: applied.requiresStateRebuild === true,
    narrativeRevisionBlocked: applied.requiresStateRebuild === true,
  };
}
