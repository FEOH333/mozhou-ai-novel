// server/engine/planning/volumereview.js —— V0.41 卷级整体审阅（主动卷体检）
// 每卷写完自动执行：对照卷大纲体检（承诺兑现/节奏/衔接/整体读感）→ 输出工单 →
// P0/P1 自动修订（复用打磨修订管线）→ P2 记债。零手动，与漂移恢复/快感审计互补不冲突。
'use strict';
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { volumeReviewInstruction } from '../prompts.js';
import { validateChapterRewrite } from '../quality/polish.js';
import { extractJSON } from '../../util/json.js';
import {
  buildLifecycleContext, lifecyclePromptText, reconcileLifecycleLedger,
} from '../longform/longform_lifecycle.js';
import { isCompletedChapter } from '../pipeline/chapter_status.js';
import { appendPublicationFeedback } from '../quality/publication_feedback.js'; // V0.99：卷审同源消费推流反馈

/** pilot 的 onEvent 只收 {type,...}；旧调用是 emit(name, data)。字符串事件会被作业注册器直接丢弃。 */
export function emitVolumeReviewEvent(onEvent, typeOrEvent, data) {
  if (!onEvent) return;
  if (typeOrEvent && typeof typeOrEvent === 'object') {
    onEvent(typeOrEvent);
    return;
  }
  const payload = data && typeof data === 'object' ? data : { message: data };
  onEvent({ type: String(typeOrEvent || 'volume_review'), ...payload });
}

/** 组装卷审阅输入（全部来自摘要/结构化数据，不读全文，控制成本） */
export function buildVolumeReviewContext(bookId, volume) {
  const book = store.books.get(bookId);
  const chapters = store.chapters.listByVolume(volume.id).sort((a, b) => a.idx - b.idx);
  const chapterLines = chapters.map((ch) => {
    const sum = (store.summaries.get(ch.id) || {}).summary || '';
    const scenes = store.scenes.list(ch.id);
    const tail = scenes.length ? (scenes[scenes.length - 1].content || '').slice(-120) : '';
    const hook = tail ? `…${tail}` : '';
    return `第${ch.idx}章《${ch.title || ''}》—— ${(sum || '').slice(0, 160)}${hook}`;
  });
  // 本卷登记的伏笔（卷内章节范围）
  const fsAll = store.foreshadows.list(bookId) || [];
  const minIdx = chapters[0]?.idx || 0;
  const maxIdx = chapters[chapters.length - 1]?.idx || 0;
  const foreshadowLines = fsAll
    .filter((f) => (f.planted_chapter ?? f.chapter_idx ?? f.source_chapter ?? 0) >= minIdx && (f.planted_chapter ?? f.chapter_idx ?? f.source_chapter ?? 0) <= maxIdx)
    .map((f) => `[${f.status}]${f.desc || f.content || ''}`)
    .join('；');
  // 上一卷末章摘要（衔接检查）
  const prevVol = store.volumes.list(bookId).find((v) => v.idx === volume.idx - 1);
  let prevVolumeTail = '';
  if (prevVol) {
    const prevChs = store.chapters.listByVolume(prevVol.id).sort((a, b) => a.idx - b.idx);
    const lastCh = prevChs[prevChs.length - 1];
    if (lastCh) {
      const sum = (store.summaries.get(lastCh.id) || {}).summary || '';
      const scenes = store.scenes.list(lastCh.id);
      const tail = scenes.length ? (scenes[scenes.length - 1].content || '').slice(-120) : '';
      prevVolumeTail = `第${lastCh.idx}章《${lastCh.title}》摘要：${sum.slice(0, 120)} 结尾：…${tail}`;
    }
  }
  // 契约卖点（滚动摘要首段或 logline）
  let contractLogline = '';
  try {
    const mat = store.materials.all(bookId) || [];
    const contract = mat.find((m) => m.kind === 'contract') || mat.find((m) => m.kind === 'logline');
    if (contract) {
      const c = typeof contract.content === 'string' ? JSON.parse(contract.content) : contract.content;
      contractLogline = c.logline || c.title || '';
    }
  } catch { /* ignore */ }

  const lifecycle = buildLifecycleContext(bookId, { volumeIdx: volume.idx });
  const lifecycleText = lifecyclePromptText(lifecycle);
  const payoffDebt = lifecycle.stageBlockers.length
    ? lifecycle.stageBlockers.slice(0, 16).map(item => `[${item.type}] ${item.label}`).join('；')
    : '（当前无硬性兑付债务）';

  return {
    bookTitle: book?.title || '未命名',
    volumeIdx: volume.idx,
    volumeTitle: volume.title || `第${volume.idx}卷`,
    volumeGoal: volume.goal || '',
    volumeSummary: volume.summary || '',
    chapterLines: chapterLines.join('\n') || '（本卷暂无章节摘要）',
    foreshadowLines,
    prevVolumeTail,
    contractLogline,
    lifecycle,
    lifecycleText,
    payoffDebt,
  };
}

