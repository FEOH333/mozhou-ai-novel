// web/js/ui.js —— 轻量 UI 工具（DOM 创建、toast、格式化、SVG 图标、模态、主题）
// V0.25：统一模态系统 openModal / 加载态 / 主题切换 / Toast 动画重构
'use strict';

/** V0.20：安全 JSON 解析（数据损坏时返回默认值，不再整页崩溃） */
export function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text ?? ''); } catch { return fallback; }
}

// ============ V0.20 SVG 图标库（feather 风格 24x24 stroke 图标） ============
const ICON_PATHS = {
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  anchor: '<circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  sparkles: '<path d="M12 3l1.9 5.7L19.6 10l-5.7 1.9L12 17.6l-1.9-5.7L4.4 10l5.7-1.9L12 3z"/><path d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8.5" cy="15.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  creditCard: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  award: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  messageSquare: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
};

/** 创建内联 SVG 图标（stroke 风格，继承 currentColor） */
export function icon(name, size = 16) {
  const paths = ICON_PATHS[name] || ICON_PATHS.file;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

/** 创建元素：el('div', {class:'x', onclick}, ...children) */
const SVG_TAGS = new Set(['svg', 'g', 'rect', 'circle', 'line', 'path', 'polyline', 'polygon', 'text', 'defs', 'linearGradient', 'stop']);
export function el(tag, attrs = {}, ...children) {
  // V0.69：SVG 元素必须用 createElementNS（createElement 对 svg 标签创建的是 HTMLUnknownElement，渲染不出）
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  // V0.31 防御：第二参数误传 DOM 节点/数组时降级为 children（否则 Object.entries(节点) 会把元素属性 setAttribute 到 tag 上）
  if (attrs && typeof attrs === 'object' && (attrs.nodeType || Array.isArray(attrs))) {
    children = [attrs, ...children];
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'innerHTML') node.innerHTML = v; // V0.69：SVG 内部 HTML 注入
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const TOAST_ICON = { info: 'info', success: 'check', error: 'warning', warn: 'warning' };

export function toast(msg, kind = 'info', timeout = 4000) {
  const box = document.getElementById('toast-container');
  if (!box) return;
  while (box.children.length >= 4) box.firstChild.remove();
  const t = el('div', { class: `toast ${kind}`, role: 'status' },
    icon(TOAST_ICON[kind] || 'info', 15),
    el('span', { text: msg }),
    el('button', { class: 'toast-close', type: 'button', 'aria-label': '关闭', onclick: () => t.remove() }, '×'),
  );
  box.append(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 200);
  }, timeout);
}

// ============ V0.25 统一模态系统 ============
/**
 * 打开模态框。返回 { overlay, box, close }。
 * @param {object} opts { title, body(Node|Node[]), actions(Node[]), large, onClose }
 */
export function openModal({ title, body, actions = [], large = false, onClose } = {}) {
  const previouslyFocused = document.activeElement;
  const titleId = title ? `modal-title-${Math.random().toString(36).slice(2, 8)}` : '';
  let close = (result) => {
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus(); } catch { /* ignore */ }
    }
    onClose?.(result);
  };
  const overlay = el('div', { class: 'modal-mask' });
  const box = el('div', {
    class: 'modal' + (large ? ' modal-lg' : ''),
    role: 'dialog',
    'aria-modal': 'true',
    ...(titleId ? { 'aria-labelledby': titleId } : {}),
  });
  if (title) box.append(el('h3', { id: titleId, text: title }));
  for (const b of [body].flat()) if (b) box.append(b);
  if (actions.length) box.append(el('div', { class: 'modal-actions' }, ...actions));
  overlay.append(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  const esc = (e) => { if (e.key === 'Escape') close(false); };
  document.addEventListener('keydown', esc);
  const origClose = close;
  close = (val) => { document.removeEventListener('keydown', esc); return origClose(val); };
  document.body.append(overlay);
  return { overlay, box, close };
}

