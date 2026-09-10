// server/engine/data_safety.js —— V0.91 正文数据安全与快照只增恢复
// V0.96.4：快照 diff 对比（借鉴 DeepWrite「可审阅的文稿修改」——重写/打磨前自动快照
// 早已存在，缺的是"改了什么"的可见性；对比只读，永不写库，不碰回滚闸门）
'use strict';
import * as store from '../db/store.js';
import { diffParagraphs } from '../util/diff.js';
import { markNarrativeStateStale } from './narrative_state.js';

const terminal = new Set(['done', 'settled', 'revised']);

/**
 * 将中断/暂停遗留的 writing 场景恢复为可续跑状态。
 * 仅改状态、不动正文：有流式草稿则 draft 续写，空场景则 planned 重写。
 */
export function recoverInterruptedScenes(chapterId) {
  const scenes = store.scenes.list(chapterId);
  const interrupted = scenes.filter(scene => scene.status === 'writing');
  if (!interrupted.length) return { recovered: 0, scenes: [] };
  const recovered = [];
  store.transaction(() => {
    for (const scene of interrupted) {
      const status = String(scene.content || '').trim() ? 'draft' : 'planned';
      store.scenes.update(scene.id, { status });
      recovered.push({ id: scene.id, idx: scene.idx, status });
    }
  });
  return { recovered: recovered.length, scenes: recovered };
}

function contentOf(snapshotChapter) {
  return (snapshotChapter?.scenes || [])
    .map(scene => String(scene?.content || ''))
    .filter(text => text.trim())
    .join('\n\n');
}

/**
 * 找出“章节记录仍有字数、正文场景却为空”的损坏章，并从全部快照中逐章选择可恢复版本。
 * 修订/精修快照按时间优先，避免较长但过时的旧稿覆盖人工修订；普通自动/手动快照仍以最长正文优先。
 * 恢复是只增操作：已有正文、当前章名和当前细纲绝不覆盖，也不删除任何快照外章节。
 */
export function recoverMissingChapterContent(bookId, { dryRun = false } = {}) {
  const book = store.books.get(bookId);
  if (!book) return { recovered: 0, candidates: [], error: '作品不存在' };
  const damaged = store.chapters.list(bookId).filter(ch =>
    Number(ch.word_count || 0) > 0 && !store.chapters.fullText(ch.id).trim());
  if (!damaged.length) return { recovered: 0, candidates: [] };

  const allSnapshots = store.snapshots.listAll(bookId);
  // “revision/polish/refine” 是经过人工或打磨确认的新基线。每章只从最新基线及其后的快照中恢复，
  // 这样既不会捞回基线之前更长的错误旧稿，也允许之后的自动快照承接最新版本。
  const revisionFloorByIdx = new Map();
  for (const meta of allSnapshots) {
    if (!/^(?:revision|polish|refine)$/i.test(String(meta.source || ''))) continue;
    const snapshot = store.snapshots.get(meta.id);
    for (const archived of snapshot?.data?.chapters || []) {
      if (!contentOf(archived).trim()) continue;
      const createdAt = Number(meta.created_at) || 0;
      if (createdAt > Number(revisionFloorByIdx.get(archived.idx) || 0)) {
        revisionFloorByIdx.set(archived.idx, createdAt);
      }
    }
  }

  const bestByIdx = new Map();
  for (const meta of allSnapshots) {
    const snapshot = store.snapshots.get(meta.id);
    for (const archived of snapshot?.data?.chapters || []) {
      const text = contentOf(archived);
      if (!text.trim()) continue;
      if (Number(meta.created_at) < Number(revisionFloorByIdx.get(archived.idx) || 0)) continue;
      const previous = bestByIdx.get(archived.idx);
      if (!previous || text.length > previous.chars
        || (text.length === previous.chars && Number(meta.created_at) > Number(previous.createdAt))) {
        bestByIdx.set(archived.idx, {
          idx: archived.idx,
          snapshotId: meta.id,
          snapshotLabel: meta.label,
          createdAt: meta.created_at,
          chars: text.length,
          chapter: archived,
        });
      }
    }
  }

  const candidates = damaged.map(ch => {
    const best = bestByIdx.get(ch.idx);
    return best ? { chapterId: ch.id, ...best } : null;
  }).filter(Boolean);
  const publicCandidates = candidates.map(({ chapter, ...candidate }) => candidate);
  if (dryRun || !candidates.length) return { recovered: 0, candidates: publicCandidates };

  let recovered = 0;
  const recoveredIndices = [];
  store.transaction(() => {
    for (const candidate of candidates) {
      const current = store.chapters.get(candidate.chapterId);
      if (!current || store.chapters.fullText(current.id).trim()) continue;
      const archived = candidate.chapter;
      for (const scene of archived.scenes || []) {
        if (!String(scene?.content || '').trim()) continue;
        store.scenes.create(current.id, Number(scene.idx) || 1, {
          pov: scene.pov || '', location: scene.location || '', beat: scene.beat || '',
          content: scene.content, targetWords: scene.target_words || 1000,
          status: terminal.has(scene.status) ? scene.status : 'done',
          sceneType: scene.scene_type || '',
        });
      }
      const wordCount = Math.max(Number(current.word_count || 0), Number(archived.word_count || 0));
      store.chapters.update(current.id, {
        status: terminal.has(archived.status) ? archived.status : 'done',
        wordCount,
      });
      recovered++;
      recoveredIndices.push(Number(current.idx));
    }
    if (recoveredIndices.length) {
      markNarrativeStateStale(bookId, {
        fromChapter: Math.min(...recoveredIndices),
        reason: '从快照恢复了缺失正文，等待同版派生状态重建',
        changedChapters: recoveredIndices,
      });
    }
  });
  return { recovered, candidates: publicCandidates };
}

