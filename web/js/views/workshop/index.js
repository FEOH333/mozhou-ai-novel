// 写作台骨架（V0.109.5 由 workshop.js 拆分）：页面布局 + 侧栏章列表 + 各卡片装配。
// 子模块职责见同目录：pilot(自动创作/打磨) chapter(章节与场景) publication(发稿驾驶舱) opening(开篇决策) shared(共用件)。
'use strict';

import { get, post, patch, put, del, sse, openingApi, publicationApi, narrativeApi, writeApi } from '../api.js';
import { el, toast, confirmDialog, openModal, icon, fmt, fmtTokens, fmtMoney, fmtPct, esc, pageHead, progressCard, CHAPTER_STATUS, CHAPTER_STATUS_TAG, chapterStatusLabel } from '../ui.js';
import { state, refreshBook, refreshGlobal, rerender, registerSSE, unregisterSSE } from '../app.js';
import {
  STEP_META, chapterListState, runStatsBar,
  getChFilter, setChFilter, getLivePatch, setLivePatch,
} from './workshop/shared.js';

import {
  renderAutoCreationCard,
  runPilot,
  runPolishNow,
} from './pilot.js';
import {
  renderPublicationDashboard,
} from './publication.js';
import {
  renderOpeningDecisionCard,
} from './opening.js';
import {
  renderChapter,
} from './chapter.js';

