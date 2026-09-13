// server/engine/quality/attraction.js —— V0.80 逐章吸引力质量门（Attraction Gate）
// 治本：auditChapter 纯一致性（节奏/文风一律PASS），快感审计 settle 后才跑只反哺未来——
// "本章平淡 → 系统已盖章 done"。本门在审校+覆盖之后、settle之前拦截：平淡/无钩子/无爽点/主角被动
// → 触发 revise。与快感审计分工：门 pre-settle 可拦截，auditPleasure 保留 post-settle 反哺。
'use strict';
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { assembleReviewMessages } from '../../llm/cache.js';
import { attractionGateInstruction } from '../prompts.js';
import { extractJSON } from '../../util/json.js';
import { getGlobal } from '../../config.js';
import { detectPlotAiMarkers } from './plot_ai.js'; // 剧情AI味作软信号
import { storyPromiseProfileText, storyPromiseStatus } from '../planning/story_promise.js';
import { platformGuidanceText } from '../../data/platform_guidance.js';
import { fanqieGenreProfileText } from '../../data/fanqie_genre_profiles.js';

// 首屏动作/变化词表（零成本本地粗信号；不能单独作为质量结论）
const EVENT_WORDS = /打了|冲了|炸了|断了|猛地|一把|当众|滚|杀|吼|劈|踹|砸|撞|退婚|被退|欺|辱|踢|夺|拦|反手|出手|冷笑|拍桌|掀桌/;
// V0.83：历史题材轻事件词表（宫廷/文戏/权谋章不因"无打杀"误报平淡开场——变故/诏令/军情/弹劾/兵临城下）
const HISTORY_EVENT_WORDS = /变故|突发|急报|军情|战报|诏令|圣旨|旨意|旨下|弹劾|参奏|构陷|下狱|抄家|罢职|贬谪|夺职|兵临|围城|攻城|破城|失守|告急|求援|献城|归降|反戈|哗变|血案|灭门|遇刺|刺杀|伏击|交战|开战|北伐|出征|勤王|入京|调任|押解|公审|断案|惊变|噩耗|凶信|密报|机关|陷阱|中计|识破|揭发|案发|罹难|殒命|殉国|遇害|抵命|开审/;
// 章末钩子词（末150字内出现即视为有钩子信号）
const HOOK_WORDS = /危机|悬念|反转|挑衅|倒计时|究竟|突然|竟然|一把抓住|猛地|怎么会|难道|完了|不祥|冷汗|凉了|背脊|心头一跳|脚步声|门被推开/;
// 主角被动句式（占比>阈值 → 主角被动）
const PASSIVE_RE = /被[^。，]{1,12}(?:告知|发现|带走|押|关|抓|拦|堵|甩|打|骂|羞辱|扔|推|锁|围)/g;
const ACTIVE_RE = /(?:我|他|她)(?:决定|冲|问|夺|拦|转身|拔|握|攥|拍案|推门|迎上|反手)/g;

// V0.82：通用爽点词（非历史题材）
const GENERIC_SATISFY = /打脸|碾压|当场|众人|哗然|震惊|一脚|扇|反杀|翻盘|爽/;
// V0.82：历史题材爽点词（"史实流的骨、爽文的皮"——小爽点=算计得手/当众立威/识破阴谋/军功擢升/布局）
const HISTORY_SATISFY = /立威|识破|得手|得逞|反将一军|将军|算无遗策|布局|收服|收编|擢升|升任|拜为|授以|军功|报捷|捷报|名震|传檄|翻盘|破敌|守城|克城|大捷|争得|扳回|稳住阵脚|人心归附|众将服|满座|惊服|动容|肃然|权衡|定策|破局|护住|救下|活下来|学会|记住|发现|线索|真相|看清|信任|托付|牵挂|和解|相认|归属|温暖|选择|决意|尊严|守住|告别|约定|承诺|余韵/;

export function countAgencySignals(chapterText) {
  const text = String(chapterText || '');
  return {
    active: (text.match(ACTIVE_RE) || []).length,
    passive: (text.match(PASSIVE_RE) || []).length,
  };
}

