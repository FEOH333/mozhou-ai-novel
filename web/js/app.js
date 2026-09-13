// web/js/app.js —— 应用入口：hash 路由、全局状态、导航
// V0.25：导航高亮修复 / 视图切换加载态 / rerender 替代整页刷新 / 主题切换
'use strict';
import { get, writeApi } from './api.js';
import { el, icon, fmtMoney, fmtPct, pageLoading, emptyState, getTheme, toggleTheme, toast } from './ui.js';
import { renderLibrary } from './views/library.js';
import { renderWorkshop } from './views/workshop.js';
import { renderOutline } from './views/outline.js';
import { renderWorld } from './views/world.js';
import { renderRoster } from './views/roster.js'; // V0.50 角色库
import { renderForeshadows } from './views/foreshadows.js';
import { renderPleasure } from './views/pleasure.js';
import { renderFacts } from './views/facts.js';
import { renderCosts } from './views/costs.js';
import { renderSettings } from './views/settings.js';
import { renderChangelog } from './views/changelog.js'; // 更新日志（只读观察面）
import { registerAbortController, unregisterAbortController, abortAllControllers } from './sse-registry.js';
import { chapterIdxFromEvent } from './pilot-observe.js';

export const state = {
  books: [],
  book: null,       // 当前书详情
  settings: null,
  costs: null,      // 全局成本聚合
  route: null,      // {name, params}
  _activeSSE: new Set(), // 页面内可能并行的 SSE 控制器
};

export function lastBookId() {
  try { return state.book?.id || localStorage.getItem('mozhou-last-book-id'); } catch { return state.book?.id || null; }
}

export function setBook(book) {
  state.book = book;
  if (book?.id) {
    try { localStorage.setItem('mozhou-last-book-id', book.id); } catch { /* ignore */ }
  }
}

export function registerSSE() {
  return registerAbortController(state._activeSSE, new AbortController());
}

export function unregisterSSE(controller) {
  return unregisterAbortController(state._activeSSE, controller);
}

export async function refreshBook() {
  if (!state.book) return;
  state.book = await get(`/api/books/${state.book.id}`);
  setBook(state.book);
}

export async function refreshGlobal() {
  try {
    state.settings = await get('/api/settings');
    state.costs = (await get('/api/costs')).aggregate;
    updateBadges();
    await updateRunChip();
  } catch { /* 未就绪 */ }
}

function updateBadges() {
  const costEl = document.getElementById('cost-badge');
  if (state.costs) {
    costEl.textContent = `${fmtMoney(state.costs.cost)}（省${fmtMoney(state.costs.saving)}）`;
    costEl.title = `全部作品累计费用 ${fmtMoney(state.costs.cost)}；若未启用缓存将花费 ${fmtMoney(state.costs.costIfMiss)}；缓存命中率 ${fmtPct(state.costs.hitRatio)}`;
  }
  const peakEl = document.getElementById('peak-badge');
  if (state.settings?.peakHint) {
    // V0.98.4：免费档模型显示「免费模型」，不再误报峰谷价差
    if (state.settings.peakHint.includes('免费')) {
      peakEl.textContent = '免费模型';
      peakEl.className = 'badge badge-ok';
    } else {
      peakEl.textContent = state.settings.peakHint.includes('高峰') ? '高峰时段 ×2' : '平价时段';
      peakEl.className = 'badge ' + (state.settings.peakHint.includes('高峰') ? 'badge-warn' : 'badge-ok');
    }
    peakEl.classList.remove('hidden');
  }
  const embEl = document.getElementById('embedding-badge');
  if (state.settings) {
    const st = state.settings.embeddingStatus;
    if (st?.ready) { embEl.textContent = '向量检索已就绪'; embEl.className = 'badge badge-ok'; embEl.classList.remove('hidden'); }
    else if (st?.loading) { embEl.textContent = `向量模型加载中 ${st.progress}%`; embEl.className = 'badge badge-warn'; embEl.classList.remove('hidden'); }
    else if (st?.error) { embEl.textContent = '向量检索降级（关键词）'; embEl.className = 'badge badge-warn'; embEl.classList.remove('hidden'); }
    else { embEl.classList.add('hidden'); }
  }
}

