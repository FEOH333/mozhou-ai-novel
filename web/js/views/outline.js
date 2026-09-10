// web/js/views/outline.js —— 大纲：书级大纲向导 + 卷大纲 + 章节管理
'use strict';
import { get, post, put, patch, del, sse } from '../api.js';
import { el, toast, confirmDialog, icon, safeJsonParse, pageHead, progressCard, openModal, CHAPTER_STATUS, CHAPTER_STATUS_TAG, chapterStatusLabel } from '../ui.js';
import { state, refreshBook, rerender } from '../app.js';

export async function renderOutline(view, book) {
  const mats = await get(`/api/books/${book.id}/public-materials`);
  const outlineMat = mats.find(m => m.kind === 'outline');
  const volumes = await get(`/api/books/${book.id}/volumes`).catch(() => []);
  // V0.73：字数档位改为解析 settings_json.lengthProfile（此前字符串 includes('2500') 会误匹配其他字段）
  const currentLengthProfile = (() => { try { return parseInt((JSON.parse(book.settings_json || '{}').lengthProfile)) || 3200; } catch { return 3200; } })();

  view.append(pageHead('icon:bookOpen:大纲', `《${book.title || '未命名'}》·书级大纲 → 卷大纲 → 章节规划，生成后自动写入写作上下文`));

  // ---- 书级大纲 ----
  const bookCard = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', text: '书级大纲' }),
      // V0.42：叙述视角切换（仅影响后续章节）
      el('span', { class: 'small muted', style: 'margin-right:8px', text: '叙述视角' }),
      el('select', {
        style: 'max-width:180px',
        onchange: async (ev) => {
          const sel = ev.currentTarget;
          try {
            const r = await put(`/api/books/${book.id}/perspective`, { perspective: sel.value });
            toast(r.note || '视角已更新');
          } catch (e) { toast(e.message, 'error'); sel.value = book.perspective === 'first' ? 'first' : 'third'; }
        },
      }, el('option', { value: 'third', text: '第三人称', selected: book.perspective !== 'first' }),
        el('option', { value: 'first', text: '第一人称（主角）', selected: book.perspective === 'first' })),
      // V0.43：每章目标字数（settings.lengthProfile，仅影响后续章节细纲）
      el('span', { class: 'small muted', style: 'margin:0 8px 0 14px', text: '每章字数' }),
      el('select', {
        style: 'max-width:130px',
        onchange: async (ev) => {
          const sel = ev.currentTarget;
          try {
            const s = await get(`/api/books/${book.id}`);
            const settings = s.settings_json ? JSON.parse(s.settings_json) : {};
            settings.lengthProfile = parseInt(sel.value);
            await put(`/api/books/${book.id}/settings`, { settings });
            toast('已更新每章目标字数（仅影响后续章节）');
          } catch (e) { toast(e.message, 'error'); }
        },
      },
        el('option', { value: '2500', text: '紧凑 2500', selected: currentLengthProfile === 2500 }),
        el('option', { value: '3200', text: '标准 3200', selected: currentLengthProfile === 3200 }),
        el('option', { value: '5000', text: '丰满 5000', selected: currentLengthProfile === 5000 })),
    ),
  );
  if (!outlineMat?.content) {
    bookCard.append(
      el('div', { class: 'muted mb', text: '还没有书级大纲。生成后将自动创建卷结构，并写入写作上下文（公共材料）。' }),
      el('div', { class: 'row' },
        el('button', { class: 'sm ghost', text: '生成书级大纲', onclick: () => generateBookOutline(book, bookCard) }),
        el('span', { class: 'small muted', text: '也可先手动填写世界观/人物（「设定」页），再生成大纲' }),
      ),
    );
  } else {
    bookCard.append(
      renderReadableOutline(outlineMat.content),
      el('div', { class: 'row mt' },
        el('button', { text: '↻ 重新生成', onclick: () => generateBookOutline(book, bookCard) }),
        el('span', { class: 'small muted', text: `版本 v${outlineMat.version}（修改书纲将重建缓存前缀）` }),
      ),
    );
  }
  view.append(bookCard);

  // V0.96：书契约与签约评估可视化——后端 scoreContract（签约模拟评分）早已存在但前端零入口；
  // 契约文本本身也只存在 materials 里，用户从未见过这本书"对读者的承诺"。
  const contractMat = mats.find(m => m.kind === 'contract');
  if (contractMat?.content) {
    const scoreBody = el('div', { class: 'small', style: 'margin-top:8px' });
    view.append(el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('h3', { class: 'grow', text: '书契约（对读者的承诺）' }),
        el('button', { class: 'sm ghost', text: '📊 签约评估（会调用模型）', onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true; b.textContent = '评估中…（走 LLM）';
          try {
            const r = await post(`/api/books/${book.id}/contract/score`, {});
            scoreBody.innerHTML = '';
            if (!r.ok) throw new Error(r.error || '评分失败');
            // V0.96.1 修复：① 原生 append(null) 会渲染字面 "null" 文本（el() 跳过 null，原生不跳过）
            // ——条件子节点必须 filter(Boolean) 后再 spread；② scores 是对象非数组
            // （schema：{"novelty","conflict","market","executable"}，contractScoreInstruction 单一真源）
            const DIM = { novelty: '新颖度', conflict: '冲突强度', market: '市场潜力', executable: '可执行性' };
            const VERDICT = { pass: '✅ 通过（≥6 分基准，值得写下去）', regen: '🔄 建议换方向重做（<6 分）' };
            const scoreRows = (r.scores && typeof r.scores === 'object' && !Array.isArray(r.scores))
              ? Object.entries(r.scores).map(([k, v]) => el('div', { text: `${DIM[k] || k}：${v} / 10` }))
              : [];
            scoreBody.append(...[
              el('div', { style: 'font-size:1.3em;font-weight:700', text: `${r.total} / 10 · ${VERDICT[r.verdict] || r.verdict || ''}` }),
              scoreRows.length ? el('div', { class: 'small', style: 'margin-top:4px;display:flex;gap:14px;flex-wrap:wrap' }, ...scoreRows) : null,
              r.regenDirection ? el('div', { class: 'small muted', style: 'margin-top:4px', text: `改进方向：${String(r.regenDirection).slice(0, 160)}` }) : null,
            ].filter(Boolean));
          } catch (e) { toast(e.message, 'error'); }
          b.disabled = false; b.textContent = '📊 签约评估（会调用模型）';
        } }),
      ),
      el('details', { class: 'small' }, el('summary', {}, '契约全文'), el('pre', { class: 'json', style: 'white-space:pre-wrap', text: contractMat.content })),
      scoreBody,
    ));
  }

  // ---- 卷 ----
  // V0.41：卷级审阅报告（每卷写完自动体检；展示 grade + 工单 + 修订数）
  const reviews = await get(`/api/books/${book.id}/volume-reviews`).catch(() => ({ reviews: [] }));
  const reviewByVol = new Map((reviews.reviews || []).map((r) => [r.volume_id, r]));
  const volCard = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', text: '卷大纲' }),
      el('button', { class: 'sm ghost', text: '⚡ 补审已完成卷', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const r = await post(`/api/books/${book.id}/volume-reviews/tidy`, {});
          toast(`卷体检完成：${r.results?.length || 0} 卷`);
          await refreshBook(); view.innerHTML = ''; renderOutline(view, state.book);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
      el('button', { class: 'sm ghost', text: '＋ 新建卷', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        // V0.20 修复：失败给出提示（此前静默无反馈）
        const v = await post(`/api/books/${book.id}/volumes`, { idx: volumes.length + 1, title: `第${volumes.length + 1}卷` }).catch(e => toast(e.message, 'error'));
        if (v) { await refreshBook(); view.innerHTML = ''; renderOutline(view, state.book); }
        btn.disabled = false;
      } }),
    ),
  );
  if (!volumes.length) {
    volCard.append(el('div', { class: 'muted', text: '暂无卷。先生成书级大纲，或手动新建。' }));
  }
  for (const v of volumes) {
    const outline = safeJsonParse(v.outline_json, {});
    const rev = reviewByVol.get(v.id);
    volCard.append(el('div', { class: 'mt2' },
      el('div', { class: 'row' },
        el('strong', { text: `${v.idx}. ${v.title || `第${v.idx}卷`}` }),
        el('span', { class: 'tag ' + (v.status === 'outlined' ? 'outlined' : ''), text: v.status === 'outlined' ? '已生成' : '待生成' }),
        // V0.94.2：体检 tag 按 status 分流——parse_failed 的兜底 C 不是质量判定，
        // 显示「体检失败·待补审」（下次自动创作或「补审已完成卷」会重审），不再误报红 C
        rev
          ? (rev.status === 'failed'
              ? el('span', {
                  class: 'tag outlined',
                  title: '卷体检未完成：模型输出解析失败（fail-closed）。\n下次「开始自动创作」启动时自动补审，也可点上方「补审已完成卷」手动重试。',
                  text: '体检失败·待补审',
                })
              : el('span', {
                  class: 'tag ' + (rev.grade === 'A' ? 'done' : rev.grade === 'B' ? 'warn' : 'low'),
                  title: `卷级体检：${rev.grade} 级 · 工单 ${safeJsonParse(rev.issues_json, []).length} 条 · 修订 ${rev.revised_count || 0} 章${rev.status === 'needs_attention' ? '\n注意：部分修订被安全闸拦截，待复检' : ''}`,
                  text: rev.status === 'needs_attention' ? `体检 ${rev.grade}·修订被拦` : `体检 ${rev.grade}`,
                }))
          : el('span', { class: 'tag', text: '未体检' }),
        el('span', { class: 'grow' }),
        // V0.82：卷编辑（改名/目标）/ 删除（级联删章，后端路由已存在）
        el('button', { class: 'sm', text: '编辑', onclick: () => {
          const nameIn = el('input', { value: v.title || '' });
          const goalIn = el('textarea', { style: 'min-height:44px', placeholder: '本卷目标', text: v.goal || '' });
          const m = openModal({
            title: `编辑第${v.idx}卷`,
            body: el('div', {},
              el('div', {}, el('label', { text: '卷名' }), nameIn),
              el('div', { class: 'mt' }, el('label', { text: '本卷目标' }), goalIn),
            ),
            actions: [
              el('button', { text: '取消', onclick: () => m.close(false) }),
              el('button', { class: 'primary', text: '保存', onclick: async (ev) => {
                const btn = ev.currentTarget; btn.disabled = true;
                try {
                  await patch(`/api/books/${book.id}/volumes/${v.id}`, { title: nameIn.value.trim(), goal: goalIn.value.trim() });
                  toast('已保存'); m.close(true);
                  await refreshBook(); view.innerHTML = ''; renderOutline(view, state.book);
                } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
              } }),
            ],
          });
        } }),
        el('button', { class: 'sm ghost', text: '删除', onclick: async () => {
          const chCount = book.chapters?.filter(c => c.volume_id === v.id).length || 0;
          if (!await confirmDialog('删除该卷？', `将删除第${v.idx}卷「${v.title || ''}」及其 ${chCount} 章（历史正文一并删除，不可恢复；已结算章节请先用快照备份）。`)) return;
          try {
            await del(`/api/books/${book.id}/volumes/${v.id}`);
            toast('已删除'); await refreshBook(); view.innerHTML = ''; renderOutline(view, state.book);
          } catch (e) { toast(e.message, 'error'); }
        } }),
        el('button', { class: 'sm', text: '生成卷大纲', onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true; btn.textContent = '生成中…';
          const prog = progressCard('正在生成卷大纲…');
          volCard.append(prog.card);
          try {
            const r = await sse(`/api/books/${book.id}/volumes/${v.id}/generate`, { chapterCount: 8 }, (event, data) => {
              if (event === 'stage') prog.setMessage(data.message);
            });
            toast(`卷大纲《${r.title}》已生成，共 ${r.chapters} 章`);
            await refreshBook(); view.innerHTML = ''; renderOutline(view, state.book);
          } catch (e) { prog.setMessage('生成失败：' + e.message); toast(e.message, 'error'); btn.disabled = false; btn.textContent = '生成卷大纲'; }
        } }),
      ),
      // V0.41：卷体检报告详情（展开式）
      rev && rev.grade
        ? el('div', { class: 'small muted', style: 'margin:4px 0 4px 0;padding:6px 8px;background:var(--bg2);border-radius:6px' },
            (() => {
              const report = safeJsonParse(rev.report_json, {});
              const issues = safeJsonParse(rev.issues_json, []);
              const lines = [];
              // V0.94.2：parse_failed 记录给明确说明（此前渲染成空白块，用户无从知道发生了什么）
              if (report.parse_failed || rev.status === 'failed') {
                lines.push('本次体检未完成：模型输出解析失败（fail-closed，未产生质量结论）。点上方「补审已完成卷」重试。');
                return el('div', {}, lines.map((t) => el('div', { text: t })));
              }
              if (report.goal_met !== undefined) lines.push(`卷目标：${report.goal_met ? '达成 ✓' : '未达成 ✗'} ${report.goal_note || ''}`);
              if (report.pacing?.issue) lines.push(`节奏：${report.pacing.issue}`);
              if (report.hooks?.volume_ending) lines.push(`卷末钩子：${report.hooks.volume_ending}`);
              if (report.reading?.issue) lines.push(`读感：${report.reading.issue}`);
              for (const i of issues.slice(0, 4)) lines.push(`[${i.severity}/${i.type}${i.chapter ? ` 第${i.chapter}章` : ''}] ${i.desc}`);
              return el('div', {}, lines.map((t) => el('div', { text: t })));
            })())
        : null,
      outline.chapters?.length
        ? el('div', { class: 'small muted', style: 'margin:6px 0 4px', text: `${outline.chapters.length} 章已规划` })
        : el('div', { class: 'small muted', style: 'margin:6px 0 4px', text: v.goal || v.outline_json ? '已规划' : '未生成' }),
    ));
  }
  view.append(volCard);

  // ---- 章节 ----
  const chapters = book.chapters || [];
  if (chapters.length) {
    const chCard = el('div', { class: 'card' },
      el('h3', { text: `章节（${chapters.length}）` }),
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: '标题' }), el('th', { text: '状态' }), el('th', { text: '字数' }))),
        el('tbody', {}, ...chapters.map(c =>
          el('tr', {},
            el('td', { text: c.idx }),
            el('td', {}, el('a', { class: 'link', href: `#/book/${book.id}/workshop?chapter=${c.id}`, text: c.title || `第${c.idx}章` })),
            // V0.78 修复：状态显示中文，revised/settled/done 用完成色（此前显示英文 revised，偏灰紫）
            el('td', {}, el('span', { class: 'tag ' + (CHAPTER_STATUS_TAG[c.status] || ''), text: chapterStatusLabel(c.status) })),
            el('td', { class: 'muted', text: c.word_count ? `${c.word_count} 字` : '—' }),
            // V0.82：章节改名（AI 按实际内容起名；历史题材自动带时代风格约束）
            el('td', {}, el('button', { class: 'sm ghost', text: '改名', onclick: async (ev) => {
              const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '改名中…';
              try {
                const r = await post(`/api/books/${book.id}/chapters/${c.id}/rename`, {});
                if (r.ok) toast(`《${r.oldTitle || ''}》→《${r.newTitle}》`, 'success');
                else toast(r.error || '改名失败', 'warn');
                await refreshBook(); view.innerHTML = ''; renderOutline(view, state.book);
              } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '改名'; }
            } })),
          ),
        )),
      ),
    );
    view.append(chCard);
  }
}

