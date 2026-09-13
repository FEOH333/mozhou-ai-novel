// web/js/views/workshop.js —— 写作台：细纲→正文→审校→结算 全流程
// V0.25：rerender 替代整页刷新；章节查询参数改走路由 query（修复切章白屏）
'use strict';
import { get, post, patch, put, del, sse, openingApi, publicationApi, narrativeApi, writeApi } from '../api.js';
import { el, toast, confirmDialog, openModal, icon, fmt, fmtTokens, fmtMoney, fmtPct, esc, pageHead, progressCard, CHAPTER_STATUS, CHAPTER_STATUS_TAG, chapterStatusLabel } from '../ui.js';
import { state, refreshBook, refreshGlobal, rerender, registerSSE, unregisterSSE } from '../app.js';
import { chapterIdxFromEvent, pilotGridSize, resolvePilotTarget } from '../pilot-observe.js';
import {
  openingDiagnosisSummary,
  openingDiagnosisFailureMessage,
  openingDiagnosisProgressMessage,
  openingComposeProgressMessage,
} from '../opening-status.js';

const STEP_META = [
  ['outline', '细纲'], ['write', '正文'], ['audit', '审校'], ['revise', '修订'], ['settle', '结算'],
];

// V0.94.1：章节列表过滤（模块级——切章/重渲染期间保持用户的过滤选择）
let chFilter = 'all';
/** 自动创作进行中不整页 rerender（会拆掉观察流），侧栏用这个补丁跟作业同步。 */
let livePatchChapterList = () => {};

function chapterListState(c) {
  const s = c.status || 'planned';
  if (s === 'done' || s === 'settled' || s === 'revised') return 'done';
  if (s === 'quality_blocked' || s === 'partial' || s === 'failed') return 'blocked';
  if (s === 'planned') return 'planned';
  return 'doing';
}

// V0.96：本次运行统计条工厂——自动创作与「一键写本章」共用。
// 此前统计条只在 runPilot 内部创建：单章写作走 runFlow 时 usage 事件只 refreshGlobal，
// tokens/费用/缓存命中全程不可见（用户实测"经常看不到都是0"的另一半根因——
// 数据链路修复在 router.js/client.js：非流式端点终帧补推 + tokens 口径修正）。
function runStatsBar() {
  let tokens = 0, cost = 0, hit = 0, miss = 0, calls = 0;
  const t = el('b', { text: '0 tokens' });
  const c = el('b', { text: '¥0' });
  const h = el('b', { text: '—' });
  const n = el('b', { text: '0 次调用' });
  const node = el('div', { class: 'cost-mini' },
    el('span', {}, '本次运行：', t, ' · 费用 ', c, ' · 缓存命中 ', h, ' · ', n));
  const upd = () => {
    t.textContent = fmtTokens(tokens);
    c.textContent = fmtMoney(cost);
    h.textContent = (hit + miss) ? fmtPct(hit / (hit + miss)) : '—';
    n.textContent = `${calls} 次调用`;
  };
  return {
    node,
    /** usage 帧：promptTokens 已含 hit+miss（normalizeUsage 语义），不得四项相加重复计 */
    onUsage(u = {}) {
      tokens += (u.promptTokens || 0) + (u.completionTokens || 0);
      hit += u.promptCacheHitTokens || 0;
      miss += u.promptCacheMissTokens || 0;
      calls++;
      if (u.cost?.total) cost += u.cost.total;
      upd();
    },
    /** 流结束费用帧（router.js onUsageCost） */
    onCost(d = {}) { if (d.cost) { cost += d.cost; upd(); } },
    summary: () => `${calls} 次调用 / ${fmtTokens(tokens)} / ${fmtMoney(cost)}`,
  };
}

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
        const visible = chapters.filter(c => chFilter === 'all' || chapterListState(c) === chFilter);
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
          btn.classList.toggle('active', key === chFilter);
        }
      };
      for (const [key, label, n] of FILTERS) {
        chipRow.append(el('button', {
          class: 'chip' + (chFilter === key ? ' active' : ''),
          'data-ch-filter': key,
          'data-ch-filter-label': label,
          onclick: () => { chFilter = key; refreshChips(); renderList(); },
          title: `${label} ${n} 章`,
        }, `${label}`, el('span', { class: 'chip-n', text: String(n) })));
      }
      livePatchChapterList = (idx, patch = {}) => {
        const c = chapters.find(ch => Number(ch.idx) === Number(idx));
        if (c) {
          if (patch.status) c.status = patch.status;
          if (patch.wordCount != null) c.word_count = patch.wordCount;
          if (patch.title) c.title = patch.title;
        }
        refreshChips();
        renderList();
      };
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

