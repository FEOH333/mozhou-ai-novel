// web/js/views/pleasure.js —— V0.17 快感看板：期待账本/并行弧线/情绪节奏/节奏问题
'use strict';
import { get, post, patch, del } from '../api.js';
import { el, icon, fmt, fmtTime, pageHead, toast, openModal } from '../ui.js';

const KIND = { short: '短期待', medium: '中期待', long: '长期待', super: '超级期待' };
const STATUS = { open: '未兑现', progressing: '推进中', confirmed: '已确认', paid: '已兑现', expired: '超期' };

export async function renderPleasure(view, book) {
  view.innerHTML = ''; // V0.20：防止操作后重复渲染叠加
  view.append(pageHead('icon:zap:快感看板', `《${book.title || '未命名'}》·读者心理引擎：期待-满足账本（蔡格尼克）、并行弧线、情绪张力曲线、爽点节奏`));

  const data = await get(`/api/books/${book.id}/pleasure`);
  const { hooks, arcs, emotions, rhythmIssues } = data;

  view.append(el('div', { class: 'kpi-row' },
    kpi('未兑现期待', fmt(hooks.open), `已兑现 ${fmt(hooks.paid)}`),
    kpi('超期期待', fmt(hooks.expired), '优先兑现/推进'),
    kpi('并行弧线', fmt(arcs.open), '应保持 3-5 条'),
    kpi('节奏问题', fmt(rhythmIssues.length), rhythmIssues.length ? '需处理' : '健康'),
  ));

  // V0.96：快感深度审计手动入口——后端 POST /pleasure/audit 早已存在（自动创作中逐章触发），
  // 但此前前端零入口：想对最近章单独重审（情绪标签/兑现标记/问题反哺）只能等自动创作。
  const auditBody = el('div', { class: 'small', style: 'margin-top:8px' });
  const lastDone = (book.chapters || []).filter(c => c.status === 'done' || c.status === 'settled').sort((a, b) => b.idx - a.idx)[0];
  view.append(el('div', { class: 'card', style: 'padding:12px 16px' },
    el('div', { class: 'row-between' },
      el('span', { class: 'small muted', text: lastDone ? `深度审计：对最近完成章（第${lastDone.idx}章）重跑读者心理审计——情绪标签、期待兑现标记、问题反哺约束` : '深度审计：暂无完成章可审计' }),
      el('button', {
        class: 'btn small ghost', text: '🧪 深度审计最近章', disabled: !lastDone,
        onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true; b.textContent = '审计中…（走 LLM，约 1-2 分钟）';
          try {
            const r = await post(`/api/books/${book.id}/pleasure/audit`, { chapterId: lastDone.id });
            auditBody.innerHTML = '';
            if (!r.ok) throw new Error(r.error || '审计失败');
            const a = r.audit || {};
            // V0.96.1：hook 强度字段是 intensity（pleasureAuditInstruction schema 单一真源）；
            // 原生 append 不跳过 null（会渲染字面 "null"）——条件子节点 filter(Boolean)
            auditBody.append(...[
              el('div', { text: `情绪：${a.emotion?.type || '?'} ${a.emotion?.intensity ?? '?'}/10 · 主体性：${a.agency_ratio || '-'} · 章末钩子：${a.hook?.present ? `${a.hook?.type || '?'}（强度 ${a.hook?.intensity ?? '?'}/5${a.hook?.desc ? '——' + String(a.hook.desc).slice(0, 40) : ''}）` : '无钩子'}` }),
              r.paid?.length ? el('div', { class: 'ok-text', text: `已兑现期待 ${r.paid.length} 条：${r.paid.join('；').slice(0, 200)}` }) : null,
              r.constraints?.length
                ? el('div', { class: 'warn-text', text: `反哺约束 ${r.constraints.length} 条：${r.constraints.map(i => i.detail).slice(0, 3).join('；')}` })
                : el('div', { class: 'muted', text: '无 high/medium 问题' }),
            ].filter(Boolean));
            toast('快感审计完成', 'success');
            b.textContent = '🧪 深度审计最近章';
          } catch (e) { toast(e.message, 'error'); b.textContent = '🧪 深度审计最近章'; }
          b.disabled = false;
        },
      }),
    ),
    auditBody,
  ));

  // 情绪张力曲线（最近 10 章）
  const curve = el('div', { class: 'card' },
    el('h3', { text: '情绪张力曲线（最近章节）' }),
  );
  if (!emotions.length) curve.append(el('div', { class: 'muted', text: '暂无数据——写几章后自动生成。' }));
  else {
    curve.append(el('div', { class: 'emotion-bar' }, ...emotions.map(e => {
      const bar = el('div', { class: 'emotion-cell', title: `第${e.chapter}章 ${e.type}${e.intensity}` },
        el('div', { class: 'emotion-dot', style: `height:${Math.max(8, e.intensity * 10)}%` }),
        el('div', { class: 'small muted', text: `${e.type}${e.intensity}` }),
      );
      if (e.intensity >= 7) bar.classList.add('hot');
      return bar;
    })));
  }
  view.append(curve);

  // 期待账本
  const hookCard = el('div', { class: 'card' },
    el('div', { class: 'row-between' },
      el('h3', { text: '期待-满足账本' }),
      el('details', { class: 'fold' },
        el('summary', {}, '登记期待（专家）'),
        el('button', { class: 'sm mt', text: '+ 登记期待', onclick: () => addHookModal(book, () => renderPleasure(view, book)) }),
      ),
    ),
  );
  if (!hooks.list.length) hookCard.append(el('div', { class: 'muted', text: '暂无登记——章细纲的 new_hooks/ending_hook 会自动登记。' }));
  else {
    hookCard.append(el('table', {},
      el('thead', {}, el('tr', {}, el('th', { text: '期待' }), el('th', { text: '类型' }), el('th', { text: '强度' }), el('th', { text: '埋设' }), el('th', { text: '计划兑现' }), el('th', { text: '状态' }), el('th', { text: '操作' }))),
      el('tbody', {}, ...hooks.list.map(h =>
        el('tr', {},
          el('td', { text: h.desc }),
          el('td', { text: `${KIND[h.kind] || h.kind}·${h.type}` }),
          el('td', { text: '●'.repeat(h.intensity || 0) || '-' }),
          el('td', { text: `第${h.planted_chapter}章` }),
          el('td', { text: h.due_chapter ? `第${h.due_chapter}章` : '-' }),
          el('td', { class: h.status === 'expired' ? 'warn' : h.status === 'paid' ? 'ok' : '', text: STATUS[h.status] || h.status }),
          el('td', { class: 'row-gap' },
            h.status !== 'paid' ? el('button', { class: 'btn small ghost', text: '兑现', onclick: async () => { await patch(`/api/books/${book.id}/hooks/${h.id}`, { status: 'paid', note: '手动标记' }); renderPleasure(view, book); } }) : null,
            el('button', { class: 'btn small ghost danger', text: '删', onclick: async () => { await del(`/api/books/${book.id}/hooks/${h.id}`); renderPleasure(view, book); } }),
          ),
        ),
      )),
    ));
  }
  view.append(hookCard);

  // 并行弧线
  const arcCard = el('div', { class: 'card' },
    el('div', { class: 'row-between' },
      el('h3', { text: '并行叙事弧线' }),
      el('details', { class: 'fold' },
        el('summary', {}, '新建弧线（专家）'),
        el('button', { class: 'sm mt', text: '+ 新建弧线', onclick: () => addArcModal(book, () => renderPleasure(view, book)) }),
      ),
    ),
  );
  if (!arcs.list.length) arcCard.append(el('div', { class: 'muted', text: '暂无弧线。' }));
  else {
    arcCard.append(el('table', {},
      el('thead', {}, el('tr', {}, el('th', { text: '弧线' }), el('th', { text: '类型' }), el('th', { text: '状态' }), el('th', { text: '开启' }), el('th', { text: '上次活动' }), el('th', { text: '操作' }))),
      el('tbody', {}, ...arcs.list.map(a =>
        el('tr', {},
          el('td', { text: a.name }),
          el('td', { text: a.type }),
          el('td', { text: a.status === 'open' ? '进行中' : (a.status === 'closed' ? '已闭合' : a.status) }),
          el('td', { text: a.opened_chapter ? `第${a.opened_chapter}章` : '-' }),
          el('td', { text: a.last_active_chapter ? `第${a.last_active_chapter}章` : '-' }),
          el('td', { class: 'row-gap' },
            a.status !== 'closed' ? el('button', { class: 'btn small ghost', text: '闭合', onclick: async () => { await patch(`/api/books/${book.id}/arcs/${a.id}`, { status: 'closed' }); renderPleasure(view, book); } }) : null,
            el('button', { class: 'btn small ghost danger', text: '删', onclick: async () => { await del(`/api/books/${book.id}/arcs/${a.id}`); renderPleasure(view, book); } }),
          ),
        ),
      )),
    ));
  }
  view.append(arcCard);

  // 节奏问题（自动约束已注入后续写作）
  const issueCard = el('div', { class: 'card' },
    el('h3', { text: '节奏健康检查' }),
  );
  if (!rhythmIssues.length) issueCard.append(el('div', { class: 'ok', text: '节奏健康：无连续疲劳/寡淡/无钩/超期问题。' }));
  else {
    for (const rule of rhythmIssues) issueCard.append(el('div', { class: 'warn-line', text: `${rule}` }));
    issueCard.append(el('div', { class: 'muted small', text: '以上规则已自动注入后续章节写作指令（【快感节奏】约束），无需手工处理。' }));
  }
  view.append(issueCard);
}