// V0.28：SSE 流式进度（阶段实时显示：读取灵感 → 生成中 → 建卷 → 完成）
async function generateBookOutline(book, card) {
  const btn = card.querySelector('button');
  if (btn) btn.disabled = true;
  const prog = progressCard('正在生成书级大纲…');
  card.append(prog.card);
  try {
    const r = await sse(`/api/books/${book.id}/outline/generate`, { volumeCount: 4 }, (event, data) => {
      if (event === 'stage') prog.setMessage(data.message);
      if (event === 'done') prog.setMessage('书级大纲生成完成，正在刷新…');
    });
    toast(`书级大纲《${r.title}》已生成，共 ${r.volumes} 卷`);
    await refreshBook();
    rerender();
  } catch (e) {
    prog.setMessage('生成失败：' + e.message);
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = btn.textContent.replace('生成中', '生成'); }
  }
}

function renderReadableOutline(content) {
  const data = safeJsonParse(content, null);
  if (!data || typeof data !== 'object') {
    return el('pre', { class: 'json', style: 'white-space:pre-wrap', text: content });
  }
  const root = el('div', { class: 'outline-read' });
  if (data.title) root.append(el('h4', { text: data.title }));
  const logline = data.logline || data.premise || data.blurb;
  if (logline) root.append(el('div', { class: 'muted mb', text: String(logline) }));
  const vols = data.volumes || data.volume_outlines || [];
  if (Array.isArray(vols) && vols.length) {
    for (const [i, v] of vols.entries()) {
      const body = [v.goal, v.theme, v.beat, v.summary, v.arc].filter(Boolean).join('\n')
        || (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      root.append(el('details', { class: 'fold' },
        el('summary', {}, v.title || `第${v.idx || i + 1}卷`),
        el('div', { class: 'small', style: 'white-space:pre-wrap', text: body }),
      ));
    }
  } else {
    root.append(el('pre', { class: 'json', style: 'white-space:pre-wrap', text: content }));
  }
  return root;
}