/** 确认对话框（Promise<boolean>）。danger=true 时主按钮为红色警示风格。 */
export function confirmDialog(title, message, okText = '确定', { danger = false } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let closer = () => {};
    const finish = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onEnter);
      closer(val);
      resolve(val);
    };
    const onEnter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };
    const { close } = openModal({
      title,
      body: el('div', { class: 'muted', style: 'line-height:1.7', text: message }),
      actions: [
        el('button', { type: 'button', text: '取消', onclick: () => finish(false) }),
        el('button', {
          type: 'button',
          class: danger ? 'danger' : 'primary',
          text: okText,
          onclick: () => finish(true),
        }),
      ],
      onClose: (r) => { if (!settled) { settled = true; document.removeEventListener('keydown', onEnter); resolve(!!r); } },
    });
    closer = close;
    document.addEventListener('keydown', onEnter);
  });
}

/** 加载占位（视图切换时） */
export function pageLoading(text = '加载中…') {
  // V0.94.1：骨架屏（结构预览）替代孤零转圈——数据到达前页面已有版式感，
  // 视觉上"正在填充"而非"空白等待"；顶部保留行内加载说明（无障碍朗读可感知）
  return el('div', { class: 'skeleton', role: 'status', 'aria-label': text },
    el('div', { class: 'loading-page', style: 'padding: 30px 0 6px' }, el('span', { class: 'spinner' }), el('span', { class: 'small muted', text })),
    el('div', { class: 'skeleton-card' }),
    el('div', { class: 'skeleton-card', style: 'height: 180px' }),
    el('div', { class: 'skeleton-card', style: 'height: 90px' }),
  );
}

/** 统一页面头：pageHead('icon:globe:设定', '副标题', ...操作按钮) */
export function pageHead(title, sub, ...actions) {
  // V0.27：标题支持 "icon:图标名:文字" 前缀（SVG 图标 + 文字），如 pageHead('icon:globe:设定')
  const titleEl = el('h2');
  if (typeof title === 'string' && title.startsWith('icon:')) {
    const parts = title.split(':');
    titleEl.append(icon(parts[1] || 'file', 18), ' ' + (parts.slice(2).join(':') || ''));
  } else {
    titleEl.textContent = title;
  }
  return el('div', { class: 'page-head' },
    el('div', { class: 'ph-text' },
      titleEl,
      sub ? el('div', { class: 'ph-sub', text: sub }) : null,
    ),
    actions.length ? el('div', { class: 'ph-actions' }, ...actions) : null,
  );
}

/** 空状态：emptyState('compass', '标题', '说明') —— V0.27 图标参数为 SVG icon name */
export function emptyState(iconName, title, sub) {
  return el('div', { class: 'empty' },
    el('div', { class: 'big' }, icon(iconName || 'file', 44)),
    el('div', { class: 'empty-title', text: title }),
    sub ? el('div', { class: 'small', text: sub }) : null,
  );
}

// ============ V0.25 主题（明/暗） ============
const THEME_KEY = 'mozhou-theme';

export function getTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

// 尽早应用主题，避免首屏闪烁
applyTheme(getTheme());

/** 数字格式：12345 → 12,345 */
export function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

/** token 数 → 可读（12.3K / 1.2M） */
export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function fmtMoney(n) {
  return '¥' + Number(n || 0).toFixed(4);
}

export function fmtPct(n) {
  return Math.round((n || 0) * 100) + '%';
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 章节状态中文名 */
export const CHAPTER_STATUS = {
  planned: '待细纲', outlined: '已细纲', writing: '写作中', drafted: '已草稿',
  revised: '已修订', settled: '已结算', done: '已完成',
  quality_blocked: '卡住', partial: '部分', failed: '失败',
};

export const CHAPTER_STATUS_TAG = {
  planned: '', outlined: 'outlined', writing: 'writing', drafted: 'drafted',
  revised: 'revised', settled: 'settled', done: 'done',
  quality_blocked: 'quality_blocked', partial: 'partial', failed: 'failed',
};

export function chapterStatusLabel(status) {
  return CHAPTER_STATUS[status] || status || '待细纲';
}


/** V0.28 生成进度卡片：progressCard('正在生成…') → { card, setMessage }，供 SSE 生成流程实时展示 */
export function progressCard(initial) {
  const statusEl = el('div', { class: 'progress-status' });
  const card = el('div', { class: 'card progress-card' },
    el('div', { class: 'row', style: 'gap:10px;align-items:center' },
      el('span', { class: 'spinner' }),
      statusEl,
    ),
  );
  statusEl.textContent = initial || '生成中…';
  return { card, setMessage: (m) => { statusEl.textContent = m || '生成中…'; } };
}