function kpi(label, value, sub) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label', text: label }),
    el('div', { class: 'kpi-value', text: value }),
    sub ? el('div', { class: 'kpi-sub muted', text: sub }) : null,
  );
}

function addHookModal(book, refresh) {
  const descInput = el('input', { placeholder: '如：苏晚的真实身份之谜', style: 'width:100%' });
  const typeSel = el('select', { style: 'width:100%' }, ...[
    ['short', '短期待（1-2章兑现）'], ['medium', '中期待（3-5章）'], ['long', '长期待（10-20章）'], ['super', '超级期待（贯穿全书）'],
  ].map(([v, t]) => el('option', { value: v, text: t })));
  const intInput = el('input', { type: 'number', min: 1, max: 5, value: 3, style: 'width:100%' });
  const body = el('div', {},
    el('label', { text: '描述' }), descInput,
    el('label', { text: '类型' }), typeSel,
    el('label', { text: '强度（1-5）' }), intInput,
  );
  let modal;
  modal = openModal({
    title: '登记期待（钩子）',
    body,
    actions: [
      el('button', { class: 'primary', text: '登记', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          await post(`/api/books/${book.id}/hooks`, {
            desc: descInput.value,
            kind: typeSel.value,
            intensity: Number(intInput.value) || 3,
            plantedChapter: 0,
          });
          modal.close(true);
          await refresh();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } }),
      el('button', { text: '取消', onclick: () => modal.close(false) }),
    ],
  });
  descInput.focus();
}

function addArcModal(book, refresh) {
  const nameInput = el('input', { placeholder: '如：玉佩之谜', style: 'width:100%' });
  const typeSel = el('select', { style: 'width:100%' }, ...['主线', '支线', '感情线', '暗线'].map(t => el('option', { value: t, text: t })));
  const body = el('div', {},
    el('label', { text: '名称' }), nameInput,
    el('label', { text: '类型' }), typeSel,
  );
  let modal;
  modal = openModal({
    title: '新建叙事弧线',
    body,
    actions: [
      el('button', { class: 'primary', text: '创建', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          await post(`/api/books/${book.id}/arcs`, { name: nameInput.value, type: typeSel.value });
          modal.close(true);
          await refresh();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } }),
      el('button', { text: '取消', onclick: () => modal.close(false) }),
    ],
  });
  nameInput.focus();
}
