// web/js/views/roster.js —— V0.50 角色库：工牌式卡片（分级/性格/目标/秘密/弧线/心境/关系/能力）
// AI 本位：自动整理按钮（tidy）补全缺失维度与分级；人可手动编辑/新增/删除
'use strict';
import { get, post, patch, del } from '../api.js';
import { el, toast, confirmDialog, safeJsonParse, pageHead, progressCard, openModal } from '../ui.js';
import { refreshBook, rerender } from '../app.js';

const TIER_META = {
  protagonist: { label: '主角', cls: 'tier-protagonist' },
  major: { label: '主要配角', cls: 'tier-major' },
  minor: { label: '次要配角', cls: 'tier-minor' },
  extra: { label: '龙套', cls: 'tier-extra' },
};
const TIER_ORDER = ['protagonist', 'major', 'minor', 'extra'];

export async function renderRoster(view, book) {
  view.append(pageHead('icon:users:角色库', `《${book.title || '未命名'}》· 角色工牌——分级/性格/目标/秘密/弧线/心境/关系/能力`));
  const chars = await get(`/api/books/${book.id}/characters`);

  // ---- 统计条 ----
  const count = (t) => chars.filter(c => (c.tier || 'minor') === t).length;
  const stats = el('div', { class: 'row mb wrap' },
    el('span', { class: 'badge', style: 'background:var(--gold);color:#fff' }, `主角 ${count('protagonist')}`),
    el('span', { class: 'badge', style: 'background:var(--blue);color:#fff' }, `主要配角 ${count('major')}`),
    el('span', { class: 'badge', style: 'background:var(--green);color:#fff' }, `次要配角 ${count('minor')}`),
    el('span', { class: 'badge' }, `龙套 ${count('extra')}`),
    el('span', { class: 'small muted' }, `共 ${chars.length} 人`),
    el('span', { class: 'grow' }),
    el('details', { class: 'fold' },
      el('summary', {}, '新增 / 整理（专家）'),
      el('div', { class: 'row mt' },
    el('button', { class: 'sm', text: '⚡ AI 全书整理', onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      const prog = progressCard('AI 全书整理中（待登记→角色库→事实库，各司其职）…');
      ev.currentTarget.parentElement.append(prog.card);
      try {
        const r = await post(`/api/books/${book.id}/tidy-all`, {});
        prog.setMessage('整理完成');
        (r.notes || []).forEach(n => toast(n, 'info', 5000));
        await refreshBook(); rerender();
      } catch (e) { prog.setMessage('整理失败：' + e.message); toast(e.message, 'error'); btn.disabled = false; }
    } }),
    el('button', { class: 'sm', text: '＋ 新增角色', onclick: () => grid.append(renderEditor(book, null, grid)) }),
    // V0.82：AI 取名（历史题材自动带朝代命名/避讳规则）
    el('button', { class: 'sm ghost', text: '✒️ AI 取名', onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '取名中…';
      try {
        const r = await post(`/api/books/${book.id}/characters/name`, { count: 6 });
        if (!r.ok) { toast(r.error || '取名失败', 'error'); return; }
        const used = new Set(chars.map(c => c.name));
        const fresh = (r.names || []).filter(n => !used.has(n));
        if (!fresh.length) { toast('已生成的名字全部与现有角色重名，请重试', 'warn'); return; }
        const pickerModal = openModal({
          title: 'AI 取名候选（点击即填入新增角色编辑器）',
          body: el('div', { class: 'col' }, ...fresh.map(name => {
            const picker = el('div', { class: 'preset-card', onclick: () => { pickerModal.close(true); grid.append(renderEditor(book, null, grid, name)); } },
              el('div', { class: 'preset-title', text: name }));
            return picker;
          })),
          actions: [el('button', { text: '关闭', onclick: () => pickerModal.close(false) })],
        });
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false; btn.textContent = '✒️ AI 取名';
    } }),
      ),
    ),
  );
  view.append(stats);

  // ---- 工牌网格 ----
  const grid = el('div', { class: 'roster-grid' });
  const sorted = [...chars].sort((a, b) => {
    const ta = TIER_ORDER.indexOf(a.tier || 'minor'), tb = TIER_ORDER.indexOf(b.tier || 'minor');
    return ta - tb || ((a.name || '').localeCompare(b.name || '', 'zh'));
  });
  if (!sorted.length) grid.append(el('div', { class: 'muted', text: '还没有角色。开始自动创作后，结算会自动抽取新角色；也可手动新增。' }));
  for (const c of sorted) grid.append(renderBadge(book, c, grid));
  view.append(grid);
}

