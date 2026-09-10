// web/js/views/world.js —— 设定：公共材料（世界观/人物卡）+ 世界书条目
'use strict';
import { get, post, patch, put, del, sse } from '../api.js';
import { el, toast, confirmDialog, icon, safeJsonParse, pageHead, progressCard } from '../ui.js';
import { refreshBook, rerender } from '../app.js';

const MATERIAL_KINDS = [
  ['world', '世界观设定', '力量体系、地理、历史、规则…'],
  ['outline', '书级大纲', '由「大纲」页生成，也可手写'],
];

export async function renderWorld(view, book) {
  const mats = await get(`/api/books/${book.id}/public-materials`);
  view.append(pageHead('icon:globe:设定', `《${book.title || '未命名'}》·公共材料是写作上下文的固定前缀；世界书按关键词触发注入`));

  // V0.28：设定全自动（AI 一键生成世界观/人物卡/地点/物品/势力/世界书词条）
  const hasWorld = mats.some(m => m.kind === 'world' && m.content);
  if (!hasWorld) {
    const autoCard = el('div', { class: 'card auto-settings' },
      el('h3', { text: '自动生成设定（推荐）' }),
      el('div', { class: 'small muted mb', text: 'AI 根据书契约与书级大纲，一键生成世界观详设、人物卡、地点、物品、势力与世界书词条——随后即可直接进入自动创作。' }),
      el('button', { class: 'primary', text: '开始自动生成设定', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const prog = progressCard('正在生成设定…');
        autoCard.append(prog.card);
        try {
          const r = await sse(`/api/books/${book.id}/settings/generate`, {}, (event, data) => {
            if (event === 'stage') prog.setMessage(data.message);
          });
          if (r.ok) {
            prog.setMessage('设定生成完成');
            toast('设定已生成');
            await refreshBook();
            rerender();
          } else { prog.setMessage('生成失败：' + (r.error || '未知错误')); toast(r.error || '生成失败', 'error'); }
        } catch (e) { prog.setMessage('生成失败：' + e.message); toast(e.message, 'error'); btn.disabled = false; }
      } }),
    );
    view.append(autoCard);
  } else {
    view.append(el('div', { class: 'row mb' },
      el('details', { class: 'fold', style: 'width:100%' },
        el('summary', {}, '重新生成设定（会覆盖现有公共材料）'),
        el('button', { class: 'sm mt', text: '重新生成设定', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '重新生成中…';
        const prog = progressCard('正在重新生成设定…');
        ev.currentTarget.parentElement.append(prog.card);
        try {
          const r = await sse(`/api/books/${book.id}/settings/generate`, {}, (event, data) => {
            if (event === 'stage') prog.setMessage(data.message);
          });
          if (r.ok) { toast('设定已重新生成'); await refreshBook(); rerender(); }
          else { prog.setMessage('生成失败：' + (r.error || '未知错误')); toast(r.error || '生成失败', 'error'); btn.disabled = false; btn.textContent = '重新生成设定'; }
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '重新生成设定'; }
      } }),
      ),
    ));
  }

  for (const [kind, title, hint] of MATERIAL_KINDS) {
    const mat = mats.find(m => m.kind === kind);
    const card = el('div', { class: 'card' });
    const ta = el('textarea', { style: 'min-height:180px', text: mat?.content || '' });
    card.append(
      el('div', { class: 'row' },
        el('h3', { class: 'grow', text: title }),
        mat ? el('span', { class: 'small muted', text: `v${mat.version}` }) : null,
      ),
      el('div', { class: 'small muted mb', text: hint }),
      ta,
      el('div', { class: 'row mt' },
        el('button', { class: 'primary sm', text: '保存', onclick: async (ev) => {
          const btn = ev.currentTarget; btn.disabled = true;
          try {
            const r = await put(`/api/books/${book.id}/public-materials`, { kind, content: ta.value });
            toast(`已保存 v${r.version}。公共材料已更新，缓存前缀已重建（下一次请求将重新构建缓存）`, 'warn', 6000);
            await refreshBook();
          } catch (e) { toast(e.message, 'error'); }
          btn.disabled = false;
        } }),
        el('span', { class: 'small muted', text: '公共材料是写作上下文的固定前缀。修改后历史正文保留，但缓存命中将从零开始。' }),
      ),
    );
    view.append(card);
  }

  // ---- V0.49：角色卡展示区（characters 表：性格/目标/秘密/弧线/心境/关系） ----
  const charRows = await get(`/api/books/${book.id}/characters`);
  if (charRows.length) {
    const castCard = el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('h3', { class: 'grow', text: `角色卡（${charRows.length}）` }),
        el('span', { class: 'small muted', text: '写作时按场景注入：性格/说话方式/目标/秘密/心境/关系；命运线逐步兑现' }),
      ),
    );
    for (const c of charRows) {
      const bits = [];
      if (c.personality) bits.push(`性格：${c.personality}`);
      if (c.speech) bits.push(`说话：${c.speech}`);
      if (c.speechForbid) bits.push(`禁腔：${c.speechForbid}`);
      if (c.goal) bits.push(`目标：${c.goal}`);
      if (c.fear) bits.push(`软肋：${c.fear}`);
      if (c.secret) bits.push(`秘密：${c.secret}`);
      if (c.relation) bits.push(`关系：${c.relation}`);
      if (c.state && c.state['心境']) bits.push(`当前心境：${c.state['心境']}`);
      if (c.state && c.state['位置']) bits.push(`位置：${c.state['位置']}`);
      if (c.deceased) bits.push(`☠️ 已退场（第${c.deathChapter || '?'}章）`);
      castCard.append(el('div', { class: 'mt2', style: 'border-top:1px solid var(--border);padding-top:10px' },
        el('strong', { text: c.name }),
        c.arc ? el('div', { class: 'small', text: `弧线：${c.arc}` }) : null,
        el('div', { class: 'small muted', text: bits.join('；') || '（待完善）' }),
      ));
    }
    view.append(castCard);
  }

  // ---- 世界书 ----
  const wb = await get(`/api/books/${book.id}/worldbook`);
  const card = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', text: `世界书（${wb.length} 条）` }),
      el('span', { class: 'small muted', text: '关键词触发注入，用于写作时自动携带相关设定' }),
      el('button', { class: 'sm ghost', text: '＋ 新增条目', onclick: () => card.append(renderWorldbookEditor(book, null, card)) }),
    ),
  );
  if (!wb.length) card.append(el('div', { class: 'muted', text: '暂无条目。设置条目后，当正文场景涉及关键词时自动注入写作指令。' }));
  for (const w of wb) {
    const kws = safeJsonParse(w.keywords, []);
    card.append(
      el('div', { class: 'mt2', style: 'border-top:1px solid var(--border);padding-top:10px' },
        el('div', { class: 'row' },
          el('strong', { text: `${w.category || '通用'} · ${w.priority || 0}` }),
          el('span', { class: 'tag ' + (w.enabled ? 'done' : ''), text: w.enabled ? '启用' : '停用' }),
          el('span', { class: 'grow' }),
          el('button', { class: 'sm ghost', text: '编辑', onclick: () => {
            // V0.20 修复：先移除已有编辑器再打开，防止重复点击堆叠
            card.querySelectorAll('.wb-editor').forEach(n => n.remove());
            card.append(renderWorldbookEditor(book, w, card));
          } }),
          el('button', { class: 'sm ghost danger', text: '删除', onclick: async () => {
            if (!await confirmDialog('删除条目？', w.content.slice(0, 40))) return;
            await del(`/api/books/${book.id}/worldbook/${w.id}`);
            rerender();
          } }),
        ),
        el('div', { class: 'small muted', text: `关键词：${kws.join('、') || '（常驻）'}` }),
        el('div', { class: 'small mt', text: w.content }),
      ),
    );
  }
  view.append(card);

  // ---- 待登记设定 ----
  const pending = book.pending || [];
  if (pending.length) {
    const pc = el('div', { class: 'card' },
      el('h3', { text: `待登记新设定（${pending.length}）` }),
      el('div', { class: 'small muted mb', text: '正文中出现但未登记的专有名词，确认后请加入世界书或人物卡' }),
      ...pending.map(p =>
        el('div', { class: 'row mb' },
          el('strong', { text: p.name }),
          el('span', { class: 'small muted grow', text: p.context || '' }),
          el('button', { class: 'sm', text: '加入世界书', onclick: async () => {
            await post(`/api/books/${book.id}/worldbook`, { keywords: [p.name], content: `${p.name}：${p.context || '（待补充）'}`, category: '待确认', priority: 0 });
            await post(`/api/books/${book.id}/pending/${p.id}/resolve`, { status: 'confirmed' });
            toast(`已将「${p.name}」加入世界书`);
            rerender();
          } }),
          el('button', { class: 'sm ghost', text: '忽略', onclick: async () => {
            await post(`/api/books/${book.id}/pending/${p.id}/resolve`, { status: 'rejected' });
            rerender();
          } }),
        ),
      ),
    );
    view.append(pc);
  }

  // V0.71：地点库（自动创作中随剧情整理；地点稳定，除非重大事件否则不变）
  // V0.82：增/删/改编辑 UI + 历史题材行政层级/战略属性展示
  try {
    const locs = await get(`/api/books/${book.id}/locations`);
    // 先建 grid（供新增/编辑 onclick 闭包引用）
    const grid = el('div', { class: 'grid2' });
    const locCard = el('div', { class: 'card' },
      el('div', { class: 'split mb' },
        el('h3', { style: 'margin:0', text: `地点库（${locs.length}）` }),
        el('div', { class: 'row', style: 'gap:8px' },
          el('button', { class: 'sm ghost', text: '＋ 新增地点', onclick: () => grid.append(renderLocEditor(book, null, grid)) }),
          el('button', { class: 'sm ghost', text: '🧹 AI 整理地点', onclick: async (ev) => {
            const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '整理中…';
            try { const r = await post(`/api/books/${book.id}/locations/tidy`, {}); toast(r.note || '整理完成'); rerender(); }
            catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '🧹 AI 整理地点'; }
          } }),
        ),
      ),
      el('div', { class: 'small muted mb', text: '自动创作中按世界观/卷/章剧情自动整理；写作时按场景地点注入类型/描述/状态。（历史题材：行政层级=路/州/县/寨/堡，战略属性=三江汇流/锁江天堑等）' }),
      grid,
    );
    if (locs.length) {
      for (const l of locs) {
        const tag = l.status && l.status !== 'normal'
          ? el('span', { class: 'tag warn', text: l.status === 'changed' ? '已变化' : (l.status === 'destroyed' ? '已毁' : l.status) })
          : (l.stable === false ? el('span', { class: 'tag', text: '易变' }) : null);
        const chip = el('div', { class: 'loc-chip' },
          el('div', { class: 'row', style: 'gap:6px;align-items:center' },
            el('strong', { text: l.name }), tag,
            l.kind ? el('span', { class: 'small muted', text: l.kind }) : null,
            el('span', { class: 'grow' }),
            el('button', { class: 'sm ghost', text: '改', onclick: () => chip.replaceWith(renderLocEditor(book, l, grid)) }),
            el('button', { class: 'sm ghost', text: '删', onclick: async () => {
              if (!await confirmDialog('删除地点？', `将移除地点「${l.name}」（历史正文不受影响）。`)) return;
              await del(`/api/books/${book.id}/locations/${l.id}`);
              toast('已删除'); rerender();
            } }),
          ),
          l.admin_level ? el('div', { class: 'small', text: `🗺 ${l.admin_level}${l.strategic ? `｜战略：${l.strategic}` : ''}` }) : null,
          l.desc ? el('div', { class: 'small', text: l.desc }) : null,
          l.note ? el('div', { class: 'small muted', text: l.note }) : null,
        );
        grid.append(chip);
      }
    } else {
      grid.append(el('div', { class: 'muted', text: '暂无地点（自动创作中自动登记）' }));
    }
    view.append(locCard);
  } catch { /* 地点库不可用则跳过 */ }

  try {
    const [items, factions] = await Promise.all([
      get(`/api/books/${book.id}/items`).catch(() => []),
      get(`/api/books/${book.id}/factions`).catch(() => []),
    ]);
    if (items.length || factions.length) {
      const entityCard = el('div', { class: 'card' },
        el('h3', { text: '物品与势力（只读观察）' }),
        el('div', { class: 'small muted mb', text: '自动创作结算时登记；写作时按场景提及注入。' }),
      );
      if (items.length) {
        entityCard.append(el('div', { class: 'small mb', text: '物品：' + items.map(i => i.name).join('、') }));
      }
      if (factions.length) {
        entityCard.append(el('div', { class: 'small mb', text: '势力：' + factions.map(i => i.name).join('、') }));
      }
      view.append(entityCard);
    }
  } catch { /* ignore */ }
}