/** 捕获单章可恢复草稿。只保存重规划会触碰的章级数据，不复制整本书。 */
export function captureChapterDraft(chapterId) {
  const chapter = store.chapters.get(chapterId);
  if (!chapter) return { chapterId, hasContent: false, error: '章节不存在' };
  const scenes = store.scenes.list(chapterId).map(scene => ({ ...scene }));
  const historySeqs = scenes.map(scene => Number(scene.history_seq)).filter(Number.isFinite).filter(Boolean);
  const historyFloor = historySeqs.length ? Math.min(...historySeqs) : store.history.lastSeq(chapter.book_id) + 1;
  return {
    chapterId,
    bookId: chapter.book_id,
    chapter: { ...chapter },
    scenes,
    summary: store.summaries.get(chapterId) || null,
    settlement: store.chapterSettlements.get(chapterId) || null,
    historyFloor,
    historyTail: store.history.listFrom(chapter.book_id, historyFloor).map(row => ({ ...row })),
    hasContent: scenes.some(scene => String(scene.content || '').trim()),
  };
}

/**
 * 重规划候选失败后的章级回滚。当前候选只存在历史堆尾部，因此从旧章首条消息起重建，
 * 再把旧正文按场景顺序追加并回填新的 history_seq，保证缓存上下文与数据库正文一致。
 */
export function restoreChapterDraft(backup, { reason = '章级重规划失败回滚' } = {}) {
  if (!backup?.chapter || !backup?.hasContent) return { ok: false, error: '没有可恢复的旧正文' };
  const { chapter, chapterId, bookId } = backup;
  store.transaction(() => {
    const floor = Number(backup.historyFloor);
    if (Number.isFinite(floor) && floor > 0) store.history.truncateFrom(bookId, floor, reason);
    store.scenes.clear(chapterId);
    store.chapters.update(chapterId, {
      title: chapter.title,
      outline: (() => { try { return JSON.parse(chapter.outline_json || '{}'); } catch { return {}; } })(),
      status: chapter.status,
      wordCount: chapter.word_count,
    });
    if (backup.summary?.summary != null) store.summaries.set(chapterId, bookId, backup.summary.summary);
    else store.summaries.remove(chapterId);
    if (backup.settlement) {
      store.chapterSettlements.set(bookId, chapterId, {
        contentHash: backup.settlement.content_hash,
        result: backup.settlement.result,
      });
    } else store.chapterSettlements.remove(chapterId);

    const seqMap = new Map();
    for (const row of backup.historyTail || []) {
      seqMap.set(Number(row.seq), store.history.append(bookId, row.role, row.content));
    }
    for (const scene of backup.scenes) {
      const restored = store.scenes.create(chapterId, scene.idx, {
        pov: scene.pov, location: scene.location, beat: scene.beat,
        content: scene.content, targetWords: scene.target_words,
        status: scene.status, sceneType: scene.scene_type,
      });
      if (String(scene.content || '').trim()) {
        const originalSeq = Number(scene.history_seq);
        const historySeq = seqMap.get(originalSeq) || store.history.append(bookId, 'assistant', scene.content);
        store.scenes.update(restored.id, { historySeq });
      }
    }
  });
  return { ok: true, chapterId, restoredScenes: backup.scenes.length, reason };
}

