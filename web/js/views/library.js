// web/js/views/library.js —— 作品库：列表 + 新建向导（AI 本位：灵感 + 平台 → 自动成书）
// V0.25：统一 openModal 模态 / pageHead / emptyState；卡片视觉升级
'use strict';
import { get, post, del } from '../api.js';
import { el, toast, icon, openModal, pageHead, emptyState, fmtTokens, chapterStatusLabel } from '../ui.js';
import { state, refreshGlobal } from '../app.js';

const GENRES = ['玄幻', '都市', '科幻', '悬疑', '言情', '仙侠', '历史', '游戏', '无限流', '其他'];
const PLATFORMS = ['番茄', '起点', '通用'];

export async function renderLibrary(view) {
  state.books = await get('/api/books');
  view.innerHTML = ''; // V0.20：防止删除/刷新后重复渲染叠加

  view.append(pageHead(
    'icon:book:作品库',
    '墨舟 · 观察自动创作：点开始即可去读，进度在顶栏，停止按钮才取消',
    el('button', { class: 'primary', onclick: () => showCreateDialog(view) }, icon('plus', 15), '新建作品'),
  ));

  if (!state.books.length) {
    view.append(emptyState(
      'pencil',
      '还没有作品',
      '点击「新建作品」，只需填一个灵感，AI 会从书契约、设定、大纲到每一章全部自动完成。无需懂网文套路：平台模式（番茄/起点）已内建爽点节奏、钩子与 AI 味消除规则。',
    ));
    return;
  }

  const grid = el('div', { class: 'grid' });
  for (const b of state.books) {
    const done = b.chapterCount || 0;
    const tokens = b.history?.tokens || 0;
    const card = el('div', { class: 'card book-card', onclick: () => { location.hash = `#/book/${b.id}/workshop`; } },
      el('div', { class: 'title' },
        el('span', { text: b.title }),
        // V0.26：未命名作品提示（创建后运行「自动创作」会按大纲自动命名）
        b.title === '未命名' ? el('span', { class: 'tag book-unnamed', text: '待自动命名' }) : null,
        b.activeWriteJob ? el('span', { class: 'tag writing', text: b.activeWriteJob.type === 'polish' ? '打磨中' : '写作中' }) : null,
        b.activeRecoveryJob ? el('span', { class: 'tag writing', text: '返工中' }) : null,
        b.blockedCount ? el('span', { class: 'tag quality_blocked', text: `${b.blockedCount} 章卡住` }) : null,
        el('button', { class: 'btn small ghost', title: '导出全文（复制/下载）', onclick: (ev) => {
          ev.stopPropagation();
          exportBook(b);
        } }, icon('download', 14)),
        el('button', { class: 'btn small ghost danger book-del', title: '删除作品', onclick: (ev) => {
          ev.stopPropagation();
          confirmDelete(b, () => renderLibrary(view));
        } }, icon('trash', 14)),
      ),
      el('div', { class: 'meta' },
        el('span', { class: 'tag', text: b.genre }),
        el('span', { class: 'tag ' + (b.platform && b.platform !== '通用' ? 'done' : ''), text: b.platform || '通用' }),
        el('span', { class: 'tag', text: b.perspective === 'first' ? '第一人称' : '第三人称' }), // V0.42
        el('span', { class: 'tag done', text: `${done} 章` }),
      ),
      el('div', { class: 'blurb', text: b.blurb || '（无简介）' }),
      el('div', { class: 'row mt', style: 'justify-content:space-between' },
        el('span', { class: 'stat', text: `历史 ${tokens.toLocaleString()} tokens` }),
        el('span', { class: 'stat muted small', text: new Date(b.updated_at).toLocaleDateString('zh-CN') }),
      ),
    );
    grid.append(card);
  }
  view.append(grid);
}

