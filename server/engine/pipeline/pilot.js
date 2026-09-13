// server/engine/pipeline/pilot.js —— AI 本位：一键自动全书（从当前进度连续写多章，checkpoint 可中断续跑）
// V0.16：集成 漂移检测与自动恢复（autoRecover）+ 上下文自动归档（runArchive）+ 人工出口（need_human）
'use strict';
import * as store from '../../db/store.js';
import { runChapterFlow } from './pipeline.js';
import { writeScene } from './write.js'; // V0.62：场景级补写（done 章缺失场景轻量补写，不重跑全流程）
import { ensureHistory, generateBookContract, generateBookOutline, generateVolumeOutline,
  generateChapterOutline, volumeChapterCount } from '../planning/outline.js';
import { generateBookSettings } from '../planning/settings.js';
import { planBookPleasure } from '../quality/pleasure.js';
import { runPolish, smoothTransitions, shouldRunMidStoryReview, readMidStoryCursor } from '../quality/polish.js';
import { logFlow } from '../../util/oplog.js';
import { getGlobal } from '../../config.js';
import { autoRecover, detectDrift, recoveryConfig, recordChapterHealth } from '../recovery/recovery.js';
import { autoReviewVolumes, runVolumeReview, reviewDueVolumes, shouldReviewVolumeBeforeLazyOutline, volumeReviewDisplayEvent } from '../planning/volumereview.js'; // V0.41 卷体检；V0.67 补体检候选
import { runArchive, checkArchiveNeed } from './archive.js';
import { shouldContinueBook, generateNextVolume, ENDING_DEFAULTS } from './continuation.js'; // V0.44：完本判定 + 自动续卷
import { tidyRoster, sweepVolumeCastDesign } from '../narrative/roster.js'; // V0.70：动态 import 静态化（无循环依赖，静态更清晰） // V0.105.4 cast 设计持久化 sweep（runCastDesign 移入 sweep 内部）
import { tidyFacts } from '../narrative/factbook.js'; // V0.68 事实库整理
import {
  checkChapterAlignment, checkVolumeAlignment, volumeAlignedRecently, bookAlignDue,
  adjustChapterTitle, adjustVolumeTitle, rewriteVolumeOutline, rewriteBookOutline, tidyChapterTitles,
} from '../longform/alignment.js'; // V0.45：三层大纲对齐（章名/卷名/卷大纲/书纲自动修订）
import { recoverMissingChapterContent } from './data_safety.js'; // V0.91：字数在但正文空时从最佳快照只增恢复
import { persistLifecycleCheckpoint } from '../longform/longform_lifecycle.js'; // V0.92：每卷阶段/兑付债务断点
import { isCompletedChapter, hasExplicitCompletedStatus, transitionChapterStatus } from './chapter_status.js'; // V0.93：完成态单一真源 // V0.93.2：状态写入单一真源 // V0.105.4 isCompletedVolume 随 cast sweep 移入 roster
import { ensureStoryPromiseProfile } from '../planning/story_promise.js'; // V0.98：先建立作品独有承诺，再规划开篇
import {
  prepareOpeningBeforeChapterOne, applyNewBookOpeningCandidate, maybeReviewOpening,
} from '../planning/opening_intervention.js';
import {
  shouldRefreshPublication, syncFanqiePublication,
} from '../quality/publication_feedback.js'; // V0.99：自动刷新发布边界并持续提示推荐失败

export { isCompletedChapter };

/**
 * V0.78 卡章自动修复：扫描全书 quality_blocked / partial 的章，用 runChapterFlow 修复
 * （partial 补缺失场景；quality_blocked 走原流程。纯 AI 味文本问题
 * 走 pipeline 的 textOnly 记债放行，不再死磕死循环）。
 * 每章每轮最多尝试 2 次（fixAttempts 计数），防无限烧钱；修复成功返回被修复的章号。
 * 在 while 主循环每轮开头调用一次，实现"写作间隙主动回头修复历史卡章"。
 * @returns {Promise<number[]>} 本轮修复成功的章节 idx
 */
async function autoFixBlocked(bookId, { signal, onEvent, fixAttempts }) {
  if (signal?.aborted) return [];
  const blocked = store.chapters.list(bookId)
    .filter(c => ['quality_blocked', 'partial'].includes(c.status) && (fixAttempts.get(c.id) || 0) < 2);
  if (!blocked.length) return [];
  const fixed = [];
  for (const ch of blocked) {
    if (signal?.aborted) break;
    const attempts = (fixAttempts.get(ch.id) || 0);
    fixAttempts.set(ch.id, attempts + 1);
    try {
      onEvent?.({ type: 'stage', stage: 'recovery', message: `自动修复卡住的第 ${ch.idx} 章《${ch.title}》（第 ${attempts + 1}/2 次尝试）…` });
      const r = await runChapterFlow(bookId, ch.id, { onEvent, signal, autoConfirm: true });
      if (isCompletedChapter(store.chapters.get(ch.id))) {
        fixed.push(ch.idx);
        onEvent?.({ type: 'chapter_done', chapterId: ch.id, idx: ch.idx, settled: r.settled, partial: false, recovered: true });
      } else {
        // 最早卡章尚未完成时，后面的卡章也不能越序修复。
        break;
      }
    } catch (e) {
      // 最早卡章修复失败：立即停止，不能让后章建立在未结算的前章上。
      onEvent?.({ type: 'chapter_error', chapterId: ch.id, idx: ch.idx, error: e.message });
      break;
    }
  }
  return fixed;
}

/** 质量门的自动重试预算：格式/截断可重试两次，正文不收敛只再给一轮，陈旧结算需显式修复。 */
export function qualityAutoRetryLimit(code) {
  if (code === 'AUDIT_INVALID' || code === 'COVERAGE_INVALID') return 2;
  if (code === 'QUALITY_GATE_FAILED' || code === 'SETTLEMENT_INVALID') return 1;
  return 0;
}

/** 章节终态失败统一暂停；质量门失败保留正文并标成 quality_blocked。 */
export function chapterFailurePolicy(code, { hasDraftContent = false } = {}) {
  const qualityStop = ['AUDIT_INVALID', 'COVERAGE_INVALID', 'QUALITY_GATE_FAILED', 'SETTLEMENT_INVALID', 'SETTLEMENT_STALE', 'OUTLINE_GUARD_FAILED', 'CHAPTER_LENGTH_BLOCKED'].includes(code); // V0.93.3：细纲硬防线失败归类质量门；V0.103.1：字数门同权，避免 catch 改成 drafted 后自动修复看不见
  return {
    qualityStop,
    status: qualityStop ? 'quality_blocked' : (hasDraftContent ? 'drafted' : 'planned'),
    pause: true,
  };
}

/** pilot 启动前正文自愈；独立导出便于只测数据修复而不触发 LLM。 */
export function repairMissingDraftsBeforePilot(bookId, { onEvent } = {}) {
  const result = recoverMissingChapterContent(bookId);
  if (result.recovered > 0) {
    onEvent?.({
      type: 'content_recovered',
      count: result.recovered,
      chapters: result.candidates.map(candidate => candidate.idx),
      message: `检测到 ${result.recovered} 章正文缺失，已从内容最完整的快照只增恢复（未覆盖现有正文）`,
    });
  }
  return result;
}

/**
 * 自动全书模式：确保基础骨架（契约/书纲/卷纲/章）后，从第一个未完成章节连续写到 targetChapters。
 * 每章完成后 checkpoint（章节 status=done），中断后再次调用会从断点继续。
 * V0.16 保障：连续失败/质量问题 → 全局诊断 + 自动修复/重规划；历史超预算 → 自动归档（防降智）。
 * @param {string} bookId
 * @param {object} [opts]
 *   { targetChapters?: number  目标章数（默认：全部已建章节）
 *     idea?: string            灵感（无书纲时用于生成书契约+书纲）
 *     polish?: boolean         全部写完后自动全书打磨
 *     onEvent?: fn             事件回调（stage/chapter_start/chapter_done/recovery/archive/need_human/done/error）
 *     signal?: AbortSignal }
 */