/**
 * V0.67 补体检候选：需要补检的卷——
 * ① status='failed'（上次解析失败，重试）
 * ② 已写完但从未体检（或只有 failed 记录）的完成卷（可能因中断漏检）
 * @returns {Array<{idx:number, id:string, reason:string}>}
 */
export function reviewDueVolumes(bookId) {
  store.volumeReviews.repairLegacyRefs(bookId);
  const vols = store.volumes.list(bookId);
  const reviews = store.volumeReviews.list(bookId);
  const byId = new Map(reviews.map(r => [r.volume_id, r]));
  const due = [];
  for (const v of vols) {
    const chs = store.chapters.listByVolume(v.id);
    const volDone = chs.length > 0 && chs.every(isCompletedChapter);
    if (!volDone) continue;
    const rv = byId.get(v.id);
    if (!rv || rv.status === 'failed' || rv.status === 'needs_attention') {
      const reason = !rv ? '写完未体检'
        : (rv.status === 'failed' ? '上次解析失败，重试' : '上次修订被安全闸拦截，重试');
      due.push({ idx: v.idx, id: v.id, reason });
    }
  }
  return due;
}

/** 懒加载下一卷 / 启动补审：只补「从未体检」和「解析失败」。
 * 安全闸拦截（needs_attention）已经形成有效评级与工单，再审只会反复烧 volume_review 并拦住建章。 */
export function shouldReviewVolumeBeforeLazyOutline(dueEntry) {
  const reason = String(dueEntry?.reason || '');
  return reason === '写完未体检' || reason.includes('解析失败');
}

/**
 * 卷级审阅（幂等：同一卷已有审阅记录则覆盖更新，不重复创建；status='failed' 可重审）。
 * @returns {{grade:string, issues:Array, report:Object, revised:number, failedRevisions:number, rewriteFailures:Array}}
 */
