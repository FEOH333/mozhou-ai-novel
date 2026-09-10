// server/engine/opening.js —— V0.80 前20章开篇蓝图（Opening Blueprint）
// 治本：平凡少年修仙第1章写平凡少年日常无事件、前10章无战斗爽点、金手指迟迟不明确。
// 顶层必须有"前20章环环相扣"的结构化蓝图：每章钩子链、爽点节奏、金手指上线、目标阶梯、承诺期限。
// 数据：settings_json.openingBlueprint（结构化）+ materials('opening_blueprint')（注入文本，不进公共前缀）
'use strict';
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { openingBlueprintInstruction } from './prompts.js';
import { genrePackText } from '../data/creative_packs.js';
import { extractJSON } from '../util/json.js';
import { getGlobal } from '../config.js';
import { historicalPhaseText } from './historical_longform.js';
import { absolutePromiseDue } from './promise.js';
import { platformGuidanceText } from '../data/platform_guidance.js';
import { fanqieGenreProfileText } from '../data/fanqie_genre_profiles.js';
import { storyPromiseStatus, storyPromiseProfileText } from './story_promise.js';
import { isCompletedChapter } from './chapter_status.js';

function completedMaxIdx(bookId) {
  return store.chapters.list(bookId)
    .filter(isCompletedChapter)
    .reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
}

function normalizePromiseDeadlines(deadlines) {
  if (!Array.isArray(deadlines)) return [];
  return deadlines
    .map(item => {
      const promise = String(item?.promise || '');
      const due = absolutePromiseDue(promise);
      return due == null ? null : { ...item, promise, due_chapter: due };
    })
    .filter(Boolean);
}