// ---- 工牌卡 ----
function renderBadge(book, c, grid) {
  const meta = TIER_META[c.tier] || TIER_META.minor;
  const st = c.state || {};
  const bits = [];
  if (c.role) bits.push(`身份 ${c.role}`); // V0.96：card.role 身份单源，前端可见（与 AI 注入同源）
  if (c.personality) bits.push(`性格 ${c.personality}`);
  if (c.speech) bits.push(`说话 ${c.speech}`);
  if (c.speechForbid) bits.push(`禁腔 ${c.speechForbid}`);
  if (c.goal) bits.push(`目标 ${c.goal}`);
  if (c.fear) bits.push(`软肋 ${c.fear}`);
  if (c.secret) bits.push(`秘密 ${c.secret}`);
  if (c.relation) bits.push(`关系 ${c.relation}`);
  const stateLine = [];
  if (st['位置']) stateLine.push(`📍${st['位置']}`);
  if (st['实力'] || st['境界']) stateLine.push(`⚔️${st['实力'] || st['境界']}`);
  if (st['心境']) stateLine.push(`💭${st['心境']}`);
  const abilities = Array.isArray(c.abilities) ? c.abilities : [];
  const abiText = abilities.length ? `🎒 ${abilities.map(a => a.name || a).join('、')}` : '';

  const card = el('div', { class: 'card roster-badge' + (c.deceased ? ' deceased' : '') },
    el('div', { class: 'row' },
      el('div', { class: 'roster-avatar', style: `background:${avatarColor(c.name)}` }, el('span', { text: (c.name || '?')[0] })),
      el('div', { class: 'grow' },
        el('div', { class: 'row' },
          el('strong', { text: c.name || '无名' }),
          el('span', { class: `tier-badge ${meta.cls}`, text: meta.label }),
          c.deceased ? el('span', { class: 'tier-badge tier-dead', text: `☠️ 退场${c.deathChapter ? '·' + c.deathChapter + '章' : ''}` }) : null,
        ),
        el('div', { class: 'small muted', text: stateLine.join('　') || '（暂无状态）' }),
      ),
    ),
    bits.length ? el('div', { class: 'small mt', text: bits.join('；') }) : el('div', { class: 'small muted mt', text: '（待完善，可点编辑或 AI 自动整理）' }),
    c.arc ? el('div', { class: 'small mt arc-line', text: `🔄 ${c.arc}` }) : null,
    abiText ? el('div', { class: 'small mt', text: abiText }) : null,
    c.exitNote ? el('div', { class: 'small mt muted', text: `🚪 ${c.exitNote}` }) : null,
    el('div', { class: 'row mt' },
      el('button', { class: 'sm', text: '编辑', onclick: () => card.replaceWith(renderEditor(book, c, grid)) }),
      el('button', { class: 'sm ghost', text: '删除', onclick: async () => {
        if (!await confirmDialog('删除角色？', `将移除「${c.name}」的角色卡（历史正文不受影响）。`)) return;
        await del(`/api/books/${book.id}/characters/${c.id}`);
        toast('已删除'); rerender();
      } }),
    ),
  );
  return card;
}

// ---- 编辑/新增表单 ----
function renderEditor(book, c, grid, presetName = '') {
  const isNew = !c;
  const v = (k, fb = '') => (c ? (c[k] ?? fb) : fb);
  const nameIn = el('input', { placeholder: '角色名', value: presetName || v('name') });
  const tierSel = el('select');
  for (const [t, m] of Object.entries(TIER_META)) tierSel.append(el('option', { value: t, text: m.label, selected: v('tier', 'minor') === t }));
  // 字段输入控件（保存引用便于收集）
  const inputs = {};
  const fieldDefs = [
    ['role', '身份（如：合州知州/料石队工头）'], // V0.96：card.role 身份单源，可编辑
    ['personality', '性格（含缺陷）'],
    ['speech', '说话方式（句长/用词层/答法，写机制不要写可抄的例句）'],
    ['speechForbid', '禁腔（用 | 分隔）'],
    ['goal', '目标'],
    ['fear', '软肋/恐惧'],
    ['secret', '秘密'],
    ['arc', '成长弧线'],
    ['relation', '关系'],
  ];
  for (const [k, label] of fieldDefs) {
    inputs[k] = el('textarea', { style: 'min-height:44px', placeholder: label, text: v(k) });
  }
  const abiIn = el('textarea', { style: 'min-height:44px', placeholder: '能力/物品（每行一条：名称｜类型｜说明）', text: (v('abilities', [])).map(a => `${a.name || ''}｜${a.type || ''}｜${a.desc || ''}`).join('\n') });

  const wrap = el('div', { class: 'card roster-editor' },
    el('div', { class: 'row' }, nameIn, tierSel),
    ...fieldDefs.map(([k, label]) => el('div', {}, el('label', { class: 'small muted', text: label }), inputs[k])),
    el('div', {}, el('label', { class: 'small muted', text: '能力/物品（按书类型：技能/法宝/道具/功法/背包…）' }), abiIn),
    el('div', { class: 'row mt' },
      el('button', { class: 'sm primary', text: isNew ? '创建' : '保存', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const abilities = abiIn.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
          const [name, type = '', desc = ''] = l.split('｜');
          return { name: name.trim(), type: type.trim(), desc: desc.trim() };
        });
        const body = { name: nameIn.value.trim(), tier: tierSel.value, abilities };
        for (const [k] of fieldDefs) body[k] = inputs[k].value.trim();
        try {
          if (isNew) await post(`/api/books/${book.id}/characters`, body);
          else await patch(`/api/books/${book.id}/characters/${c.id}`, body);
          toast(isNew ? '已创建' : '已保存');
          rerender();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } }),
      el('button', { class: 'sm', text: '取消', onclick: () => { if (isNew) wrap.remove(); else wrap.replaceWith(renderBadge(book, c, grid)); } }),
    ),
  );
  return wrap;
}

// ---- 工具 ----
function avatarColor(name) {
  // V0.94 书卷色板：赭红/赭金/竹绿/花青/青黛/褐金/砖红/橄榄/陶赭/豆沙（全暖+墨系，无紫）
  const palette = ['#a8432f', '#a05e1c', '#47714a', '#3d6484', '#4a7a8c', '#7a5c3a', '#8c4a3c', '#5d705a', '#8a5a4a', '#96684a'];
  let h = 0;
  for (const ch of (name || '?')) h = (h * 31 + ch.codePointAt(0)) % 997;
  return palette[h % palette.length];
}