export async function runVolumeReview(bookId, volumeId, { signal, onEvent, _recheck = false } = {}) {
  store.volumeReviews.repairLegacyRefs(bookId);
  const volume = store.volumes.get(volumeId);
  if (!volume) throw new Error('卷不存在');
  const ctx = buildVolumeReviewContext(bookId, volume);
  const emit = (type, data) => emitVolumeReviewEvent(onEvent, type, data);

  const res = await runTask({
    task: 'volume_review',
    bookId,
    jsonMode: true,
    messages: [{ role: 'user', content: appendPublicationFeedback(volumeReviewInstruction(ctx), bookId) }],
    signal,
  });
  const parsed = extractJSON(res.content);
  if (!parsed) {
    // 解析失败：记录失败状态（status='failed'——V0.62：pilot/补审对 failed 会重审，不再永远跳过）
    store.volumeReviews.upsert(bookId, volume.id, {
      grade: 'C', report: { parse_failed: true }, issues: [], status: 'failed',
    });
    return {
      grade: 'C', issues: [], report: { parse_failed: true }, revised: 0,
      failed: true, failedRevisions: 0, rewriteFailures: [],
    };
  }

  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const grade = ['A', 'B', 'C'].includes(parsed.pacing?.grade) ? parsed.pacing.grade
    : ['A', 'B', 'C'].includes(parsed.reading?.grade) ? parsed.reading.grade : 'C';
  const report = {
    goal_met: parsed.goal_met,
    goal_note: parsed.goal_note || '',
    promises: Array.isArray(parsed.promises) ? parsed.promises : [],
    pacing: parsed.pacing || {},
    hooks: parsed.hooks || {},
    reading: parsed.reading || {},
    stage_progress: {
      stage: ctx.lifecycle.stage.id,
      duty_met: parsed.stage_progress?.duty_met === true,
      note: parsed.stage_progress?.note || '',
      required_turn_met: parsed.stage_progress?.required_turn_met === true,
    },
    arc_movement: parsed.arc_movement || { advanced: [], closed: [], opened: [] },
    payoff_movement: parsed.payoff_movement || { paid: [], remaining: [] },
    new_debt: Array.isArray(parsed.new_debt) ? parsed.new_debt : [],
    ending_readiness: parsed.ending_readiness || { ready: false, missing: [] },
  };

  // 卷审阅必须同时回答“本卷好不好”和“整书阶段任务是否完成”。模型漏字段时闭合失败，
  // 自动落一个 P1 规划工单，不能以 A/B + 0 工单掩盖整书原地踏步。
  // 这是“未来规划债”而非可定位到某一章的正文错误，chapter=0，禁止自动重写
  // 已写正文（否则模型可能为修一个卷级方向问题而误改最后一章）。
  if (report.stage_progress.duty_met !== true) {
    issues.push({
      severity: 'P1', type: 'lifecycle', chapter: 0,
      desc: `第${volume.idx}卷未证明完成${ctx.lifecycle.stage.label}阶段职责`,
      suggest: ctx.lifecycle.stage.requiredTurn,
    });
  }

  const ledgerSync = reconcileLifecycleLedger(bookId, volume.id, report);
  report.ledger_sync = ledgerSync;

  // 落库（幂等 upsert）
  store.volumeReviews.upsert(bookId, volume.id, { grade, report, issues, status: 'done' });

  // P0/P1 工单 → 自动修订（复用打磨管线）；P2 记债（写入报告 + conflicts 供后续圆场）
  const lifecyclePlanning = issues.filter(i => i.type === 'lifecycle' && !Number(i.chapter));
  const p01 = issues.filter((i) => (i.severity === 'P0' || i.severity === 'P1') && !lifecyclePlanning.includes(i));
  const p2 = issues.filter((i) => lifecyclePlanning.includes(i) || i.severity === 'P2' || !['P0', 'P1'].includes(i.severity));
  const rewriteFailures = [];
  let revised = 0;
  if (p01.length) {
    emit('volume_review_revising', { volumeIdx: volume.idx, count: p01.length });
    revised = await applyReviewWorkOrders(bookId, volume, p01, {
      signal,
      onEvent,
      onRejected: (failure) => rewriteFailures.push(failure),
    });
  }
  // V0.62：P2 工单落 conflicts（供后续章节圆场；conflicts 有最近 5 章清理窗口防堆积）
  if (p2.length) {
    const chapters = store.chapters.listByVolume(volume.id).sort((a, b) => a.idx - b.idx);
    for (const wo of p2) {
      if (!wo.desc && !wo.issue) continue;
      const chNum = Number(wo.chapter) || 0;
      const ch = chapters.find((c) => c.idx === chNum) || chapters[chapters.length - 1];
      if (!ch) continue;
      try {
        store.conflicts.create(bookId, {
          chapterId: ch.id, type: '卷体检工单', quote: wo.quote || '',
          issue: `[P2] ${wo.desc || wo.issue || ''}${wo.suggest ? `（建议：${wo.suggest}）` : ''}`.slice(0, 300),
        });
      } catch { /* 落债失败不阻塞 */ }
    }
  }
  report.rewrite_failures = rewriteFailures;
  const reviewStatus = rewriteFailures.length ? 'needs_attention' : 'done';
  store.volumeReviews.upsert(bookId, volume.id, { grade, report, issues, status: reviewStatus, revisedCount: revised });

  // V0.62：修订后复检一次（确认 P0/P1 已修复；最多 1 次防循环）
  if (revised > 0 && !_recheck) {
    emit('volume_review_recheck', { volumeIdx: volume.idx, message: `修订 ${revised} 章后复检…` });
    try {
      const re = await runVolumeReview(bookId, volumeId, { signal, onEvent, _recheck: true });
      const combinedFailures = [...rewriteFailures, ...(re.rewriteFailures || [])]
        .filter((failure, index, all) => all.findIndex((item) => item.chapter === failure.chapter && item.code === failure.code) === index);
      const combinedReport = { ...re.report, rewrite_failures: combinedFailures };
      // 复检内部 upsert 会覆盖 revised_count 为复检值——补回累计（总修订数 = 首次 + 复检）
      store.volumeReviews.upsert(bookId, volume.id, {
        grade: re.grade, report: combinedReport, issues: re.issues,
        status: combinedFailures.length ? 'needs_attention' : 'done',
        revisedCount: revised + (re.revised || 0),
      });
      return {
        grade: re.grade, issues: re.issues, report: combinedReport,
        revised: revised + (re.revised || 0), rechecked: true,
        failedRevisions: combinedFailures.length, rewriteFailures: combinedFailures,
      };
    } catch (e) {
      emit('volume_review_error', { volumeIdx: volume.idx, error: `复检失败：${e.message.slice(0, 40)}` });
    }
  }

  // 操作日志
  try {
    store.operationLogs.add({
      ts: Date.now(), category: 'flow', level: rewriteFailures.length ? 'warn' : 'info',
      op: `volume_review v${volume.idx}`,
      detail: `grade=${grade} issues=${issues.length} revised=${revised} rejected=${rewriteFailures.length}`,
      bookId,
    });
  } catch { /* ignore */ }

  return {
    grade, issues, report, revised,
    failedRevisions: rewriteFailures.length,
    rewriteFailures,
  };
}