/** 词表只描述“命中了什么”，不把未命中解释成平淡、无钩子或无回报。 */
export function attractionLocalSignals(chapterText, { isHistory = false } = {}) {
  const text = String(chapterText || '').trim();
  const paragraphs = text.split(/\n+/).map(item => item.trim()).filter(Boolean);
  const eventRe = isHistory ? HISTORY_EVENT_WORDS : EVENT_WORDS;
  const satisfyRe = isHistory ? HISTORY_SATISFY : GENERIC_SATISFY;
  return {
    chars: text.replace(/\s+/g, '').length,
    paragraph_count: paragraphs.length,
    duplicate_paragraphs: paragraphs.length - new Set(paragraphs).size,
    long_paragraphs: paragraphs.filter(item => item.replace(/\s+/g, '').length > 1200).length,
    head_event_terms_found: eventRe.test(text.slice(0, 300)),
    tail_hook_terms_found: HOOK_WORDS.test(text.slice(-150)),
    reward_terms_found: satisfyRe.test(text),
    agency: countAgencySignals(text),
  };
}

/** 本地零成本吸引力规则（不并入 runLocalRules，避免污染 auditChapter 判定）
 *  V0.82：历史题材换爽点词表——"打脸/碾压"式玄幻爽点是历史文减分项，
 *  历史文的爽是"压抑后的释放、有代价的胜利"（算计得手/当众立威/军功擢升/识破阴谋）。 */
export function attractionLocalRules(chapterText, { isHistory = false } = {}) {
  const text = String(chapterText || '').trim();
  const issues = [];
  const signals = attractionLocalSignals(text, { isHistory });
  if (signals.chars < 20) {
    issues.push({
      type: '正文异常', severity: 'high', quote: text,
      issue: `正文仅 ${signals.chars} 个非空白字符，无法形成可审阅章节`, fix: '补齐缺失正文后重新审阅',
    });
    return issues;
  }
  if (signals.duplicate_paragraphs > 0) {
    issues.push({
      type: '异常复读', severity: 'medium', quote: '',
      issue: `发现 ${signals.duplicate_paragraphs} 个完全相同段落`, fix: '删除误重复段落并检查生成拼接边界',
    });
  }
  if (signals.long_paragraphs > 0) {
    issues.push({
      type: '极长段落', severity: 'medium', quote: '',
      issue: `发现 ${signals.long_paragraphs} 个超过 1200 字的段落`, fix: '在语义转折处合理分段并检查换行丢失',
    });
  }
  // 可定位的剧情模板痕迹仍作为带证据的软信号；纯词表缺席不进入 issues。
  issues.push(...detectPlotAiMarkers(text));
  return issues;
}

function recordGateHealth(bookId, chapterId, chapterIdx, gate) {
  try {
    let health = store.chapterHealth.getByChapter(chapterId);
    if (!health) health = store.chapterHealth.add({ bookId, chapterId, idx: chapterIdx, verdict: 'ok', notes: '{}' });
    let notes = {};
    try { notes = health.notes ? JSON.parse(health.notes) : {}; } catch { notes = {}; }
    notes.gate = {
      verdict: gate.verdict, reviewed: gate.reviewed === true,
      issues: (gate.issues || []).length, score: gate.score || '', chapterIdx,
      ...(gate.reason ? { reason: gate.reason } : {}),
    };
    store.chapterHealth.update(health.id, { notes: JSON.stringify(notes) });
  } catch { /* 健康快照失败不阻塞正文 */ }
}

/** 逐章吸引力质量门（pre-settle 调用）
 *  mode：hard（番茄，始终调 LLM）/ soft（普通平台，本地无命中则 pass 不调 LLM）/ off
 *  门调用失败不阻塞正文，但必须显式返回 unreviewed，不能伪装成 pass。 */