export async function runBookPilot(bookId, opts = {}) {
  const pilotStarted = Date.now();
  logFlow({ op: 'pilot_start', level: 'info', detail: `目标章数=${opts.targetChapters || '全部'}`, bookId });
  const { targetChapters, idea, polish = false, skipStoryPromise = false, onEvent, signal } = opts;
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const emit = (type, data) => onEvent?.({ type, ...data });
  const emitVolumeReview = result => {
    const event = volumeReviewDisplayEvent(result);
    if (event.type === 'volume_review_done') emit('volume_review_done', event.data);
    else emit('volume_review_error', event.data);
  };
  // 公开页是“已发布边界”的观察源，不是创作真相。过期时自动刷新一次；网络或页面漂移
  // 只发可见警告并沿用最近成功快照，绝不能让外部站点故障卡死本地创作。
  const initialPublication = store.publicationProfiles.get(bookId);
  if (shouldRefreshPublication(initialPublication)) {
    emit('publication_feedback', { stage: 'syncing', message: '正在刷新番茄已发布章节与公开数据…' });
    try {
      const synced = await syncFanqiePublication(bookId, { signal, timeoutMs: 10000 });
      emit('publication_feedback', {
        stage: synced.profile.recommendation_stage,
        publishedChapterCount: synced.profile.published_chapter_count,
        localChapterCount: synced.localChapterCount,
        message: `番茄公开进度已刷新：发布到第 ${synced.profile.published_chapter_count} 章，本地共 ${synced.localChapterCount} 章`,
      });
    } catch (error) {
      if (error.code === 'ABORTED') throw error;
      emit('publication_feedback', {
        stage: 'sync_error', code: error.code || 'FANQIE_SYNC_FAILED',
        message: `番茄公开进度刷新失败：${error.message}；本次继续使用最近成功快照`,
      });
    }
  }
  const publication = store.publicationProfiles.get(bookId);
  if (publication) {
    emit('publication_feedback', {
      stage: publication.recommendation_stage,
      remainingAttempts: publication.remaining_attempts,
      publishedChapterCount: publication.published_chapter_count,
      pendingSyncChapters: publication.pending_sync_chapters,
      message: publication.recommendation_stage === 'failed'
        ? `P0 内容质量事故：推荐评估未通过，剩余 ${publication.remaining_attempts ?? '未知'} 次；后续规划必须反思第 7—20 章注水问题，不能用楔子或继续堆字数代替整改`
        : '平台发布反馈已注入本轮规划、写作与审核',
    });
  }
  // 任何 LLM/重规划动作之前先修复“word_count 非零但 scenes 正文为空”的已知损坏模式。
  repairMissingDraftsBeforePilot(bookId, { onEvent });
  ensureHistory(bookId);
  const cfg = recoveryConfig();

  // 明确目标已在断点中完成时直接返回，不能为了“补齐卷纲”又把已裁掉的未来
  // 计划章重新建回来。无目标的一键全书仍照常执行骨架与续卷流程。
  if (targetChapters && targetChapters > 0) {
    const existingChapters = store.chapters.list(bookId);
    const completedAtTarget = existingChapters.filter(isCompletedChapter).length >= targetChapters;
    if (completedAtTarget) {
      const reportedTotal = Math.min(targetChapters, existingChapters.length);
      emit('stage', { stage: 'done', message: `已达目标章数 ${targetChapters} 章` });
      emit('done', { written: reportedTotal, total: reportedTotal, partial: false, partialChapters: 0, blocked: [] });
      return { written: reportedTotal, total: reportedTotal, partialChapters: 0 };
    }
  }

  // 1) 骨架保障：书契约 → 书纲（缺失才生成，已有则跳过）
  if (!store.materials.get(bookId, 'contract')?.content) {
    emit('stage', { stage: 'setup', message: '生成书契约…' });
    await generateBookContract(bookId, { idea });
  }
  if (!store.materials.get(bookId, 'outline')?.content) {
    emit('stage', { stage: 'setup', message: '生成书级大纲…' });
    const before = store.books.get(bookId)?.title || '';
    await generateBookOutline(bookId, {});
    // V0.26：书纲生成后按大纲命名（用户方向：先大纲后取名）
    const after = store.books.get(bookId)?.title || '';
    if (before !== after) emit('stage', { stage: 'setup', message: `已按大纲命名为《${after}》` });
  }
  // V0.83 修复：快感计划/开篇蓝图/设定生成从"书纲缺失"块内移出（各自幂等）——
  // 老书/中断书重跑时书纲已存在 → 此前三步整体被跳过，开篇蓝图且无手动端点可补。
  // V0.17：书级快感计划（奖励节奏/情绪轮换/压抑释放/弧线/情感线/主角配方）
  // V0.80 时序修复：设定生成之前先出快感计划——settings.js:56 一直读 materials('pleasure')
  // 但此前 planBookPleasure 在设定之后才跑，设定永远读不到（死读）。前移后设定可消费快感计划。
  let settings = {}; try { settings = JSON.parse(store.books.get(bookId).settings_json || '{}'); } catch { /* ignore */ }
  if (!settings.pleasurePlan) {
    emit('stage', { stage: 'setup', message: '生成书级快感计划…' });
    const pp = await planBookPleasure(bookId, { onProgress: p => emit('progress', p) });
    if (pp.ok) emit('stage', { stage: 'setup', message: '快感计划完成（奖励节奏/情绪轮换/代入感配方）' });
  }
  // V0.28：设定全自动（书纲完成后自动生成世界观/人物卡/地点/物品/势力/世界书词条）
  if (!store.materials.get(bookId, 'world')?.content) {
    emit('stage', { stage: 'setup', message: '自动生成设定（世界观/地点/物品/势力/世界书）…' });
    const sr = await generateBookSettings(bookId, { onEvent: (ev) => emit('stage', ev), signal });
    if (!sr.ok && !sr.skipped) emit('stage', { stage: 'setup', message: `设定生成失败：${sr.error}（可在设定页重试）` });
  }
  // V0.81 历史时代背景卡（史实锚点/官职/地理/时代红线/可改史点——历史质感与防时代错误）
  try {
    const { ensureEraContext } = await import('../narrative/history.js');
    const ec = await ensureEraContext(bookId, { signal, onEvent });
    if (!ec.ok && ec.error && store.books.get(bookId)?.genre === '历史') {
      emit('stage', { stage: 'setup', message: `时代背景卡生成失败（${ec.error.slice(0, 40)}），将用通用考据参考` });
    }
  } catch { /* 时代背景卡失败不阻塞 */ }
  // V0.98：设定与历史红线齐备后，先建立本书独有创作宪章，再允许规划开篇。
  const promiseResult = await ensureStoryPromiseProfile(bookId, { signal, onEvent });
  if (!promiseResult.ok) {
    emit('stage', { stage: 'setup', message: `创作画像未完成：${promiseResult.error}。再次启动会自动重试。` });
    if (!skipStoryPromise) {
      emit('need_human', {
        code: 'STORY_PROMISE_REQUIRED',
        message: `创作画像未完成（${promiseResult.error}），已在写第一章前安全暂停；可重试，或明确选择“跳过创作画像”沿用旧蓝图。`,
        suggestions: ['重试建立创作画像', '检查契约/大纲后重试', '明确跳过并沿用旧蓝图'],
      });
      const current = store.chapters.list(bookId);
      return {
        written: current.filter(isCompletedChapter).length,
        total: current.length,
        blocked: ['story_promise'],
        code: 'STORY_PROMISE_REQUIRED',
      };
    }
    emit('stage', { stage: 'setup', message: '已按用户明确选择跳过创作画像；仅本次降级沿用旧开篇蓝图。' });
  } else {
    emit('stage', { stage: 'setup', message: `本书创作宪章完成：${promiseResult.profile.primary_attraction_axis}` });
  }

  // V0.80/V0.98：开篇蓝图绑定创作宪章指纹；画像改变后自动重建。
  try {
    const { generateOpeningBlueprint } = await import('../planning/opening.js');
    const ob = await generateOpeningBlueprint(bookId, {
      onEvent,
      signal,
      allowWithoutStoryPromise: skipStoryPromise && !promiseResult.ok,
    });
    if (ob.ok && !ob.skipped) emit('stage', { stage: 'setup', message: store.books.get(bookId)?.genre === '历史'
      ? '前20章开篇蓝图完成（年代锁/钩子阶梯/阅读回报/立身之本）'
      : '前20章开篇蓝图完成（钩子阶梯/回报节奏/核心玩法）' });
    if (!ob.ok) emit('stage', { stage: 'setup', message: `开篇蓝图生成失败：${ob.error}（保留现有内容，可稍后重试）` });
  } catch (error) {
    emit('stage', { stage: 'setup', message: `开篇蓝图生成失败：${error?.message || error}（保留现有内容，可稍后重试）` });
  }
  let volumes = store.volumes.list(bookId);
  if (!volumes.length) {
    // V0.20 修复：无卷时兜底创建一卷（此前为死代码，卷大纲永不生成）
    emit('stage', { stage: 'setup', message: '创建首卷并生成卷大纲…' });
    const v = store.volumes.create(bookId, 1, { title: '第一卷', goal: '', outline: {}, status: 'planned' });
    // V0.85：卷大纲失败软降级——建空章结构让自动创作可继续（后续卷纲由每卷懒生成/续卷兜底），不崩自动创作
    try {
      await generateVolumeOutline(bookId, v.id, { chapterCount: volumeChapterCount(book, { isFirst: true }) });
    } catch (e) {
      emit('stage', { stage: 'setup', message: `首卷卷大纲生成失败（${String(e?.message || e).slice(0, 50)}），已建空卷结构，可稍后手动重试` });
      for (let i = 1; i <= volumeChapterCount(book, { isFirst: true }); i++) {
        store.chapters.create(bookId, v.id, i, { title: `第${i}章`, status: 'planned' });
      }
    }
    volumes = store.volumes.list(bookId);
  }
  // V0.83 懒卷纲：只预生成前 2 卷卷大纲（书纲"后续卷写概要、细节留到卷大纲阶段实时生成"），
  // 后续卷进入 planned 按卷序懒生成（写到哪卷生成哪卷，pilot 主循环每卷开始前检查）
  const eagerVolumes = volumes.filter(v => v.idx <= 2);
  for (const v of eagerVolumes) {
    if (store.chapters.listByVolume(v.id).length === 0) {
      emit('stage', { stage: 'setup', message: `生成第${v.idx}卷大纲…` });
      // V0.85：失败不崩——主循环懒卷纲/续卷路径会再兜底
      try {
        await generateVolumeOutline(bookId, v.id, { chapterCount: volumeChapterCount(book) });
      } catch (e) {
        emit('stage', { stage: 'setup', message: `第${v.idx}卷卷大纲生成失败（${String(e?.message || e).slice(0, 50)}），将按序续写时重试` });
      }
    }
  }
  // 无任何卷/章时：兜底建 1 卷
  if (!store.chapters.list(bookId).length) {
    const v = store.volumes.list(bookId)[0] || store.volumes.create(bookId, 1, { title: '第一卷' });
    try {
      await generateVolumeOutline(bookId, v.id, { chapterCount: volumeChapterCount(book, { isFirst: true }) });
    } catch { /* 兜底失败由主循环懒卷纲/续卷重试 */ }
  }

  // V0.98：新书在第一章正文产生前先比较不同进入逻辑。失败或无稳定胜者均沿用正常蓝图，
  // 不清章、不重置、不阻断；只有跨模型两轮稳定胜者才自动成为第一章草稿。
  const openingChapters = store.chapters.list(bookId);
  const hasAnyNarrativeText = openingChapters.some(chapter => String(store.chapters.fullText(chapter.id) || '').trim());
  if (!hasAnyNarrativeText && openingChapters.some(chapter => Number(chapter.idx) === 1) && promiseResult.ok) {
    try {
      const prepared = await prepareOpeningBeforeChapterOne(bookId, { signal, onEvent });
      if (prepared.auto_safe && prepared.winner) {
        emit('opening_stage', { step: 'selected', detail: `跨模型稳定胜者：${prepared.winner.strategy_family || '第一章方案'}` });
        const applied = applyNewBookOpeningCandidate(bookId, prepared.winner);
        if (applied.ok) emit('opening_stage', { step: 'applied', detail: '稳定方案已成为第一章草稿，继续正常审校与结算' });
        else emit('opening_stage', { step: 'unreviewed', detail: `稳定方案未自动采用：${applied.message}` });
      } else if (!prepared.skipped) {
        emit('opening_stage', { step: 'rejected', detail: prepared.status === 'single_model_advisory'
          ? '同模型冷读仅供参考，沿用正常第一章蓝图'
          : '未找到跨两轮稳定胜者，沿用正常第一章蓝图' });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
      emit('opening_stage', { step: 'unreviewed', detail: `开篇候选未完成：${String(error?.message || error).slice(0, 120)}；已沿用正常第一章蓝图` });
    }
  } else if (hasAnyNarrativeText && promiseResult.ok) {
    const latestCompleted = openingChapters.filter(isCompletedChapter).reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
    if (latestCompleted) await maybeReviewOpening(bookId, latestCompleted, { signal, onEvent });
  }

  // V0.43：自动创作前自动快照（每天一次，写坏可回滚）
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existing = store.snapshots.list(bookId) || [];
    if (!existing.some(s => (s.label || '').includes(today))) {
      store.snapshots.add(bookId, { label: `自动快照 ${today}（开始自动创作前）`, source: 'auto', data: store.snapshotBook(bookId) });
    }
  } catch { /* 快照失败不阻塞写作 */ }

  // V0.41：启动补审——写一半的书/中断续跑的书，先对"已完成的卷"做卷级体检（幂等：已审不重审）
  // 适配"写一半还没完成的任务"：已完成卷补审 + 未完成卷跳过，不打断续写
  const backfillReviews = await autoReviewVolumes(bookId, { signal, onEvent, maxVolumes: 1 });
  for (const r of backfillReviews) {
    emitVolumeReview(r);
  }

  // 2) 逐章自动写作（从断点继续；集成漂移恢复 + 自动归档 + 卷级审阅 + V0.44 自动续卷）
  let written = 0;
  let partialChapters = 0; // V0.21：含失败场景的章节数（重跑自动补写）
  let recoveryRounds = 0;
  // 一次全局恢复会把约束作用到后续数章；必须等完整的新鲜观察窗写出来后才能再次判定。
  // 旧实现把仍含恢复前坏章的滑窗逐章重复诊断，连续叠加恢复约束，并在第 4/5 章误停。
  const recoveryObservationChapters = 3;
  let lastRecoveryAtDoneCount = null;
  let continuations = 0; // V0.44 续卷轮数
  const seen = new Set(); // V0.44 续卷后重新拉章节，防重复计数
  // 卡章必须按章号顺序修复；最早卡章未通过时暂停，禁止越序继续写后文。
  const blockedChapters = new Set();
  const fixAttempts = new Map(); // chapterId → 修复尝试次数（≥2 本轮不再修，防无限烧钱）
  // V0.62 补写通道：缺章（生成失败跳过的旧章）+ 缺场景（done 章含 failed/draft 场景）自动检测补写
  const backfillAttempts = new Map(); // chapterId → 尝试次数（≥2 本轮不再试，防无限重试烧钱）
  const backfillMissed = async (cap) => {
    if (signal?.aborted) return 0;
    const chapters = store.chapters.list(bookId);
    const maxDone = chapters.filter(isCompletedChapter)
      .reduce((m, c) => Math.max(m, c.idx), 0);
    let backfilled = 0;
    // 1) 缺场景的已完成章（部分场景生成失败 → 轻量补写，不重跑审校/结算防重复消费）
    for (const ch of chapters) {
      if (signal?.aborted) break;
      if (!hasExplicitCompletedStatus(ch)) continue; // V0.93.1：终态判定走单一真源
      if (backfillAttempts.get(ch.id) >= 2) continue;
      const missing = store.scenes.list(ch.id).filter(s => s.status !== 'done' && s.status !== 'revised');
      if (!missing.length) continue;
      backfillAttempts.set(ch.id, (backfillAttempts.get(ch.id) || 0) + 1);
      emit('backfill', { idx: ch.idx, title: ch.title, scenes: missing.length, message: `补写第 ${ch.idx} 章缺失的 ${missing.length} 个场景…` });
      for (const scene of missing) {
        if (signal?.aborted) break;
        try {
          // V0.96.5：writeScene 不消费 onEvent（此前传了等于补写零统计零流式）——
          // 补写与主流程同源透传 onDelta/onUsage/onUsageCost
          const r = await writeScene(bookId, ch.id, scene.id, {
            onDelta: d => onEvent?.({ type: 'delta', sceneId: scene.id, delta: d }),
            onUsage: u => onEvent?.({ type: 'usage', ...u, sceneId: scene.id }),
            onUsageCost: c => onEvent?.({ type: 'usage_cost', ...c }),
            signal,
          });
          if (r?.content) { backfilled++; emit('backfill_scene', { chapterIdx: ch.idx, sceneIdx: scene.idx }); }
        } catch { /* 补写失败：下轮再试（attempts 已计数） */ }
      }
      if (store.scenes.list(ch.id).every(scene => ['done', 'revised'].includes(scene.status) && String(scene.content || '').trim())) {
        store.conflicts.resolveRecoveredChapter(ch.id, store.chapters.fullText(ch.id));
        const health = store.chapterHealth.getByChapter(ch.id);
        if (health?.failed) store.chapterHealth.update(health.id, { verdict: 'ok', failed: 0, notes: '' });
      }
    }
    // 2) 被跳过的旧章（status=planned 且位于已写进度附近 → 完整重跑）
    for (const ch of chapters) {
      if (signal?.aborted) break;
      if (ch.status !== 'planned') continue;
      if (ch.idx > (cap || chapters.length)) continue; // 尊重目标章数
      if (ch.idx > maxDone + 1) break; // 只补已写区间内的缺章（未来章 planned 是正常的）
      if (backfillAttempts.get(ch.id) >= 2) continue;
      backfillAttempts.set(ch.id, (backfillAttempts.get(ch.id) || 0) + 1);
      emit('backfill', {
        idx: ch.idx, title: ch.title,
        message: ch.idx < maxDone
          ? `补写被跳过的第 ${ch.idx} 章…`
          : `续写第 ${ch.idx} 章…`,
      });
      try {
        const r = await runChapterFlow(bookId, ch.id, { onEvent, signal, autoConfirm: true });
        if (isCompletedChapter(store.chapters.get(ch.id))) { backfilled++; seen.add(ch.id); } // V0.72：补写成功登记 seen，防主循环按旧快照重写
        else { seen.delete(ch.id); } // V0.72：未完成（awaiting_confirm/异常）→ 放行让主循环兜底
      } catch (error) {
        seen.delete(ch.id);
        if (error?.code === 'ABORTED' || error?.name === 'AbortError') throw error;
        const failure = chapterFailurePolicy(error?.code, {
          hasDraftContent: store.scenes.list(ch.id).some(scene => String(scene.content || '').trim()),
        });
        if (failure.qualityStop) {
          transitionChapterStatus(bookId, ch.id, failure.status, { reason: `补写质量门（${error.code}）` });
          recordChapterHealth(bookId, ch.id, {
            verdict: 'error', issues: [], failed: true,
            note: `失败代码：${error.code || 'unknown'}；${String(error.message || '').slice(0, 180)}`,
          });
          emit('chapter_blocked', {
            idx: ch.idx, error: error.code,
            message: `第 ${ch.idx} 章补写未通过质量门（${error.code}），已暂停后续创作`,
          });
          break;
        }
      }
    }
    return backfilled;
  };
  let fatal = false; // V0.73：系统性故障（熔断/鉴权）提前终止整个自动创作
  // V0.105.4：cast 设计幂等标记改由 sweepVolumeCastDesign 持久化（books.settings.castDesignedVolumes）。
  // 旧实现是进程内存 Set，重启即丢——每次自动创作重启都对全部历史完成卷重跑全书级
 // cast_design（实测 49 章实证 vol1-5 连烧 5 次、cast_text 被重写 5 次）。
  let writtenWords = 0; // V0.96.5：本轮产出字数（done 事件效率观察面）
  while (true) {
    if (signal?.aborted) break;
    // V0.83 懒卷纲：前 2 卷写完后，按卷序懒生成后续卷大纲（书纲建了卷行但无章）——
    // 开书时不再一次性触发 10-30 次卷大纲 LLM 调用，且后续卷规划不被过早锁定
    try {
      const volsNow = store.volumes.list(bookId);
      const nextLazy = volsNow.find(v => v.idx > 2 && store.chapters.listByVolume(v.id).length === 0);
      if (nextLazy) {
        const allChs = store.chapters.list(bookId);
        const allDone = allChs.length > 0 && allChs.every(isCompletedChapter);
        if (allDone) {
          const prevVol = volsNow.find(v => v.idx === nextLazy.idx - 1);
          if (prevVol) {
            const duePrev = reviewDueVolumes(bookId)
              .filter(d => d.id === prevVol.id)
              .filter(shouldReviewVolumeBeforeLazyOutline);
            for (const dv of duePrev) {
              emit('volume_review_start', { volumeIdx: dv.idx, message: `卷缝前体检：第 ${dv.idx} 卷（${dv.reason}）…` });
              try {
                const reviewed = await runVolumeReview(bookId, dv.id, { signal, onEvent });
                emitVolumeReview({ volumeIdx: dv.idx, ...reviewed });
              } catch { /* 卷缝前体检失败不阻断懒卷纲 */ }
            }
          }
          emit('stage', { stage: 'setup', message: `生成第${nextLazy.idx}卷大纲（懒加载，含卷缝）…` });
          try {
            await generateVolumeOutline(bookId, nextLazy.id, { chapterCount: volumeChapterCount(book) }, { onEvent, signal });
            continue;
          } catch (error) {
            if (error?.code === 'ABORTED' || error?.name === 'AbortError') throw error;
            emit('stage', {
              stage: 'setup',
              message: `第${nextLazy.idx}卷懒加载失败（${String(error?.message || error).slice(0, 80)}），改由续卷路径兜底`,
            });
            if (store.chapters.listByVolume(nextLazy.id).length) continue;
          }
        }
      }
    } catch (error) {
      if (error?.code === 'ABORTED' || error?.name === 'AbortError') throw error;
      /* 懒卷纲失败由续卷路径兜底 */
    }
    const chapters = store.chapters.list(bookId);
    const cap = targetChapters && targetChapters > 0 ? targetChapters : chapters.length;
    // targetChapters 表示本轮只推进到指定全书章号。新书书纲会预建整卷计划章，
    // 目标之外的 future planned 章不是“生成失败”，也不应让调用方误以为本轮未完成。
    // 仅在没有任何正文/场景时裁掉目标外的纯空白计划章；存量书及已有正文的规划不动。
    if (targetChapters && chapters.length > cap) {
      const beyond = chapters.filter(chapter => chapter.idx > cap);
      const pristine = chapters.every(chapter => store.chapters.fullText(chapter.id).length === 0)
        && beyond.every(chapter => chapter.status === 'planned' && store.scenes.list(chapter.id).length === 0);
      if (pristine) {
        for (const chapter of beyond) store.chapters.remove(chapter.id);
        continue;
      }
    }
    // 写任何新章/补写前，必须先按章号修复历史卡章。
    try {
      const fixed = await autoFixBlocked(bookId, { signal, onEvent, fixAttempts });
      if (fixed.length) {
        for (const idx of fixed) blockedChapters.delete(idx);
        emit('blocked_fixed', { chapters: fixed, message: `已自动修复卡住的章节：${fixed.map(i => `第${i}章`).join('、')}` });
      }
    } catch { /* 下方实时状态闸会拦住未修复章节 */ }
    const earliestBlocked = store.chapters.list(bookId)
      .find(chapter => ['quality_blocked', 'partial', 'failed'].includes(chapter.status));
    if (earliestBlocked) {
      blockedChapters.add(earliestBlocked.idx);
      emit('blocked_pending', {
        chapters: [earliestBlocked.idx],
        message: `第 ${earliestBlocked.idx} 章仍未完成（${earliestBlocked.status}），已暂停后续创作；再次启动将继续修复本章`,
      });
      emit('need_human', {
        chapterId: earliestBlocked.id,
        message: `第 ${earliestBlocked.idx} 章尚未修复完成，后续章节没有继续生成，正文均已保留。`,
      });
      fatal = true;
      break;
    }
    // 卡章清零后再补写中断/遗漏场景，保证严格叙事顺序。
    if (written === 0) {
      try {
        const bf = await backfillMissed(cap);
        if (bf > 0) emit('backfill_done', { count: bf, message: `补写完成：共 ${bf} 处` });
      } catch { /* 补写失败由主循环在对应章节再次处理 */ }
      // 补写把章打成 quality_blocked 后必须回到 while 头走 autoFixBlocked，
      // 不能拿本轮开始时的 planned 快照进 for 立刻 fatal。
      if (store.chapters.list(bookId).some(c => ['quality_blocked', 'partial'].includes(c.status))) continue;
    }
    let chapterSinceBackfill = 0; // V0.62：每写 3 章再补查一次（防缺漏长期滞留）
    for (const ch of chapters.slice(0, cap)) {
      if (signal?.aborted || fatal) break;
      if (seen.has(ch.id)) continue;
      seen.add(ch.id);
      // V0.72 修复：快照状态过期导致补写完成的章被重复写（快照里 planned、DB 已 done）——
      // 改为实时查库；补写/续卷/多轮交错下状态始终准确
      const cur = store.chapters.get(ch.id);
      if (isCompletedChapter(cur)) { written++; continue; } // 断点续跑/补写已完成
      // 理论上已被轮首状态闸处理；保留兜底，遇到卡章立即暂停而非跳过。
      if (cur?.status === 'quality_blocked') {
        blockedChapters.add(ch.idx);
        fatal = true;
        break;
      }
      emit('chapter_start', { chapterId: ch.id, idx: ch.idx, title: ch.title || `第${ch.idx}章`, progress: `${written}/${cap}` });
      const chapterStartedAt = Date.now(); // V0.96.5：单章耗时（chapter_done 效率观察面）
    try {
      let r;
      let qualityRetry = 0;
      while (true) {
        try {
          r = await runChapterFlow(bookId, ch.id, { onEvent, signal, autoConfirm: true });
          if (r.status === 'awaiting_confirm') {
            emit('stage', { stage: 'write', message: '自动确认细纲，继续写作…' });
            r = await runChapterFlow(bookId, ch.id, { onEvent, signal, autoConfirm: true });
          }
          break;
        } catch (error) {
          const limit = qualityAutoRetryLimit(error.code);
          if (signal?.aborted || qualityRetry >= limit) throw error;
          qualityRetry++;
          emit('stage', {
            stage: 'audit',
            message: `第 ${ch.idx} 章质量门返回 ${error.code}，自动重试 ${qualityRetry}/${limit}…`,
          });
        }
      }
      // 场景内部与 pipeline 已经做过多轮网络重试；再补跑一次只写缺失场景。
      // 若仍不完整，必须停在本章，不能让后文建立在叙事空洞上。
      if (r.status === 'partial' && !signal?.aborted) {
        emit('stage', { stage: 'write', message: `第 ${ch.idx} 章仍有缺失场景，自动补写一次…` });
        r = await runChapterFlow(bookId, ch.id, { onEvent, signal, autoConfirm: true });
      }
      if (r.status === 'partial') {
        partialChapters++;
        seen.delete(ch.id);
        emit('need_human', {
          message: `第 ${ch.idx} 章仍有 ${r.failedScenes?.length || 1} 个场景未完成，已暂停后续章节；再次点击“开始自动创作”会从本章续跑。`,
          chapterId: ch.id,
          failedScenes: r.failedScenes || [],
        });
        fatal = true;
        break;
      }
      // V0.96.5：chapter_done 带字数与耗时（效率观察面——此前只有"第 N 章完成"无量化）
      const chapterWordCount = Number(store.chapters.get(ch.id)?.word_count || 0);
      writtenWords += chapterWordCount;
      emit('chapter_done', { chapterId: ch.id, idx: ch.idx, settled: r.settled, partial: false, wordCount: chapterWordCount, durationMs: Date.now() - chapterStartedAt });
      // 第1/3/10章与作者配置字数点复核开篇实际供给；坏 JSON/模型不可用只标 unreviewed。
      await maybeReviewOpening(bookId, ch.idx, { signal, onEvent });
      // V0.80 契约承诺兑现校验：到期承诺未兑现 → 约束注入下一章优先补（不阻塞，仅到期章触发 LLM）
      try {
        const { checkPromiseFulfillment } = await import('../planning/promise.js');
        const unfilled = await checkPromiseFulfillment(bookId, ch.idx, { signal });
        if (unfilled.some(u => !u.met)) {
          emit('debt', { message: `契约承诺未兑现：${unfilled.filter(u => !u.met).map(u => u.text).join('；')}——下一章优先补` });
        }
      } catch { /* 承诺校验失败不阻塞写作 */ }
      // 开篇文本发布前预审：前三章形成可读样本后按正文指纹审阅；不预测平台签约或推流结果。
      try {
        const { signingDue, simulateSigningReview, rewriteOpening } = await import('../planning/signing.js');
        if (signingDue(bookId)) {
          emit('stage', { stage: 'signing', message: '开篇文本已形成可审样本，正在读取真实正文做发布前预审…' });
          const sr = await simulateSigningReview(bookId, { signal, onEvent });
          if (sr.ok && sr.review?.verdict && sr.review.verdict !== 'pass') {
            emit('need_human', {
              message: `开篇文本预审发现问题（${sr.review.score ?? '?'}分）：${(sr.review.reason || '').slice(0, 60)}。正在登记有证据的修订任务（原稿保留）…`,
              suggestions: ['运行开篇诊断与候选对比', '查看原文引文', '保留原稿继续写'],
            });
            const feedback = (sr.review.issues || []).map(i => `[${i.type}] ${i.issue}${i.fix ? `→${i.fix}` : ''}`).join('；');
            const rw = await rewriteOpening(bookId, { toChapter: ch.idx, feedback, signal, onEvent });
            if (rw.ok) {
              emit('stage', { stage: 'rewrite', message: `开篇修订建议已登记：ch1..ch${rw.targetChapters || ch.idx} 原稿保持不变；后续按反馈改进` });
            }
          }
        }
      } catch { /* 签约评审失败不阻塞写作 */ }
      logFlow({ op: `chapter_done #${ch.idx}`, detail: 'ok', bookId, durationMs: Date.now() - pilotStarted });
    } catch (e) {
      // V0.93.4：用户主动中止（停止/断连）不是失败——不弹人工提示、健康记 aborted、
      // 状态保持当前值，下次启动从断点续写（writing 场景由 recoverInterruptedScenes 归位）。
      if (e.code === 'ABORTED' || e.name === 'AbortError') {
        recordChapterHealth(bookId, ch.id, { verdict: 'aborted', issues: [], failed: false, note: '用户中止，下次启动从断点续写' });
        emit('stage', { stage: 'aborted', message: `第 ${ch.idx} 章已中止（用户停止），正文与草稿已保留` });
        fatal = true;
        break;
      }
      emit('chapter_error', { chapterId: ch.id, idx: ch.idx, error: e.message });
      const failure = chapterFailurePolicy(e.code, {
        hasDraftContent: store.scenes.list(ch.id).some(scene => String(scene.content || '').trim()),
      });
      transitionChapterStatus(bookId, ch.id, failure.status, { reason: `章节失败策略（${e.code || 'unknown'}）` });
      // V0.93.3：失败信息落库（此前只记 verdict=error 无原因，卡章后无法定位根因）
      recordChapterHealth(bookId, ch.id, {
        verdict: 'error', issues: [], failed: true,
        note: `失败代码：${e.code || 'unknown'}；${String(e.message || '').slice(0, 180)}`,
      });
      // V0.73 修复：失败章节从 seen 移除，让后续轮/backfill 重试（此前永久漏写）；
      // 熔断/鉴权失败是系统性故障，继续空跑 N 章浪费钱且污染统计 → 提前人工出口
      seen.delete(ch.id);
      if (e.code === 'CIRCUIT_OPEN' || e.code === 'AUTH_ERROR') {
        emit('need_human', { message: `LLM 服务异常（${e.code === 'CIRCUIT_OPEN' ? '服务商熔断' : 'API Key 无效'}），已暂停自动创作。请检查设置后重新开始。` });
        fatal = true;
        break;
      }
      if (failure.qualityStop) {
        blockedChapters.add(ch.idx);
        emit('chapter_blocked', { idx: ch.idx, error: e.code, message: `第 ${ch.idx} 章未通过质量门（${e.code}），已暂停后续创作；再次启动会先自动修复本章` });
      } else {
        emit('need_human', { chapterId: ch.id, message: `第 ${ch.idx} 章生成失败，已暂停后续创作；正文与草稿均已保留，再次启动会从本章重试。` });
      }
      fatal = failure.pause;
      break;
    }
    written++;

    // ---- V0.62：每写 3 章补查一次缺漏（生成失败的章/场景自动补齐，防长期滞留） ----
    chapterSinceBackfill++;
    if (chapterSinceBackfill >= 3 && !signal?.aborted) {
      chapterSinceBackfill = 0;
      try {
        const bf = await backfillMissed(cap);
        if (bf > 0) emit('backfill_done', { count: bf, message: `补写完成：共 ${bf} 处` });
      } catch { /* 补写失败不阻塞主流程 */ }
    }

    // ---- V0.52：自动创作中每 5 章自动整理角色库（AI 本位：分级/补全无需手动点；candidates 为空时零 LLM 成本） ----
    if (written > 0 && written % 5 === 0 && !signal?.aborted) {
      try {
        const r = await tidyRoster(bookId, { onEvent, signal });
        if (r.created?.length || r.updated) emit('auto_tidy', { message: `已自动整理角色库：${r.note}` });
      } catch { /* 整理失败不阻塞写作 */ }
      // V0.68：事实库定期整理（同义词合并 + 上限归档——防 2000+ 条膨胀损害检索质量）
      try {
        const tf = tidyFacts(bookId);
        if (tf.merged || tf.archived) {
          emit('auto_tidy', { message: `已整理事实库：合并 ${tf.merged} 条重复、归档 ${tf.archived} 条超龄` });
          logFlow({ op: '事实库整理', detail: `合并 ${tf.merged}、归档 ${tf.archived}`, bookId });
        }
      } catch { /* 整理失败不阻塞写作 */ }
      // V0.71：地点库定期整理（净化人物误入/补全 kind/desc——地点稳定，变化少，低频整理即可）
      try {
        const { tidyLocations } = await import('../narrative/locations.js');
        const tl = await tidyLocations(bookId, { onEvent, signal });
        if (tl.purged?.length || tl.created?.length || tl.updated) {
          emit('auto_tidy', { message: `已整理地点库：${tl.note}` });
        }
      } catch { /* 整理失败不阻塞写作 */ }
      // V0.73：章名整书体检（AI 味动作直述/重名/空标题 → 自动改名；最多 5 个/轮）
      try {
        const tt = await tidyChapterTitles(bookId, { onEvent, signal });
        if (tt.renamed.length) emit('auto_tidy', { message: `已自动优化章名：${tt.renamed.length} 章（${tt.renamed.map(r => '《' + r.newTitle + '》').join('、')}）` });
      } catch { /* 整理失败不阻塞写作 */ }
    }

    // ---- V0.71/V0.105：创作中期过程打磨（每 10 完成章或跨 10 万字一次，同一关只跑一次；
    //      前瞻调整后续规划，不改已写章节；与卷体检/漂移检测/完本打磨分工不冲突） ----
    if (!signal?.aborted) {
      try {
        const completedNow = store.chapters.list(bookId).filter(isCompletedChapter);
        const cursor = readMidStoryCursor(bookId);
        const totalWordsNow = completedNow.reduce((sum, ch) => sum + (Number(ch.word_count) || 0), 0);
        if (shouldRunMidStoryReview({
          written: completedNow.length,
          totalWords: totalWordsNow,
          lastReviewWritten: cursor.written,
          lastReviewWords: cursor.words,
        })) {
          const { midStoryReview } = await import('../quality/polish.js');
          const mr = await midStoryReview(bookId, { onEvent, signal });
          if (mr.adjustments) emit('mid_review', { message: mr.note });
        }
      } catch { /* 中期审阅失败不阻塞写作 */ }
    }

    // ---- V0.45 章级对齐：章名与内容脱节 → 自动改名（本地粗筛零成本，LLM 兜底；失败不影响写作） ----
    // V0.73：只对"确定性坏标题"（重名/动作直述/空标题）自动改名；意象型标题不强制
    // V0.107：+ 章名↔正文核对闸（事件承诺零在场→改名候选）；已发布章只标记建议不动名
    try {
      const ca = checkChapterAlignment(bookId, ch.id);
      if (!ca.aligned && ca.autoFix) {
        const { isPublishedChapterIdx } = await import('../longform/alignment.js');
        if (isPublishedChapterIdx(bookId, ch.idx)) {
          emit('align_chapter', { idx: ch.idx, title: ch.title, suggestionOnly: true, message: `已发布章《${ch.title}》章名与正文疑似失配（${String(ca.reason || '').slice(0, 60)}），待作者确认后再改` });
        } else {
          const renamed = await adjustChapterTitle(bookId, ch.id, { onEvent, signal });
          if (renamed) emit('align_chapter', { idx: ch.idx, oldTitle: renamed.oldTitle, newTitle: renamed.newTitle });
        }
      }
    } catch { /* 对齐失败忽略 */ }

    // ---- 漂移检测与自动恢复（每章后，但恢复之间必须有完整的新鲜观察窗） ----
    const doneAfterChapter = store.chapters.list(bookId).filter(isCompletedChapter).length;
    const recoveryEligible = lastRecoveryAtDoneCount === null
      || doneAfterChapter - lastRecoveryAtDoneCount >= recoveryObservationChapters;
    if (recoveryEligible) {
      const drift = detectDrift(bookId);
      if (drift.trigger) {
        emit('stage', { stage: 'recovery', message: '检测到质量信号，执行全局诊断…' });
        const r = await autoRecover(bookId, { signal, onEvent });
        if (r.recovered) {
          recoveryRounds++;
          lastRecoveryAtDoneCount = doneAfterChapter;
          emit('recovery_done_all', {
            round: recoveryRounds,
            atChapter: ch.idx,
            nextEligibleChapter: ch.idx + recoveryObservationChapters,
            observationWindow: recoveryObservationChapters,
            note: r.note,
          });
          if (recoveryRounds >= cfg.maxRecoveryRounds) {
            // 人工出口：只有三批互不重叠的新正文仍确认漂移，才暂停 pilot。
            emit('need_human', {
              message: `连续 ${recoveryRounds} 个独立观察窗恢复后仍存在质量风险，自动创作已暂停。`,
              suggestions: ['查看最近三批正文的诊断证据', '在「设定」中调整书契约/大纲后继续', '人工确认是否返工'],
            });
            fatal = true;
            break;
          }
        } else {
          recoveryRounds = 0; // 诊断未确认漂移，旧恢复链已被证伪
          lastRecoveryAtDoneCount = null;
        }
      } else {
        // 一个完整观察窗没有再出现漂移，不能让很久以前的恢复轮数继续累计。
        recoveryRounds = 0;
        lastRecoveryAtDoneCount = null;
      }
    }

    // ---- 上下文自动归档（防降智：结构化精炼卡 + 必保清单） ----
    const need = checkArchiveNeed(bookId);
    if (need.needed) {
      // V0.29：归档策略——prompt=归档前通知（不暂停），auto=静默自动，off=跳过
      const strategy = getGlobal()?.archiveStrategy || 'auto';
      if (strategy === 'off') {
        emit('archive_warn', { message: `历史堆超预算（${Math.round(need.usedTokens / 1000)}K tokens），归档已关闭，建议在设置中开启` });
        // V0.73：归档关闭 + 超预算 → 继续写会超模型窗口（每章请求 400），暂停等人工
        if (need.usedTokens > need.budget * 1.05) {
          emit('need_human', { message: `历史堆已超预算（${Math.round(need.usedTokens / 1000)}K tokens）且归档已关闭，继续写作将超出模型上下文窗口。请在「设置」开启自动归档，或手动归档后重试。`, suggestions: ['在设置中开启自动归档', '调大上下文预算'] });
          fatal = true;
          break;
        }
      } else {
        if (strategy === 'prompt') emit('archive_notice', { message: `历史堆超预算（${Math.round(need.usedTokens / 1000)}K tokens），即将自动归档早期章节（保留最近章节全文）` });
        emit('stage', { stage: 'archive', message: `历史堆超预算（${Math.round(need.usedTokens / 1000)}K tokens），自动归档早期章节…` });
        try {
          const ar = await runArchive(bookId, { onEvent, signal });
          if (ar) emit('archive_done_all', { batch: ar.batch, range: ar.range, tokensSaved: ar.tokensSaved, missing: ar.missing });
        } catch (e) {
          emit('archive_error', { error: e.message });
        }
      }
    } else if (need.warnOnly) {
      emit('archive_warn', { message: `历史堆 ${Math.round(need.usedTokens / 1000)}K tokens（预算 ${Math.round(need.budget / 1000)}K），接近归档线` });
    }

    // ---- V0.41 卷级整体审阅：本卷最后一章刚写完 → 卷体检（主动；幂等由 volume_reviews 保证） ----
    try {
      const vol = store.volumes.get(ch.volume_id);
      if (vol) {
        const volChs = store.chapters.listByVolume(vol.id);
        const volDone = volChs.length > 0 && volChs.every(isCompletedChapter);
        // V0.62：status='failed'（解析失败）不视为已审——下次会重审（此前 failed 永久跳过）
        const prevReview = store.volumeReviews.byVolume(bookId, vol.id);
        if (volDone && (!prevReview || prevReview.status === 'failed')) {
          emit('stage', { stage: 'volume_review', message: `第${vol.idx}卷写完，卷级整体审阅…` });
          const vr = await runVolumeReview(bookId, vol.id, { signal, onEvent });
          emitVolumeReview({ volumeIdx: vol.idx, ...vr });
          // V0.71：卷写完 → 伏笔收束计划（超龄伏笔分配回收，防挖坑不填）
          try {
            const { foreshadowClosurePlan } = await import('../narrative/foreshadow.js');
            const fp = await foreshadowClosurePlan(bookId, { onEvent, signal });
            if (fp.assigned) emit('foreshadow_plan', { message: fp.note });
          } catch { /* 收束计划失败不阻塞 */ }
          // 卷体检与台账回写完成后固化全书阶段检查点；即使进程在下一卷前中断，
          // 续跑也能从同一阶段职责和当前到期债务继续，不会退回通用“继续扩张”。
          try {
            const checkpoint = persistLifecycleCheckpoint(bookId, { volumeIdx: vol.idx });
            emit('lifecycle_checkpoint', {
              volumeIdx: vol.idx,
              stage: checkpoint.checkpoint.stage,
              blockingCount: checkpoint.checkpoint.blocking_count,
              message: `第${vol.idx}卷生命周期检查点：${checkpoint.checkpoint.stage_label}，当前阶段待处理 ${checkpoint.checkpoint.blocking_count} 项`,
            });
          } catch { /* 检查点失败不阻塞正文 */ }
          // ---- V0.45 卷级对齐：卷名/卷大纲与实际内容脱节 → 自动修订（只改规划记录，不动正文；幂等：已对齐不重复） ----
          try {
            const va = checkVolumeAlignment(bookId, vol.id);
            const alreadyAligned = volumeAlignedRecently(bookId, vol.idx);
            if (!alreadyAligned) {
              emit('stage', { stage: 'align', message: `第${vol.idx}卷大纲与内容存在偏差，自动对齐（卷名/卷大纲）…` });
              if (!va.aligned) {
                const vrn = await adjustVolumeTitle(bookId, vol.id, { onEvent, signal });
                if (vrn) emit('align_volume', { idx: vrn.idx, oldTitle: vrn.oldTitle, newTitle: vrn.newTitle });
              }
              await rewriteVolumeOutline(bookId, vol.id, { onEvent, signal });
              emit('align_volume_outline', { idx: vol.idx, note: `第${vol.idx}卷大纲已回填实际内容` });
            }
          } catch (e2) {
            emit('volume_review_error', { volumeIdx: vol.idx, error: `大纲对齐失败：${e2.message.slice(0, 40)}` });
          }
        }
      }
    } catch (e) {
      // 卷审阅失败不中断写作（下次触发重审；解析失败已自动标记 failed）
      emit('volume_review_error', { volumeIdx: ch.volume_id, error: e.message.slice(0, 60) });
    }

    // ---- V0.62 书级对齐：每章后按章数间隔检查（此前只在轮末按卷数触发——长书写作中书纲长期过时） ----
    try {
      if (bookAlignDue(bookId)) {
        emit('stage', { stage: 'align', message: '书级大纲自动对齐（回填实际+调整后续分卷）…' });
        const br = await rewriteBookOutline(bookId, { onEvent, signal });
        if (br) emit('align_book', { written: br.written, volumes: br.volumes });
      }
      // ---- V0.67 补体检：对齐节奏（每 8 章）同时检查 failed/未检卷 → 自动补检 ----
      const dueVols = reviewDueVolumes(bookId).filter(shouldReviewVolumeBeforeLazyOutline);
      for (const dv of dueVols) {
        if (signal?.aborted) break;
        emit('volume_review_start', { volumeIdx: dv.idx, message: `补体检：第 ${dv.idx} 卷（${dv.reason}）…` });
        try { await runVolumeReview(bookId, dv.id, { onEvent, signal }); }
        catch { /* 补检失败不阻塞 */ }
      }
      // ---- V0.83 cast 设计接线（每卷完成后补配角弧光/命运线）→ V0.105.4 改调持久化 sweep ----
      // runCastDesign 是全书级操作（重写整个 cast_text），多个完成卷只烧一次并全部标记，
      // 标记落 books.settings 跨进程幂等（旧进程内 Set 重启即丢，历史卷重烧）。
      try { await sweepVolumeCastDesign(bookId, { onEvent, signal }); }
      catch { /* cast 设计失败不阻塞 */ }
    } catch { /* 书纲对齐/补体检失败不阻塞写作 */ }
  } // ← 内层 for 闭合

    // ---- V0.44：写完已规划章节 → 目标达成 / 完本判定 / 自动续卷（网文百万字才完本） ----
    if (signal?.aborted || fatal) break;
    // ---- V0.45 书级对齐兜底：for 内每章后已按 bookAlignDue 检查，此处兜底空轮/漏检（幂等） ----
    try {
      if (bookAlignDue(bookId)) {
        emit('stage', { stage: 'align', message: '书级大纲自动对齐（回填实际+调整后续分卷）…' });
        const br = await rewriteBookOutline(bookId, { onEvent, signal });
        if (br) emit('align_book', { written: br.written, volumes: br.volumes });
      }
    } catch (e3) {
      emit('stage', { stage: 'align', message: `书纲对齐失败（不影响写作）：${e3.message.slice(0, 40)}` });
    }
    // V0.72 修复：目标章数判定用"已完成章数"而非本次 written（written 不含 backfill 补写与续跑已有章，
    // 此前重复写章掩盖了该问题——消除重复写后目标判定提前 break，续卷后的章节永不写）
    const doneCount = store.chapters.list(bookId).filter(isCompletedChapter).length;
    if (targetChapters && doneCount >= targetChapters) {
      emit('stage', { stage: 'done', message: `已达目标章数 ${targetChapters} 章` });
      break;
    }
    if (continuations >= ENDING_DEFAULTS.maxContinuations) {
      emit('need_human', { message: '已达本轮续卷次数安全上限，自动创作已暂停；这不是完本，请检查后续分卷或提高续写上限。', suggestions: ['检查后续卷大纲与生命周期债务', '确认后再次开始自动创作'] });
      fatal = true;
      break;
    }
    const decide = await shouldContinueBook(bookId);
    if (!decide.shouldContinue) {
      if (decide.needsHuman) {
        emit('need_human', { message: decide.reason, suggestions: ['检查完本兑付台账', '扩展章节上限后续写', '人工确认结局状态'] });
        emit('stage', { stage: 'paused', message: decide.reason });
        fatal = true;
        break;
      }
      emit('book_done', { reason: decide.reason });
      emit('stage', { stage: 'done', message: `全书完成：${decide.reason}` });
      break;
    }
    try {
      const nv = await generateNextVolume(bookId, { onEvent, signal, reason: decide.reason });
      continuations++;
      emit('continuation', { volumeIdx: nv.idx, title: nv.title, chapterCount: nv.chapterCount, reason: decide.reason });
    } catch (e) {
      emit('chapter_error', { error: `续卷失败：${e.message.slice(0, 60)}（已写内容不受影响，可稍后重试）` });
      break;
    }
  } // ← while 闭合

  // 3) 全书打磨（可选）
  if (shouldRunFinalPolish({ requested: polish, fatal, aborted: signal?.aborted })) {
    emit('stage', { stage: 'polish', message: '全书打磨…' });
    await runPolish(bookId, { onEvent, signal });
    // V0.30：衔接平滑检查（章节首尾重写，修复生硬转场）——打磨的最后一道自动工序
    emit('stage', { stage: 'polish', message: '章节衔接检查（平滑转场）…' });
    try {
      const tr = await smoothTransitions(bookId, { onEvent, signal });
      if (tr.rewrites?.length) emit('stage', { stage: 'polish', message: `衔接优化：重写 ${tr.rewrites.length} 章开头` });
    } catch (e) {
      // V0.70：非 Error 抛出（undefined/字符串）时不再 ReferenceError 崩溃吞掉衔接检查
      const msg = (e instanceof Error ? e.message : String(e ?? '未知错误')).slice(0, 40);
      emit('stage', { stage: 'polish', message: `衔接检查跳过（${msg}）` });
    }
  }

  const finalChapters = store.chapters.list(bookId);
  const totalChapters = finalChapters.length;
  const completedTotal = finalChapters.filter(isCompletedChapter).length;
  // written 是主循环计数，不含 backfill/断点续跑命中的完成章；对外进度必须使用数据库终态。
  // 指定目标时 total 必须保留用户目标。旧实现用 min(target, actual) 把提前停止的 5/6
  // 错报成 5/5“完成”，掩盖了真正的暂停原因。
  const reportedTotal = targetChapters || totalChapters;
  const reportedWritten = Math.min(completedTotal, reportedTotal);
  // V0.78：本轮仍未修复的卡章 → 在 done 里汇总提示（自动修复有 2 次/轮上限，可能仍有残留）
  const stillBlocked = [...blockedChapters].sort((a, b) => a - b);
  const liveBlocked = stillBlocked.filter(idx => {
    const c = store.chapters.list(bookId).find(x => x.idx === idx);
    return c && c.status === 'quality_blocked';
  });
  if (liveBlocked.length) {
    emit('blocked_pending', { chapters: liveBlocked, message: `本轮仍有 ${liveBlocked.length} 章卡住未修复（第${liveBlocked.join('、')}章），可再点“开始自动创作”重试` });
  }
  const halted = Boolean(signal?.aborted || fatal || reportedWritten < reportedTotal);
  emit('done', {
    written: reportedWritten,
    total: reportedTotal,
    partial: partialChapters > 0 || reportedWritten < reportedTotal,
    partialChapters,
    blocked: liveBlocked,
    halted,
    reachedTarget: reportedWritten >= reportedTotal,
    durationMs: Date.now() - pilotStarted,
    writtenWords,
  });
  logFlow({ op: 'pilot_done', detail: `完成 ${reportedWritten}/${reportedTotal} 章${partialChapters ? `，${partialChapters} 章含失败场景可重跑补写` : ''}`, bookId, durationMs: Date.now() - pilotStarted });
  return { written: reportedWritten, total: reportedTotal, partialChapters };
}

/** 只有正常完成的自动创作才进入昂贵的全书打磨；质量门失败和取消都必须停在原处。 */
export function shouldRunFinalPolish({ requested, fatal, aborted }) {
  return Boolean(requested && !fatal && !aborted);
}

/** 生成书级大纲的便捷包装（pilot 骨架用） */export { generateBookOutline, generateVolumeOutline, generateChapterOutline };
