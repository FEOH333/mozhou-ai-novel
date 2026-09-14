// 由 workshop.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import { get, post, patch, put, del, sse, openingApi, publicationApi, narrativeApi, writeApi } from '../api.js';
import { el, toast, confirmDialog, openModal, icon, fmt, fmtTokens, fmtMoney, fmtPct, esc, pageHead, progressCard, CHAPTER_STATUS, CHAPTER_STATUS_TAG, chapterStatusLabel } from '../ui.js';
import { state, refreshBook, refreshGlobal, rerender, registerSSE, unregisterSSE } from '../app.js';
import {
  STEP_META, chapterListState, runStatsBar,
  getChFilter, setChFilter, getLivePatch, setLivePatch,
} from './workshop/shared.js';
import { chapterIdxFromEvent, pilotGridSize, resolvePilotTarget } from '../pilot-observe.js';

import {
  runFlow,
} from './chapter.js';

// ================= 章节视图 =================
function pilotPrefKey(bookId) {
  return `mozhou-pilot-prefs:${bookId}`;
}

function readPilotPrefs(bookId) {
  try {
    const raw = localStorage.getItem(pilotPrefKey(bookId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writePilotPrefs(bookId, patch) {
  try {
    localStorage.setItem(pilotPrefKey(bookId), JSON.stringify({ ...readPilotPrefs(bookId), ...patch }));
  } catch { /* ignore */ }
}

export function renderAutoCreationCard(book, root) {
  const running = book.activeWriteJob;
  const startLabel = running
    ? (running.type === 'polish' ? '重新连接打磨进度' : '重新连接进度')
    : '开始自动创作';
  const prefs = readPilotPrefs(book.id);
  const targetAttrs = {
    type: 'number', id: 'pilot-target', min: '1', placeholder: '再写几章',
    style: 'width:110px', title: '填 N = 从当前进度再写 N 章（如已写 48 章填 3 → 写到第 51 章）；留空 = 由 AI 按故事进度自动续写',
    oninput: (ev) => writePilotPrefs(book.id, { target: ev.currentTarget.value || '' }),
  };
  if (prefs.target) targetAttrs.value = String(prefs.target);
  const polishAttrs = {
    type: 'checkbox', id: 'pilot-polish',
    onchange: (ev) => writePilotPrefs(book.id, { polish: !!ev.currentTarget.checked }),
  };
  if (prefs.polish === true) polishAttrs.checked = true;
  return el('div', { class: 'card hl auto-create' },
    el('div', { class: 'grow' },
      el('div', { style: 'font-weight:700;font-size:15px;display:flex;align-items:center;gap:6px' }, icon('rocket', 17), ' AI 自动创作'),
      el('div', { class: 'small muted', text: '点开始即可离开本页去读：进度在顶栏，断开只停观察，停止按钮才取消。' }),
    ),
    el('div', { class: 'row mt auto-create-main' },
      el('button', { class: 'primary', id: 'pilot-btn', text: startLabel, onclick: (ev) => {
        const b = ev.currentTarget;
        b.classList.add('busy');
        b.setAttribute('aria-busy', 'true');
        runPilot(book, root, b);
      } }),
      el('input', targetAttrs),
      el('label', { class: 'small', style: 'white-space:nowrap;display:inline-flex;align-items:center;gap:4px;cursor:pointer' },
        el('input', polishAttrs),
        '完本后打磨',
      ),
      el('button', { id: 'polish-btn', class: 'sm ghost', text: '全书打磨', onclick: (ev) => runPolishNow(book, root, ev.currentTarget) }),
      el('button', { id: 'emergency-btn', class: 'sm ghost', text: '紧急完本', title: '不想再写了：规划一个短收束卷集中兑付伏笔，写完即完本', onclick: (ev) => openEmergencyFinish(book, root, ev.currentTarget) }),
      el('button', { id: 'sequel-btn', class: 'sm ghost', text: '写续作', title: '以本书为母本开新书：继承世界观、设定与可选角色，重新立契约', onclick: (ev) => openSequel(book, root, ev.currentTarget) }),
    ),
    el('div', { id: 'pilot-progress', class: 'mt sticky-progress' }),
  );
}

/** 自动创作（pilot）：一键自动全书（V0.43 可视化大升级：章节网格/当前章/成本条/完成卡片/事件流） */
export async function runPilot(book, root, btn, opts = {}) {
  let jobId = opts.jobId || book.activeWriteJob?.id || null;
  const targetInput = document.getElementById('pilot-target');
  const polishCheck = document.getElementById('pilot-polish');
  // V0.105.3：输入语义 = 再写 N 章（相对增量），pilot-observe.resolvePilotTarget 翻译成绝对目标
  const targetChapters = resolvePilotTarget(targetInput?.value, book.chapters || []);
  writePilotPrefs(book.id, { target: targetInput?.value || '', polish: !!polishCheck?.checked });
  const progressBox = document.getElementById('pilot-progress');
  progressBox.innerHTML = '';

  const chapters = book.chapters || [];
  // V0.62：total 改为 let（续卷后动态扩展网格）；必须在函数开头声明——TDZ：声明前访问会 ReferenceError
  // 目标 48、已建 42 时网格必须是 48，不能 min 截成已有章数。
  let total = pilotGridSize(targetChapters, chapters.length) || chapters.length;
  // V0.78 修复：revised 也是已完成（正文已修订过），此前只认 done/settled →
  // 大量 revised 章在网格里显示灰色。quality_blocked 是卡住章 → 标红提示。
  const isCompletedStatus = s => s === 'done' || s === 'settled' || s === 'revised';
  const cellClass = (status) => {
    if (status === 'quality_blocked' || status === 'partial') return 'ch-cell failed';
    if (isCompletedStatus(status)) return 'ch-cell done';
    return 'ch-cell';
  };

  // ---- V0.43 面板骨架 ----
  // 当前章指示 + 停止按钮
  const curLine = el('div', { class: 'row', style: 'gap:10px;align-items:center;margin-bottom:6px' },
    el('strong', { class: 'grow', id: 'pilot-cur', text: total ? `准备开始：共 ${total} 章（已完成 ${chapters.filter(c => isCompletedStatus(c?.status)).length} 章，从断点继续）` : '正在准备书骨架…' }),
    el('button', { class: 'sm ghost', id: 'pilot-stop', text: '⏹ 停止（进度已保存）' }),
  );
  // 章节进度网格
  const grid = el('div', { class: 'ch-grid' });
  const cells = [];
  for (let i = 0; i < total; i++) {
    const c = chapters[i];
    const cell = el('div', {
      class: cellClass(c?.status),
      text: c?.idx ?? i + 1,
      title: `第${c?.idx ?? i + 1}章 ${c?.title || ''}${c?.status === 'quality_blocked' ? '（卡住）' : ''}`,
      'data-chapter-id': c?.id || '',
    });
    cells.push(cell); grid.append(cell);
  }
  const ensureGridCells = (n) => {
    const want = Math.max(0, Number(n) || 0);
    while (cells.length < want) {
      const i = cells.length;
      const cell = el('div', { class: 'ch-cell', text: i + 1, title: `第${i + 1}章` });
      cells.push(cell); grid.append(cell);
    }
    if (want > total) total = want;
  };
  const markChapter = (idx, cls) => {
    if (!idx) return;
    ensureGridCells(idx);
    const cell = cells[idx - 1];
    if (cell) cell.className = cls;
  };
  const setCur = (text) => {
    const cur = document.getElementById('pilot-cur');
    if (cur && text) cur.textContent = text;
  };
  // 实时成本条（本次运行累计）—— V0.96 抽为 runStatsBar 工厂（与「一键写本章」共用）
  const stats = runStatsBar();
  const costMini = stats.node;
  // 事件流
  const eventFeed = el('div', { class: 'ev-feed' }, el('div', { class: 'muted', text: '事件流将在此滚动…' }));
  const feed = (tag, msg, cls = '') => {
    const t = new Date(eventAt || Date.now()).toTimeString().slice(0, 8);
    eventFeed.append(el('div', { class: 'ev-item' },
      el('span', { class: 'ev-tag ' + cls, text: tag }), el('span', { class: 'grow', text: msg }), el('span', { class: 'ev-time', text: t })));
    eventFeed.scrollTop = eventFeed.scrollHeight;
  };
  // 已完成章节卡片
  const doneCards = el('div', { class: 'ch-done-cards' });
  const statusEl = el('div', { class: 'small mt' });
  const bar = el('div', { class: 'progress-bar mt' }, el('div', { style: 'width:2%' }));
  progressBox.append(curLine, grid, costMini, eventFeed, doneCards, statusEl, bar);

  // ---- 本次运行累计（V0.96 全部收进 stats 工厂，这里只剩全局刷新节流） ----
  let usageRefreshAt = 0; // V0.62：refreshGlobal 节流（此前每 usage 帧都 fetch → 高频请求 + 后端聚合压力）
  let lastBeatAt = Date.now();
  let lastStatus = '';
  let eventAt = Date.now();

  const setStatus = (msg) => { lastStatus = msg || ''; lastBeatAt = Date.now(); statusEl.textContent = lastStatus; };
  const setCurFromEvent = (data, fallback) => {
    const idx = chapterIdxFromEvent(data);
    if (idx) {
      markChapter(idx, 'ch-cell active');
      setCur(`第 ${idx} / ${total} 章${data.title ? `《${data.title}》` : ''}`);
      bar.firstChild.style.width = `${Math.round(((idx - 1) / Math.max(total, 1)) * 100)}%`;
      return;
    }
    if (fallback) setCur(String(fallback).slice(0, 80));
  };
  const beatTimer = setInterval(() => {
    const waited = Math.round((Date.now() - lastBeatAt) / 1000);
    if (waited < 20) return;
    const mm = Math.floor(waited / 60);
    const ss = waited % 60;
    statusEl.textContent = `${lastStatus || '模型仍在工作'} · 已等待 ${mm} 分 ${ss} 秒（作业未断）`;
  }, 10000);
  btn.disabled = true;
  btn.textContent = '自动创作中…（停止按钮可暂停，进度已保存）';
  const ctrl = registerSSE();
  const stopBtn = document.getElementById('pilot-stop');
  stopBtn?.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try {
      if (jobId) await writeApi.cancelWriteJob(book.id, jobId);
      else ctrl.abort();
      setStatus('已请求停止（进度已保存，再次点击「开始自动创作」从断点继续）');
    } catch (e) { toast(e.message, 'error'); stopBtn.disabled = false; }
  });
  try {
    const onPilotEvent = (event, data) => {
      if (data?.jobId) jobId = data.jobId;
      eventAt = data?.emittedAt || Date.now();
      const liveIdx = chapterIdxFromEvent(data);
      if (liveIdx) {
        try { sessionStorage.setItem(`mozhou-pilot-idx:${book.id}`, String(liveIdx)); } catch { /* ignore */ }
      }
      switch (event) {
        case 'stage': {
          setStatus(data.message || data.stage);
          setCurFromEvent(data, data.message || data.stage);
          const label = ({ setup: '准备', outline: '大纲', write: '写作', audit: '审校', settle: '结算', pleasure: '快感', archive: '归档', recovery: '恢复', polish: '打磨', volume_review: '卷体检' })[data.stage] || data.stage;
          feed(label, data.message || '', data.stage === 'write' ? 'write' : data.stage === 'audit' ? 'audit' : data.stage === 'settle' ? 'settle' : data.stage === 'archive' || data.stage === 'recovery' ? 'warn' : '');
          break;
        }
        case 'chapter_start': {
          ensureGridCells(data.idx);
          setStatus(`写作第 ${data.idx} 章《${data.title}》（进度 ${data.progress}）…`);
          markChapter(data.idx, 'ch-cell active');
          setCur(`第 ${data.idx} / ${total} 章《${data.title}》`);
          bar.firstChild.style.width = `${Math.round(((data.idx - 1) / Math.max(total, 1)) * 100)}%`;
          feed('章节', `开始第 ${data.idx} 章《${data.title}》`, 'write');
          getLivePatch()(data.idx, { status: 'writing', title: data.title });
          break;
        }
        case 'chapter_done': {
          markChapter(data.idx, 'ch-cell done');
          setCur(`第 ${data.idx} / ${total} 章完成`);
          // V0.96.5：效率观察面——字数与耗时（4 分 12 秒式），后端未带时静默降级
          const dur = data.durationMs ? ` · ${Math.floor(data.durationMs / 60000)} 分 ${Math.round(data.durationMs % 60000 / 1000)} 秒` : '';
          const wc = data.wordCount ? ` · ${fmt(data.wordCount)} 字` : '';
          setStatus(`第 ${data.idx} 章完成${wc}${dur}`);
          bar.firstChild.style.width = `${Math.round((data.idx / total) * 100)}%`;
          feed('章节', `第 ${data.idx} 章完成${data.partial ? '（部分场景失败）' : ''}${wc}${dur}`, 'settle');
          getLivePatch()(data.idx, { status: 'done', wordCount: data.wordCount, title: data.title });
          // 完成卡片（异步补摘要）
          (async () => {
            try {
              const ch = await get(`/api/books/${book.id}/chapters/${data.chapterId}`);
              getLivePatch()(data.idx, { status: ch.status, wordCount: ch.word_count, title: ch.title });
              const sum = (ch.summary || '').slice(0, 60) || '（无摘要）';
              const item = el('div', { class: 'ch-done-item', onclick: () => { location.hash = `#/book/${book.id}/workshop?chapter=${data.chapterId}`; } },
                el('div', {}, el('b', { text: `第${data.idx}章 ${ch.title || ''}` }), el('span', { class: 'small muted', style: 'margin-left:8px', text: `${ch.word_count || 0} 字` })),
                el('div', { class: 'sum', text: sum }));
              doneCards.prepend(item);
              while (doneCards.children.length > 6) doneCards.lastChild.remove();
            } catch { /* ignore */ }
          })();
          break;
        }
        case 'chapter_error':
          setStatus(`第 ${data.idx} 章失败（已记录，将自动诊断）：${data.error}`);
          feed('失败', `第 ${data.idx} 章：${data.error}`, 'warn');
          markChapter(data.idx, 'ch-cell failed');
          break;
        case 'chapter_blocked':
          // V0.92：后端严格按章序暂停；界面必须同步表达，不能误称“跳过继续写”。
          setStatus(`第 ${data.idx} 章未通过质量门（${data.error}），已暂停后续创作并保留正文`);
          feed('卡章', `第 ${data.idx} 章未通过质量门，已暂停；再次启动会先修复本章`, 'warn');
          markChapter(data.idx, 'ch-cell failed');
          getLivePatch()(data.idx, { status: 'quality_blocked' });
          break;
        case 'blocked_fixed':
          setStatus(`${data.message}`);
          feed('修复', data.message, 'ok');
          (data.chapters || []).forEach(idx => {
            markChapter(idx, 'ch-cell done');
            getLivePatch()(idx, { status: 'done' });
          });
          break;
        case 'blocked_pending':
          setStatus(`${data.message}`);
          feed('卡章', data.message, 'warn');
          toast(data.message, 'warn', 12000);
          break;
        // V0.96.5：观察面补角——runFlow 有而 runPilot 缺的审校结论，及三个重大事件
        case 'audit_done': {
          // 每章审校结论进动态流（质量趋势可见）；accept 不刷 toast 防打扰
          const verdictLabel = { accept: '✅ 通过', fix: '🔧 需修订', defer: '📋 记债放行', replan: '♻️ 重规划' }[data.verdict] || data.verdict || '?';
          const n = (data.issues || []).length;
          feed('审校', `${verdictLabel}${n ? `（${n} 处问题）` : ''}${data.grade ? ` · ${data.grade} 级` : ''}${data.round ? ` · 第 ${data.round} 轮` : ''}`, data.verdict === 'accept' ? 'settle' : 'audit');
          break;
        }
        case 'content_recovered':
          setStatus(data.message || '检测到正文缺失，已从快照恢复');
          feed('恢复', data.message || `已从快照恢复 ${data.count || '?'} 章正文`, 'warn');
          toast(data.message || '已从快照恢复缺失正文', 'warn', 10000);
          break;
        case 'replan_rollback':
          setStatus(data.message || '重规划未通过，已恢复旧正文');
          feed('回滚', data.message || '重规划未通过，已恢复重规划前正文', 'warn');
          break;
        case 'quality_blocked': {
          const idxCell = data.chapterId;
          setStatus(data.message || '质量门未通过，已暂停');
          feed('卡章', data.message || '质量门未通过（正文已保留）', 'warn');
          if (idxCell) { const qc = document.querySelector(`[data-chapter-id="${idxCell}"]`); if (qc) qc.classList.add('failed'); }
          break;
        }
        case 'debt':
          setStatus(`${data.message || '问题已记债'}`);
          feed('记债', data.message || '问题已记债', 'warn');
          break;
        case 'api_retry': {
          const reason = data.reason === 'RATE_LIMIT' ? '限流' : data.reason === 'STREAM_STALL' ? '响应卡死' : (data.reason || '卡顿');
          const wait = data.waitMs ? `，${Math.ceil(data.waitMs / 1000)} 秒后重试` : '';
          const msg = `API ${reason}，自动重试第 ${data.attempt} 次${wait}`;
          setStatus(`⏳ ${msg}`);
          feed('重试', data.message || msg, 'warn');
          break;
        }
        case 'scene_failed':
          setStatus(`场景 ${data.idx} 生成失败，已跳过继续（重跑可补写）`);
          feed('失败', `场景 ${data.idx} 生成失败`, 'warn');
          break;
        case 'chapter_partial':
          setStatus(`${data.message}`);
          toast(data.message, 'warn', 10000);
          break;
        case 'recovery':
          setStatus(`${data.message || '检测到质量信号，执行全局诊断…'}`);
          feed('恢复', data.message || '执行全局诊断…', 'warn');
          break;
        case 'recovery_diag':
          setStatus(`诊断完成：${(data.causes || []).map(c => `${c.type}(${c.severity})`).join('、') || '未见漂移'}，正在修复…`);
          feed('恢复', `诊断完成：${(data.causes || []).length} 项问题，正在修复…`, 'warn');
          break;
        case 'recovery_stage':
          // V0.57：重规划逐章进度（此前未处理→页面 10-20 分钟零反馈像卡死）
          setStatus(`🔧 ${data.message || '正在重规划…'}`);
          feed('恢复', data.message || '正在重规划…', 'warn');
          break;
        case 'recovery_executed':
          // V0.57：修复动作统计（作废事实/调伏笔/注入约束——本地毫秒级）
          feed('恢复', `已执行修复：${(data.executed || []).map(e => `${e.type}×${e.count}`).join('、') || '无'}`, 'warn');
          break;
        case 'recovery_done_all':
          setStatus(`第 ${data.round} 轮恢复完成${data.note ? `：${data.note.slice(0, 60)}` : ''}`);
          feed('恢复', `第 ${data.round} 轮恢复完成`, 'warn');
          break;
        case 'need_human':
          setStatus(`已暂停：${data.message || '需要人工介入'}`);
          toast(data.message || '需要人工介入', 'warn', 8000);
          break;
        case 'chapter_rewrite_rejected': {
          const idx = data.idx || data.chapterIdx || '?';
          const matched = data.matchedChapter ? `，疑似错写成第 ${data.matchedChapter} 章` : '';
          const message = `第 ${idx} 章重写被安全闸拒绝（${data.code || 'REWRITE_REJECTED'}${matched}），原正文已保留`;
          setStatus(`⚠ ${message}`);
          feed('安全闸', message, 'warn');
          toast(message, 'warn', 9000);
          break;
        }
        case 'archive_warn':
          setStatus(`${data.message || '历史堆接近预算'}`);
          break;
        case 'archive_notice':
          setStatus(`${data.message || '即将自动归档'}`);
          toast(data.message || '即将自动归档', 'info', 6000);
          break;
        case 'archive_done_all':
          setStatus(`已归档第 ${data.range?.[0]}-${data.range?.[1]} 章（节省 ${fmtTokens(data.tokensSaved)} tokens）`);
          feed('归档', `归档 ${data.range?.[0]}-${data.range?.[1]} 章`, 'warn');
          break;
        case 'archive_error':
          setStatus(`归档失败：${data.error}`);
          break;
        case 'volume_review_done':
          feed('卷体检', `${data.note || `第 ${data.volumeIdx} 卷体检：${data.grade} 级`}`, 'audit');
          setStatus(data.note || `第 ${data.volumeIdx} 卷体检完成`);
          setCur(data.note || `第 ${data.volumeIdx} 卷体检完成`);
          break;
        case 'lifecycle_checkpoint': {
          const blockingCount = data.blockingCount ?? data.blocking_count ?? 0;
          const message = data.message || `第${data.volumeIdx}卷阶段检查点：${data.stage || '当前阶段'}，待处理 ${blockingCount} 项`;
          setStatus(`🧭 ${message}`);
          feed('阶段', message, blockingCount > 0 ? 'warn' : 'ok');
          break;
        }
        // ---- V0.70：补齐 pilot 专属事件（此前在 runFlow 里处理但 pilot 才 emit——用户全程零反馈像卡死） ----
        case 'backfill':
          setStatus(data.message || `补写第 ${data.idx} 章…`);
          setCurFromEvent(data, data.message);
          feed('补写', data.message || `补写第 ${data.idx} 章`, 'write');
          if (data.idx) getLivePatch()(data.idx, { status: 'writing' });
          break;
        case 'backfill_scene':
          break; // 细节帧，不打扰
        case 'backfill_done':
          setStatus(data.message || `补写完成：${data.count} 处`);
          feed('补写', data.message || `补写完成：${data.count} 处`, 'settle');
          cells.forEach((cell) => {
            if (cell.className.includes('active')) cell.className = 'ch-cell done';
          });
          break;
        case 'volume_review_start':
          setStatus(data.message || `第 ${data.volumeIdx} 卷体检…`);
          setCur(data.message || `第 ${data.volumeIdx} 卷体检…`);
          feed('卷体检', data.message || `第 ${data.volumeIdx} 卷体检…`, 'audit');
          break;
        case 'volume_review_error':
          setStatus(`卷体检失败：${data.error}`);
          setCur(`卷体检失败：第 ${data.volumeIdx || '?'} 卷`);
          break;
        case 'volume_review_revising':
          setStatus(`第 ${data.volumeIdx} 卷体检发现 ${data.count} 个问题，自动修订中…`);
          setCur(`第 ${data.volumeIdx} 卷自动修订 ${data.count} 条工单…`);
          feed('卷体检', `第 ${data.volumeIdx} 卷 ${data.count} 个问题待修订`, 'audit');
          break;
        case 'volume_review_revise': {
          const msg = `第 ${data.chapterIdx} 章按卷审工单最小修订…`;
          setStatus(msg);
          setCur(msg);
          feed('卷修订', msg, 'audit');
          break;
        }
        case 'volume_review_revision_building':
          setStatus(data.message || '卷审候选正在影子取证…');
          setCur(data.message || '卷审候选正在影子取证…');
          feed('卷体检', data.message || '卷审候选正在影子取证…', 'audit');
          break;
        case 'volume_review_recheck':
          setStatus(data.message || '修订后复检…');
          setCur(data.message || '修订后复检…');
          feed('卷体检', data.message || '修订后复检…', 'audit');
          break;
        case 'align_chapter':
          setStatus(`章节改名：第 ${data.idx} 章《${data.oldTitle}》→《${data.newTitle}》`);
          feed('对齐', `第 ${data.idx} 章改名`, 'audit');
          break;
        case 'align_volume':
          setStatus(`卷名修正：第 ${data.volumeIdx} 卷《${data.oldTitle}》→《${data.newTitle}》`);
          break;
        case 'align_volume_outline':
          setStatus(`卷大纲已回填实际（第 ${data.volumeIdx} 卷）`);
          break;
        case 'align_book':
          setStatus(`书级大纲已自动对齐（回填 ${data.written} 卷实际）`);
          feed('对齐', '书级大纲自动对齐', 'audit');
          break;
        case 'auto_tidy':
          setStatus(data.message || '已自动整理');
          feed('整理', data.message || '已自动整理', 'settle');
          break;
        case 'continuation':
          setStatus(data.message || `续写第 ${data.volumeIdx} 卷…`);
          feed('续卷', data.message || `续写第 ${data.volumeIdx} 卷`, 'write');
          if (data.chapterCount) ensureGridCells(cells.length + Number(data.chapterCount));
          break;
        case 'book_done':
          setStatus(data.message || '全书完成！');
          feed('完成', data.message || '全书完成', 'settle');
          toast(data.message || '全书完成！', 'success');
          break;
        case 'mid_review':
          setStatus(data.message || '中期审阅完成');
          feed('打磨', data.message || '中期审阅完成', 'audit');
          break;
        case 'foreshadow_plan':
          setStatus(data.message || '伏笔收束计划已生成');
          feed('伏笔', data.message || '伏笔收束计划已生成', 'audit');
          break;
        case 'usage': {
          // V0.62：refreshGlobal 节流——usage 帧每场景多次，此前每次都 fetch /api/settings+/api/costs
          // （全表聚合）→ 高频请求压后端，造成"后端卡死/前端一直刷新"观感；3 秒最多刷新一次
          if (!usageRefreshAt || Date.now() - usageRefreshAt > 3000) {
            usageRefreshAt = Date.now();
            refreshGlobal();
          }
          stats.onUsage(data); // V0.96：累计/渲染收进工厂（tokens 口径：promptTokens 已含 hit+miss）
          break;
        }
        case 'error': throw new Error(data.error);
        case 'done': {
          // V0.72 修复：'done' 事件被三方共用（pipeline 每章帧/打磨帧/全书帧）——
          // 每章/打磨帧无 written/total，此前直接显示 undefined/undefined；无字段则按"本章流程完成"处理
          if (data.written === undefined) {
            setStatus(data.message || '本章流程完成');
            feed('流程', data.message || '本章流程完成', 'settle');
            cells.forEach((cell) => {
              if (cell.className.includes('active')) cell.className = 'ch-cell done';
            });
            break;
          }
          // V0.96.5：done 汇总带本轮耗时与产出字数（效率观察面；旧版后端未带时静默降级）
          const totalDur = data.durationMs ? ` · 耗时 ${Math.floor(data.durationMs / 60000)} 分 ${Math.round(data.durationMs % 60000 / 1000)} 秒` : '';
          const totalWc = data.writtenWords ? ` · ${fmt(data.writtenWords)} 字` : '';
          setStatus(data.partial ? `自动创作完成：共 ${data.written}/${data.total} 章（${data.partialChapters || 0} 章有失败场景，重跑自动补写）${totalWc}${totalDur}` : `自动创作完成：共 ${data.written}/${data.total} 章${totalWc}${totalDur}`);
          bar.firstChild.style.width = '100%';
          if (stopBtn) stopBtn.disabled = true;
          feed('完成', `自动创作完成 ${data.written}/${data.total} 章${totalWc}${totalDur}，本次 ${stats.summary()}`, 'settle');
          toast(data.partial ? `自动创作完成 ${data.written}/${data.total} 章，有失败场景待补写` : `自动创作完成 ${data.written}/${data.total} 章`, data.partial ? 'warn' : 'success');
          break;
        }
        // V0.72：实时费用事件（后端 router.js 流结束后推送 cost；此前 usage 帧无 cost 字段 → 恒 ¥0.0000）
        case 'usage_cost': {
          stats.onCost(data);
          break;
        }
      }
    };
    if (jobId) await writeApi.observeWriteJob(book.id, jobId, onPilotEvent, ctrl.signal);
    else await writeApi.startPilot(book.id, { targetChapters, polish: !!polishCheck?.checked }, onPilotEvent, ctrl.signal);
  } catch (e) {
    // 路由切换 abort 观察流：作业仍在跑，不要把按钮说成已停止全书。
    if (e.name === 'AbortError') {
      btn.disabled = false;
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
      btn.textContent = '重新连接进度';
      setStatus('已离开本页（服务端仍在写；回写作台或点顶栏可继续观察）');
      return;
    }
    setStatus(`${e.message}`);
    toast(e.message || '自动创作出错', 'error');
  } finally {
    clearInterval(beatTimer);
    unregisterSSE(ctrl);
  }
  btn.disabled = false;
  btn.classList.remove('busy');
  btn.removeAttribute('aria-busy');
  btn.textContent = '▶ 开始自动创作';
  // V0.29：仅在仍停留本书时刷新（防止切页后强制重渲染）
  if (state.book?.id === book.id) { await refreshBook(); rerender(); }
}

/** 全书打磨（polish）：诊断→核查→工单→逐章修订 */
/**
 * V0.109.4 紧急完本：不想再写下去时，规划一个短收束卷集中兑付伏笔，写完即完本。
 * 不绕过任何质量闸——收束卷的正文仍走正常写作/审校/结算流程，只是不再受字数下限与章数上限约束。
 */

export async function runPolishNow(book, root, btn, opts = {}) {
  let jobId = opts.jobId || (book.activeWriteJob?.type === 'polish' ? book.activeWriteJob.id : null);
  const progressBox = document.getElementById('pilot-progress');
  const statusEl = el('div', { class: 'small mt' });
  progressBox.innerHTML = '';
  progressBox.append(statusEl);
  btn.disabled = true;
  const ctrl = registerSSE();
  try {
    const onEvent = (event, data) => {
      if (data?.jobId) jobId = data.jobId;
      switch (event) {
        case 'stage': statusEl.textContent = data.message || data.stage; break;
        case 'diagnose_done': statusEl.textContent = `诊断完成：${data.priorities} 个优先问题`; break;
        case 'consistency_done': statusEl.textContent = `一致性核查：${data.checks} 条`; break;
        case 'workorders': statusEl.textContent = `工单已生成：${data.total} 条（同章合并）`; break;
        case 'chapter_polished': statusEl.textContent = `第 ${data.idx} 章${data.changed ? '已修订' : '无需修改'}`; break;
        case 'chapter_rewrite_rejected': {
          const idx = data.idx || data.chapterIdx || '?';
          const matched = data.matchedChapter ? `，疑似错写成第 ${data.matchedChapter} 章` : '';
          const message = `第 ${idx} 章重写被安全闸拒绝（${data.code || 'REWRITE_REJECTED'}${matched}），原正文已保留`;
          statusEl.textContent = `⚠ ${message}`;
          toast(message, 'warn', 9000);
          break;
        }
        case 'usage': refreshGlobal(); break;
        case 'error': throw new Error(data.error || data.message || '服务端错误');
        case 'done': {
          statusEl.textContent = `打磨完成：修订 ${data.executed} 章，跳过 ${data.skipped} 章`;
          toast(`全书打磨完成（修订 ${data.executed} 章）`);
          break;
        }
      }
    };
    if (jobId) await writeApi.observeWriteJob(book.id, jobId, onEvent, ctrl.signal);
    else await writeApi.startPolish(book.id, {}, onEvent, ctrl.signal);
  } catch (e) {
    if (e.name === 'AbortError') return; // 页面切换只断观察
    statusEl.textContent = `${e.message}`;
    toast(e.message, 'error');
  } finally {
    unregisterSSE(ctrl);
  }
  btn.disabled = false;
  if (state.book?.id === book.id) { await refreshBook(); rerender(); }
}

/** 全书打磨（polish）：诊断→核查→工单→逐章修订 */
/**
 * V0.109.4 紧急完本：不想再写下去时，规划一个短收束卷集中兑付伏笔，写完即完本。
 * 不绕过任何质量闸——收束卷的正文仍走正常写作/审校/结算流程，只是不再受字数下限与章数上限约束。
 */
async function openEmergencyFinish(book, root, btn) {
  let st = null;
  try { st = await get(`/api/books/${book.id}/emergency-finish`); } catch { /* 未启动时也能进 */ }

  if (st?.active && !st.done) {
    const { close } = openModal({
      title: '紧急完本进行中',
      body: el('div', {},
        el('p', { text: `第 ${st.volumeIdx} 卷（收束卷）已写 ${st.writtenChapters}/${st.targetChapters} 章，完成后自动判为完本。` }),
        el('p', { class: 'small muted', text: '继续点「开始自动创作」把它写完即可。取消紧急完本会保留收束卷，可当普通卷继续写。' }),
      ),
      actions: [
        { text: '取消紧急完本', class: 'ghost', onclick: async () => {
          await del(`/api/books/${book.id}/emergency-finish`);
          toast('已取消紧急完本');
          close(); rerender();
        } },
        { text: '知道了', onclick: () => close() },
      ],
    });
    return;
  }

  const chapterAttrs = { type: 'number', min: '3', max: '8', value: '4', style: 'width:90px' };
  const { close } = openModal({
    title: '紧急完本',
    body: el('div', {},
      el('p', { text: '系统会规划一个「收束卷」，把未回收的伏笔集中兑付，写完即完本。' }),
      el('p', { class: 'small muted', text: '不绕过任何质量防线：收束卷的正文照常写作、审校、结算，只是不再受 20 万字下限与 500 章上限约束。' }),
      el('div', { class: 'row mt' },
        el('label', { class: 'small', text: '收束卷章数' }),
        el('input', chapterAttrs),
        el('span', { class: 'small muted', text: '3-8 章；越少越紧凑，太少可能收不干净' }),
      ),
      el('p', { class: 'small muted mt', text: '启动后请继续点「开始自动创作」，系统会先把收束卷写完再停下。' }),
    ),
    actions: [
      { text: '取消', class: 'ghost', onclick: () => close() },
      { text: '启动紧急完本', onclick: async () => {
        try {
          await post(`/api/books/${book.id}/emergency-finish`, { chapters: Number(chapterAttrs.value) || 4 });
          toast('已启动紧急完本，正在规划收束卷…');
          close();
          if (root) runPilot(book, root, document.getElementById('pilot-btn'));
          else rerender();
        } catch (e) { toast(e.message || '启动失败', 'error'); }
      } },
    ],
  });
}

/** V0.109.4 续作：以本书为母本派生新书，继承世界观/设定/可选角色，重新立契约 */

/** V0.109.4 续作：以本书为母本派生新书，继承世界观/设定/可选角色，重新立契约 */
async function openSequel(book, root, btn) {
  let cand = null;
  try { cand = await get(`/api/books/${book.id}/sequel-candidates`); } catch (e) { toast(e.message || '读取母本失败', 'error'); return; }
  if (!cand) { toast('母本不存在', 'error'); return; }

  const titleAttrs = { type: 'text', value: `${cand.title}·续`, style: 'width:220px' };
  const worldAttrs = { type: 'checkbox', checked: cand.world.available };
  const factsAttrs = { type: 'checkbox', checked: cand.facts.available };
  const charsAttrs = { type: 'checkbox', checked: cand.characters.available };
  const castAttrs = { type: 'checkbox' };

  const { close } = openModal({
    title: '写续作（衍新书）',
    body: el('div', {},
      el('p', { text: `以《${cand.title}》为母本开新书。继承世界观与设定，但契约与主线重新立——续作是新书，不是把旧账接着记。` }),
      el('div', { class: 'row mt' }, el('label', { class: 'small', text: '新书标题' }), el('input', titleAttrs)),
      el('div', { class: 'mt' },
        el('label', { class: 'small', style: 'display:block;margin-bottom:6px', text: '继承内容' }),
        el('label', { class: 'small', style: 'display:block' }, el('input', worldAttrs), ` 世界观（${cand.world.chars} 字）`),
        el('label', { class: 'small', style: 'display:block' }, el('input', factsAttrs), ` 事实库（${cand.facts.count} 条）`),
        el('label', { class: 'small', style: 'display:block' }, el('input', charsAttrs), ` 角色（${cand.characters.count} 位：${cand.characters.names.slice(0, 6).join('、')}${cand.characters.count > 6 ? '…' : ''}）`),
        el('label', { class: 'small', style: 'display:block' }, el('input', castAttrs), ' 旧主角弧光材料（默认不带——它描述旧主角的成长线，可能与新主线打架）'),
      ),
      el('p', { class: 'small muted mt', text: '旧卷、旧章、旧角色当前状态都不会带过去，避免新书开篇与自己的设定打架。' }),
    ),
    actions: [
      { text: '取消', class: 'ghost', onclick: () => close() },
      { text: '创建续作', onclick: async () => {
        try {
          const r = await post(`/api/books/${book.id}/sequel`, {
            title: titleAttrs.value,
            inherit: {
              world: worldAttrs.checked, facts: factsAttrs.checked,
              characters: charsAttrs.checked, cast: castAttrs.checked,
            },
          });
          toast(`已创建《${r.title}》：世界 ${r.inherited.world ? '✓' : '—'}、事实 ${r.inherited.facts} 条、角色 ${r.inherited.characters} 位`);
          close();
          location.hash = `#/book/${r.bookId}/workshop`;
        } catch (e) { toast(e.message || '创建失败', 'error'); }
      } },
    ],
  });
}
