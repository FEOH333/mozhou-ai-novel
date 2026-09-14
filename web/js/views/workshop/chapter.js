// 由 workshop.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import { get, post, patch, put, del, sse, openingApi, publicationApi, narrativeApi, writeApi } from '../api.js';
import { el, toast, confirmDialog, openModal, icon, fmt, fmtTokens, fmtMoney, fmtPct, esc, pageHead, progressCard, CHAPTER_STATUS, CHAPTER_STATUS_TAG, chapterStatusLabel } from '../ui.js';
import { state, refreshBook, refreshGlobal, rerender, registerSSE, unregisterSSE } from '../app.js';
import {
  STEP_META, chapterListState, runStatsBar,
  getChFilter, setChFilter, getLivePatch, setLivePatch,
} from './workshop/shared.js';

export function renderChapter(book, chapter) {
  const root = el('div', { class: 'col', id: 'chapter-read' });

  const stepOrder = ['outlined', 'drafted', 'revised', 'settled', 'done'];
  let curStepIdx = stepOrder.findIndex(s => chapter.status === s);
  if (chapter.status === 'revised') curStepIdx = stepOrder.length - 1;
  const expertOutline = (state.settings?.autoConfirmOutline ?? true) === false;

  const opsFold = el('details', { class: 'fold' },
    el('summary', {}, '本书务 · 本章单步（细纲 / 审校 / 覆盖 / 结算 / 重写）'),
    el('div', { class: 'ops-main mt' },
      el('button', { class: 'sm ghost', text: '一键写本章（全流程）', onclick: (ev) => runFlow(book, chapter, root, ev.currentTarget) }),
      el('button', { class: 'sm ghost', style: 'color:var(--red);border-color:var(--red)', text: '↻ 重写本章', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        if (!await confirmDialog('重写本章？', `将把第 ${chapter.idx} 章《${chapter.title}》打回待写状态（删除场景/摘要/结算，快照已自动保存可回滚）。\n\n若此章之后还有已完成章节，重写后建议用「自动创作」从本章继续（会重写后续章节的承接）。`)) { btn.disabled = false; return; }
        try {
          const r = await post(`/api/books/${book.id}/chapters/${chapter.id}/rewrite`, {});
          if (r.ok) { toast(r.note || '已打回重写', 'success'); await refreshBook(); rerender(); }
          else toast(r.error || '重写失败', 'error');
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false; btn.textContent = '↻ 重写本章';
      } }),
    ),
    el('div', { class: 'ops-sub mt' },
      el('span', { class: 'small', style: 'color:var(--text-3)', text: '单步：' }),
      el('button', { class: 'sm', text: '生成细纲', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '生成中…';
        const ctrl = registerSSE();
        try {
          const prog = progressCard('正在生成章节细纲…');
          root.append(prog.card);
          await sse(`/api/books/${book.id}/chapters/${chapter.id}/outline`, {}, (event, data) => {
            if (event === 'stage') prog.setMessage(data.message);
          }, ctrl.signal);
          prog.setMessage('细纲生成完成');
          toast('细纲已生成');
          rerender();
        } catch (e) {
          if (e.name !== 'AbortError') toast(e.message, 'error');
          btn.disabled = false; btn.textContent = '生成细纲';
        } finally { unregisterSSE(ctrl); }
      } }),
      el('button', { class: 'sm', text: '审校', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '审校中…';
        try {
          const r = await post(`/api/books/${book.id}/chapters/${chapter.id}/audit`);
          renderAudit(root, book, chapter, r);
          toast(r.verdict === 'pass' ? '审校通过' : `发现 ${r.issues.length} 个问题`);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false; btn.textContent = '审校';
      } }),
      el('button', { class: 'sm', text: '覆盖校验', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const r = await post(`/api/books/${book.id}/chapters/${chapter.id}/coverage`);
          toast(r.verdict === 'pass' ? '细纲要点全部覆盖' : `缺失：${r.missing.join('；')}`);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
      el('button', { class: 'sm', text: '结算', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '结算中…';
        try {
          const r = await post(`/api/books/${book.id}/chapters/${chapter.id}/settle`);
          toast(`结算完成：新事实 ${r.facts.created}，伏笔 ${r.foreshadows.planted + r.foreshadows.advanced + r.foreshadows.paidOff} 动作`);
          rerender();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '结算'; }
      } }),
    ),
  );

  root.append(
    el('div', { class: 'card chapter-read-head' },
      el('div', { class: 'row' },
        el('h2', { class: 'grow', style: 'margin:0', text: `${chapter.title || `第${chapter.idx}章`}` }),
        el('span', { class: 'tag ' + (CHAPTER_STATUS_TAG[chapter.status] || chapter.status || ''), text: chapterStatusLabel(chapter.status) }),
        el('span', { class: 'muted small', text: chapter.word_count ? `${chapter.word_count} 字` : '' }),
      ),
      el('div', { class: 'steps mt' }, ...STEP_META.flatMap(([k, label], i) => {
        const started = curStepIdx >= 0;
        const done = started && i <= curStepIdx;
        const active = started && i === curStepIdx + 1;
        return [
          el('span', { class: 'step ' + (done ? 'done' : (active ? 'active' : '')), text: label }),
          i < STEP_META.length - 1 ? el('span', { class: 'step-arrow', text: '→' }) : null,
        ];
      })),
      el('div', { id: 'flow-status', class: 'small muted mt', role: 'status' }),
      opsFold,
    ),
  );

  root.append(renderOutlineCard(book, chapter, expertOutline));

  // 场景卡
  const outline = chapter.outline || {};
  const sceneCards = el('div', { class: 'card' });
  sceneCards.append(el('h3', { text: `场景（${(chapter.scenes || []).length || (outline.scenes || []).length}）` }));
  const scenes = chapter.scenes?.length ? chapter.scenes : (outline.scenes || []).map((s, i) => ({ idx: i + 1, ...s, id: 's' + (i + 1), content: '' }));
  if (!scenes.length) {
    sceneCards.append(el('div', { class: 'muted', text: '还没有场景。先生成细纲，细纲确认后即可逐场景写作。' }));
  }
  for (const sc of scenes) {
    sceneCards.append(renderSceneCard(book, chapter, sc));
  }
  root.append(sceneCards);

  // 审校结果区
  const auditBox = el('div', { id: 'audit-box' });
  root.append(auditBox);
  return root;
}

