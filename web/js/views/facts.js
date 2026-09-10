// web/js/views/facts.js —— 事实库 + 时间线 + 冲突 + 待登记
'use strict';
import { get, post } from '../api.js';
import { el, toast, fmt, pageHead } from '../ui.js';
import { rerender } from '../app.js';

export async function renderFacts(view, book) {
  const facts = await get(`/api/books/${book.id}/facts`);
  const timeline = book.timeline || [];
  const conflicts = book.conflicts || [];
  const pending = book.pending || [];

  view.append(pageHead('icon:fileText:事实库', `《${book.title || '未命名'}》·事实由「章结算」自动抽取，是幻觉控制的锚：写作指令只注入 active 事实`));

  // 冲突
  if (conflicts.length) {
    const open = conflicts.filter(c => c.resolution === 'open');
    if (open.length) {
      view.append(el('div', { class: 'card', style: 'border-color:var(--red)' },
        el('h3', { text: `未裁决冲突（${open.length}）` }),
        ...open.map(c =>
          el('div', { class: 'issue high', style: 'background:none' },
            el('div', {}, el('span', { class: 'tag high', text: c.type }), el('span', { class: 'small muted', text: ` 第${c.chapter_idx ?? c.chapter_id ?? '?'}章` })),
            el('div', { class: 'mt', text: c.issue }),
            c.quote ? el('div', { class: 'q', text: `「${c.quote}」` }) : null,
            el('div', { class: 'row mt' },
              el('details', { class: 'fold' },
                el('summary', {}, '裁决（专家）'),
                el('div', { class: 'row mt' },
                  el('button', { class: 'sm', text: '接受（新事实有效）', onclick: async () => {
                    await post(`/api/books/${book.id}/conflicts/${c.id}/resolve`, { resolution: 'accepted' });
                    rerender();
                  } }),
                  el('button', { class: 'sm ghost', text: '忽略', onclick: async () => {
                    await post(`/api/books/${book.id}/conflicts/${c.id}/resolve`, { resolution: 'rejected' });
                    rerender();
                  } }),
                ),
              ),
            ),
          ),
        ),
      ));
    }
  }

  // 待登记（V0.40：自动整理——类型推断建卡/去重/超期归档；保留手动确认出口）
  view.append(el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', text: pending.length ? `待登记新设定（${pending.length}）` : '待登记新设定' }),
      el('button', { class: 'sm', text: '⚡ 自动整理', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const r = await post(`/api/books/${book.id}/pending/tidy`, {});
          toast(`整理完成：登记 ${r.confirmed || 0} 项、归档 ${r.archived || 0} 项、迁移 ${r.migrated || 0} 项`);
          rerender();
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
    ),
    el('div', { class: 'small muted mb', text: '每章结算后自动整理：能归类的地点/物品/势力/角色自动建卡，多章未再出现的弱信号自动归档；无法归类的概念类保留在此观察（再次出现会自动处理）。' }),
    ...(pending.length
      ? pending.map(p =>
        el('div', { class: 'row mb' },
          el('strong', { text: p.name }),
          el('span', { class: 'tag low', text: `第${p.source_chapter ?? '?'}章` }),
          el('span', { class: 'small muted grow', text: p.context }),
          el('button', { class: 'sm', text: '确认', onclick: async () => {
            await post(`/api/books/${book.id}/pending/${p.id}/resolve`, { status: 'confirmed' });
            rerender();
          } }),
          el('button', { class: 'sm ghost', text: '忽略', onclick: async () => {
            await post(`/api/books/${book.id}/pending/${p.id}/resolve`, { status: 'rejected' });
            rerender();
          } }),
        ),
      )
      : el('div', { class: 'muted', text: '暂无待登记——新出现且无法归类的设定会出现在这里，并随章节自动整理。' })),
  ));

  // 事实表
  const card = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', text: `事实（${facts.length}）` }),
      el('span', { class: 'small muted', text: 'subject / predicate / object' }),
    ),
  );
  if (!facts.length) card.append(el('div', { class: 'muted', text: '暂无事实。自动创作结算后会抽取；无需手点结算。' }));
  else {
    card.append(el('table', {},
      el('thead', {}, el('tr', {}, el('th', { text: '事实' }), el('th', { text: '来源章' }), el('th', { text: '状态' }), el('th', { text: '备注' }))),
      el('tbody', {}, ...facts.map(f =>
        el('tr', {},
          el('td', { text: `${f.subject} ${f.predicate} ${f.object}` }),
          el('td', { class: 'muted', text: f.source_chapter ? `第${f.source_chapter}章` : '—' }),
          el('td', {}, el('span', { class: 'tag ' + (f.status === 'active' ? 'done' : 'low'), text: f.status === 'active' ? '有效' : (f.status === 'superseded' ? '已取代' : f.status) })),
          el('td', { class: 'small muted', text: f.note || '' }),
        ),
      )),
    ));
  }
  view.append(card);

  // 时间线
  const tl = el('div', { class: 'card' },
    el('h3', { text: `时间线（${timeline.length}）` }),
  );
  if (!timeline.length) tl.append(el('div', { class: 'muted', text: '暂无事件。' }));
  else {
    tl.append(el('ol', {}, ...timeline.map(t => {
      const stamp = [t.era_year, t.year ? `${t.year}年` : '', t.season].filter(Boolean).join(' · ');
      return el('li', { class: 'mb small', text: stamp ? `${stamp}　${t.event}` : t.event });
    })));
  }
  view.append(tl);
}