export async function renderWorkshop(view, book) {
  const params = state.route?.query || new URLSearchParams();
  // V0.26：写作台头部显示书名（此前无任何书级标识）
  view.append(pageHead('icon:pencil:写作台', `《${book.title || '未命名'}》·观察自动创作 · 当前章正文`));
  // V0.21：API 状态徽章（健康度随 settings 响应附带）
  try {
    const st = await get('/api/settings');
    const h = st._llmHealth || {};
    const tripped = (h.circuits || []).filter(c => c.state === 'OPEN');
    const rate = h.recentSuccessRate;
    let badge = { text: 'API 正常', cls: 'api-ok' };
    if (tripped.length) badge = { text: 'API 故障熔断中（自动恢复中）', cls: 'api-bad' };
    else if (rate !== null && rate < 70) badge = { text: `API 不稳定（近20次成功率 ${rate}%）`, cls: 'api-warn' };
    else if (h.recentAvgDurationMs > 15000) badge = { text: `API 响应慢（平均 ${Math.round(h.recentAvgDurationMs / 1000)}s）`, cls: 'api-warn' };
    else if (h.lastErrors?.length) badge = { text: `API 偶发错误（最近 ${h.lastErrors.length} 次失败）`, cls: 'api-warn' };
    view.append(el('div', { class: 'api-badge ' + badge.cls, text: badge.text }));
  } catch { /* 健康度不可用时静默 */ }
  // V0.94.1：快照/创作设置从首屏工作区上方移入末尾折叠区「书务台」——
  // 此前两张大卡把章节工作区挤到首屏之外（核心操作反而要滚动寻找）
  // V0.22：作品快照（打磨前自动快照 + 手动快照 + 一键回滚，借鉴 storyforge 版本历史）
  // V0.96.4：快照「对比」入口（借鉴 DeepWrite 可审阅的文稿修改）——重写/打磨前自动快照
  // 早已存在，缺的是"改了什么"的可见性；对比只读，回滚仍是全有全无的既有闸门
  const diffPanel = el('div');
  const CHANGE_BADGE = { modified: ['修改', 'badge-warn'], added: ['新增', 'badge-ok'], removed: ['删除', 'badge-del'] };
  /** 块级 diff 渲染：连续未变段 >2 时折叠中间（保留首尾各 1 段上下文） */
  const renderDiffBlocks = (blocks) => {
    const nodes = [];
    let i = 0;
    while (i < blocks.length) {
      if (blocks[i].type !== '=') {
        const cls = blocks[i].type === '-' ? 'diff-block-del' : 'diff-block-add';
        nodes.push(el('div', { class: `diff-block ${cls}`, text: (blocks[i].type === '-' ? '− ' : '+ ') + blocks[i].text }));
        i++;
        continue;
      }
      let j = i;
      while (j < blocks.length && blocks[j].type === '=') j++;
      const run = blocks.slice(i, j);
      if (run.length <= 2) {
        for (const b of run) nodes.push(el('div', { class: 'diff-block diff-block-same', text: b.text }));
      } else {
        nodes.push(el('div', { class: 'diff-block diff-block-same', text: run[0].text }));
        nodes.push(el('div', { class: 'diff-fold', text: `⋯ 中间 ${run.length - 2} 段未变 ⋯` }));
        nodes.push(el('div', { class: 'diff-block diff-block-same', text: run[run.length - 1].text }));
      }
      i = j;
    }
    return nodes;
  };
  const openChapterDiff = async (holder, snapId, idx) => {
    holder.innerHTML = '';
    holder.append(el('div', { class: 'small muted', text: '加载对比…' }));
    try {
      const d = await get(`/api/books/${book.id}/snapshots/${snapId}/diff?chapter=${idx}`);
      holder.innerHTML = '';
      holder.append(
        el('div', { class: 'small', style: 'margin:6px 0 4px' },
          `第 ${d.idx} 章 · 快照「${d.snapshotTitle || '（无）'}」(${fmt(d.snapWords)} 字) → 当前「${d.currentTitle || '（无）'}」(${fmt(d.curWords)} 字)`),
        ...renderDiffBlocks(d.blocks),
      );
    } catch (e) { holder.innerHTML = ''; holder.append(el('div', { class: 'small', text: `对比加载失败：${e.message}`, style: 'color:var(--red)' })); }
  };
  const openSnapshotDiff = async (snapId) => {
    diffPanel.innerHTML = '';
    diffPanel.append(el('div', { class: 'small muted', text: '加载对比…' }));
    try {
      const ov = await get(`/api/books/${book.id}/snapshots/${snapId}/diff`);
      diffPanel.innerHTML = '';
      if (ov.error) { diffPanel.append(el('div', { class: 'small', text: ov.error, style: 'color:var(--red)' })); return; }
      diffPanel.append(
        el('div', { class: 'row', style: 'gap:8px;align-items:center' },
          el('b', { text: `对比「${ov.snapshot.label}」` }),
          el('span', { class: 'small muted', text: ov.chapters.length ? `${ov.chapters.length} 章有变化 · ${ov.unchanged} 章未变` : '与当前完全一致' }),
        ),
      );
      for (const row of ov.chapters) {
        const [badgeText, badgeCls] = CHANGE_BADGE[row.change] || [row.change, 'badge-warn'];
        const holder = el('div');
        const titleText = row.titleChanged
          ? `「${row.snapTitle}」→「${row.curTitle}」`
          : `「${row.curTitle || row.snapTitle}」`;
        const wordsText = row.change === 'added' ? `${fmt(row.curWords)} 字`
          : row.change === 'removed' ? `${fmt(row.snapWords)} 字`
            : `${fmt(row.snapWords)} → ${fmt(row.curWords)} 字`;
        diffPanel.append(el('div', { class: 'row', style: 'gap:8px;padding:3px 0' },
          el('button', { class: 'sm ghost', text: `第 ${row.idx} 章`, onclick: (ev) => {
            const b = ev.currentTarget;
            if (holder.childNodes.length) { holder.innerHTML = ''; b.classList.remove('primary'); return; }
            b.classList.add('primary');
            openChapterDiff(holder, snapId, row.idx);
          } }),
          el('span', { class: `badge ${badgeCls}`, text: badgeText }),
          el('span', { class: 'small grow', text: titleText }),
          el('span', { class: 'small muted', text: wordsText }),
        ), holder);
      }
    } catch (e) {
      diffPanel.innerHTML = '';
      diffPanel.append(el('div', { class: 'small', text: `对比加载失败：${e.message}`, style: 'color:var(--red)' }));
    }
  };
  const foldBody = el('div', { class: 'fold-body' });
  try {
    const snaps = await get(`/api/books/${book.id}/snapshots`);
    if (snaps.length) {
      const snapCard = el('div', { class: 'card', style: 'margin-top:0' },
        el('div', { class: 'row' },
          el('h3', { class: 'grow', text: '版本快照（可回滚 · 可对比）' }),
          el('button', { class: 'sm ghost', text: '手动快照', onclick: async (ev) => {
            const b = ev.currentTarget; b.disabled = true;
            try { await post(`/api/books/${book.id}/snapshots`, { label: '手动快照' }); toast('快照已创建'); rerender(); }
            catch (e) { toast(e.message, 'error'); }
            b.disabled = false;
          } }),
        ),
        ...snaps.slice(0, 5).map(s =>
          el('div', { class: 'row', style: 'gap:8px;padding:4px 0;border-bottom:1px dashed var(--border)' },
            el('span', { class: 'grow small', text: `${s.label}（${new Date(s.created_at).toLocaleString()}）` }),
            el('button', { text: '对比当前', onclick: (ev) => {
              const b = ev.currentTarget;
              if (diffPanel.dataset.snap === s.id) { diffPanel.innerHTML = ''; delete diffPanel.dataset.snap; b.classList.remove('primary'); return; }
              diffPanel.dataset.snap = s.id;
              document.querySelectorAll('.snap-diff-btn.primary').forEach(x => x.classList.remove('primary'));
              b.classList.add('primary');
              openSnapshotDiff(s.id);
            }, class: 'sm ghost snap-diff-btn' }),
            el('button', { class: 'sm ghost danger', text: '回滚到此时', onclick: async (ev) => {
              const b = ev.currentTarget;
              if (!await confirmDialog('回滚到该快照？', '将用快照内容覆盖当前全部章节正文（当前内容会丢失），确定吗？')) return;
              b.disabled = true;
              try {
                const r = await post(`/api/books/${book.id}/snapshots/${s.id}/restore`);
                toast(r.message || '已恢复', 'success');
                rerender();
              } catch (e) { toast(e.message, 'error'); b.disabled = false; }
            } }),
          ),
        ),
        diffPanel,
      );
      foldBody.append(snapCard);
    }
  } catch { /* 快照不可用时静默 */ }

  // V0.22：创作设置（反 AI 味风格画像 + 文风样本 + 用户规则，借鉴 spark 风格克隆）
  let curSettings = {};
  try { curSettings = book.settings_json ? (JSON.parse(book.settings_json) || {}) : {}; } catch { curSettings = {}; } // V0.29 数据损坏保护
  const styleSel = el('select', {},
    el('option', { value: '', text: '不指定（默认）' }),
    ...Object.entries({
      fierce: '热血爽文（自撰样本：少年逆境争锋）',
      grim: '冷峻权谋（自撰样本：边镇冷笔）',
      light: '轻松日常（自撰样本：市井闲笔）',
      ancient: '古风雅韵（自撰样本：山门清谈）',
      urban: '都市快节奏（自撰样本：职场短刀）',
      noir: '悬疑暗流（自撰样本：雾巷折证）',
    }).map(([k, v]) =>
      el('option', { value: k, text: v, selected: curSettings.styleProfile === k }),
    ),
  );
  const styleSample = el('textarea', { placeholder: '可留空——未填时自动使用所选画像的内置代表作样本；填写则优先用你的（300-1500 字）', style: 'width:100%;min-height:70px', value: curSettings.styleSample || '' });
  const userRules = el('textarea', { placeholder: '自定义创作规则（可选）：如"主角绝不轻易原谅背叛者"', style: 'width:100%;min-height:50px', value: curSettings.userRules || '' });
  const styleCard = el('div', { class: 'card' },
    el('h3', { text: '创作设置（反 AI 味）' }),
    el('div', { class: 'small muted mb', text: '选择文风画像即内置对应自撰风格样本（正文自动模仿其节奏 + AI 高频词红线）。也可粘贴自己的文风样本覆盖内置样本，或留空直接用内置。' }),
    el('div', { class: 'mb', text: '文风画像：' }, styleSel),
    el('div', { class: 'mb', text: '文风样本：' }, styleSample),
    el('div', { class: 'mb', text: '自定义规则：' }, userRules),
    el('button', { class: 'primary sm', text: '保存创作设置', onclick: async (ev) => {
      const b = ev.currentTarget; b.disabled = true;
      try {
        await put(`/api/books/${book.id}/settings`, { settings: {
          styleProfile: styleSel.value,
          styleSample: styleSample.value.trim(),
          userRules: userRules.value.trim(),
        } });
        toast('创作设置已保存（将在下一章生效）', 'success');
      } catch (e) { toast(e.message, 'error'); }
      b.disabled = false;
    } }),
  );
  foldBody.append(styleCard);

  // V0.96：体检与检索——后端早有但前端零入口的三类能力补齐可视化：
  // ① 健康看板（drift 漂移/活跃约束 + autoRecover）② 全书语义搜索 ③ 引擎内部状态概览
  // （V0.95 叙事记忆库/滚动摘要/物品卡/批次自检此前纯引擎内部，用户完全看不到）。
  // 懒加载：点按钮才拉取，不增加页面渲染请求。
  const diagBody = el('div', {});
  const diagCard = el('div', { class: 'card' },
    el('h3', { text: '体检与检索' }),
    el('div', { class: 'small muted mb', text: '全书健康体检（漂移检测 + 活跃约束 + 一键恢复）· 语义搜索（找"某情节在哪章"）· 引擎内部状态（记忆库/滚动摘要/向量索引/三章一轮自检）' }),
    el('div', { class: 'row mb', style: 'flex-wrap:wrap;gap:8px' },
      el('button', { class: 'sm ghost', text: '🩺 健康体检', onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; diagBody.innerHTML = '';
        try {
          const h = await get(`/api/books/${book.id}/health`);
          const driftRows = (h.drift?.signals || h.drift || []);
          const driftList = Array.isArray(driftRows) ? driftRows : [];
          // V0.96.1：原生 append 不跳过 null（会渲染字面 "null"）——条件子节点 filter(Boolean)
          diagBody.append(...[
            el('h4', { text: '健康体检' }),
            el('div', { class: 'small mb', text: `归档批次 ${h.archives || 0} · 活跃约束 ${(h.constraints || []).length} 条 · 近 5 章健康记录 ${(h.recent || []).length} 条` }),
            driftList.length
              ? el('div', { class: 'small warn-text mb' }, ...driftList.map(s => el('div', { text: `⚠ ${typeof s === 'string' ? s : (s.signal || s.message || JSON.stringify(s))}` })))
              : el('div', { class: 'small mb', text: '✓ 无漂移信号' }),
            (h.constraints || []).length
              ? el('details', { class: 'small mb' }, el('summary', {}, '活跃写作约束（当前反哺指令）'), ...h.constraints.map(c =>
                  el('div', { class: 'small', style: 'padding:2px 0;border-bottom:1px dashed var(--border)', text: `ch${c.chapter_idx ?? c.from_chapter ?? '?'} · ${String(c.content || c.text || '').slice(0, 100)}` })))
              : null,
            el('button', { class: 'sm ghost', text: '⚙ 自动恢复（修复漂移/约束违反）', onclick: async (ev2) => {
              const b2 = ev2.currentTarget; b2.disabled = true;
              try { const r = await post(`/api/books/${book.id}/recover`, {}); toast(r.message || JSON.stringify(r).slice(0, 120), 'success'); }
              catch (e) { toast(e.message, 'error'); b2.disabled = false; }
            } }),
          ].filter(Boolean));
        } catch (e) { toast(e.message, 'error'); }
        b.disabled = false;
      } }),
      (() => {
        const q = el('input', { placeholder: '全书语义搜索：如"青布护身符首次出现"', style: 'flex:1;min-width:180px' });
        return el('span', { class: 'row', style: 'gap:8px;flex:1' },
          q,
          el('button', { class: 'sm ghost', text: '🔍 搜索', onclick: async (ev) => {
            const b = ev.currentTarget; b.disabled = true;
            try {
              const r = await get(`/api/books/${book.id}/search?q=${encodeURIComponent(q.value.trim())}`);
              diagBody.innerHTML = '';
              diagBody.append(el('h4', { text: `搜索：${q.value.trim()}` }));
              if (!r.available || !r.semantic?.length) {
                diagBody.append(el('div', { class: 'small muted', text: '无结果（或语义索引未就绪——可在「设置」页初始化向量索引后重试）' }));
              } else {
                for (const s of r.semantic) {
                  diagBody.append(el('div', { class: 'small', style: 'padding:4px 0;border-bottom:1px dashed var(--border)' },
                    el('span', { class: 'ev-tag', text: `[${s.kind}] ` }),
                    el('span', { text: (s.chunk || '').slice(0, 160) + ((s.chunk || '').length > 160 ? '…' : '') }),
                    el('span', { class: 'muted', text: `  相似度 ${(s.score * 100).toFixed(0)}%` })));
                }
              }
            } catch (e) { toast(e.message, 'error'); }
            b.disabled = false;
          } }));
      })(),
      el('button', { class: 'sm ghost', text: '🧠 引擎概览', onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; diagBody.innerHTML = '';
        try {
          const e = await get(`/api/books/${book.id}/engine`);
          if (e.error) throw new Error(e.error);
          const cat = e.memory.byCategory || {};
          diagBody.append(...[
            el('h4', { text: '引擎内部状态' }),
            el('div', { class: 'small mb', text: `叙事记忆 ${e.memory.total} 条（${Object.entries(cat).map(([k, v]) => `${k} ${v}`).join(' · ') || '暂无'}）· 滚动摘要 ${e.rolling.chars} 字 · 物品/势力卡 ${e.items} 条 · 向量索引 ${e.vectors} 条` }),
            e.craftProfile ? el('div', { class: 'small muted mb', text: e.craftProfile }) : null,
            e.rolling.preview ? el('div', { class: 'small muted mb', text: `滚动摘要预览：${e.rolling.preview}…` }) : null,
            e.batchScan
              ? el('div', { class: 'small mb' },
                  el('div', { text: e.batchScan.signals?.length
                    ? `三章一轮自检（至 ch${e.batchScan.chapterIdx}）：⚠ ${e.batchScan.signals.map(s => s.signal).join('；')} → 已生成 ${e.batchScan.constraints} 条反哺约束`
                    : `三章一轮自检（至 ch${e.batchScan.chapterIdx}）：✓ 无系统性纪律失守` }))
              : el('div', { class: 'small muted mb', text: '三章一轮自检：完成章不足一批（<3 章）' }),
            e.memory.latest?.length
              ? el('details', { class: 'small' }, el('summary', {}, '最近记忆条目'), ...e.memory.latest.map(m =>
                  el('div', { class: 'small', style: 'padding:2px 0;border-bottom:1px dashed var(--border)', text: `ch${m.chapter} [${m.category}] ${m.name ? m.name + '：' : ''}${m.content}` })))
              : null,
          ].filter(Boolean));
        } catch (err) { toast(err.message, 'error'); }
        b.disabled = false;
      } }),
    ),
    diagBody,
  );
  foldBody.append(diagCard);
  const deskFold = el('details', { class: 'fold' },
    el('summary', {}, '书务 · 专家：体检检索 · 快照 · 创作设置 · 手改入口（低频）'),
    el('div', { class: 'row mb', style: 'flex-wrap:wrap;gap:8px' },
      el('button', { class: 'sm ghost', text: '＋ 手动加章', onclick: async () => {
        const idx = (book.chapters || []).length + 1;
        const ch = await post(`/api/books/${book.id}/chapters`, { idx, title: `第${idx}章` });
        toast(`已创建第${idx}章`);
        location.hash = `#/book/${book.id}/workshop?chapter=${ch.id}`;
      } }),
      el('span', { class: 'small muted', text: '日常请用「开始自动创作」。手动加章/手改细纲/逐场重写都在这里。' }),
    ),
    foldBody,
  );

  let chapterId = params.get('chapter');
  if (!chapterId && book.chapters?.length) {
    // 默认选中第一个未完成的章（V0.78：revised 也是已完成——与后端 isCompletedChapter 一致，
    // 避免默认选中一个实际已完成的 revised 章，点"一键写本章"却无反应）
    const undone = book.chapters.find(c => c.status !== 'done' && c.status !== 'settled' && c.status !== 'revised');
    chapterId = undone?.id || book.chapters[0].id;
  }

  const ws = el('div', { class: 'workshop' });
  const sidebar = el('div', { class: 'card sidebar', id: 'chapter-sidebar' });
  const main = el('div', { class: 'grow', style: 'min-width:0' });
  const drawerToggle = el('button', {
    class: 'sm ghost sidebar-toggle', type: 'button', text: '目录',
    onclick: () => sidebar.classList.toggle('open'),
  });
  ws.append(sidebar, main);
  view.append(drawerToggle, ws);
  const mainRoot = el('div', { class: 'col' });
  main.append(mainRoot);
  mainRoot.append(renderAutoCreationCard(book, mainRoot));

  if (!chapterId) {
    mainRoot.append(el('div', { class: 'card', id: 'chapter-read' },
      el('h3', { text: '还没有章节' }),
      el('p', { class: 'muted', text: '点击「开始自动创作」，AI 会自动生成书契约、设定、大纲与章节。' }),
    ));
  } else {
    const chapter = await get(`/api/books/${book.id}/chapters/${chapterId}`);
    mainRoot.append(renderChapter(book, chapter));
  }

  try {
    const dash = await renderPublicationDashboard(book);
    mainRoot.append(el('details', { class: 'fold' },
      el('summary', {}, '推流质量驾驶舱'),
      dash,
    ));
  } catch (error) {
    mainRoot.append(el('div', { class: 'card publication-alert error', text: `推流质量驾驶舱加载失败：${error.message}` }));
  }
  try { mainRoot.append(await renderOpeningDecisionCard(book)); } catch { /* 开篇决策台不可用不影响章节写作 */ }

  // ---- 侧栏：章列表（V0.94.1 卷分组 + 状态点 + 过滤 chips）----
  // V0.78 语义保持：revised 也是已完成；quality_blocked/partial/failed = 卡住
  const chapters = book.chapters || [];
  const stateCount = (st) => chapters.filter(c => chapterListState(c) === st).length;
  const FILTERS = [
    ['all', '全部', chapters.length],
    ['doing', '进行中', stateCount('doing')],
    ['planned', '待写', stateCount('planned')],
    ['done', '已完成', stateCount('done')],
    ['blocked', '卡住', stateCount('blocked')],
  ];
  const volNameOf = (volId) => {
    const v = (book.volumes || []).find(x => x.id === volId);
    return v ? `第${v.idx}卷 · ${v.title || ''}` : '未分卷';
  };
  sidebar.append(
    el('div', { class: 'row mb' },
      el('strong', { class: 'grow', text: book.title }),
    ),
    el('div', { class: 'small muted mb', text: `历史 ${fmtTokens(book.history?.tokens || 0)} tokens / 预算 ${fmtTokens(book.budget?.budget || 400000)}` }),
    el('div', { class: 'progress-bar mb' },
      el('div', { style: `width:${Math.min(100, (book.history?.tokens || 0) / (book.budget?.budget || 400000) * 100)}%` }),
    ),
    (() => {
      const list = el('ul', { class: 'chapter-list' });
      const chipRow = el('div', { class: 'chip-row mb' });
      const renderList = () => {
        list.innerHTML = '';
        const visible = chapters.filter(c => getChFilter() === 'all' || chapterListState(c) === getChFilter());
        let lastVol = null;
        for (const c of visible) {
          const volKey = c.volume_id || '';
          if (volKey !== lastVol) {
            lastVol = volKey;
            list.append(el('div', { class: 'vol-head' }, volNameOf(c.volume_id)));
          }
          list.append(el('li', {
            class: c.id === chapterId ? 'active' : '',
            'data-chapter-idx': String(c.idx),
            onclick: () => {
              location.hash = `#/book/${book.id}/workshop?chapter=${c.id}`;
            },
            title: `第${c.idx}章 ${c.title || ''}（${c.status || 'planned'}）`,
          },
            el('span', { class: 'dot dot-' + chapterListState(c) }),
            el('span', { class: 'idx', text: c.idx }),
            el('span', { class: 'grow', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: c.title || `第${c.idx}章` }),
            c.word_count ? el('span', { class: 'small ch-wc', style: 'color:var(--text-3);flex:none', text: `${fmt(c.word_count)}字` }) : null,
          ));
        }
        if (!visible.length) list.append(el('li', { class: 'muted small', text: '该状态下暂无章节' }));
      };
      const refreshChips = () => {
        for (const btn of chipRow.querySelectorAll('[data-ch-filter]')) {
          const key = btn.getAttribute('data-ch-filter');
          const n = key === 'all' ? chapters.length : chapters.filter(c => chapterListState(c) === key).length;
          const span = btn.querySelector('.chip-n');
          if (span) span.textContent = String(n);
          btn.title = `${btn.getAttribute('data-ch-filter-label') || ''} ${n} 章`;
          btn.classList.toggle('active', key === getChFilter());
        }
      };
      for (const [key, label, n] of FILTERS) {
        chipRow.append(el('button', {
          class: 'chip' + (getChFilter() === key ? ' active' : ''),
          'data-ch-filter': key,
          'data-ch-filter-label': label,
          onclick: () => { setChFilter(key); refreshChips(); renderList(); },
          title: `${label} ${n} 章`,
        }, `${label}`, el('span', { class: 'chip-n', text: String(n) })));
      }
      setLivePatch((idx, patch = {}) => {
        const c = chapters.find(ch => Number(ch.idx) === Number(idx));
        if (c) {
          if (patch.status) c.status = patch.status;
          if (patch.wordCount != null) c.word_count = patch.wordCount;
          if (patch.title) c.title = patch.title;
        }
        refreshChips();
        renderList();
      });
      renderList();
      requestAnimationFrame(() => list.querySelector('li.active')?.scrollIntoView({ block: 'nearest' }));
      return el('div', {}, chipRow, list);
    })(),
  );

  view.append(deskFold);

  const activeWrite = book.activeWriteJob;
  if (activeWrite) {
    const btn = document.getElementById('pilot-btn');
    if (btn) {
      if (activeWrite.type === 'polish') runPolishNow(book, mainRoot, btn, { jobId: activeWrite.id });
      else runPilot(book, mainRoot, btn, { jobId: activeWrite.id });
    }
  }
}

// ================= 章节视图 =================