export async function attractionGate(bookId, chapterId, chapterIdx, { signal, streamCb } = {}) {
  try {
    const book = store.books.get(bookId);
    if (!book) return { verdict: 'unreviewed', issues: [], reviewed: false, reason: '作品不存在' };
    // mode 判定：作品级 > 全局默认 > 番茄默认 hard（V0.83：|| 改 ??——全局默认 'soft' 恒真遮蔽了"番茄 hard"分支，番茄实际一直是 soft）
    const settings = store.books.settings(bookId);
    const g = getGlobal();
    const configuredMode = settings.attractionGate ?? g?.attractionGate ?? 'soft';
    // 配置中的 soft 语义是“番茄仍做文本审阅，其他平台仅跑本地客观检查”，不是全平台 soft。
    const mode = configuredMode === 'soft' && book.platform === '番茄' ? 'hard' : configuredMode;
    if (mode === 'off') return { verdict: 'pass', issues: [], skipped: true, reviewed: false, mode };
    const chapterText = store.chapters.fullText(chapterId);
    if (!chapterText) {
      const missing = { verdict: 'unreviewed', issues: [], reviewed: false, reason: '正文为空', mode };
      recordGateHealth(bookId, chapterId, chapterIdx, missing);
      return missing;
    }
    const isHistory = book.genre === '历史';
    // 本地规则（V0.82：历史题材换史实流爽点词表）
    const localIssues = attractionLocalRules(chapterText, { isHistory });
    const localSignals = attractionLocalSignals(chapterText, { isHistory });
    // V0.81 历史题材：时代红线 + 历史去AI味（软信号，低 severity 反哺 LLM 修订，不 throw）
    // V0.82 升级：红线/去AI味/降智/无代价胜利 severity low→medium——此前 low 被 parseAttractionResult
    // 丢弃（只认 high/medium），时代错误永不触发修订；现在 medium 直接构成 fix 条件
    if (isHistory) {
      try {
        const { eraRedLineCheck, detectHistoryMarkers } = await import('../narrative/history.js');
        for (const r of eraRedLineCheck(chapterText)) {
          localIssues.push({ type: '时代错误', severity: 'medium', quote: r.term, issue: r.issue, fix: r.fix });
        }
        for (const m of detectHistoryMarkers(chapterText)) {
          localIssues.push({ ...m, severity: 'medium' });
        }
      } catch { /* ignore */ }
    }
    // soft 模式：本地无命中 → 直接 pass（普通平台零成本）
    if (mode === 'soft' && localIssues.length === 0) {
      return { verdict: 'pass', issues: [], score: '', mode, reviewed: false, skipped: true };
    }
    const promise = storyPromiseStatus(bookId);
    const promiseProfile = promise.exists && !promise.stale ? promise.profile : null;
    const route = promiseProfile?.texture?.route || 'general';
    // hard 或本地有命中 → 调 LLM 判定
    const instruction = attractionGateInstruction({
      bookTitle: book.title, chapterTitle: store.chapters.get(chapterId)?.title || '',
      chapterIdx, chapterText, localIssues, localSignals, isHistory,
      storyPromise: promiseProfile ? storyPromiseProfileText(promiseProfile) : '',
      platformGuidance: platformGuidanceText(book.platform),
      genreProfile: fanqieGenreProfileText(book.genre, route),
    });
    const messages = assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]);
    const res = await runTask({
      task: 'attraction', bookId, chapterId, messages, jsonMode: true, signal,
      streamCb: { onUsage: streamCb?.onUsage, onUsageCost: streamCb?.onUsageCost }, // V0.96.5：usage 透传（此前吸引力门 tokens 漏出统计）
      routeOverride: { maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low' }, // V0.95.3 回退：与 config 同步——判定门确定性优先（medium 思考端点实证致输出漂移/截断）
    });
    const parsed = parseAttractionResult(res.content);
    const gate = { verdict: parsed.verdict, issues: parsed.issues || [], score: parsed.score || '', reason: parsed.reason || '', mode, reviewed: parsed.verdict !== 'unreviewed' };
    recordGateHealth(bookId, chapterId, chapterIdx, gate);
    return gate;
  } catch (e) {
    const gate = { verdict: 'unreviewed', issues: [], reviewed: false, reason: e.message, error: e.message };
    recordGateHealth(bookId, chapterId, chapterIdx, gate);
    return gate;
  }
}

/** 解析吸引力门结果；坏 JSON/截断/矛盾输出显式未审，只有“无 serious 问题”才 pass。 */
export function parseAttractionResult(content) {
  try {
    const parsed = extractJSON(content);
    if (!parsed || typeof parsed !== 'object') return { verdict: 'unreviewed', issues: [], reason: '吸引力审阅结果不是 JSON 对象' };
    const verdict = parsed.verdict;
    if (!['pass', 'fix', 'replan'].includes(verdict)) {
      return { verdict: 'unreviewed', issues: [], score: parsed.score, reason: `未知审阅结论：${String(verdict || '空')}` };
    }
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const serious = issues.filter(i => i.severity === 'high' || i.severity === 'medium');
    if (serious.length === 0) return { verdict: 'pass', issues: [], score: parsed.score, reason: parsed.reason || '' };
    if (verdict === 'pass') return { verdict: 'unreviewed', issues: [], score: parsed.score, reason: '结论为 pass 但同时返回 serious 问题' };
    return { verdict, issues: serious, score: parsed.score, reason: parsed.reason || '' };
  } catch (error) {
    return { verdict: 'unreviewed', issues: [], reason: `吸引力审阅解析失败：${error.message}` };
  }
}