// ---------- V0.96.4 快照 diff 对比（只读，永不写库） ----------

function snapshotChapterText(snapshotChapter) {
  return (snapshotChapter?.scenes || [])
    .map(scene => String(scene?.content || ''))
    .filter(text => text.trim())
    .join('\n\n');
}

/**
 * 快照 vs 当前的差异章节概览：只列变化的章（modified/added/removed），
 * 未变章不进列表（回带 unchanged 计数）。章按 idx 对齐——快照与当前共用章号坐标系。
 */
export function snapshotDiffOverview(bookId, snapshotId) {
  const snap = store.snapshots.get(snapshotId);
  if (!snap) return { error: '快照不存在' };
  const snapByIdx = new Map();
  for (const ch of snap.data?.chapters || []) {
    if (Number.isInteger(Number(ch.idx))) snapByIdx.set(Number(ch.idx), ch);
  }
  const curChapters = store.chapters.list(bookId);
  const rows = [];
  const seen = new Set();
  for (const cur of curChapters) {
    const idx = Number(cur.idx);
    seen.add(idx);
    const snapCh = snapByIdx.get(idx);
    const snapText = snapshotChapterText(snapCh);
    const curText = store.chapters.fullText(cur.id);
    const snapTitle = snapCh?.title || '';
    const titleChanged = snapCh && snapTitle !== String(cur.title || '');
    const textChanged = snapText !== curText;
    if (!titleChanged && !textChanged) continue;
    rows.push({
      idx,
      change: snapCh ? 'modified' : 'added',
      snapTitle,
      curTitle: cur.title || '',
      titleChanged: !!titleChanged,
      snapWords: snapText.length,
      curWords: curText.length,
    });
  }
  for (const idx of snapByIdx.keys()) {
    if (!seen.has(idx)) {
      const snapCh = snapByIdx.get(idx);
      const snapText = snapshotChapterText(snapCh);
      rows.push({
        idx,
        change: 'removed',
        snapTitle: snapCh?.title || '',
        curTitle: '',
        titleChanged: false,
        snapWords: snapText.length,
        curWords: 0,
      });
    }
  }
  rows.sort((a, b) => a.idx - b.idx);
  return {
    snapshot: { id: snap.id, label: snap.label, source: snap.source, createdAt: snap.created_at },
    chapters: rows,
    unchanged: curChapters.length - rows.filter(r => r.change !== 'removed').length,
  };
}

/**
 * 单章块级 diff：快照章正文 vs 当前章正文（段落级 LCS，红删绿增同灰）。
 * 快照无该章时按空文本对比（全新增）；当前无该章时按空文本对比（全删除）。
 */
export function snapshotChapterDiff(bookId, snapshotId, chapterIdx) {
  const snap = store.snapshots.get(snapshotId);
  if (!snap) return { error: '快照不存在' };
  const idx = Number(chapterIdx);
  const snapCh = (snap.data?.chapters || []).find(c => Number(c.idx) === idx);
  const cur = store.chapters.list(bookId).find(c => Number(c.idx) === idx);
  const snapText = snapshotChapterText(snapCh);
  const curText = cur ? store.chapters.fullText(cur.id) : '';
  const blocks = diffParagraphs(snapText, curText);
  return {
    idx,
    snapshotTitle: snapCh?.title || '',
    currentTitle: cur?.title || '',
    snapWords: snapText.length,
    curWords: curText.length,
    changed: blocks.some(b => b.type !== '='),
    blocks,
  };
}