/**
 * 自动补审：书内所有"已完成的卷"（卷内全部章节 done/settled）且无审阅记录 → 逐个审阅。
 * 适配"写一半的书"：中断的书再次点「开始自动创作」时，先补审已完成卷，再继续写。
 */
export async function autoReviewVolumes(bookId, { signal, onEvent, maxVolumes } = {}) {
  store.volumeReviews.repairLegacyRefs(bookId);
  const emit = (type, data) => emitVolumeReviewEvent(onEvent, type, data);
  const volumes = store.volumes.list(bookId).sort((a, b) => a.idx - b.idx);
  const reviews = store.volumeReviews.list(bookId);
  // 解析失败可重审；needs_attention（修订被安全闸拦截）已有有效体检，启动补审不再重烧。
  const reviewedIds = new Set(reviews
    .filter((r) => r.status !== 'failed')
    .map((r) => r.volume_id));
  const due = [];
  for (const v of volumes) {
    if (reviewedIds.has(v.id)) continue; // 幂等：已审不重审
    const chapters = store.chapters.listByVolume(v.id);
    if (!chapters.length) continue;
    const done = chapters.every(isCompletedChapter);
    if (!done) continue; // 未完成的卷不审（写一半的书）
    due.push(v);
  }
  // V0.102：自动创作开跑时默认只审最近完成的未审卷（卷缝需要上一卷，不必先把四卷旧账审完才允许写下一章）。
  // HTTP 手动补审不传 maxVolumes，仍审全部到期卷。
  const capped = Number.isFinite(maxVolumes) && maxVolumes > 0 ? due.slice(-maxVolumes) : due;
  const results = [];
  for (const v of capped) {
    if (signal?.aborted) break;
    emit('volume_review_start', { volumeIdx: v.idx, title: v.title || `第${v.idx}卷` });
    const r = await runVolumeReview(bookId, v.id, { signal, onEvent });
    results.push({ volumeIdx: v.idx, ...r });
  }
  return results;
}

/** 将卷审结果转换成不会误导用户的事件。解析失败不是 C 级，也没有“0 工单”的含义。 */
export function volumeReviewDisplayEvent(result = {}) {
  const volumeIdx = result.volumeIdx;
  if (result.failed || result.report?.parse_failed) {
    return {
      type: 'volume_review_error',
      data: {
        volumeIdx,
        error: `第${volumeIdx || '?'}卷体检结果解析失败，未形成有效评级；已标记待自动重试`,
      },
    };
  }
  return {
    type: 'volume_review_done',
    data: {
      volumeIdx,
      grade: result.grade,
      issues: result.issues?.length || 0,
      revised: result.revised || 0,
      note: `第${volumeIdx || '?'}卷体检：${result.grade} 级，工单 ${result.issues?.length || 0} 条，修订 ${result.revised || 0} 章`,
    },
  };
}

/**
 * 按工单逐章最小化修订（复用打磨的修订思路：读上一章结尾 → 修订本章 → 替换场景文本）。
 * 导出供测试与手动触发。
 */