// V0.82：地点库编辑/新增表单（kind/desc/行政层级/战略属性/状态）
function renderLocEditor(book, l, grid) {
  const isNew = !l;
  const nameIn = el('input', { placeholder: '地点名', value: l?.name || '' });
  const kindIn = el('input', { placeholder: '类型（城镇/山/城/关隘…）', value: l?.kind || '' });
  const adminIn = el('input', { placeholder: '行政层级（历史题材：路/州/县/寨/堡…）', value: l?.admin_level || '' });
  const strIn = el('input', { placeholder: '战略属性（历史题材：三江汇流/锁江天堑…）', value: l?.strategic || '' });
  const descIn = el('textarea', { style: 'min-height:52px', placeholder: '一句话描述（地理位置/氛围/作用）', text: l?.desc || '' });
  const wrap = el('div', { class: 'loc-chip', style: 'background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:10px' },
    el('div', {}, el('label', { class: 'small muted', text: '地点名' }), nameIn),
    el('div', { class: 'split mt' },
      el('div', {}, el('label', { class: 'small muted', text: '类型' }), kindIn),
      el('div', {}, el('label', { class: 'small muted', text: '行政层级' }), adminIn),
    ),
    el('div', { class: 'mt' }, el('label', { class: 'small muted', text: '战略属性' }), strIn),
    el('div', { class: 'mt' }, el('label', { class: 'small muted', text: '描述' }), descIn),
    el('div', { class: 'row mt' },
      el('button', { class: 'sm primary', text: isNew ? '创建' : '保存', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const body = { name: nameIn.value.trim(), kind: kindIn.value.trim(), desc: descIn.value.trim(), admin_level: adminIn.value.trim(), strategic: strIn.value.trim() };
        try {
          if (isNew) await post(`/api/books/${book.id}/locations`, body);
          else await patch(`/api/books/${book.id}/locations/${l.id}`, body);
          toast(isNew ? '已创建' : '已保存');
          rerender();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } }),
      el('button', { class: 'sm', text: '取消', onclick: () => { if (isNew) wrap.remove(); else rerender(); } }),
    ),
  );
  return wrap;
}