// ---- 细纲卡 ----

// ---- 细纲卡 ----
function renderOutlineCard(book, chapter, expertOutline = false) {
  const outline = chapter.outline || {};
  const card = el('div', { class: 'card' });
  const has = outline.scenes?.length;

  card.append(el('h3', { text: '细纲' }));

  if (!has) {
    card.append(el('div', { class: 'muted mb', text: '本章尚无细纲。点击上方「生成细纲」，或手动编辑 JSON。' }));
    card.append(el('button', { class: 'sm', text: '手动编辑 JSON', onclick: () => {
      card.append(renderOutlineEditor(book, chapter, card));
    } }));
    return card;
  }

  card.append(
    el('div', { class: 'row' },
      el('strong', { text: outline.title || `第${chapter.idx}章` }),
      el('span', { class: 'tag outlined', text: '已细纲' }),
      el('span', { class: 'grow' }),
      expertOutline ? el('button', { class: 'sm', text: '确认细纲', onclick: async (ev) => {
        const btn = ev.currentTarget;
        try {
          btn.textContent = '已确认';
          await post(`/api/books/${book.id}/chapters/${chapter.id}/confirm`);
          toast('细纲已确认');
        } catch (e) { toast(e.message, 'error'); btn.textContent = '确认细纲'; }
      } }) : null,
      el('button', { class: 'sm ghost', text: '编辑 JSON', onclick: () => { card.append(renderOutlineEditor(book, chapter, card)); } }),
    ),
    el('div', { class: 'small mt' },
      el('div', { class: 'muted', text: `${outline.goal || '（无目标）'}` }),
      el('div', { class: 'muted', text: `冲突：${outline.conflict || '（无）'}` }),
    ),
    el('table', { class: 'mt' },
      el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: '视角' }), el('th', { text: '地点' }), el('th', { text: '节拍' }), el('th', { text: '字数' }))),
      el('tbody', {}, ...(outline.scenes || []).map((s, i) =>
        el('tr', {},
          el('td', { text: s.id || i + 1 }),
          el('td', { text: s.pov || '—' }),
          el('td', { text: s.location || '—' }),
          el('td', { class: 'small', text: s.beat || '—' }),
          el('td', { class: 'muted', text: s.target_words || 1000 }),
        ),
      )),
    ),
    outline.checkpoints?.length
      ? el('div', { class: 'mt' }, el('div', { class: 'small muted', text: '检查点：' }),
          ...outline.checkpoints.map((c, i) => el('div', { class: 'small', text: `${i + 1}. ${c}` })))
      : null,
  );
  return card;
}