export async function applyReviewWorkOrders(bookId, volume, workorders, {
  signal, onEvent, onRejected, includePublished = false,
} = {}) {
  const emit = (type, data) => emitVolumeReviewEvent(onEvent, type, data);
  const chapters = store.chapters.listByVolume(volume.id).sort((a, b) => a.idx - b.idx);
  const peerChapters = store.chapters.list(bookId)
    .map((chapter) => ({ idx: chapter.idx, text: store.chapters.fullText(chapter.id) }));
  const publishedBoundary = store.publicationProfiles.get(bookId)?.published_chapter_count || 0;
  let executed = 0;
  const pendingRewrites = new Map();
  const pendingChapters = new Map();
  // 同章合并
  const byChapter = new Map();
  for (const wo of workorders) {
    const num = Number(wo.chapter) || 0;
    if (!byChapter.has(num)) byChapter.set(num, []);
    byChapter.get(num).push(wo);
  }
  for (const [chNum, wos] of byChapter) {
    if (signal?.aborted) break;
    const ch = chapters.find((c) => c.idx === chNum);
    if (!ch) continue;
    if (!includePublished && ch.idx <= publishedBoundary) {
      const failure = {
        chapter: ch.idx, chapterId: ch.id, code: 'PUBLISHED_CHAPTER_PROTECTED',
        message: `第${ch.idx}章已发布；自动卷审只记录工单，不覆盖正文，请走推荐失败专用返工闭环`,
      };
      onRejected?.(failure);
      emit('chapter_rewrite_rejected', {
        chapterId: ch.id, chapterIdx: ch.idx, source: 'volume_review',
        code: failure.code, error: failure.message,
      });
      continue;
    }
    const feedback = wos.map((w) => `[${w.severity}/${w.type}] ${w.desc}。建议：${w.suggest || ''}`).join('\n');
    emit('volume_review_revise', { chapterIdx: ch.idx, feedback: feedback.slice(0, 80) });
    const chapterText = store.chapters.fullText(ch.id);
    const prevCh = chapters.find((c) => c.idx === ch.idx - 1);
    const prevChapterTail = prevCh ? store.chapters.fullText(prevCh.id).slice(-300) : '';
    const res = await runTask({
      task: 'revise', bookId, chapterId: ch.id,
      messages: [{
        role: 'user',
        content: appendPublicationFeedback(`你是网文修订编辑。请按卷级审阅意见对本章做**最小化修订**（保留剧情骨架与风格，只改问题处）。

【章节】第${ch.idx}章《${ch.title}》
【上一章结尾（衔接参考）】${prevChapterTail}
【卷级审阅意见】
${feedback}

【本章正文】
${chapterText}

请直接输出修订后的完整正文（不要 JSON，不要解释）。`, bookId, { targetChapterIdx: ch.idx }),
      }],
      signal,
    });
    const after = (res.content || '').trim();
    const targetChars = store.scenes.list(ch.id)
      .reduce((sum, scene) => sum + (Number(scene.target_words) || 0), 0);
    const safety = validateChapterRewrite({
      before: chapterText,
      after,
      finishReason: res.finishReason,
      targetChars,
      chapterIdx: ch.idx,
      peerChapters,
    });
    if (!safety.ok) {
      const failure = {
        chapter: ch.idx,
        chapterId: ch.id,
        code: safety.code,
        message: safety.message,
        finishReason: res.finishReason || '',
        metrics: safety.metrics,
        ...(safety.matchedChapter ? { matchedChapter: safety.matchedChapter } : {}),
      };
      onRejected?.(failure);
      try {
        store.operationLogs.add({
          ts: Date.now(), category: 'flow', level: 'warn', op: 'rewrite_rejected', bookId,
          detail: `卷体检 第${ch.idx}章 ${failure.code}: ${failure.message}`.slice(0, 500),
          result: 'rejected',
        });
      } catch { /* 诊断日志失败不能反过来破坏正文保护 */ }
      emit('chapter_rewrite_rejected', {
        chapterId: ch.id, chapterIdx: ch.idx, source: 'volume_review',
        code: failure.code, error: failure.message, metrics: failure.metrics,
        ...(failure.matchedChapter ? { matchedChapter: failure.matchedChapter } : {}),
      });
      continue;
    }
    if (safety.unchanged) continue;
    pendingRewrites.set(ch.id, after);
    pendingChapters.set(ch.id, ch);
  }

  if (pendingRewrites.size) {
    emit('volume_review_revision_building', {
      volumeIdx: volume.idx,
      count: pendingRewrites.size,
      message: '卷审候选正在影子取证并同步各层叙事状态…',
    });
    try {
      const { prepareAndCommitNarrativeRevision } = await import('../narrative/narrative_state.js');
      const revision = await prepareAndCommitNarrativeRevision(bookId, {
        rewrites: pendingRewrites,
        reason: `第${volume.idx}卷体检原子换版（${pendingRewrites.size}章）`,
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
          message: `卷审候选未通过同版取证，整批未落盘：${error.message}`,
        };
        onRejected?.(failure);
        try {
          store.operationLogs.add({
            ts: Date.now(), category: 'flow', level: 'warn', op: 'rewrite_rejected', bookId,
            detail: `卷体检 第${ch.idx}章 ${failure.code}: ${failure.message}`.slice(0, 500),
            result: 'rejected',
          });
        } catch { /* ignore */ }
        emit('chapter_rewrite_rejected', {
          chapterId, chapterIdx: ch.idx, source: 'volume_review',
          code: failure.code, error: failure.message,
        });
      }
    }
  }
  return executed;
}
