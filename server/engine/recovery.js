// server/engine/recovery.js —— 系统性跑偏检测与自动恢复（V0.16）
// 借鉴：show-me-the-story 根因分析（foreshadow_outline/outline_history/foreshadow_history/mixed → extra_constraints
//       注入 + force_review 人工出口）；NovelClaw 失败反哺闭环；MemGPT 双阈值压力。
// 流程：健康快照 → 滑窗漂移检测 → 全局诊断（根因+证据链）→ 自动修复（作废事实/调伏笔/重规划/注入约束）→
//       修复后重置计数；重规划轮数超限 → 暂停 pilot，人工出口。
'use strict';
import * as store from '../db/store.js';
import { assembleMessages } from '../llm/cache.js';
import { runTask } from '../llm/router.js';
import { extractJSON } from '../util/json.js';
import { driftDiagnoseInstruction } from './prompts.js';
import { getGlobal } from '../config.js';
import { generateVolumeOutline, generateChapterOutline } from './outline.js';
import { worldExpansionStatus } from './world_expansion.js'; // V0.83：世界展开停滞并入漂移信号
import { formatRolling } from './archive.js';
import { rollingText } from './rolling.js'; // V0.95：滚动摘要两段式统一读取
import { isCompletedChapter, transitionChapterStatus } from './chapter_status.js'; // V0.93.2：状态写入单一真源

function parseVolumeOutline(vol) {
  try {
    const raw = vol?.outline_json;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    return JSON.parse(raw || '{}') || {};
  } catch {
    return {};
  }
}

/**
 * 已有完成章、或卷纲 chapters 已建章行：禁止再烧一遍卷大纲。
 * 与续卷 `volumeReadyToWrite` 同一把尺（V0.102.1 / V0.104.2）。
 */
export function shouldRegenerateVolumeOutline(volumeId) {
  if (!volumeId) return false;
  const chapters = store.chapters.listByVolume(volumeId);
  if (chapters.some(isCompletedChapter)) return false;
  const vol = store.volumes.get(volumeId);
  if (!vol) return false;
  const planned = parseVolumeOutline(vol).chapters;
  return !(chapters.length > 0 && Array.isArray(planned) && planned.length > 0);
}

/** 漂移检测配置 */
export function recoveryConfig() {
  const g = getGlobal();
  return {
    // 连续失败 N 章触发诊断
    consecutiveFailures: g.consecutiveFailures ?? 2,
    // 近 3 章 high 问题数 ≥ N 触发
    highIssueThreshold: g.highIssueThreshold ?? 3,
    // 最大恢复轮数（超过暂停人工出口）
    maxRecoveryRounds: g.maxRecoveryRounds ?? 2,
  };
}

/**
 * 记录一章健康快照（每章结算后调用）
 */
export function recordChapterHealth(bookId, chapterId, { verdict = 'ok', issues = [], replanCount = 0, failed = false, wordCount = 0, note = '' } = {}) {
  const chapter = store.chapters.get(chapterId);
  const highIssues = issues.filter(i => i?.severity === 'high').length;
  return store.chapterHealth.upsert({
    bookId, chapterId, idx: chapter?.idx || 0,
    verdict, issues: issues.length, highIssues, replanCount, failed, wordCount, notes: note,
  });
}

/**
 * 滑窗漂移检测：返回是否触发全局诊断
 */