function renderOutlineEditor(book, chapter, card) {
  const ta = el('textarea', { class: 'mono', style: 'min-height:280px', text: JSON.stringify(chapter.outline || {}, null, 2) });
  const wrap = el('div', { class: 'mt' },
    ta,
    el('div', { class: 'row mt' },
      el('button', { class: 'primary sm', text: '保存细纲', onclick: async (ev) => {
        try {
          const o = JSON.parse(ta.value);
          await patch(`/api/books/${book.id}/chapters/${chapter.id}`, { outline: o, status: 'outlined' });
          toast('细纲已保存');
          rerender();
        } catch (e) { toast('JSON 格式错误：' + e.message, 'error'); }
      } }),
      el('button', { class: 'sm', text: '收起', onclick: () => wrap.remove() }),
    ),
  );
  return wrap;
}

// ---- 场景卡 ----

// ---- 场景卡 ----
function renderSceneCard(book, chapter, sc) {
  const status = sc.status || 'planned';
  const card = el('div', { class: `scene-card ${status}` });

  const contentBox = el('div', { class: 'scene-body', 'data-scene-id': sc.id });
  if (sc.content) contentBox.textContent = sc.content;
  else contentBox.append(el('span', { class: 'muted', text: '（未生成）' }));

  // V0.94.1：实际字数 vs 目标达成度（中文口径，与后端 estimateChineseChars 一致按汉字计）
  const hanCount = (sc.content || '').replace(/[^\u4e00-\u9fff]/g, '').length;
  const targetWords = Number(sc.target_words) || 1000;
  const wordsMeta = hanCount
    ? el('span', {
        class: 'small scene-words ' + (hanCount >= targetWords * 0.9 ? 'over' : 'under'),
        title: `实际 ${hanCount} 字 / 目标 ${targetWords} 字`,
        text: `${fmt(hanCount)}/${fmt(targetWords)} 字`,
      })
    : el('span', { class: 'small muted', text: `目标 ${targetWords} 字` });

  card.append(
    el('div', { class: 'scene-head' },
      el('strong', { text: `场景 ${sc.idx}` }),
      el('span', { class: 'tag', text: sc.pov || '多视角' }),
      el('span', { class: 'tag', text: sc.location || '未知地点' }),
      wordsMeta,
      el('span', { class: 'tag ' + (status === 'done' || status === 'revised' ? 'done' : ''), text: chapterStatusLabel(status) }),
      el('span', { class: 'grow' }),
    ),
    contentBox,
    el('div', { class: 'small muted mt', text: sc.beat || '' }),
    el('details', { class: 'fold mt' },
      el('summary', {}, '本场操作（重写 / 手改）'),
      el('div', { class: 'row mt' },
        el('button', { class: 'sm ghost', text: sc.content ? '重写' : '写本场景', onclick: (ev) => writeSceneStream(book, chapter, sc, card, contentBox, ev.currentTarget) }),
        el('button', { class: 'sm ghost', text: '编辑', onclick: () => {
          const ta = el('textarea', { class: 'mono', style: 'min-height:200px', text: sc.content || '' });
          const prev = contentBox.innerHTML;
          contentBox.innerHTML = '';
          contentBox.append(ta,
            el('div', { class: 'row mt' },
              el('button', { class: 'sm primary', text: '保存正文', onclick: async () => {
                try {
                  const saved = await patch(`/api/books/${book.id}/scenes/${sc.id}`, { content: ta.value, status: 'revised' });
                  toast(saved.requiresStateRebuild
                    ? '正文已保存；旧摘要和旧大纲已停用，请在“叙事版本安全门”重建后再自动续写'
                    : '已保存；若该章已发布，也已加入线上待同步清单。',
                  saved.requiresStateRebuild ? 'warn' : 'success');
                  rerender();
                } catch (e) { toast(e.message, 'error'); }
              } }),
              el('button', { class: 'sm', text: '取消', onclick: () => { contentBox.innerHTML = prev; } }),
            ),
          );
        } }),
      ),
    ),
  );
  return card;
}

/** 单场景流式写作 */

