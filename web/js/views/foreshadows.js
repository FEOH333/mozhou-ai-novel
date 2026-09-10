// web/js/views/foreshadows.js —— 伏笔看板
'use strict';
import { get, post, patch, del } from '../api.js';
import { el, toast, confirmDialog, icon, safeJsonParse, pageHead, emptyState } from '../ui.js';
import { rerender } from '../app.js';

const STATUS_META = {
  planted: ['已埋设', 'planted'], advanced: ['推进中', 'advanced'],
  paid_off: ['已回收', 'paid_off'], abandoned: ['已废弃', 'abandoned'],
  expired: ['已超期', 'expired'],
};

export async function renderForeshadows(view, book) {
  const fs = await get(`/api/books/${book.id}/foreshadows`);
  const forgotten = (book.forgotten || []).map(f => f.id);

  view.append(pageHead(
    'icon:bookmark:伏笔看板',
    `《${book.title || '未命名'}》·写作时活跃伏笔自动注入正文指令；超期未回收会预警`,
    el('details', { class: 'fold' },
      el('summary', {}, '登记 / 推进（专家）'),
      el('button', { class: 'sm mt', text: '＋ 登记伏笔', onclick: () => view.append(renderEditor(book, null, view)) }),
    ),
  ));

  if (!fs.length) {
    view.append(emptyState('bookmark', '还没有伏笔', '生成章细纲时埋设的钩子会自动登记，也可手动添加。'));
    return;
  }

  const grid = el('div', { class: 'fs-grid' });
  for (const f of fs) {
    const [statusText, statusTag] = STATUS_META[f.status] || [f.status, ''];
    const isForgotten = forgotten.includes(f.id);
    const adv = safeJsonParse(f.advance_chapters, []);
    grid.append(el('div', { class: `card fs-card ${isForgotten ? 'forgotten' : ''}` },
      isForgotten ? el('span', { class: 'forgotten-flag', text: '遗忘预警' }) : null,
      el('div', { class: 'row' },
        el('span', { class: 'tag ' + statusTag, text: statusText }),
        el('span', { class: 'tag ' + f.importance, text: f.importance === 'high' ? '重要' : (f.importance === 'medium' ? '一般' : '次要') }),
        el('span', { class: 'tag', text: f.type }),
        el('span', { class: 'grow' }),
        el('span', { class: 'small muted', text: f.id }),
      ),
      el('div', { class: 'fs-desc mt', text: f.desc }),
      el('div', { class: 'small muted',
        text: `埋设：第${f.planted_chapter || '?'}章${adv.length ? `｜推进：${adv.map(n => '第' + n + '章').join('、')}` : ''}${f.payoff_chapter ? `｜计划回收：第${f.payoff_chapter}章` : ''}` }),
      el('details', { class: 'fold mt' },
        el('summary', {}, '推进 / 编辑'),
        el('div', { class: 'row mt' },
          el('button', { class: 'sm', text: '推进', onclick: async () => { await patch(`/api/books/${book.id}/foreshadows/${f.id}`, { status: 'advanced' }); rerender(); } }),
          el('button', { class: 'sm', text: '回收', onclick: async () => { await patch(`/api/books/${book.id}/foreshadows/${f.id}`, { status: 'paid_off' }); toast('伏笔已回收'); rerender(); } }),
          el('button', { class: 'sm ghost', text: '废弃', onclick: async () => { await patch(`/api/books/${book.id}/foreshadows/${f.id}`, { status: 'abandoned' }); rerender(); } }),
          el('span', { class: 'grow' }),
          el('button', { class: 'sm ghost', text: '编辑', onclick: () => {
            view.querySelectorAll('.foreshadow-editor').forEach(n => n.remove());
            view.append(renderEditor(book, f, view));
          } }),
          el('button', { class: 'sm ghost danger', text: '删', onclick: async () => {
            if (!await confirmDialog('删除伏笔？', f.desc.slice(0, 40))) return;
            await del(`/api/books/${book.id}/foreshadows/${f.id}`);
            rerender();
          } }),
        ),
      ),
    ));
  }
  view.append(grid);
}

function renderEditor(book, f, view) {
  const isNew = !f;
  const descTa = el('textarea', { style: 'min-height:60px', placeholder: '伏笔描述（如：苏晚的玉佩在月圆夜微微发烫）', text: f?.desc || '' });
  const typeSel = el('select');
  for (const t of ['剧情伏笔', '物品伏笔', '身份伏笔', '对话伏笔']) {
    typeSel.append(el('option', { value: t, text: t, selected: f?.type === t }));
  }
  const impSel = el('select');
  for (const [v, t] of [['high', '重要'], ['medium', '一般'], ['low', '次要']]) {
    impSel.append(el('option', { value: v, text: t, selected: f?.importance === v }));
  }
  const payoffInput = el('input', { type: 'number', placeholder: '计划回收章（可选）', value: f?.payoff_chapter || '' });
  const noteInput = el('input', { type: 'text', placeholder: '备注（可选）', value: f?.note || '' });

  const wrap = el('div', { class: 'card foreshadow-editor' },
    el('h3', { text: isNew ? '登记伏笔' : '编辑伏笔' }),
    el('label', { text: '描述' }), descTa,
    el('div', { class: 'split mt' },
      el('div', {}, el('label', { text: '类型' }), typeSel),
      el('div', {}, el('label', { text: '重要性' }), impSel),
      el('div', {}, el('label', { text: '计划回收章' }), payoffInput),
      el('div', {}, el('label', { text: '备注' }), noteInput),
    ),
    el('div', { class: 'row mt' },
      el('button', { class: 'sm primary', text: isNew ? '登记' : '保存', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const body = { desc: descTa.value.trim(), type: typeSel.value, importance: impSel.value, note: noteInput.value.trim() };
          if (payoffInput.value) body.payoffChapter = parseInt(payoffInput.value);
          if (isNew) await post(`/api/books/${book.id}/foreshadows`, body);
          else await patch(`/api/books/${book.id}/foreshadows/${f.id}`, body);
          toast(isNew ? '已登记' : '已保存');
          rerender();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } }),
      el('button', { class: 'sm', text: '取消', onclick: () => wrap.remove() }),
    ),
  );
  return wrap;
}