/** 幂等生成开篇蓝图；默认必须消费最新创作宪章，显式跳过时才允许旧链路。 */
export async function generateOpeningBlueprint(bookId, { onEvent, signal, force = false, data, allowWithoutStoryPromise = false } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const settings = safeSettings(book);
  const chapterCount = getGlobal()?.openingBlueprintChapters || 20;
  // V0.102.1：开篇已过后不得因角色库/书纲对齐造成的指纹漂移重烧前 20 章钩子链。
  if (!force && settings.openingBlueprint && completedMaxIdx(bookId) > chapterCount) {
    return { ok: true, skipped: true, frozen: true, blueprint: settings.openingBlueprint };
  }
  const promiseStatus = storyPromiseStatus(bookId);
  if ((!promiseStatus.exists || promiseStatus.stale) && !allowWithoutStoryPromise) {
    return {
      ok: false,
      code: 'STORY_PROMISE_REQUIRED',
      error: promiseStatus.stale && promiseStatus.exists
        ? '创作画像已过期，请先重新建立创作宪章'
        : '创作画像未完成，请先建立创作宪章',
    };
  }
  const promiseFingerprint = promiseStatus.exists && !promiseStatus.stale
    ? promiseStatus.source_fingerprint : 'explicit-skip';
  if (!force && settings.openingBlueprint) {
    if (allowWithoutStoryPromise && promiseFingerprint === 'explicit-skip') {
      return { ok: true, skipped: true, blueprint: settings.openingBlueprint };
    }
    if (settings.openingBlueprint.story_promise_fingerprint === promiseFingerprint) {
      return { ok: true, skipped: true, blueprint: settings.openingBlueprint };
    }
  }
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const bookOutline = store.materials.get(bookId, 'outline')?.content || '';
  const pleasurePlan = (settings.pleasurePlan ? JSON.stringify(settings.pleasurePlan) : '') || store.materials.get(bookId, 'pleasure')?.content || '';
  try {
    let blueprint = data;
    if (!blueprint) {
      const res = await runTask({
        bookId, task: 'opening_blueprint', jsonMode: true, signal,
        messages: assembleMessages(bookId, [{
          role: 'user',
          content: openingBlueprintInstruction({
            bookTitle: book.title, genre: book.genre, platform: book.platform || '通用',
            contract, bookOutline, pleasurePlan, genreText: genrePackText(book.genre), chapterCount,
            storyPromise: storyPromiseProfileText(promiseStatus.profile),
            platformGuidance: platformGuidanceText(book.platform),
            genreProfile: fanqieGenreProfileText(book.genre, promiseStatus.profile?.texture?.route),
            // V0.82：历史题材（史实流）——"金手指"语义改为"立身之本/核心资本"
            isHistory: book.genre === '历史',
            historicalPhaseText: historicalPhaseText(book, 1),
          }),
        }]),
      });
      blueprint = extractJSON(res.content);
    }
    // 结构校验：必须有 hook_ladder（哪怕只有几章）才算可用
    if (!blueprint || !Array.isArray(blueprint.hook_ladder) || !blueprint.hook_ladder.length) {
      return { ok: false, error: '开篇蓝图解析失败或缺少 hook_ladder' };
    }
    blueprint = structuredClone(blueprint);
    blueprint.promise_deadlines = normalizePromiseDeadlines(blueprint.promise_deadlines);
    blueprint.story_promise_fingerprint = promiseFingerprint;
    settings.openingBlueprint = blueprint;
    store.books.update(bookId, { settings_json: JSON.stringify(settings) });
    // 注入文本材料（不进 buildPublicMaterials 前缀，只供卷纲/章细纲尾部消费）
    try { store.materials.set(bookId, 'opening_blueprint', formatBlueprintText(blueprint, { isHistory: book.genre === '历史' })); } catch { /* ignore */ }
    onEvent?.({ type: 'stage', stage: 'setup', message: book.genre === '历史'
      ? `开篇蓝图完成：${blueprint.hook_ladder.length} 章钩子链 + 立身之本（${blueprint.golden_finger?.power?.slice(0, 20) || '史实流' }）`
      : `开篇蓝图完成：${blueprint.hook_ladder.length} 章钩子链 + 金手指（${blueprint.golden_finger?.power?.slice(0, 20) || '待定'}）` });
    return { ok: true, blueprint };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 蓝图 → 注入文本（供卷大纲消费：只取前 N 章钩子链概览）
 *  V0.82：历史题材（史实流）不注入"金手指"（无金手指纯史实流），改注入"立身之本" */
export function openingBlueprintText(bookId, { maxChapters = 20 } = {}) {
  const bp = getBlueprint(bookId);
  if (!bp) return '';
  const isHistory = store.books.get(bookId)?.genre === '历史';
  const gf = bp.golden_finger;
  const lines = [];
  if (gf && !isHistory) lines.push(`金手指：${gf.power || ''}（激活第${gf.activate_chapter ?? '?'}章，限制：${gf.limit || '无'}）首次显威：${gf.first_display || ''}`);
  if (gf && isHistory) lines.push(`立身之本（史实流·无金手指）：${gf.power || ''}${gf.limit ? `｜当前边界：${gf.limit}` : ''}；不靠超常能力`);
  const hooks = (bp.hook_ladder || []).filter(h => h.chapter <= maxChapters);
  if (hooks.length) {
    lines.push('前20章钩子链：');
    for (const h of hooks) lines.push(`  ch${h.chapter}《${h.title || ''}》钩子：${(h.hook || '').slice(0, 40)}${h.payoff ? `｜爽点：${h.payoff.slice(0, 30)}` : ''}`);
  }
  const pacing = (bp.pleasure_pacing || []).filter(p => p.chapter <= maxChapters);
  if (pacing.length) lines.push(`爽点节奏：${pacing.map(p => `ch${p.chapter}(${p.type}:${(p.beat || '').slice(0, 20)})`).join('、')}`);
  return lines.join('\n');
}

/** 取第 N 章蓝图槽位（供章细纲注入：本章 hook/payoff/金手指里程碑/目标阶段） */
export function openingBlueprintForChapter(bookId, chapterIdx) {
  const bp = getBlueprint(bookId);
  if (!bp) return null;
  const hook = (bp.hook_ladder || []).find(h => h.chapter === chapterIdx);
  const pacing = (bp.pleasure_pacing || []).find(p => p.chapter === chapterIdx);
  const gf = bp.golden_finger;
  const goalStage = (bp.protagonist_goal_ladder || []).find(g => g.chapter === chapterIdx);
  if (!hook && !pacing && !(gf && gf.activate_chapter === chapterIdx) && !goalStage) return null;
  return {
    hook: hook?.hook || null,
    payoff: hook?.payoff || null,
    beat: hook?.beat || null,
    pacingType: pacing?.type || null,
    pacingBeat: pacing?.beat || null,
    goldenFingerMilestone: gf && gf.activate_chapter === chapterIdx ? { power: gf.power, limit: gf.limit, firstDisplay: gf.first_display } : null,
    goalStage: goalStage?.goal || null,
    goalStageName: goalStage?.stage || null,
  };
}

/** 蓝图文本格式化（materials('opening_blueprint') 存读；V0.82 历史题材分流"金手指"语义） */
export function formatBlueprintText(bp, { isHistory = false } = {}) {
  const gf = bp?.golden_finger;
  const lines = [];
  if (gf && !isHistory) lines.push(`金手指：${gf.power || ''}｜激活第${gf.activate_chapter ?? '?'}章｜限制：${gf.limit || '无'}｜首次显威：${gf.first_display || ''}`);
  if (gf && isHistory) lines.push(`立身之本（史实流·无金手指）：${gf.power || ''}${gf.limit ? `｜当前边界：${gf.limit}` : ''}；不靠超常能力`);
  if (Array.isArray(bp?.protagonist_goal_ladder)) {
    lines.push('主角目标阶梯：' + bp.protagonist_goal_ladder.map(g => `ch${g.chapter}(${g.stage || ''})：${g.goal || ''}`).join('；'));
  }
  const deadlines = normalizePromiseDeadlines(bp?.promise_deadlines);
  if (deadlines.length) {
    lines.push('契约承诺期限：' + deadlines.map(p => `${p.promise}→ch${p.due_chapter}`).join('；'));
  }
  return lines.join('\n');
}

function getBlueprint(bookId) {
  const book = store.books.get(bookId);
  if (!book) return null;
  return safeSettings(book).openingBlueprint || null;
}

function safeSettings(book) {
  try { return book.settings_json ? JSON.parse(book.settings_json) : {}; } catch { return {}; }
}