/** 单场景流式写作 */
async function writeSceneStream(book, chapter, sc, card, contentBox, btn) {
  btn.disabled = true;
  btn.textContent = '写作中…';
  contentBox.textContent = '';
  contentBox.classList.add('stream-cursor');
  const ctrl = registerSSE();
  let pendingDelta = '';
  let deltaTimer = null;
  let aborted = false;
  const flushDelta = () => {
    deltaTimer = null;
    if (!pendingDelta) return;
    const cur = contentBox.textContent;
    contentBox.textContent = cur.length > 8000 ? cur.slice(-6000) + pendingDelta : cur + pendingDelta;
    pendingDelta = '';
    card.scrollIntoView({ block: 'nearest' });
  };
  try {
    // V0.38：流式 delta 节流渲染——逐帧 textContent+= 会数千次全量重建 DOM（内存/CPU 暴涨），
    // 改为 80ms 合并写入 + 限长 8000 字符（完整正文在书页/场景存档中读取，显示区只作预览）
    await sse(`/api/books/${book.id}/chapters/${chapter.id}/write`, { sceneId: sc.id }, (event, data) => {
      if (event === 'delta') {
        pendingDelta += data.delta;
        if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 80);
      } else if (event === 'usage') {
        refreshGlobal();
      } else if (event === 'progress') {
        btn.textContent = data.message || '写作中…';
      } else if (event === 'error') {
        throw new Error(data.error);
      } else if (event === 'done') {
        flushDelta();
        toast(`场景 ${sc.idx} 完成（${fmt(data.wordCount)} 字）`);
      }
    }, ctrl.signal);
  } catch (e) {
    if (e.name === 'AbortError') aborted = true;
    else toast(e.message, 'error');
  } finally {
    if (deltaTimer) clearTimeout(deltaTimer);
    unregisterSSE(ctrl);
  }
  contentBox.classList.remove('stream-cursor');
  btn.disabled = false;
  btn.textContent = '↻ 重写';
  if (aborted) return;
  await refreshBook();
  // 刷新章节状态（场景已入库）
  const fresh = await get(`/api/books/${book.id}/chapters/${chapter.id}`);
  const freshScene = fresh.scenes.find(s => s.id === sc.id);
  if (freshScene?.content) contentBox.textContent = freshScene.content;
}

/** 一键写本章（SSE 全流程） */