function renderAutoCreationCard(book, root) {
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

const PUBLICATION_STAGE_META = {
  not_applied: ['尚未申请', 'neutral'],
  preparing: ['准备推荐评估', 'neutral'],
  under_review: ['推荐评估中', 'warn'],
  failed: ['推荐评估未通过', 'danger'],
  validation: ['小流量推荐验证', 'warn'],
  recommended: ['已进入推荐', 'ok'],
  terminated: ['推荐流程终止', 'danger'],
};

const RECOVERY_STATUS_TEXT = {
  diagnosing: '正在诊断质量曲线', planned: '诊断完成，等待确认返工', rewriting: '正在生成隔离候选',
  verifying: '正在双向盲审/整段复核', completed: '返工执行结束（查看完成度）',
  failed: '返工未通过，旧稿已保留', cancelled: '已取消',
};

function selectWithOptions(options, value, attrs = {}) {
  const node = el('select', attrs, ...options.map(([key, label]) => el('option', { value: key, text: label })));
  node.value = value;
  return node;
}

function metricValue(value, suffix = '') {
  return value === null || value === undefined || value === '' ? '—' : `${fmt(value)}${suffix}`;
}

function recoveryEventText(event, data = {}) {
  if (event === 'recovery_job_started') return data.replayed
    ? '已重新连接服务端返工任务，正在回放断线期间进度'
    : '服务端后台任务已建立；断开页面只停止观察，不会取消服务端任务';
  if (event === 'recovery_job_cancelling') return '已收到明确停止指令，正在安全中止当前模型调用并保留检查点';
  if (event === 'recovery_job_cancelled') return '服务端返工已按明确指令停止；旧稿与已落检查点保留';
  if (event === 'recovery_job_completed') return data.completion === 'partial'
    ? '服务端任务结束：部分落盘，仍有章节待解决'
    : '服务端任务已正常结束';
  if (event === 'recovery_job_failed') return `服务端任务失败：${data.message || data.error || data.code || '未知错误'}；可从检查点重连或重试`;
  if (event === 'recovery_cancelled') return '返工引擎已安全记录取消状态，旧稿和当前检查点均保留';
  if (event === 'recovery_started') return `返工诊断已启动：第 ${data.startChapter || 1}—${data.endChapter || 20} 章`;
  if (event === 'recovery_diagnosing') return `诊断第 ${data.from}—${data.to} 章（${data.current}/${data.total}）`;
  if (event === 'recovery_resumed') return data.nextStage === 'synthesizing'
    ? `逐章取证已完成，正文与反馈未变化；从全范围综合规划继续（${data.completedBatches}/${data.totalBatches} 批证据已保存）`
    : `正文与反馈未变化，已从第 ${data.nextChapter} 章续跑（前 ${data.completedBatches}/${data.totalBatches} 批证据已保存）`;
  if (event === 'recovery_checkpoint_saved') return data.message
    || `已保存到第 ${data.completedThrough} 章的验证检查点（${data.completedBatches}/${data.totalBatches}）`;
  if (event === 'recovery_synthesizing') return `逐章取证完成，正在综合第 ${data.from || 1}—${data.to || data.endChapter || 20} 章全范围因果蓝图与返工依赖`;
  if (event === 'recovery_plan_compiled_locally') return data.reason || '综合计划已由本地编译器补齐，不再重跑模型蓝图';
  if (event === 'recovery_plan_normalized_locally') return data.message || '已保存计划已本地净化，未调用综合规划模型';
  if (event === 'recovery_retry') {
    const scope = data.chapter
      ? `第 ${data.chapter} 章`
      : (data.from ? `第 ${data.from}—${data.to} 章` : '当前步骤');
    const wait = data.timeoutExtended && data.nextConnectTimeoutMs
      ? `；下一轮首字节等待上限已自动放宽至 ${Math.round(data.nextConnectTimeoutMs / 1000)} 秒`
      : '';
    const waitHint = Number(data.waitMs) >= 10000 ? `，约 ${Math.round(data.waitMs / 1000)} 秒后重试` : '';
    return `${scope}模型连接不稳定，正在自动重试（第 ${data.attempt} 次，${data.reason || 'NETWORK_ERROR'}${waitHint}）${wait}`;
  }
  if (event === 'recovery_validation_retry') {
    if (data.stage === 'comparing') return `第 ${data.chapter} 章${data.round >= 3 ? '决胜轮' : `第 ${data.round}/2 轮`}盲审未通过本地校验，已退回模型重答一次：${data.reason || '结构无效'}`;
    if (data.stage === 'rewriting') return `第 ${data.chapter} 章候选未通过本地校验，已带具体命中退回模型重答（第 ${data.attempt || 1}/2 次）：${data.reason || '结构无效'}`;
    if (data.stage === 'global_review') return `整段复核未通过本地校验，已退回模型重答一次：${data.reason || '结构无效'}`;
    const scope = data.from ? `第 ${data.from}—${data.to} 章` : '当前批次';
    return `${scope}诊断报告未通过本地真实性校验，已把全部问题一次性退回模型纠正（第 ${data.attempt || 1}/2 次）：${data.reason || '结构无效'}`;
  }
  if (event === 'recovery_plan_ready') return `质量曲线完成：${data.workOrders?.length || 0} 章需要返工`;
  if (event === 'recovery_diagnosis_reused') return `诊断结论仍然有效（${data.chapters} 章已全部诊断过且正文未变），直接沿用 ${data.workOrders} 章工单，不重复烧费`;
  if (event === 'recovery_snapshot_created') return `已创建恢复快照：${data.snapshotId}`;
  if (event === 'recovery_snapshot_reused') return `正文基准未变，复用本运行恢复快照：${data.snapshotId}（不会重复堆积快照）`;
  if (event === 'recovery_rewriting') return `生成第 ${data.chapter} 章证据场景窗口候选（${data.current}/${data.total}；本章只生成一次）`;
  if (event === 'recovery_comparing') return `第 ${data.chapter} 章匿名盲审，第 ${data.round}/2 轮`;
  if (event === 'recovery_candidate_reused') return data.priorRunId
    ? `复用第 ${data.chapter} 章整段已通过候选（同一诊断、完整工单及相邻章指纹均一致；${data.current}/${data.total}，不再消耗模型调用）`
    : `复用第 ${data.chapter} 章本运行局部通过候选检查点（${data.current}/${data.total}，不再消耗模型调用；仍需整段复核）`;
  if (event === 'recovery_chapter_frozen') return `第 ${data.chapter} 章连续 ${data.attempts || 2} 轮返工都未证明优于旧稿，已自动冻结止损（零模型调用，旧稿保留）；下次有章节成功落盘会自动解冻再试，或用"全部重新诊断"立即重来`;
  if (event === 'recovery_candidate_accepted') return `第 ${data.chapter} 章候选局部通过双向盲审，等待整段复核；此时尚未落盘`;
  if (event === 'recovery_candidate_rejected') return `第 ${data.chapter} 章候选被拒：${data.reason || data.error || data.code}`;
  if (event === 'recovery_global_review') return `整段复核第 ${data.from || 1}—${data.to || 20} 章持续推进曲线`;
  if (event === 'recovery_completed') {
    const applied = (data.applied || []).join('、') || '无';
    const unresolved = (data.unresolvedChapters || []).join('、');
    return data.completion === 'partial'
      ? `部分落盘：采用第 ${applied} 章；第 ${unresolved || '其余'} 章仍未解决，旧稿保留并进入下一轮重规划`
      : `全部返工完成：采用第 ${applied} 章`;
  }
  if (event === 'recovery_failed') return `返工停止：${data.error}`;
  return data.message || event;
}

/**
 * 返工进度选择弹窗（Promise<运行 id | 'fresh' | false>）：点一键按钮后列出可沿用的
 * 历史进度——工单在手直接执行 / 诊断中道断点续跑——或全部重来。默认选最近一条可沿用进度。
 */
function pickRecoveryProgress(runs) {
  return new Promise(resolve => {
    const options = [
      ...runs.map(run => ({
        key: String(run.id),
        title: run.resumeKind === 'execute'
          ? `第 ${run.start_chapter}—${run.end_chapter} 章 · 直接执行工单`
          : `第 ${run.start_chapter}—${run.end_chapter} 章 · 续跑诊断`,
        desc: `${run.resumeDetail || ''} · ${RECOVERY_STATUS_TEXT[run.status] || run.status} · ${new Date(run.updated_at || run.created_at || Date.now()).toLocaleString()}`,
      })),
      { key: 'fresh', title: '全部重新诊断', desc: '不沿用旧运行，也不复用本运行局部通过候选检查点；从当前全书重新生成质量曲线与因果工单' },
    ];
    let picked = options[0].key;
    const { close } = openModal({
      title: '选择要沿用的返工进度',
      body: el('div', { class: 'recovery-pick-list' }, ...options.map(option => el('label', {
        class: 'recovery-pick',
        style: 'display:flex;gap:8px;align-items:flex-start;padding:8px 4px;border-bottom:1px solid var(--border);cursor:pointer',
      },
        el('input', {
          type: 'radio', name: 'recovery-progress-pick', value: option.key,
          ...(option.key === picked ? { checked: true } : {}),
          onchange: () => { picked = option.key; },
        }),
        el('div', { class: 'grow' },
          el('b', { text: option.title }),
          el('div', { class: 'small muted', text: option.desc }),
        ),
      ))),
      actions: [
        el('button', { text: '取消', onclick: () => { close(false); resolve(false); } }),
        el('button', { class: 'primary', text: '继续', onclick: () => { close(true); resolve(picked); } }),
      ],
      onClose: result => { if (!result) resolve(false); },
    });
  });
}

/** V0.99：平台事实与正文返工之间的可审计驾驶舱。 */
async function renderPublicationDashboard(book) {
  const [dashboard, narrativeState] = await Promise.all([
    publicationApi.status(book.id),
    narrativeApi.status(book.id),
  ]);
  const profile = dashboard.profile || {};
  const [stageLabel, stageTone] = PUBLICATION_STAGE_META[profile.recommendation_stage || 'not_applied'] || ['状态未知', 'neutral'];
  const latestMetric = dashboard.metrics?.[0] || null;
  const latestRun = dashboard.recoveryRuns?.[0] || null;
  const activeRecoveryJob = dashboard.activeRecoveryJob || null;
  const recoveryCompletion = latestRun?.result?.completion || null;
  const unresolvedRecovery = latestRun?.result?.unresolvedChapters || [];
  const candidateStats = latestRun?.candidateStats || {};
  const recoveryRunLabel = recoveryCompletion === 'partial' ? '部分落盘'
    : recoveryCompletion === 'complete' ? '全部完成'
      : recoveryCompletion === 'global_rejected' ? '局部通过但整段否决'
        : RECOVERY_STATUS_TEXT[latestRun?.status] || latestRun?.status;
  const pending = profile.pending_sync_chapters || [];
  const shell = el('section', { class: `publication-cockpit stage-${stageTone}` });

  shell.append(el('div', { class: 'publication-head' },
    el('div', { class: 'publication-kicker', text: '推流观察' }),
    el('div', { class: 'row', style: 'align-items:flex-start;gap:12px' },
      el('div', { class: 'grow' },
        el('h2', { text: '推流质量驾驶舱' }),
        el('div', { class: 'small muted', text: '平台反馈 → 质量曲线 → 隔离返工 → 双向盲审 → 线上同步；所有自动创作与审校读取同一份动态事实。' }),
      ),
      el('span', { class: `publication-stage ${stageTone}`, text: stageLabel }),
    ),
  ));

  if (profile.recommendation_stage === 'failed') {
    shell.append(el('div', { class: 'publication-alert danger' },
      el('div', { class: 'publication-alert-mark', text: 'P0' }),
      el('div', { class: 'grow' },
        el('b', { text: `P0 内容质量事故 · 剩余 ${profile.remaining_attempts ?? '未知'} 次申请机会` }),
        el('div', { class: 'small', text: '这不是“平台还没给量”，而是现有正文没有获得进入推荐验证的资格。楔子不能替后续正文还债，继续堆新章节也不算整改。' }),
      ),
    ));
  }

  shell.append(el('div', { class: 'publication-stats' },
    el('div', { class: 'publication-stat' }, el('span', { text: '公开边界' }), el('b', { text: profile.published_chapter_count == null ? '未同步' : `第 ${profile.published_chapter_count} 章` }), el('small', { text: profile.latest_chapter_title || '填写链接后自动检测' })),
    el('div', { class: 'publication-stat' }, el('span', { text: '公开字数' }), el('b', { text: metricValue(profile.published_word_count) }), el('small', { text: `本地 ${dashboard.localChapterCount || 0} 章 · 未发布 ${dashboard.unpublishedChapterCount ?? '—'} 章` })),
    el('div', { class: 'publication-stat' }, el('span', { text: '页面公开读者' }), el('b', { text: metricValue(profile.public_reader_count) }), el('small', { text: '仅记录页面字段，不冒充后台完整数据' })),
    el('div', { class: 'publication-stat' }, el('span', { text: '最近数据阶段' }), el('b', { text: latestMetric ? ({ not_exposed: '未获曝光', validation: '验证期', limited_test: '小流量', recommended: '推荐中', organic: '自然流量' }[latestMetric.exposure_status] || latestMetric.exposure_status) : '未录入' }), el('small', { text: latestMetric?.observed_at ? new Date(latestMetric.observed_at).toLocaleString() : '等待真实观察窗口' })),
  ));

  const narrativeProgress = el('div', { class: 'recovery-progress' });
  const narrativeNeedsRebuild = narrativeState.requiresRebuild === true;
  const narrativeLabel = ({
    ready: '正文与派生状态同版', stale: '正文已改，派生状态待重建',
    mismatch: '检测到绕过门禁的正文变化',
    legacy: narrativeNeedsRebuild ? '旧作品需建立同版账本' : '空白新书尚无叙事版本',
  })[narrativeState.status] || '状态未知';
  shell.append(el('div', { class: 'publication-section narrative-state-section' },
    el('div', { class: 'section-label', text: '00 · 叙事版本安全门' }),
    el('div', { class: `publication-alert ${narrativeNeedsRebuild ? 'danger' : narrativeState.status === 'ready' ? 'info' : 'warn'}` },
      el('div', { class: 'publication-alert-mark', text: narrativeNeedsRebuild ? '停' : '版' }),
      el('div', { class: 'grow' },
        el('b', { text: narrativeLabel }),
        el('div', { class: 'small', text: narrativeNeedsRebuild
          ? '自动创作已暂停，避免旧摘要、旧人物状态、旧伏笔或旧大纲继续污染正文。重建会先在影子环境逐章取证，全部通过后才原子切换。'
          : narrativeState.current
            ? `有效版本 ${narrativeState.current.id}，已对齐至第 ${narrativeState.current.throughChapter} 章。`
            : '空白新书将在首章结算时自动建立同版账本。' }),
        el('div', { class: 'small muted', text: `已验证创作经验 ${narrativeState.lessons?.active || 0} 条，累计用于后续章节 ${narrativeState.lessons?.uses || 0} 次；未通过整体复核的临时结论不会进入创作提示。` }),
      ),
    ),
    narrativeNeedsRebuild ? el('div', { class: 'row mt', style: 'flex-wrap:wrap' },
      el('button', { class: 'danger', text: '重建摘要、角色、伏笔与各层大纲', onclick: async ev => {
        const button = ev.currentTarget;
        if (!await confirmDialog('开始同版重建？', '模型会逐章从当前正文重新取证，并校准书纲、卷纲和未来章。构建失败不会再次覆盖正文；完成前自动创作保持暂停。')) return;
        button.disabled = true; narrativeProgress.innerHTML = '';
        const ctrl = registerSSE();
        try {
          await narrativeApi.rebuild(book.id, (event, data) => {
            const textByEvent = {
              narrative_projection_started: `开始逐章取证，共 ${data.total || 0} 章`,
              narrative_projection_progress: data.resumed
                ? `复用第 ${data.chapter} 章已验证投影（${data.current}/${data.total}，断点续跑不消耗模型调用）`
                : `取证第 ${data.chapter} 章（${data.current}/${data.total}）`,
              narrative_projection_retry: `第 ${data.chapter} 章投影未通过本地校验，已退回模型重答一次`,
              narrative_plan_started: '校准书级、卷级与未来章规划',
              narrative_plan_retry: `规划校准未通过本地校验，已退回模型重答一次（${String(data.reason || '').slice(0, 80)}）`,
              narrative_plan_validated: '规划证据校验通过，准备原子切换',
              narrative_commit_started: '正在原子切换正文派生状态',
              narrative_revision_committed: '同版重建完成',
              narrative_revision_failed: `重建停止：${data.error || data.code}`,
            };
            narrativeProgress.append(el('div', { class: `recovery-line event-${event}`, text: textByEvent[event] || data.message || event }));
            narrativeProgress.scrollTop = narrativeProgress.scrollHeight;
          }, ctrl.signal);
          toast('叙事状态与各层规划已同版重建，自动创作可以继续', 'success'); rerender();
        } catch (error) { if (error.name !== 'AbortError') toast(error.message, 'error'); button.disabled = false; }
        finally { unregisterSSE(ctrl); }
      } }),
      el('span', { class: 'small muted', text: narrativeState.blocking?.reason
        || (narrativeState.status === 'legacy'
          ? `已有 ${narrativeState.completedChapters || 0} 个完成章，但尚未从当前正文重建同版投影`
          : '当前正文与派生状态版本不一致') }),
    ) : null,
    narrativeProgress,
  ));

  const workUrl = el('input', {
    type: 'url', value: profile.work_url || '', placeholder: 'https://fanqienovel.com/page/作品ID',
    class: 'grow', title: '只接受番茄公开作品页；系统从页面自动识别已发布章节，不需要手填章数',
  });
  const syncNote = el('div', { class: `small ${profile.sync_status === 'error' ? 'error-text' : 'muted'}`, text:
    profile.sync_status === 'error' ? `上次同步失败：${profile.sync_error}`
      : profile.last_synced_at ? `上次同步：${new Date(profile.last_synced_at).toLocaleString()}；自动创作在快照过期后也会刷新` : '尚未同步；保存链接后点击“检测已发布章节”' });
  const syncButton = el('button', { class: 'primary', text: '检测已发布章节', onclick: async ev => {
    const button = ev.currentTarget;
    button.disabled = true; button.textContent = '正在读取番茄…';
    try {
      await publicationApi.saveProfile(book.id, { workUrl: workUrl.value.trim() });
      const result = await publicationApi.sync(book.id);
      toast(`已检测到发布 ${result.profile.published_chapter_count} 章，本地 ${result.localChapterCount} 章`, 'success');
    } catch (error) { toast(error.message, 'error'); }
    rerender();
  } });
  shell.append(el('div', { class: 'publication-section' },
    el('div', { class: 'section-label', text: '01 · 发布边界（自动检测）' }),
    el('div', { class: 'row publication-link-row' }, workUrl, syncButton),
    syncNote,
  ));

  const stageSelect = selectWithOptions(Object.entries(PUBLICATION_STAGE_META).map(([key, value]) => [key, value[0]]), profile.recommendation_stage || 'not_applied');
  const attemptsInput = el('input', { type: 'number', min: '0', max: '3', value: profile.remaining_attempts ?? '', placeholder: '0—3' });
  const turnInput = el('input', { type: 'number', min: '1', max: '200', value: profile.suspected_turn_chapter || 7 });
  const editorFeedback = el('textarea', { text: profile.editor_feedback || '', placeholder: '粘贴平台/编辑原话；不要自行补写编辑没说过的理由' });
  const authorDiagnosis = el('textarea', { text: profile.author_diagnosis || '', placeholder: '作者自己的判断（会明确标成“不是平台原话”）' });
  const saveReviewProfile = async ({ appendReview = false } = {}) => {
    const body = {
      workUrl: workUrl.value.trim(), recommendationStage: stageSelect.value,
      remainingAttempts: attemptsInput.value === '' ? null : Number(attemptsInput.value),
      editorFeedback: editorFeedback.value.trim(), authorDiagnosis: authorDiagnosis.value.trim(),
      suspectedTurnChapter: Number(turnInput.value) || 7,
    };
    await publicationApi.saveProfile(book.id, body);
    if (appendReview) await publicationApi.addReview(book.id, {
      stage: body.recommendationStage, remainingAttempts: body.remainingAttempts,
      feedback: body.editorFeedback, source: 'manual',
    });
  };
  shell.append(el('details', { class: 'publication-section publication-form', open: !dashboard.profile },
    el('summary', {}, '02 · 记录推荐评估与编辑反馈'),
    el('div', { class: 'form-grid mt' },
      el('label', {}, el('span', { text: '当前阶段' }), stageSelect),
      el('label', {}, el('span', { text: '剩余申请次数' }), attemptsInput),
      el('label', {}, el('span', { text: '疑似质量拐点章' }), turnInput),
    ),
    el('label', { class: 'mt block' }, el('span', { text: '平台/编辑原话' }), editorFeedback),
    el('label', { class: 'mt block' }, el('span', { text: '作者诊断（不是平台原话）' }), authorDiagnosis),
    el('div', { class: 'row mt', style: 'flex-wrap:wrap' },
      el('button', { class: 'ghost', text: '保存当前状态', onclick: async ev => {
        const button = ev.currentTarget; button.disabled = true;
        try { await saveReviewProfile(); toast('推流状态已保存并会注入后续自动创作', 'success'); rerender(); }
        catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
      el('button', { class: 'primary', text: '追加一条审核历史', onclick: async ev => {
        const button = ev.currentTarget; button.disabled = true;
        try { await saveReviewProfile({ appendReview: true }); toast('本次审核已追加保存，不会覆盖旧记录', 'success'); rerender(); }
        catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
      el('span', { class: 'small muted', text: `历史记录 ${dashboard.reviews?.length || 0} 次` }),
    ),
  ));

  const exposure = selectWithOptions([
    ['not_exposed', '未获曝光（推流前）'], ['validation', '推荐验证期'],
    ['limited_test', '小流量测试'], ['recommended', '正式推荐中'], ['organic', '自然流量'],
  ], latestMetric?.exposure_status || 'not_exposed');
  const metricInputs = {
    impressions: el('input', { type: 'number', min: '0', placeholder: '曝光数' }),
    readers: el('input', { type: 'number', min: '0', placeholder: '读者数' }),
    bookshelfAdds: el('input', { type: 'number', min: '0', placeholder: '加书架数' }),
    readThroughRate: el('input', { type: 'number', min: '0', max: '100', step: '0.01', placeholder: '读完率 %' }),
    followRate: el('input', { type: 'number', min: '0', max: '100', step: '0.01', placeholder: '追读率 %' }),
    note: el('input', { placeholder: '观察窗口/备注', class: 'grow' }),
  };
  const optionalNumber = input => input.value === '' ? null : Number(input.value);
  shell.append(el('details', { class: 'publication-section publication-form' },
    el('summary', {}, '03 · 记录作品数据（按观察窗口追加）'),
    el('div', { class: 'publication-alert info mt', text: '未获曝光时，0 读者是正常的中性数据；只有作品获得真实曝光后，读完、追读和转化才可用来诊断方向。系统不会把推流前的 0 当成“写得差”的证据。' }),
    el('div', { class: 'metric-grid mt' }, exposure, metricInputs.impressions, metricInputs.readers, metricInputs.bookshelfAdds, metricInputs.readThroughRate, metricInputs.followRate),
    el('div', { class: 'row mt' }, metricInputs.note,
      el('button', { class: 'primary', text: '保存数据快照', onclick: async ev => {
        const button = ev.currentTarget; button.disabled = true;
        try {
          await publicationApi.addMetric(book.id, {
            exposureStatus: exposure.value,
            impressions: optionalNumber(metricInputs.impressions), readers: optionalNumber(metricInputs.readers),
            bookshelfAdds: optionalNumber(metricInputs.bookshelfAdds),
            readThroughRate: optionalNumber(metricInputs.readThroughRate), followRate: optionalNumber(metricInputs.followRate),
            note: metricInputs.note.value.trim(), observedAt: Date.now(),
          });
          toast('作品数据已按当前观察窗口追加', 'success'); rerender();
        } catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
    ),
    dashboard.metrics?.length ? el('div', { class: 'metric-history mt' }, ...dashboard.metrics.slice(0, 4).map(item =>
      el('div', { class: 'small', text: `${new Date(item.observed_at).toLocaleDateString()} · ${item.exposure_status} · 曝光 ${item.impressions ?? '—'} · 读者 ${item.readers ?? '—'} · 读完 ${item.read_through_rate ?? '—'}% · 追读 ${item.follow_rate ?? '—'}%${item.note ? ` · ${item.note}` : ''}` }))) : null,
  ));

  const recoveryProgress = el('div', { class: 'recovery-progress' });
  const appendRecoveryProgress = (event, data) => {
    recoveryProgress.append(el('div', { class: `recovery-line event-${event}`, text: recoveryEventText(event, data) }));
    recoveryProgress.scrollTop = recoveryProgress.scrollHeight;
  };
  const curve = latestRun?.quality_curve || [];
  const curveNode = el('div', { class: 'quality-curve' }, ...curve.map(item => el('div', {
    class: `quality-cell action-${item.action || 'keep'} prior-${item.prior || 'unknown'}`,
    title: item.reason || '',
  },
  el('b', { text: `ch${item.chapter}` }),
  el('span', { text: `${item.score ?? '—'}分` }),
  el('small', { text: ({ keep: '保留', tune: '微调', rebuild: '重构' }[item.action] || item.action || '待诊断') }),
  )));

  const recoveryInFlight = !!activeRecoveryJob || ['diagnosing', 'rewriting', 'verifying'].includes(latestRun?.status);
  // 可沿用的既往进度（后端已标注可续性）：直接执行工单 / 诊断断点续跑。
  const recoveryOptions = (dashboard.recoveryRuns || [])
    .filter(run => run.resumeKind === 'execute' || run.resumeKind === 'diagnose');
  // 一键流程：有旧进度先弹窗选择沿用哪条（或全部重来）→ 诊断（可跳）→ 确认工单 → 执行。
  const showRecoveryOutcome = done => {
    if (done?.cancelled || done?.job?.status === 'cancelled') {
      toast('服务端返工已明确停止；旧稿与检查点已保留', 'warn');
      return;
    }
    const applied = done?.result?.applied?.length || 0;
    const unresolved = done?.result?.unresolvedChapters || [];
    if (done?.result?.completion === 'partial') {
      toast(`部分落盘：采用 ${applied} 章；第 ${unresolved.join('、') || '其余'} 章仍未解决，旧稿保留，请先重规划再继续`, 'warn');
    } else {
      toast(applied ? `返工全部通过并采用 ${applied} 章；请按线上同步清单更新番茄` : '没有候选形成明确提升，旧稿已保留', applied ? 'success' : 'warn');
    }
  };
  const oneClickButton = el('button', {
    class: 'primary', disabled: dashboard.localChapterCount < 1 || (recoveryInFlight && !activeRecoveryJob),
    text: activeRecoveryJob
      ? '重新连接返工进度'
      : recoveryInFlight
        ? `返工${{ diagnosing: '诊断', rewriting: '执行', verifying: '复核' }[latestRun.status] || '任务'}进行中…`
        : '一键诊断并返工',
    onclick: async ev => {
      const button = ev.currentTarget;
      button.disabled = true; recoveryProgress.innerHTML = '';
      const ctrl = registerSSE();
      try {
        if (activeRecoveryJob) {
          appendRecoveryProgress('recovery_job_started', { replayed: true, jobId: activeRecoveryJob.id });
          const done = await publicationApi.observeRecoveryJob(book.id, activeRecoveryJob.id, appendRecoveryProgress, ctrl.signal);
          showRecoveryOutcome(done);
          rerender();
          return;
        }
        let choice = 'fresh';
        if (recoveryOptions.length) {
          choice = await pickRecoveryProgress(recoveryOptions);
          if (!choice) { button.disabled = false; return; }
        }
        const end = Math.max(1, dashboard.localChapterCount || 20);
        let run = null;
        if (choice === 'fresh') {
          const diagnosis = await publicationApi.diagnoseRecovery(book.id, {
            startChapter: 1, endChapter: end, forceFresh: recoveryOptions.length > 0,
          }, appendRecoveryProgress, ctrl.signal);
          run = diagnosis?.run;
        } else {
          const picked = recoveryOptions.find(item => String(item.id) === String(choice));
          if (!picked) throw new Error('所选进度已失效，请刷新后重试');
          if (picked.resumeKind === 'execute') {
            run = picked; // 工单在手，跳过诊断
          } else {
            const diagnosis = await publicationApi.diagnoseRecovery(book.id, {
              startChapter: Number(picked.start_chapter), endChapter: Number(picked.end_chapter),
              resumeRunId: picked.id,
            }, appendRecoveryProgress, ctrl.signal);
            run = diagnosis?.run;
          }
        }
        const orders = run?.work_orders || [];
        if (!orders.length) {
          toast('诊断完成：范围内章节全部达标，无需返工', 'success'); rerender(); return;
        }
        const publishedInScope = Math.min(profile.published_chapter_count || 0, run.end_chapter) >= run.start_chapter;
        const accepted = await confirmDialog(
          publishedInScope ? '明确确认返工已发布正文？' : '确认执行返工？',
          `共 ${orders.length} 章工单（微调 ${orders.filter(order => order.action === 'tune').length} / 重构 ${orders.filter(order => order.action === 'rebuild').length}）。${publishedInScope ? `第 ${run.start_chapter}—${Math.min(run.end_chapter, profile.published_chapter_count)} 章已发布。` : ''}系统会先创建完整快照，再生成隔离候选；每章只有双向盲审都胜出且第 ${run.start_chapter}—${run.end_chapter} 章整段推进复核通过后才落盘。通过的已发布章节会加入“待线上同步”清单，工具不会登录或替你修改番茄后台。`,
        );
        if (!accepted) { rerender(); return; }
        button.disabled = true; // confirmDialog 期间状态可能已刷新
        const done = await publicationApi.executeRecovery(book.id, run.id, {
          confirmedPublishedRewrite: true,
          reusePriorCandidates: choice !== 'fresh',
        }, appendRecoveryProgress, ctrl.signal);
        showRecoveryOutcome(done);
        rerender();
      } catch (error) {
        if (error.name !== 'AbortError') toast(error.message, 'error');
        button.disabled = false;
      } finally { unregisterSSE(ctrl); }
    },
  });
  const recoveryActions = [oneClickButton];
  if (activeRecoveryJob) recoveryActions.push(el('button', {
    class: 'danger',
    text: '明确停止服务端返工',
    onclick: async ev => {
      if (!await confirmDialog(
        '明确停止服务端返工？',
        '关闭页面、刷新或网络闪断都不会停止任务；只有这个操作会中止服务端模型调用。已完成检查点和旧稿会保留，可稍后重新发起。',
      )) return;
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        await publicationApi.cancelRecoveryJob(book.id, activeRecoveryJob.id);
        toast('已发送停止指令，服务端正在安全收尾', 'warn');
        rerender();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    },
  }));

  const recoveryScopeEnd = Math.max(1, dashboard.localChapterCount || 20);
  const suspectedTurn = Math.min(recoveryScopeEnd, Math.max(1, Number(profile.suspected_turn_chapter) || 7));
  const recoveryPriorNodes = [];
  if (suspectedTurn > 1) recoveryPriorNodes.push(el('div', {},
    el('b', { text: `第 1—${suspectedTurn - 1} 章 · 疑似基线` }),
    el('span', { text: '签约曾通过只算弱先验，仍需证据验证；不一刀切重写。' }),
  ));
  recoveryPriorNodes.push(el('div', {},
    el('b', { text: `第 ${suspectedTurn}—${recoveryScopeEnd} 章 · 高风险严审` }),
    el('span', { text: '重点查有效事件、不可逆变化、人物代价、承诺兑现、重复注水和章末追读力。' }),
  ));
  shell.append(el('div', { class: 'publication-section recovery-section' },
    el('div', { class: 'section-label', text: `04 · 质量曲线返工（第 1—${recoveryScopeEnd} 章）` }),
    el('div', { class: 'recovery-prior' }, ...recoveryPriorNodes),
    latestRun ? el('div', { class: 'row mt', style: 'flex-wrap:wrap' },
      el('span', { class: `badge ${recoveryCompletion === 'complete' ? 'badge-ok' : latestRun.status === 'failed' || recoveryCompletion === 'global_rejected' ? 'badge-del' : 'badge-warn'}`, text: recoveryRunLabel }),
      el('span', { class: 'small muted', text: `运行 ${latestRun.id} · 第${latestRun.start_chapter}—${latestRun.end_chapter}章 · 工单 ${latestRun.work_orders?.length || 0}` }),
    ) : el('div', { class: 'small muted mt', text: '尚未诊断。诊断阶段只读正文，不创建候选、不修改已发布稿。' }),
    activeRecoveryJob ? el('div', { class: 'publication-alert info mt', text: `服务端任务 ${activeRecoveryJob.id} 正在运行。断网、刷新或离开页面只会断开观察；点击“重新连接返工进度”可回放事件，只有“明确停止服务端返工”才会取消。` }) : null,
    latestRun && candidateStats.total ? el('div', { class: 'row mt small muted', style: 'flex-wrap:wrap' },
      el('span', { text: `本运行局部通过检查点 ${candidateStats.localPassed || 0}` }),
      el('span', { text: `整段验证通过 ${candidateStats.globalPassed || 0}` }),
      el('span', { text: `整段否决 ${candidateStats.globalRejected || 0}` }),
      ...(candidateStats.legacyUntrusted
        ? [el('span', { class: 'error-text', text: `旧版无来源候选 ${candidateStats.legacyUntrusted}（已隔离，需重生）` })]
        : []),
      el('span', { text: `已落盘 ${candidateStats.applied || 0}` }),
    ) : null,
    unresolvedRecovery.length ? el('div', { class: 'publication-alert warn mt', text: `本轮仍未解决：${unresolvedRecovery.map(index => `第${index}章`).join('、')}。这些章节保留旧稿，不会被“部分落盘”伪装成全部完成。` }) : null,
    curve.length ? curveNode : null,
    latestRun?.error ? el('div', { class: 'publication-alert danger mt', text: latestRun.error }) : null,
    el('div', { class: 'row mt', style: 'flex-wrap:wrap' }, ...recoveryActions),
    recoveryProgress,
  ));

  if (pending.length) {
    shell.append(el('div', { class: 'publication-section sync-chapter-list' },
      el('div', { class: 'section-label', text: '05 · 待线上同步' }),
      el('div', { class: 'publication-alert warn', text: `本地已改、番茄后台可能仍是旧稿：${pending.map(index => `第${index}章`).join('、')}` }),
      el('button', { class: 'ghost mt', text: '我已在番茄后台同步这些章节', onclick: async ev => {
        const button = ev.currentTarget;
        if (!await confirmDialog('确认线上已经更新？', '这只会清除本地提醒，不会检查或修改番茄后台。请确认列出的章节已经逐章同步。')) return;
        button.disabled = true;
        try { await publicationApi.confirmPendingSync(book.id, pending); toast('线上同步提醒已清除', 'success'); rerender(); }
        catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
    ));
  }

  return shell;
}

const OPENING_KIND_NAME = {
  head_rewrite: '顺叙强化',
  chapter1_cold_open: '第一章内嵌楔子',
  standalone_prologue: '独立楔子',
};

/** V0.98：创作决策台先讲作品与候选的创作理由，哈希/模型/快照折叠到技术详情。 */
async function renderOpeningDecisionCard(book) {
  const [promise, diagnosis, assetPack, publish] = await Promise.all([
    openingApi.storyPromise(book.id).catch(() => ({ exists: false, stale: true, locks: {} })),
    openingApi.diagnosis(book.id).catch(() => ({ exists: false, stale: true })),
    openingApi.assets(book.id).catch(() => ({ assets: [], active: null })),
    openingApi.publishPatch(book.id).catch(() => ({ changed: false })),
  ]);
  const assets = assetPack.assets || [];
  const profile = promise.profile || null;
  const profileStatus = el('div', { class: 'small muted mt', role: 'status', 'aria-live': 'polite' });
  const status = el('div', {
    id: 'opening-action-status', class: 'small muted mt', role: 'status', 'aria-live': 'polite',
    text: '生成会依次构思、写作、审校和匿名比较，通常需数分钟；可切页去读，进度会保留。',
  });
  const body = el('div', { class: 'fold-body' });
  const hasText = (book.chapters || []).some(chapter => Number(chapter.word_count) > 0);
  const refresh = async message => {
    if (message) toast(message, 'success');
    if (state.book?.id === book.id) { await refreshBook(); rerender(); }
  };
  const run = async (button, fn, { onError } = {}) => {
    button.disabled = true;
    try { return await fn(); }
    catch (error) {
      onError?.(error);
      toast(error.message, 'error');
      return null;
    }
    finally { button.disabled = false; }
  };

  body.append(
    el('div', { class: 'card', style: 'margin-top:0' },
      el('div', { class: 'small muted', text: '本书靠什么吸引人' }),
      el('div', { style: 'font-size:15px;font-weight:700;margin:4px 0', text: profile?.primary_attraction_axis || '尚未建立本书创作宪章' }),
      profile ? el('div', { class: 'small', text: `一句承诺：${profile.premise_in_one_breath || '—'}` }) : null,
      profile ? el('div', { class: 'small', text: `禁止优化成：${(profile.anti_promises || []).join('；') || '未设置'}` }) : null,
      el('div', { class: 'small muted mt', text: `作者锁：${Object.keys(promise.locks || {}).join('、') || '尚无'}。锁定后重建画像也会保留。` }),
      el('div', { class: 'row mt', style: 'gap:8px;flex-wrap:wrap' },
        el('button', { class: 'sm primary', text: profile ? '重建创作宪章' : '建立创作宪章', onclick: ev => run(ev.currentTarget, async () => {
          profileStatus.textContent = '正在理解本书的独特承诺…';
          await openingApi.rebuildStoryPromise(book.id);
          await refresh('创作宪章已建立');
        }) }),
        profile ? el('button', { class: 'sm ghost', text: '锁定当前题材路线', onclick: ev => run(ev.currentTarget, async () => {
          await openingApi.lockStoryPromise(book.id, { 'texture.route': profile.texture?.route || 'general' });
          await refresh('当前题材路线已锁定');
        }) }) : null,
      ),
      profileStatus,
    ),
  );

  const diagnosisText = openingDiagnosisSummary(diagnosis);
  body.append(el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('b', { text: '正文证据诊断' }),
        el('div', { class: 'small muted', text: diagnosisText }),
      ),
      el('button', { class: 'sm ghost', text: '精读诊断', onclick: ev => run(ev.currentTarget, async () => {
        const startedAt = Date.now();
        const updateProgress = () => {
          status.textContent = openingDiagnosisProgressMessage(Date.now() - startedAt);
        };
        updateProgress();
        const progressTimer = setInterval(updateProgress, 1_000);
        try {
          await openingApi.runDiagnosis(book.id);
          await refresh('开篇诊断完成');
        } finally {
          clearInterval(progressTimer);
        }
      }, { onError: error => { status.textContent = openingDiagnosisFailureMessage(error); } }) }),
      el('button', { class: 'sm primary', text: hasText ? '生成并比较开篇方案' : '预演第一章方案', onclick: ev => {
        const button = ev.currentTarget;
        return run(button, async () => {
          const originalText = button.textContent;
          button.textContent = '方案生成中…';
          const startedAt = Date.now();
          let latestDetail = '正在构思不同的开篇进入逻辑';
          const updateProgress = () => {
            status.textContent = openingComposeProgressMessage({
              detail: latestDetail, elapsedMs: Date.now() - startedAt,
            });
          };
          updateProgress();
          const progressTimer = setInterval(updateProgress, 1_000);
          const ctrl = registerSSE();
          try {
            const result = await openingApi.compose(book.id, {
              mode: hasText ? 'repair' : 'create', autoPrepare: true, autoCompare: true,
            }, (_event, data) => {
              if (data.detail) latestDetail = data.detail;
              updateProgress();
            }, ctrl.signal);
            const compared = result.comparison?.status;
            const suffix = compared === 'stable_winner' ? '；两轮匿名比较得到稳定胜者'
              : compared === 'single_model_advisory' ? '；同模型判断仅供参考'
                : compared ? '；没有稳定胜者，建议保留原稿' : '；候选已生成';
            toast(`已生成 ${result.candidates || 0} 个方案${suffix}`, 'success');
            await refresh();
          } finally {
            clearInterval(progressTimer);
            unregisterSSE(ctrl);
            button.textContent = originalText;
          }
        }, { onError: error => {
          status.textContent = error?.name === 'AbortError'
            ? '方案生成已停止；未完成的候选不会写入正文。'
            : `方案生成失败：${error?.message || error}`;
        } });
      } }),
    ),
    el('div', { class: 'small muted mt', text: '原稿会匿名参与比较；没有稳定胜者时，工具明确建议“不改”。模型冷读是模拟判断，不冒充真实留存或平台结果。' }),
    status,
  ));

  const comparable = assets.filter(asset => asset.status === 'audited' && asset.freshness?.fresh);
  const candidatesCard = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', style: 'margin:0', text: '可读候选' }),
      comparable.length ? el('button', { class: 'sm ghost', text: '两轮匿名比较', onclick: ev => run(ev.currentTarget, async () => {
        const result = await openingApi.compareOpeningAssets(book.id, comparable.map(asset => asset.id));
        // V0.98.11：优先用服务端可读结论——同模型两轮同胜者提示「可手动采用」，不再误读为失败
        const message = result.message || (result.status === 'stable_winner' ? `稳定胜者：${OPENING_KIND_NAME[result.winner?.kind] || '原稿'}`
          : result.status === 'single_model_advisory' ? '同模型判断仅供参考，不会自动应用'
            : '两轮结论不一致，建议保留原稿');
        toast(message, result.status === 'stable_winner' ? 'success' : 'info', 8000);
        await refresh();
      }) }) : null,
    ),
  );
  if (!assets.length) candidatesCard.append(el('div', { class: 'small muted mt', text: '还没有存量开篇候选。先运行诊断，再生成方案。' }));
  for (const asset of assets) {
    const name = OPENING_KIND_NAME[asset.kind] || asset.kind;
    const audit = asset.audit || {};
    const comparison = asset.rank?.comparison || {};
    const auditBlockers = [
      ...(Array.isArray(audit.hard_failures) ? audit.hard_failures : []),
      ...(Array.isArray(audit.issues) ? audit.issues.filter(issue => issue?.severity === 'high') : []),
    ];
    const freshness = asset.freshness?.fresh ? '当前有效' : `已过期：${asset.freshness?.reason || '输入变化'}`;
    const actions = [];
    if (asset.status === 'audited' && !auditBlockers.length) actions.push(el('button', { class: 'sm primary', text: '采用此方案', onclick: async ev => {
      // V0.98.12：async 处理器必须同步捕获按钮（await confirmDialog 后 currentTarget 已被清空为 null）
      const btn = ev.currentTarget;
      if (!await confirmDialog(`采用“${name}”？`, '工具会先保存快照。顺叙强化只改精确锚点；内嵌楔子只改变读者发布视图，不进入后续人物记忆。')) return;
      await run(btn, async () => {
        await openingApi.selectOpeningAsset(book.id, asset.id);
        await openingApi.applyOpeningAsset(book.id, asset.id);
        await refresh(`${name}已应用；可在下方查看完整发布差异`);
      });
    } }));
    if (asset.status === 'selected') actions.push(el('button', { class: 'sm primary', text: '应用到发布稿', onclick: ev => run(ev.currentTarget, async () => {
      await openingApi.applyOpeningAsset(book.id, asset.id);
      await refresh(`${name}已应用`);
    }) }));
    if (asset.status === 'applied' && asset.placement !== 'scene_patch') actions.push(el('button', { class: 'sm ghost danger', text: '撤下前置层', onclick: ev => run(ev.currentTarget, async () => {
      await openingApi.retireOpeningAsset(book.id, asset.id);
      await refresh('读者前置层已撤下；叙事正文未改动');
    }) }));
    if (asset.status !== 'applied') actions.push(el('button', { class: 'sm ghost', text: '审校此方案', onclick: ev => run(ev.currentTarget, async () => {
      await openingApi.auditOpeningAsset(book.id, asset.id);
      await refresh('已完成开篇方案审校');
    }) }));
    if (asset.status !== 'applied') actions.push(el('button', { class: 'sm ghost danger', text: '删除此方案', onclick: async ev => {
      const btn = ev.currentTarget;
      if (!await confirmDialog(`删除“${name}”？`, '该候选将从列表中永久移除，无法恢复；已应用方案需先撤下前置层。')) return;
      await run(btn, async () => {
        await openingApi.removeOpeningAsset(book.id, asset.id);
        await refresh('该候选已删除');
      });
    } }));
    candidatesCard.append(el('div', { style: 'padding:10px 0;border-top:1px solid var(--border)' },
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
        el('b', { class: 'grow', text: name }),
        el('span', { class: `badge ${asset.freshness?.fresh ? 'badge-ok' : 'badge-warn'}`, text: freshness }),
        el('span', { class: 'small muted', text: asset.status }),
        ...actions,
      ),
      el('div', { class: 'small mt', text: `创作假设：${asset.creative_hypothesis || '—'}` }),
      audit.continue_question ? el('div', { class: 'small', text: `冷读者具体想追：${audit.continue_question}` }) : null,
      audit.strongest_axis?.reason ? el('div', { class: 'small', text: `最强吸引轴：${audit.strongest_axis.reason}` }) : null,
      audit.attention_drop?.length ? el('div', { class: 'small warn-text', text: `注意力断点：${audit.attention_drop.join('；')}` }) : null,
      auditBlockers.length ? el('div', { class: 'small warn-text', text: `禁止采用：仍有 ${auditBlockers.length} 项硬伤/high 问题，请重新生成` }) : null,
      comparison.status ? el('div', { class: 'small muted', text: `匿名比较：${comparison.status}${comparison.winner ? '（本候选胜出）' : ''}` }) : null,
      el('details', { class: 'small mt' },
        el('summary', {}, '查看完整候选正文'),
        el('div', { style: 'white-space:pre-wrap;max-height:360px;overflow:auto;padding:8px;background:var(--bg-soft)', text: asset.content || '' }),
      ),
      el('details', { class: 'small mt' },
        el('summary', {}, '技术详情'),
        el('div', { text: `位置：${asset.placement} · 源哈希：${asset.source_hash || '—'} · 生成模型：${asset.rank?.generator_model || '—'} · 资产ID：${asset.id}` }),
      ),
    ));
  }
  body.append(candidatesCard);

  if (publish.changed && publish.patch) {
    body.append(el('div', { class: 'card' },
      el('b', { text: '发布同步差异' }),
      el('div', { class: 'small muted', text: '这是本地完整发布稿差异；不会直接覆盖下载目录或番茄后台。应用前快照可在书务台查看。' }),
      el('div', { class: 'small mt', text: `before ${publish.patch.before_hash} → after ${publish.patch.after_hash}；变化 ${publish.patch.changed_chars} 字符` }),
      el('details', { class: 'small mt' }, el('summary', {}, '查看可直接替换的完整第一章'),
        el('div', { style: 'white-space:pre-wrap;max-height:420px;overflow:auto', text: publish.patch.after_text || '' })),
    ));
  }

  const metricName = el('input', { placeholder: '后台指标名（可选）', style: 'min-width:160px' });
  const metricValue = el('input', { placeholder: '当时可见值（可选）', style: 'min-width:150px' });
  const comment = el('input', { placeholder: '去身份化代表评论（可选）', style: 'min-width:220px;flex:1' });
  body.append(el('div', { class: 'card' },
    el('b', { text: '记录真实反馈' }),
    el('div', { class: 'small muted', text: '记录后台当时可见的数据与评论，只校准这一本书的创作假设；不会把一次数据写成全平台定律。' }),
    el('div', { class: 'row mt', style: 'gap:8px;flex-wrap:wrap' }, metricName, metricValue, comment,
      el('button', { class: 'sm ghost', text: '保存反馈', onclick: ev => run(ev.currentTarget, async () => {
        await openingApi.recordFeedback(book.id, {
          metrics: metricName.value.trim() ? [{ name: metricName.value.trim(), value: metricValue.value.trim() }] : [],
          comments: comment.value.trim() ? [comment.value.trim()] : [],
          observation_window: '作者录入时未指定窗口',
        });
        metricName.value = ''; metricValue.value = ''; comment.value = '';
        toast('反馈已按当前开篇版本哈希保存', 'success');
      }) }),
    ),
  ));
  return el('details', { class: 'fold', open: assets.length > 0 },
    el('summary', {}, '开篇创作决策台：宪章 · 诊断 · 候选 · 一键应用'), body);
}

function renderChapter(book, chapter) {
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
async function runFlow(book, chapter, root, btn) {
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
async function runPilot(book, root, btn, opts = {}) {
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
          livePatchChapterList(data.idx, { status: 'writing', title: data.title });
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
          livePatchChapterList(data.idx, { status: 'done', wordCount: data.wordCount, title: data.title });
          // 完成卡片（异步补摘要）
          (async () => {
            try {
              const ch = await get(`/api/books/${book.id}/chapters/${data.chapterId}`);
              livePatchChapterList(data.idx, { status: ch.status, wordCount: ch.word_count, title: ch.title });
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
          livePatchChapterList(data.idx, { status: 'quality_blocked' });
          break;
        case 'blocked_fixed':
          setStatus(`${data.message}`);
          feed('修复', data.message, 'ok');
          (data.chapters || []).forEach(idx => {
            markChapter(idx, 'ch-cell done');
            livePatchChapterList(idx, { status: 'done' });
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
          if (data.idx) livePatchChapterList(data.idx, { status: 'writing' });
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

async function runPolishNow(book, root, btn, opts = {}) {
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