export function checkCacheHealth(ratio, calls) {
  const elBadge = document.getElementById('cache-badge');
  const warn = state.settings?.cacheWarnRatio ?? 0.7;
  // V0.84：calls 用当前书调用数（此前混用全局 state.costs?.calls——多书并行时单书重建被稀释）
  const sample = calls ?? state.costs?.calls ?? 0;
  if (ratio !== undefined && ratio < warn && sample > 5) {
    elBadge.textContent = `缓存命中率低 ${fmtPct(ratio)}`;
    elBadge.classList.remove('hidden');
  } else {
    elBadge.classList.add('hidden');
  }
}

// ---------- 路由 ----------
function parseHash() {
  // V0.25 修复：先剥离 ?query 再分段（此前 ?chapter= 会粘进视图名导致"未知视图"白屏）
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');
  if (!parts.length) return { name: 'library', params: {}, query };
  if (parts[0] === 'book' && parts[1]) {
    return { name: parts[2] || 'workshop', params: { id: parts[1] }, query };
  }
  return { name: parts[0], params: {}, query };
}

const VIEW_TITLES = {
  library: '作品库', workshop: '写作台', outline: '大纲', world: '设定', roster: '角色库',
  foreshadows: '伏笔看板', facts: '事实库', pleasure: '快感', costs: '成本',
  settings: '设置', changelog: '更新日志',
};

function writeJobLabel(job) {
  if (!job) return '';
  const ev = job.lastEvent || {};
  let idx = chapterIdxFromEvent(ev);
  if (!idx && job.bookId) {
    try { idx = Number(sessionStorage.getItem(`mozhou-pilot-idx:${job.bookId}`)) || 0; } catch { idx = 0; }
  }
  if (job.type === 'polish') return idx ? `正在打磨第 ${idx} 章` : '正在全书打磨';
  if (idx) return `正在写第 ${idx} 章`;
  return '正在自动创作';
}

async function updateRunChip() {
  const chip = document.getElementById('run-chip');
  if (!chip) return;
  const bookId = state.book?.id || (() => { try { return localStorage.getItem('mozhou-last-book-id'); } catch { return null; } })();
  if (!bookId) {
    chip.classList.add('hidden');
    chip.innerHTML = '';
    return;
  }
  let jobs = { write: state.book?.activeWriteJob || null, recovery: state.book?.activeRecoveryJob || null };
  try { jobs = await writeApi.activeJobs(bookId); } catch { /* 作业接口未就绪时沿用书详情 */ }
  const write = jobs.write;
  const recovery = jobs.recovery;
  const job = write || recovery;
  if (!job) {
    chip.classList.add('hidden');
    chip.innerHTML = '';
    return;
  }
  chip.classList.remove('hidden');
  chip.innerHTML = '';
  const label = write ? writeJobLabel(write) : '正在返工';
  chip.append(
    el('span', { class: 'run-chip-label', text: label }),
    el('button', {
      class: 'sm ghost', type: 'button', text: '停止',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          if (write) {
            await writeApi.cancelWriteJob(bookId, write.id);
            toast('已请求停止（进度已保存，可断点续跑）');
          } else {
            const { publicationApi } = await import('./api.js');
            await publicationApi.cancelRecoveryJob(bookId, recovery.id);
            toast('已请求停止返工');
          }
          await updateRunChip();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      },
    }),
  );
}