/** 一键写本章（SSE 全流程） */
export async function runFlow(book, chapter, root, btn) {
  const doRun = async () => {
    btn.disabled = true;
    btn.textContent = '写作中…';
    const steps = root.querySelectorAll('.step');
    const setStep = (i, cls) => { if (steps[i]) { steps[i].className = 'step ' + cls; } };
    // V0.73 修复：runFlow 此前调用未定义的 setStatus → 每次一键写本章结尾抛 ReferenceError。
    // 定义本地 setStatus（回退到状态条；不可用时静默，不阻断流程）。
    const statusEl = root.querySelector('#flow-status');
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
    // V0.96：单章流程也显示本次运行统计条（此前只在自动创作里有——单章写作 tokens/费用全程不可见）
    const stats = runStatsBar();
    const statsMount = statusEl?.parentElement || root;
    statsMount.insertBefore(stats.node, statusEl?.nextSibling || null);
    let usageRefreshAt = 0;
    const ctrl = registerSSE();
    let awaitingConfirm = false; // V0.73：need_confirm 后不 rerender（否则确认框被页面重建销毁）
    try {
      await sse(`/api/books/${book.id}/chapters/${chapter.id}/flow`, {
        // V0.20 修复：尊重设置（此前硬编码 false 使"自动确认"设置失效）
        autoConfirm: state.settings?.autoConfirmOutline ?? true,
      }, (event, data) => {
        switch (event) {
          case 'stage': {
            const idx = STEP_META.findIndex(([k]) => k === data.stage);
            if (idx >= 0) {
              for (let i = 0; i < steps.length; i++) setStep(i, i < idx ? 'done' : (i === idx ? 'active' : ''));
            }
            // V0.29：只在关键阶段 toast（降噪，避免每 stage 弹一次）
            if (['replan', 'recover', 'archive'].includes(data.stage)) toast(data.message, 'info', 4000);
            break;
          }
          case 'delta': {
            const box = root.querySelector(`.scene-body[data-scene-id="${data.sceneId}"]`);
            if (box) {
              if (!box.dataset.streaming) { box.textContent = ''; box.dataset.streaming = '1'; } // V0.20：先清占位/旧文
              box.textContent += data.delta;
            }
            break;
          }
          case 'need_confirm': {
            // V0.20：不再只弹 5 秒 toast——提供"确认并继续"入口
            // V0.73：标记 awaitingConfirm——doRun 结尾跳过 rerender，防止确认框被页面重建销毁
            awaitingConfirm = true;
            toast('细纲已生成，请确认后继续', 'warn', 8000);
            const box = root.querySelector('#confirm-box') || el('div', { id: 'confirm-box' });
            box.innerHTML = '';
            box.append(el('div', { class: 'card' },
              el('div', { class: 'row' },
                el('span', { class: 'grow', text: '细纲已生成（当前设置为人工确认）' }),
                el('button', { class: 'primary sm', text: '确认并继续写本章', onclick: async (ev) => {
                  const b = ev.currentTarget; b.disabled = true; b.textContent = '继续中…';
                  try {
                    // V0.29 修复：细纲已落库——中断旧流并重新发起全流程（服务端复用细纲直接写正文）
                    ctrl.abort();
                    unregisterSSE(ctrl);
                    await new Promise(r => setTimeout(r, 400));
                    box.remove();
                    // 重新跑完整流程（新 SSE 流）
                    runFlow(book, chapter, root, btn);
                  } catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = '确认并继续写本章'; }
                } }),
              ),
            ));
            root.append(box);
            break;
          }
          case 'usage': {
            // V0.96：单章统计累计 + 全局刷新节流（与自动创作同款）
            if (!usageRefreshAt || Date.now() - usageRefreshAt > 3000) {
              usageRefreshAt = Date.now();
              refreshGlobal();
            }
            stats.onUsage(data);
            break;
          }
          case 'usage_cost': stats.onCost(data); break; // V0.96：流结束费用帧（此前 runFlow 无此处理 → 费用恒 ¥0）
          case 'archive_warn': setStatus(data.message || '历史堆接近预算'); toast(data.message || '历史堆接近预算', 'warn'); break;
          case 'archive_need': setStatus(data.message || '建议归档'); toast(data.message || '建议归档', 'warn', 6000); break;
          case 'debt': /* 质量债务：记入冲突表，后续章节圆场——仅提示 */ if (data.issue) toast('已记质量债务：' + data.issue.slice(0, 60), 'info', 4000); break;
          case 'pleasure_done': break;
          case 'done': setStatus(data.message || '本章流程完成'); if (stats.summary() !== '0 次调用 / 0 tokens / ¥0') setStatus(`本章流程完成 · 本次 ${stats.summary()}`); break;
          case 'scene_done': {
            // V0.21：流式重试后全文替换（防 delta 重复拼接错位）
            const box2 = root.querySelector(`.scene-body[data-scene-id="${data.sceneId}"]`);
            if (box2 && data.content) { box2.textContent = data.content; delete box2.dataset.streaming; }
            break;
          }
          case 'api_retry': {
            // V0.21：API 卡顿自动重试提示
            const reason = data.reason === 'RATE_LIMIT' ? '限流' : data.reason === 'STREAM_STALL' ? '响应卡死' : '服务异常';
            toast(`API ${reason}，自动重试第 ${data.attempt} 次…`, 'warn', 6000);
            break;
          }
          case 'scene_failed': {
            const box4 = root.querySelector(`.scene-body[data-scene-id="${data.sceneId}"]`);
            if (box4) box4.classList.add('scene-failed');
            toast(`场景 ${data.idx} 生成失败，已跳过（重跑可自动补写）`, 'error', 8000);
            break;
          }
          case 'chapter_partial': {
            toast(data.message, 'warn', 10000);
            break;
          }
          case 'align_chapter': {
            // V0.45：章名自动修正
            setStatus(`✏️ 第 ${data.idx} 章改名：《${data.oldTitle}》→《${data.newTitle}》（内容与原名不符，自动对齐）`);
            toast(`第 ${data.idx} 章已改名《${data.newTitle}》`, 'info', 6000);
            break;
          }
          case 'align_volume': {
            setStatus(`📦 第 ${data.idx} 卷改名：《${data.oldTitle}》→《${data.newTitle}》`);
            toast(`第 ${data.idx} 卷已改名《${data.newTitle}》`, 'info', 6000);
            break;
          }
          case 'align_volume_outline': {
            setStatus(`📐 第 ${data.idx} 卷大纲已按实际内容回填对齐`);
            break;
          }
          case 'align_book': {
            setStatus(`🗺️ 书级大纲已自动对齐（${data.written} 卷实际内容回填，共 ${data.volumes} 卷规划）`);
            break;
          }
          case 'auto_tidy': {
            // V0.52：自动创作中自动整理角色库
            setStatus(`🧹 ${data.message || '已自动整理角色库'}`);
            break;
          }
          case 'continuation': {
            // V0.44：自动续卷事件
            setStatus(`📖 故事未完，自动续写第 ${data.volumeIdx} 卷《${data.title || ''}》（${data.chapterCount || ''} 章）`);
            toast(`故事未完（${data.reason || ''}），自动生成第 ${data.volumeIdx} 卷继续写`, 'info', 8000);
            break;
          }
          case 'book_done': {
            // V0.44：真正完本（AI 判定主线收束）
            setStatus(`🏁 全书完成：${data.reason || ''}`);
            toast(`全书完成：${data.reason || ''}`, 'success', 10000);
            break;
          }
          case 'audit_done': {
            const box = root.querySelector('#audit-box');
            if (box) renderAuditResult(box, book, chapter, data.issues, data.verdict, data.grade);
            break;
          }
          case 'error': throw new Error(data.error || data.message || '服务端错误');
        }
      }, ctrl.signal);
    } catch (e) {
      if (e.name === 'AbortError') { btn.disabled = false; btn.textContent = '一键写本章（全流程）'; return; } // V0.29：中止后彻底退出，不刷新/不重渲染
      toast(e.message || '流程出错', 'error');
    } finally {
      unregisterSSE(ctrl);
    }
    btn.disabled = false;
    btn.textContent = '一键写本章（全流程）';
    await refreshBook();
    // V0.73：等待人工确认时不 rerender（否则确认框被销毁，用户来不及点"确认并继续"）
    if (awaitingConfirm) return;
    // 写完一章：刷新整页获取最新章节/侧栏状态（数据已落库，刷新无副作用）
    rerender();
  };
  // V0.78 修复：revised 也是已完成（正文已修订过），点"一键写本章"同样弹确认，
  // 避免对已完成的 revised 章直接执行却因后端跳过而无反应
  if (chapter.status === 'done' || chapter.status === 'settled' || chapter.status === 'revised') {
    if (await confirmDialog('重写本章？', '本章已完成。继续将重新执行流程（已写场景会跳过）。')) doRun();
  } else doRun();
}