function renderWorldbookEditor(book, w, card) {
  const isNew = !w;
  const kwInput = el('input', { type: 'text', placeholder: '关键词，逗号分隔（留空=常驻）', value: w ? safeJsonParse(w.keywords, []).join(', ') : '' });
  const catInput = el('input', { type: 'text', placeholder: '分类（如：物品/地点/人物）', value: w?.category || '通用' });
  const priInput = el('input', { type: 'number', placeholder: '优先级（高者先注入）', value: w?.priority || 0 });
  const contentTa = el('textarea', { style: 'min-height:120px', placeholder: '条目内容：设定描述，写作时自动注入', text: w?.content || '' });
  const wrap = el('div', { class: 'mt', style: 'background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:14px' },
    el('div', { class: 'split' },
      el('div', {}, el('label', { text: '关键词' }), kwInput, el('label', { text: '分类' }), catInput, el('label', { text: '优先级' }), priInput),
      el('div', {}, el('label', { text: '内容' }), contentTa),
    ),
    el('div', { class: 'row mt' },
      el('button', { class: 'sm primary', text: isNew ? '创建' : '保存', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const kws = kwInput.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        try {
          if (isNew) await post(`/api/books/${book.id}/worldbook`, { keywords: kws, content: contentTa.value, category: catInput.value, priority: parseInt(priInput.value) || 0 });
          else await patch(`/api/books/${book.id}/worldbook/${w.id}`, { keywords: kws, content: contentTa.value, category: catInput.value, priority: parseInt(priInput.value) || 0 });
          toast(isNew ? '已创建' : '已保存');
          rerender();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } }),
      el('button', { class: 'sm', text: '取消', onclick: () => wrap.remove() }),
    ),
  );
  return wrap;
}