async function route() {
  // V0.104：页面切换只取消观察 SSE，不取消服务端作业（自动创作/打磨/返工由作业注册器持有）。
  // V0.43：同时清理成本页轮询定时器
  if (state._costTimers) { state._costTimers.forEach(t => clearInterval(t)); state._costTimers = []; }
  abortAllControllers(state._activeSSE);
  const r = parseHash();
  state.route = r;
  const view = document.getElementById('view');
  view.innerHTML = '';
  // V0.25：数据到达前的加载占位（此前白屏无反馈）
  const loading = pageLoading();
  view.append(loading);
  try {
    // V0.26 修复：先确定 state.book，再渲染导航。
    // 此前 renderNav 在 state.book 更新前执行——进作品库时残留旧书导航、进书页时显示空导航，
    // 且 get() 完成后不再重渲染，导致"作品库页面出现大纲/设定等书内入口，点进作品反而只剩作品库"。
    if (r.name === 'library' || r.name === 'settings' || r.name === 'changelog') {
      state.book = null;
    } else if (r.name === 'book' && r.params.id) {
      // 兼容旧 hash：#/book/:id → 默认写作台（hash 变化会再次触发 route）
      location.hash = `#/book/${r.params.id}/workshop`;
      return;
    } else if (r.params.id) {
      state.book = await get(`/api/books/${r.params.id}`);
      setBook(state.book);
    } else {
      state.book = null;
    }
    document.title = `${VIEW_TITLES[r.name] || r.name} · 墨舟`;
    renderNav(r);

    if (r.name === 'library' || r.name === 'settings' || r.name === 'changelog') {
      if (r.name === 'settings') await renderSettings(view);
      else if (r.name === 'changelog') await renderChangelog(view);
      else await renderLibrary(view);
    } else if (r.params.id && state.book) {
      switch (r.name) {
        case 'workshop': await renderWorkshop(view, state.book); break;
        case 'outline': await renderOutline(view, state.book); break;
        case 'world': await renderWorld(view, state.book); break;
    case 'roster': await renderRoster(view, state.book); break; // V0.50 角色库
        case 'foreshadows': await renderForeshadows(view, state.book); break;
        case 'pleasure': await renderPleasure(view, state.book); break;
        case 'facts': await renderFacts(view, state.book); break;
        case 'costs': await renderCosts(view, state.book); break;
        default: view.append(emptyState('compass', '未知视图', '该页面不存在，请从顶部导航进入。'));
      }
    } else if (r.params.id) {
      view.append(emptyState('book', '作品不存在', '该书可能已被删除，请返回作品库。'));
    } else {
      view.append(emptyState('compass', '未知路由', '请从顶部导航进入功能页面。'));
    }
  } catch (e) {
    view.innerHTML = '';
    view.append(emptyState('warning', '出错了', e.message));
  } finally {
    loading.remove();
  }
  updateBadges();
  updateRunChip();
}

/** V0.25：原地重渲染当前视图（替代 location.reload()，不闪屏、不丢主题态） */
export function rerender() { route(); }

function renderNav(r) {
  const nav = document.getElementById('main-nav');
  nav.innerHTML = '';
  nav.setAttribute('aria-label', '主导航');
  const items = [];
  const navItem = (href, ico, label) => {
    const a = el('a', { href, class: 'nav-item' }, icon(ico, 15), el('span', { text: label }));
    const key = a.getAttribute('href');
    const active = r.params.id ? key === `#/book/${r.params.id}/${r.name}` : key === `#/${r.name}`;
    if (active) a.classList.add('active');
    return a;
  };
  const sep = () => el('span', { class: 'nav-sep', 'aria-hidden': 'true' });
  if (state.book) {
    items.push(
      navItem('#/library', 'book', '作品库'),
      sep(),
      navItem(`#/book/${state.book.id}/workshop`, 'edit', '写作台'),
      navItem(`#/book/${state.book.id}/outline`, 'list', '大纲'),
      navItem(`#/book/${state.book.id}/world`, 'globe', '设定'),
      navItem(`#/book/${state.book.id}/roster`, 'users', '角色库'),
      sep(),
      navItem(`#/book/${state.book.id}/foreshadows`, 'anchor', '伏笔'),
      navItem(`#/book/${state.book.id}/pleasure`, 'zap', '快感'),
      navItem(`#/book/${state.book.id}/facts`, 'database', '事实库'),
      navItem(`#/book/${state.book.id}/costs`, 'coins', '成本'),
    );
  } else {
    items.push(navItem('#/library', 'book', '作品库'));
  }
  items.push(sep(), navItem('#/changelog', 'list', '更新日志'));
  items.push(sep(), navItem('#/settings', 'settings', '设置'));
  for (const a of items) nav.append(a);
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    const dark = getTheme() === 'dark';
    themeBtn.innerHTML = '';
    themeBtn.append(icon(dark ? 'sun' : 'moon', 16));
    themeBtn.setAttribute('aria-label', dark ? '当前夜间，点击切换到日间' : '当前日间，点击切换到夜间');
    themeBtn.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
}

window.addEventListener('hashchange', route);

// ---------- 启动 ----------
(async function init() {
  // V0.25：品牌点击回作品库（此前 data-nav 无处理器，点击无效）
  document.querySelector('.brand')?.addEventListener('click', () => { location.hash = '#/library'; });
  // V0.25：主题切换
  const themeBtn = document.getElementById('theme-toggle');
  themeBtn?.addEventListener('click', () => {
    toggleTheme();
    renderNav(state.route || { name: 'library', params: {} });
  });
  await refreshGlobal();
  await route();
  // 每 30s 刷新全局成本与 embedding 状态
  setInterval(refreshGlobal, 30000);
})();