/** 审校结果渲染（独立按钮路径） */

/** 审校结果渲染（独立按钮路径） */
function renderAudit(root, book, chapter, r) {
  const box = root.querySelector('#audit-box') || el('div', { id: 'audit-box' });
  renderAuditResult(box, book, chapter, r.issues, r.verdict);
  root.append(box);
}

function renderAuditResult(box, book, chapter, issues, verdict, grade) {
  box.innerHTML = '';
  const card = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', text: `审校结果（${issues?.length || 0} 个问题）` }),
      grade ? el('span', { class: 'tag grade-' + grade.toLowerCase(), text: `质量等级 ${grade}` }) : null,
      el('span', { class: 'tag ' + (verdict === 'accept' || verdict === 'pass' ? 'done' : (verdict === 'defer' ? 'outlined' : 'high')), text: verdict === 'accept' || verdict === 'pass' ? '通过' : (verdict === 'defer' ? '已记债' : '需处理') }),
    ),
  );
  if (!issues?.length) {
    card.append(el('div', { class: 'muted', text: '未发现一致性问题。' }));
  }
  for (const i of issues || []) {
    card.append(
      el('div', { class: `issue ${i.severity || 'low'}` },
        el('div', {}, el('span', { class: 'tag ' + (i.severity || 'low'), text: i.type || '问题' }),
          el('span', { class: 'small muted', text: `（${i.severity || '低'}）` })),
        el('div', { class: 'mt', text: i.issue }),
        i.quote ? el('div', { class: 'q', text: `「${i.quote}」` }) : null,
        el('div', { class: 'row mt' },
          el('button', { class: 'sm', text: '修订该处', onclick: async (ev) => {
            const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '修订中…';
            try {
              const scenes = chapter.scenes || [];
              const target = scenes.find(s => i.quote && s.content.includes(i.quote.slice(0, 20))) || scenes[scenes.length - 1];
              await post(`/api/books/${book.id}/chapters/${chapter.id}/revise`, {
                sceneId: target?.id, issues: [i],
                extraNote: '仅修正上述问题，保持情节走向不变',
              });
              toast('已修订（该场景起的历史已重建，后续请求缓存将重新构建）');
              rerender();
            } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '修订该处'; }
          } }),
        ),
      ),
    );
  }
  box.append(card);
}

/** 自动创作（pilot）：一键自动全书（V0.43 可视化大升级：章节网格/当前章/成本条/完成卡片/事件流） */