/** 一键导出：获取格式化全文 → 弹窗（章节勾选 + textarea 全选 + 复制 + 下载 .txt） */
async function exportBook(book) {
  try {
    const r = await get(`/api/books/${book.id}/export`);
    if (!r.text) { toast('本书还没有可导出的章节（先写几章）', 'warn'); return; }
    // 当前选中章节 id 集合（默认全选）
    let selected = new Set((r.chapterList || []).map(c => c.id));
    // 按卷分组展示章节清单
    const volTitles = new Map();
    try {
      const vols = await get(`/api/books/${book.id}/volumes`);
      for (const v of vols) volTitles.set(v.id, v.title || `第${v.idx}卷`);
    } catch { /* 卷列表不可用时平铺 */ }
    const list = r.chapterList || [];
    const checkboxes = new Map(); // id → checkbox 节点
    const selBox = el('div', { class: 'export-sel', style: 'max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px' });
    let lastVol = Symbol();
    for (const c of list) {
      const vTitle = c.volume_id ? (volTitles.get(c.volume_id) || '') : '';
      if (c.volume_id !== lastVol) {
        lastVol = c.volume_id;
        if (list.indexOf(c) > 0) selBox.append(el('div', { class: 'small muted', style: 'margin:6px 0 2px', text: vTitle || '（无卷）' }));
      }
      const cb = el('input', { type: 'checkbox', checked: true, style: 'margin-right:6px' });
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(c.id); else selected.delete(c.id);
        refreshText();
      });
      checkboxes.set(c.id, cb);
      selBox.append(el('label', { class: 'row', style: 'gap:6px;align-items:center;padding:1px 0' },
        cb, el('span', { class: 'small', text: `第${c.idx}章 ${c.title || ''}` })));
    }
    const selHead = el('div', { class: 'row mb', style: 'gap:8px;align-items:center' },
      el('strong', { class: 'grow small', text: `选择章节（${list.length}）` }),
      el('button', { class: 'sm ghost', text: '全选', onclick: () => {
        for (const [id, cb] of checkboxes) { cb.checked = true; selected.add(id); }
        refreshText();
      } }),
      el('button', { class: 'sm ghost', text: '清空', onclick: () => {
        for (const [id, cb] of checkboxes) { cb.checked = false; selected.delete(id); }
        refreshText();
      } }),
    );
    const ta = el('textarea', {
      style: 'width:100%;height:40vh;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.7;resize:vertical;white-space:pre-wrap',
      readonly: true, text: r.text,
    });
    // 点击 textarea 自动全选（复制粘贴最顺滑）
    ta.addEventListener('focus', () => ta.select());
    let titleEl = el('span', { text: `导出《${r.title}》（${r.chapters} 章 · ${fmtTokens(r.chars)}）` });
    let reqSeq = 0;
    const refreshText = async () => {
      const seq = ++reqSeq;
      const ids = [...selected];
      const q = ids.length && ids.length < list.length ? `?chapterIds=${ids.join(',')}` : '';
      try {
        const rr = await get(`/api/books/${book.id}/export${q}`);
        if (seq !== reqSeq) return; // 防抖竞态：只采纳最新一次
        ta.value = rr.text;
        titleEl.textContent = `导出《${rr.title}》（${rr.chapters} 章 · ${fmtTokens(rr.chars)}）`;
        state._exportText = rr.text;
      } catch { /* 忽略瞬时失败 */ }
    };
    state._exportText = r.text;
    const modal = openModal({
      title: '',
      body: el('div', {},
        el('div', { class: 'modal-title mb' }, titleEl),
        selHead, selBox, ta,
      ),
      large: true,
      actions: [
        el('button', { class: 'primary', text: '复制全文', onclick: async (ev) => {
          const btn = ev.currentTarget;
          const cur = state._exportText || ta.value;
          try {
            await navigator.clipboard.writeText(cur);
            btn.textContent = '✓ 已复制'; toast('已复制到剪贴板', 'success');
          } catch {
            ta.focus(); ta.select();
            try { document.execCommand('copy'); btn.textContent = '✓ 已复制'; toast('已复制到剪贴板', 'success'); }
            catch { toast('复制失败，请手动 Ctrl+C', 'error'); }
          }
        } }),
        el('button', { text: '下载 .txt', onclick: () => {
          const cur = state._exportText || ta.value;
          const blob = new Blob([cur], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${(r.title || '作品').replace(/[\\/:*?"<>|]/g, '_')}.txt`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          toast('已开始下载', 'success');
        } }),
        el('button', { text: '关闭', onclick: () => { state._exportText = null; modal.close(false); } }),
      ],
    });
  } catch (e) { toast(e.message, 'error'); }
}

/** 删除作品：二次确认（输入书名）后调用 DELETE API */
function confirmDelete(book, refresh) {
  const input = el('input', { type: 'text', placeholder: `输入「${book.title}」确认删除` });
  // V0.30：自动聚焦输入框（减少一步操作）
  setTimeout(() => input.focus(), 50);
  const doDelete = async (ev) => {
    if (input.value.trim() !== book.title) {
      // V0.30 修复：明确提示要输入的书名（此前只有红框，用户不知如何操作）
      input.style.borderColor = 'var(--red)';
      toast(`请输入完整书名「${book.title}」再点击删除`, 'warn', 5000);
      input.focus();
      return;
    }
    const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '删除中…';
    try {
      await del(`/api/books/${book.id}`);
      m.close(true);
      toast(`《${book.title}》已删除`, 'success');
      await refreshGlobal();
      refresh();
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '永久删除'; }
  };
  const m = openModal({
    title: '删除作品？',
    body: el('div', {},
      el('div', { class: 'muted small mb', text: `《${book.title}》的全部章节、设定、伏笔、成本记录将永久删除，无法恢复。` }),
      el('label', { text: '请输入书名确认' }), input,
    ),
    actions: [
      el('button', { text: '取消', onclick: () => m.close(false) }),
      el('button', { text: '永久删除', style: 'background:var(--red);border-color:var(--red);color:#fff', onclick: doDelete }),
    ],
  });
  input.focus();
}

function showCreateDialog(view) {
  const titleInput = el('input', { type: 'text', maxlength: '30', placeholder: '书名（留空则 AI 自动起名）' });
  const genreSelect = el('select');
  for (const g of GENRES) genreSelect.append(el('option', { value: g, text: g }));
  const platformSelect = el('select');
  for (const p of PLATFORMS) {
    platformSelect.append(el('option', { value: p, text: `${p}${p === '番茄' ? '（快节奏爽文）' : p === '起点' ? '（慢热品质）' : ''}`, selected: p === '番茄' }));
  }
  // V0.42：叙述视角（第三人称默认 / 第一人称主角）
  const perspSelect = el('select');
  perspSelect.append(
    el('option', { value: 'third', text: '第三人称（默认，适合大多数爽文）' }),
    el('option', { value: 'first', text: '第一人称（主角视角，代入感强）' }),
  );
  const ideaInput = el('textarea', { style: 'min-height:80px', placeholder: '一句话灵感，或粘贴一段片段/随笔/草稿（AI 会先反推故事核心再提级）' });
  const amplifyBox = el('div', { class: 'test-result mt' });
  // V0.82：历史题材朝代配置（选"历史"时展开；留空=默认宋末内置考据包）
  const eraDynasty = el('input', { type: 'text', maxlength: '30', placeholder: '朝代名（如：南宋末 / 明末 / 唐末…）' });
  const eraYears = el('input', { type: 'text', maxlength: '40', placeholder: '年份范围（如：1234-1279）' });
  const eraLine = el('input', { type: 'text', maxlength: '60', placeholder: '主要年号（如：淳祐/宝祐/开庆…）' });
  const eraSeed = el('textarea', { style: 'min-height:70px', placeholder: '自定义考据要点（可选）：关键历史事件/人物/官职/地理/你想保留或改写的史实，AI 会据此生成时代背景卡。越具体，史实越准。' });
  const eraBox = el('div', { class: 'era-config', style: 'display:none;margin-top:8px;padding:10px;border:1px dashed var(--border);border-radius:8px' },
    el('div', { class: 'small muted', style: 'margin-bottom:6px', text: '【朝代配置】留空则用内置"南宋末宋蒙战争"考据包（官方推荐：史料最全）。自定义朝代时请尽量填全——朝代/年份/年号是史实骨架，考据要点决定时代质感。' }),
    el('div', { class: 'split' },
      el('div', {}, el('label', { text: '朝代名' }), eraDynasty),
      el('div', {}, el('label', { text: '年份范围' }), eraYears),
    ),
    el('div', { class: 'mt' }, el('label', { text: '主要年号' }), eraLine),
    el('div', { class: 'mt' }, el('label', { text: '自定义考据要点（可选）' }), eraSeed),
  );
  genreSelect.addEventListener('change', () => { eraBox.style.display = genreSelect.value === '历史' ? '' : 'none'; });
  // 选"历史"时提示朝代配置
  if (genreSelect.value === '历史') eraBox.style.display = '';

  const body = el('div', {},
    el('div', {}, el('label', { text: '书名（可选）' }), titleInput),
    el('div', { class: 'split' },
      el('div', {}, el('label', { text: '题材' }), genreSelect),
      el('div', {}, el('label', { text: '目标平台' }), platformSelect),
    ),
    el('div', { class: 'split' },
      el('div', {}, el('label', { text: '叙述视角' }), perspSelect),
      el('div', {}, el('label', { text: '' })),
    ),
    eraBox,
    el('div', { class: 'mt' }, el('label', { class: 'req', text: '灵感素材（一句话 / 片段 / 随笔 / 草稿都行，不想写就点下面的生成器）' }), ideaInput),
    el('div', { class: 'row', style: 'gap:8px;margin-bottom:4px' },
      el('button', { class: 'sm', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '生成中…';
        try {
          const r = await post('/api/idea/seeds', { genre: genreSelect.value });
          const seeds = r.seeds || [];
          if (!seeds.length) { toast('生成失败', 'error'); return; }
          const picker = openModal({
            title: '选一个高概念种子（点击即填入）',
            large: true,
            body: el('div', { class: 'col' }, ...seeds.map(seed =>
              el('div', { class: 'preset-card', onclick: () => { ideaInput.value = seed.concept; picker.close(true); } },
                el('div', { class: 'preset-title', text: seed.concept }),
                el('div', { class: 'small muted', text: seed.why }),
              ),
            )),
            actions: [el('button', { text: '关闭', onclick: () => picker.close(false) })],
          });
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false; btn.textContent = '灵感生成器（本地零成本）';
      } }, icon('dice', 14), '灵感生成器（本地零成本）'),
      el('button', { class: 'sm', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'AI 诊断中…';
        amplifyBox.className = 'test-result mt'; amplifyBox.textContent = '';
        try {
          const r = await post('/api/idea/amplify', {
            idea: ideaInput.value.trim(),
            genre: genreSelect.value,
            platform: platformSelect.value,
          });
          if (!r.ok) { toast(r.error || '提级失败', 'error'); return; }
          let selected = null;
          const scoreBars = (label, v) => el('div', { class: 'score-row' },
            el('span', { class: 'score-label', text: label }),
            el('div', { class: 'score-bar' }, el('div', { class: 'score-fill', style: `width:${Math.max(5, Math.min(100, (v || 0) * 10))}%` })),
            el('span', { class: 'score-val', text: `${v ?? '-'}/10` }),
          );
          const optionCards = (r.options || []).map((o, i) => {
            const card = el('div', { class: 'preset-card', style: 'margin:6px 0', onclick: () => {
              selected = o;
              optionCards.forEach(c => c.classList.remove('active'));
              card.classList.add('active');
              applyBtn.disabled = false;
            } },
              el('div', { class: 'preset-title', text: `${i + 1}. ${o.title}` }),
              el('div', { text: o.concept }),
              el('div', { class: 'small muted', text: `第一幕钩子：${o.hook || '-'}` }),
              el('div', { class: 'small muted', text: `为什么强：${o.why || ''}${o.risk ? `｜风险：${o.risk}` : ''}` }),
            );
            return card;
          });
          const applyBtn = el('button', { class: 'primary sm', disabled: true, text: '应用所选方案（填入灵感框）', onclick: () => {
            if (selected) { ideaInput.value = selected.concept; amplifyBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
          } });
          const iterateBtn = el('button', { class: 'sm', text: '↻ 基于所选方案再提级一轮', onclick: async () => {
            if (!selected) { toast('请先选择一个方案', 'warn'); return; }
            ideaInput.value = selected.concept;
            amplifyBox.innerHTML = ''; amplifyBox.textContent = '第二轮提级中…';
            const r2 = await post('/api/idea/amplify', {
              idea: selected.concept,
              genre: genreSelect.value,
              platform: platformSelect.value,
            });
            if (!r2.ok) { amplifyBox.textContent = r2.error || '提级失败'; return; }
            amplifyBox.innerHTML = '';
            const cards2 = (r2.options || []).map((o, i) =>
              el('div', { class: 'preset-card', style: 'margin:6px 0', onclick: () => { ideaInput.value = o.concept; } },
                el('div', { class: 'preset-title', text: `${i + 1}. ${o.title}` }),
                el('div', { text: o.concept }),
                el('div', { class: 'small muted', text: `第一幕钩子：${o.hook || '-'}` }),
              ),
            );
            amplifyBox.append(
              el('div', { class: 'preset-title', text: `第二轮评分：${r2.total ?? '-'}/10` }),
              ...cards2,
              r2.goldenOpen ? el('div', { class: 'small muted mt', text: `黄金开场建议：${r2.goldenOpen}` }) : null,
            );
          } });
          amplifyBox.append(
            el('div', { class: 'preset-title', text: `概念评分：${r.total ?? '-'}/10（${r.verdict === 'good' ? '优秀' : r.verdict === 'weak' ? '偏弱，建议升级' : '较弱，强烈建议升级'}）` }),
            // V0.25：核心元素守恒可视化——让用户确认"穿越"等锚点没丢
            (r.keptElements || []).length ? el('div', { class: 'row-gap mt' },
              el('span', { class: 'small muted', text: '已锁定你的核心设定：' }),
              ...r.keptElements.map(k => el('span', { class: 'tag done', text: `${k}` })),
            ) : null,
            (r.keptElements || []).length ? el('div', { class: 'small muted', style: 'margin:2px 0 6px', text: '所有提级方案都会保留以上元素，只在此基础上强化。' }) : null,
            el('div', { class: 'score-grid' },
              scoreBars('新颖', r.scores?.novelty),
              scoreBars('冲突', r.scores?.conflict),
              scoreBars('市场', r.scores?.market),
              scoreBars('可执行', r.scores?.executable),
            ),
            ...(r.issues || []).map(i => el('div', { class: 'warn-line', text: `${i}` })),
            el('div', { class: 'divider' }),
            el('div', { class: 'small muted', text: '点击选择一个升级方向（可基于它继续迭代）' }),
            ...optionCards,
            el('div', { class: 'row', style: 'justify-content:flex-end;gap:8px;margin-top:8px' }, iterateBtn, applyBtn),
            r.goldenOpen ? el('div', { class: 'small muted mt', text: `黄金开场建议：${r.goldenOpen}` }) : null,
          );
        } catch (e) { amplifyBox.textContent = `${e.message}`; }
        btn.disabled = false; btn.textContent = 'AI 提级灵感（诊断+3个升级方案）';
      } }, icon('sparkles', 14), 'AI 提级灵感'),
    ),
    amplifyBox,
    el('div', { class: 'small muted mt', text: '创建后可点「自动创作」一键生成契约→设定→大纲→连续写作→全书打磨。灵感越具体越好；不想写就点「灵感生成器」。' }),
  );

  const m = openModal({
    title: '新建作品',
    large: true,
    body,
    actions: [
      el('button', { text: '取消', onclick: () => m.close(false) }),
      el('button', { class: 'primary', text: '创建作品', onclick: async (ev) => {
        const idea = ideaInput.value.trim();
        if (!idea) return toast('请填写一句话灵感', 'error');
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '创建中…';
        try {
          // V0.82：历史题材携带朝代配置（era JSON；空朝代/空年份 = 默认宋末）
          const era = {};
          if (genreSelect.value === '历史') {
            if (eraDynasty.value.trim()) era.dynasty = eraDynasty.value.trim();
            if (eraYears.value.trim()) era.years = eraYears.value.trim();
            if (eraLine.value.trim()) era.eraLine = eraLine.value.trim();
            if (eraSeed.value.trim()) era.seed = eraSeed.value.trim();
          }
          const book = await post('/api/books', {
            title: titleInput.value.trim(),
            genre: genreSelect.value,
            platform: platformSelect.value,
            perspective: perspSelect.value, // V0.42 叙述视角
            era: JSON.stringify(era), // V0.82 朝代配置
            // V0.25 修复：截断从 120 放宽到 500（提级方案的 concept+钩子此前被砍断）
            blurb: idea.slice(0, 500),
          });
          m.close(true);
          toast(`《${book.title}》创建成功`, 'success');
          await refreshGlobal();
          location.hash = `#/book/${book.id}/workshop`;
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '创建作品'; }
      } }),
    ],
  });
  ideaInput.focus();
}