export function detectDrift(bookId) {
  const cfg = recoveryConfig();
  const recent = store.chapterHealth.recent(bookId, 4);
  if (recent.length < 2) return { trigger: false, reason: '', signals: [] };
  const signals = [];
  // 信号1：连续失败
  let streak = 0;
  for (const h of recent) {
    if (h.failed || h.verdict === 'error') streak++;
    else break;
  }
  if (streak >= cfg.consecutiveFailures) signals.push(`连续 ${streak} 章失败`);
  // 信号2：近 3 章 high 问题累积
  const last3 = recent.slice(0, 3);
  const highSum = last3.reduce((s, h) => s + (h.high_issues || 0), 0);
  if (highSum >= cfg.highIssueThreshold) signals.push(`近 ${last3.length} 章 high 级问题 ${highSum} 个`);
  // 信号3：连续 replan 或重债务（defer 且问题多）
  const replanStreak = last3.filter(h => h.verdict === 'replan').length;
  if (replanStreak >= 2) signals.push(`连续 ${replanStreak} 章触发重规划`);
  // 审校预算耗尽后 leftover 记债（defer + 十几条中低/proseFix）是正常完成路径，不是漂移。
 // 只有仍带多条 high 的 defer 才算债务累积（实测 ch39-40 实证：12/19 条残差误触发重生卷纲）。
  const deferHeavy = last3.filter(h => h.verdict === 'defer' && (h.high_issues || 0) >= 2).length;
  if (deferHeavy >= 2) signals.push('债务累积（多章 defer 且 high 问题多）');
  // V0.80 吸引力信号（只读 chapter_health.notes；缺席/坏 JSON 跳过——不影响一致性信号）
  try {
    const recentNotes = store.chapterHealth.recent(bookId, 15).map(h => {
      try { return h.notes ? JSON.parse(h.notes) : null; } catch { return null; }
    }).filter(Boolean);
    // 连续 ≥2 章情绪强度≤3 或 type=平淡
    let flatStreak = 0;
    for (const n of recentNotes.slice(0, 6)) {
      const emo = n.emotion;
      if (emo && (emo.type === '平淡' || (typeof emo.intensity === 'number' && emo.intensity <= 3))) flatStreak++;
      else break;
    }
    if (flatStreak >= 2) signals.push(`连续 ${flatStreak} 章情绪寡淡（强度≤3/平淡）——读者流失风险`);
    // 连续 ≥2 章无有效章末钩子（attraction gate 或快感审计的 hook）
    let hooklessStreak = 0;
    for (const n of recentNotes.slice(0, 6)) {
      const hookOk = n.hook?.present === true && (n.hook.intensity || 0) >= 3; // V0.95：与细纲/正文/快感审计统一（≥3 才算有钩）
      const gateOk = n.gate?.verdict === 'pass';
      if (hookOk || gateOk) break;
      hooklessStreak++;
    }
    if (hooklessStreak >= 2) signals.push(`连续 ${hooklessStreak} 章无有效章末钩子——追读率会崩`);
    // 近 15 章爽点密度过低（payoff_count 总和 ≤1）
    const payoffSum = recentNotes.reduce((s, n) => s + (n.payoff_count || 0), 0);
    if (recentNotes.length >= 5 && payoffSum <= 1) signals.push('近 15 章爽点密度过低（总爽点≤1）——读者没爽到会弃书');
  } catch { /* 吸引力信号失败不阻塞 */ }
  // V0.83 周期信号：每 15 章强制一次漂移诊断（"每章质量好但主题偏"此前永不触发——检测信号全是质量信号）
  const totalDone = store.chapters.list(bookId).filter(isCompletedChapter).length;
  if (totalDone >= 15 && totalDone % 15 === 0) {
    signals.push(`已写满 ${totalDone} 章（每 15 章周期性主题/大纲体检）`);
  }
  // V0.83：世界展开停滞并入漂移信号（60 章仍困基层/100 章未展开到中上层 → 全局诊断）
  try {
    const ws = worldExpansionStatus(bookId);
    if (ws.severity !== 'none') signals.push(`世界观展开停滞：${ws.reason}`);
  } catch { /* 世界展开检测失败不阻塞 */ }

  // V0.95 纪律失守信号（修仙书解剖实证：ch22 起破折号 7→14→18→22 爬坡式失守且再未恢复——
  // 单章检测只看本章超不超线，"每章都只超一点"的系统性滑坡在单章视角下永远慢一拍）。
  // 近 5 章完成章正文本地扫描：破折号均值/对话占比（正则计数，毫秒级零成本）。
  try {
    const doneChapters = store.chapters.list(bookId)
      .filter(c => isCompletedChapter(c))
      .sort((a, b) => b.idx - a.idx)
      .slice(0, 5);
    if (doneChapters.length >= 5) {
      const texts = doneChapters.map(c => ({ idx: c.idx, text: store.chapters.fullText(c.id) || '' }));
      const dashCounts = texts.map(t => ({ idx: t.idx, n: (t.text.match(/——/g) || []).length }));
      const dashAvg = dashCounts.reduce((s, x) => s + x.n, 0) / dashCounts.length;
      const dashOverCount = dashCounts.filter(x => x.n > 20).length;
      if (dashAvg > 20 || dashOverCount >= 3) {
        signals.push(`破折号纪律失守：近 5 章均值 ${dashAvg.toFixed(1)}、超线 ${dashOverCount} 章（${dashCounts.map(x => `ch${x.idx}=${x.n}`).join('，')}）——系统性滑坡需全局诊断`);
      }
      // 对话空心化（修仙 ch43-76 模式：连续 4 章引号数 0）
      const ratios = texts.map(t => {
        const paras = t.text.split(/\n+/).filter(p => p.trim());
        const d = paras.filter(p => /[“「『"]/.test(p)).length;
        return { idx: t.idx, r: paras.length ? d / paras.length : 0 };
      });
      const dialogueLowCount = ratios.filter(x => x.r < 0.15).length;
      if (dialogueLowCount >= 3) {
        signals.push(`对话空心化：近 5 章 ${dialogueLowCount} 章对话占比 <15%（${ratios.filter(x => x.r < 0.15).map(x => `ch${x.idx}=${(x.r * 100).toFixed(0)}%`).join('，')}）——独白式推进需全局诊断`);
      }
    }
  } catch { /* 纪律信号失败不阻塞 */ }

  // V0.95 中段疲劳信号（novel-writing-framework：中段疲软是 100-300 章完读率头号杀手——
  // 连续 5 章无新人物/新地点/新物品登场 = 信息增量枯竭，读者感到"重复刷副本"）
  try {
    const doneChapters = store.chapters.list(bookId).filter(isCompletedChapter);
    if (doneChapters.length >= 8) {
      const maxDone = doneChapters.reduce((m, c) => Math.max(m, c.idx), 0);
      const window = 5;
      const newEntitySince = (list) => list.filter(e => Number(e.first_chapter) > maxDone - window).length;
      const newChars = newEntitySince(store.characters.list(bookId));
      const newLocs = newEntitySince(store.locations.list(bookId));
      const newItems = newEntitySince(store.items.list(bookId));
      const recentHookTypes = new Set(store.pleasureHooks.list(bookId)
        .filter(h => Number(h.planted_chapter) > maxDone - window)
        .map(h => String(h.type || '')));
      if (newChars + newLocs + newItems === 0 && recentHookTypes.size <= 1) {
        signals.push(`中段疲劳：近 ${window} 章零新实体登场（新角色/地点/物品全为 0）且钩型单一（${recentHookTypes.size} 种）——信息增量枯竭，读者"重复刷副本"感强，需全局诊断`);
      }
    }
  } catch { /* 中段疲劳检测失败不阻塞 */ }

  if (signals.length) return { trigger: true, reason: signals.join('；'), signals };
  return { trigger: false, reason: '', signals };
}

/**
 * 全局漂移诊断（LLM，根因 + 证据链 + 修复动作）
 */
export async function diagnoseDrift(bookId, { signal } = {}) {
  const book = store.books.get(bookId);
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const bookOutline = store.materials.get(bookId, 'outline')?.content || '';
  const rollingSummary = formatRollingSafe(bookId);
  const recentHealth = store.chapterHealth.recent(bookId, 5).map(h =>
    `第${h.idx}章：verdict=${h.verdict}, 问题${h.issues}（high ${h.high_issues}）, 失败=${h.failed ? '是' : '否'}`).join('\n');
  const chapters = store.chapters.list(bookId).filter(isCompletedChapter);
  const recentSummaries = chapters.slice(-3).map(c => {
    const s = store.summaries.get(c.id)?.summary || '';
    return `第${c.idx}章《${c.title}》：${s.slice(0, 120)}`;
  }).join('\n');
  const activeFacts = store.facts.recent(bookId, { status: 'active', limit: 20 }).map(f =>
    `${f.subject}${f.predicate ? ' ' + f.predicate : ''}${f.object ? ' ' + f.object : ''}`).join('\n');
  const charStates = store.characters.list(bookId).slice(0, 15).map(c => {
    let s = '';
    try { s = Object.entries(JSON.parse(c.state_json || '{}')).map(([k, v]) => `${k}=${v}`).join('；'); } catch { }
    return `${c.name}：${s || '（无状态）'}`;
  }).join('\n');
  const hooks = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced')
    .map(f => `[${f.id}] ${f.desc}（计划第${f.payoff_chapter || '?'}章）`).join('\n');
  const constraints = store.constraints.text(bookId);
  // V0.83：注入当前卷目标——此前诊断模型看不到"最近几章是否偏离本卷目标"，只能靠质量信号推断
  let volumeGoal = '';
  try {
    const vols = store.volumes.list(bookId);
    const done = store.chapters.list(bookId).filter(isCompletedChapter);
    const last = done[done.length - 1];
    const curVol = last?.volume_id ? vols.find(v => v.id === last.volume_id) : null;
    volumeGoal = curVol ? `第${curVol.idx}卷《${curVol.title || ''}》目标：${curVol.goal || ''}` : '';
  } catch { /* ignore */ }

  const res = await runTask({
    task: 'audit', bookId, messages: assembleMessages(bookId, [{
      role: 'user',
      content: driftDiagnoseInstruction({
        bookTitle: book.title, contract, bookOutline, rollingSummary, recentHealth, recentSummaries,
        activeFacts, characterStates: charStates, unresolvedHooks: hooks, constraints, volumeGoal,
      }),
    }]), jsonMode: true, signal,
  });
  const parsed = extractJSON(res.content);
  return {
    drifted: parsed?.drifted === true,
    causes: Array.isArray(parsed?.causes) ? parsed.causes : [],
    actions: Array.isArray(parsed?.actions) ? parsed.actions : [],
    recoveryNote: parsed?.recovery_note || '',
  };
}

function formatRollingSafe(bookId) {
  // V0.95：滚动摘要两段式统一读取（rolling.js 兼容旧自由文本/旧结构化 JSON）
  return rollingText(bookId);
}

/**
 * 执行诊断出的修复动作
 * @returns {{executed:Array, note:string}}
 */
export async function executeRecoveryActions(bookId, diag, { signal, onEvent } = {}) {
  const executed = [];
  const emit = (type, data) => onEvent?.({ type, ...data });
  const currentIdx = store.chapters.list(bookId)
    .filter(chapter => ['done', 'settled', 'revised'].includes(chapter.status))
    .reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
  let constraintOrdinal = 0;
  for (const a of diag.actions || []) {
    const type = a.type;
    const detail = a.detail || '';
    if (type === 'supersede_facts') {
      // 作废冲突事实：detail 中提到的 subject 全部 superseded
      let n = 0;
      for (const f of store.facts.list(bookId, { status: 'active' })) {
        if (detail.includes(f.subject) && detail.includes(f.predicate)) {
          store.facts.setStatus(f.id, 'superseded');
          n++;
        }
      }
      executed.push({ type, detail, count: n });
    } else if (type === 'adjust_foreshadow') {
      // 调整伏笔：detail 提到 [fs-xxx] 或伏笔描述
      let n = 0;
      for (const f of store.foreshadows.list(bookId)) {
        if (detail.includes(f.id)) {
          if (detail.includes('回收')) store.foreshadows.update(f.id, { status: 'paid_off' });
          else if (detail.includes('废弃')) store.foreshadows.update(f.id, { status: 'abandoned' });
          else if (detail.includes('延期')) store.foreshadows.update(f.id, { payoffChapter: (f.payoff_chapter || 0) + 10, note: (f.note || '') + '；诊断延期' });
          n++;
        }
      }
      executed.push({ type, detail, count: n });
    } else if (type === 'constraints') {
      // 注入约束（反哺后续写作）
      if (detail) {
        constraintOrdinal++;
        store.constraints.add(bookId, {
          content: detail, source: 'recovery', key: `recovery-action:${constraintOrdinal}`,
          scopeStart: currentIdx + 1, scopeEnd: currentIdx + 5,
        });
        executed.push({ type, detail, count: 1 });
      }
    }
    // replan_next 由调用方（pilot）执行：需要上下文（当前章位置）
  }
  if (diag.recoveryNote) {
    store.constraints.add(bookId, {
      content: `【恢复总纲】${diag.recoveryNote}`, source: 'recovery', key: 'recovery-summary',
      scopeStart: currentIdx + 1, scopeEnd: currentIdx + 5,
    });
    executed.push({ type: 'recovery_note', detail: diag.recoveryNote, count: 1 });
  }
  emit('recovery_executed', { executed });
  return { executed };
}

/**
 * 重规划后续章节：从指定章 idx 开始，重置章节状态并重新生成细纲（可重生成卷大纲）
 * @param {string} bookId @param {number} fromIdx
 * @param {object} [opts] { regenerateVolume: boolean, signal, onEvent, reason }
 *   V0.83：reason 漂移诊断原因/恢复说明 → 注入重生成细纲（replanReason），防重蹈覆辙
 */
export async function replanFrom(bookId, fromIdx, opts = {}) {
  const { regenerateVolume = false, signal, onEvent, reason = '' } = opts;
  const emit = (type, data) => onEvent?.({ type, ...data });
  const candidates = store.chapters.list(bookId).filter(c => c.idx >= fromIdx);
  if (!candidates.length) return { replanned: 0, skippedSettled: 0 };
  if (signal?.aborted) return { replanned: 0, skippedSettled: 0, aborted: true };

  // 已结算章节的事实、时间线、角色、伏笔和滚动摘要是全书级派生投影，当前并没有
  // 能从任意章向后精确逆放这些投影的事件溯源器。因此恢复只能重规划尚未结算的章；
  // 删除已结算正文却保留派生投影，会让新正文从一开始就被不存在的旧剧情污染。
  const protectedChapters = candidates.filter(ch =>
    isCompletedChapter(ch) || store.chapterSettlements.get(ch.id) || store.summaries.get(ch.id));
  const protectedIds = new Set(protectedChapters.map(ch => ch.id));
  const chapters = candidates.filter(ch => !protectedIds.has(ch.id));
  if (!chapters.length) {
    emit('recovery_stage', { message: `跳过 ${protectedChapters.length} 个已结算章节；没有可安全重规划的未来章` });
    return { replanned: 0, skippedSettled: protectedChapters.length };
  }

  // history 是按 seq 截断的。如果待重规划草稿之后还存在受保护章节的历史，直接截断会
  // 连带删除定稿前缀；在可精确重建该交错历史前必须失败关闭，并且不能先改任何正文。
  const mutableIds = new Set(chapters.map(ch => ch.id));
  const mutableScenes = chapters.flatMap(ch => store.scenes.list(ch.id));
  const minSeq = mutableScenes.reduce((min, scene) => {
    if (!scene.history_seq) return min;
    return min === null ? scene.history_seq : Math.min(min, scene.history_seq);
  }, null);
  if (minSeq !== null) {
    const conflict = store.chapters.list(bookId)
      .filter(ch => !mutableIds.has(ch.id))
      .flatMap(ch => store.scenes.list(ch.id).map(scene => ({ chapter: ch, scene })))
      .find(({ scene }) => scene.history_seq && scene.history_seq >= minSeq);
    if (conflict) {
      const error = new Error(`重规划历史与第${conflict.chapter.idx}章定稿历史交错，已拒绝破坏性截断`);
      error.code = 'REPLAN_HISTORY_CONFLICT';
      throw error;
    }
  }

  // 找到 fromIdx 所属卷
  const target = chapters[0];
  const vol = target.volume_id ? store.volumes.get(target.volume_id) : null;
  // 所有本地破坏性变更一次事务提交；异步 LLM 规划仍在事务外执行。
  store.transaction(() => {
    if (minSeq !== null) store.history.truncateFrom(bookId, minSeq, '漂移恢复重规划');
    for (const ch of chapters) {
      store.scenes.clear(ch.id);
      store.chapterHealth.removeByChapter(ch.id);
      // 重规划已经接管旧失败；该类冲突若继续保持 open，会在下一轮体检中制造假卡章。
      for (const conflict of store.conflicts.list(bookId)) {
        if (conflict.chapter_id === ch.id && conflict.resolution === 'open'
          && (/生成失败|生成中断|质量门未通过/.test(conflict.type || '')
            || /章细纲返回空|STREAM_INCOMPLETE|生成中断/.test(conflict.issue || ''))) {
          store.conflicts.resolve(conflict.id, 'auto_replanned');
        }
      }
      // 细纲留到 generateChapterOutline 成功后再覆盖。先清成 {} 再去重生卷纲，
 // 中断会留下空纲，历史坐标（年号/年龄/阶段）一并丢失（实测 ch41/42 实证）。
      store.chapters.update(ch.id, { wordCount: 0 });
      transitionChapterStatus(bookId, ch.id, 'planned', { reason: '漂移诊断重规划' });
    }
  });
  let replanned = 0;
  // V0.57：先提示总数（让用户知道要等多久，避免"无反馈像卡死"）
  emit('recovery_stage', { message: `诊断完成，将重规划 ${chapters.length} 章（每章需生成细纲，约 ${Math.ceil(chapters.length * 1.5)} 分钟，请稍候）…` });
  const canRegenVolume = regenerateVolume && vol && shouldRegenerateVolumeOutline(vol.id);
  if (regenerateVolume && vol && !canRegenVolume) {
    emit('recovery_stage', { message: `第${vol.idx}卷已有完成章或既有卷纲，跳过重生卷大纲，只重规划未写章细纲…` });
  }
  if (canRegenVolume) {
    emit('recovery_stage', { message: `重新生成第${vol.idx}卷大纲…` });
    await generateVolumeOutline(bookId, vol.id,
      { chapterCount: Math.max(3, store.chapters.listByVolume(vol.id).length || 6) },
      { signal, onEvent });
  }
  for (const ch of chapters) {
    if (signal?.aborted) break;
    emit('recovery_stage', { message: `重新规划第${ch.idx}章（${replanned + 1}/${chapters.length}）…` });
    try {
      // V0.83：注入漂移诊断原因（replanReason）——此前 replanFrom 不传 reason，诊断结论不进重生成细纲
      await generateChapterOutline(bookId, ch.id, { signal, onEvent, replanReason: reason });
      replanned++;
    } catch (error) {
      if (signal?.aborted || error?.code === 'ABORTED' || error?.name === 'AbortError') break;
      // 单章重规划失败继续下一章；该章保持 planned，下一轮自动创作可重试。
    }
  }
  return { replanned, skippedSettled: protectedChapters.length };
}

/** pilot 集成入口：检测 → 诊断 → 修复/重规划 → 返回是否继续 */
export async function autoRecover(bookId, { signal, onEvent } = {}) {
  const cfg = recoveryConfig();
  const detect = detectDrift(bookId);
  if (!detect.trigger) return { recovered: false, reason: '' };
  const emit = (type, data) => onEvent?.({ type, ...data });
  emit('recovery', { message: `检测到系统性漂移：${detect.reason}，启动全局诊断…` });

  // 恢复轮数上限（持久化计数：用 archives 无、用 chapter_health 无 → 简单内存 + 章节状态标记）
  const diag = await diagnoseDrift(bookId, { signal });
  if (!diag.drifted) {
    emit('recovery_ok', { message: '诊断结论：未漂移，继续' });
    return { recovered: false, reason: '诊断未确认漂移' };
  }
  emit('recovery_diag', { causes: diag.causes, actions: diag.actions, note: diag.recoveryNote });
  const { executed } = await executeRecoveryActions(bookId, diag, { signal, onEvent });

  // replan_next：从指定章节重规划（V0.83：注入诊断原因——主题漂移/偏离卷目标等结论进重生成细纲）
  let replanned = 0;
  const replanAction = diag.actions.find(a => a.type === 'replan_next');
  if (replanAction) {
    const m = String(replanAction.detail).match(/(\d+)/);
    const fromIdx = m ? parseInt(m[1]) : (store.chapters.list(bookId).length);
    const reason = `【漂移诊断原因】${(diag.causes || []).join('；')}${diag.recoveryNote ? `；${diag.recoveryNote}` : ''}`.slice(0, 600);
    const r = await replanFrom(bookId, fromIdx, { regenerateVolume: true, signal, onEvent, reason });
    replanned = r.replanned;
  }
  emit('recovery_done', { executed, replanned, note: diag.recoveryNote });
  return { recovered: true, executed, replanned, note: diag.recoveryNote };
}
