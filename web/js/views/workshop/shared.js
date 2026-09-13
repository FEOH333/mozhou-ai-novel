// web/js/views/workshop/shared.js —— 写作台各子模块共用的状态与工具。
//
// 存在的理由：拆分前 workshop.js 里 `livePatchChapterList` 是**双向耦合点**——
// 骨架层（renderWorkshop 的侧栏）给它赋值，而打磨/自动创作层在流式回调里调用它。
// 拆成多文件后若继续直接读写模块级变量，就会形成「index ↔ pilot」循环依赖。
// 这里把可变状态收进 getter/setter，依赖方向变成单向：谁都只依赖 shared。
'use strict';
import { el, fmtTokens, fmtMoney, fmtPct } from '../../ui.js';

/** 五个生产阶段（细纲→正文→审校→修订→结算），章节卡与运行流程共用 */
export const STEP_META = [
  ['outline', '细纲'], ['write', '正文'], ['audit', '审校'], ['revise', '修订'], ['settle', '结算'],
];

// V0.94.1：章节列表过滤（模块级——切章/重渲染期间保持用户的过滤选择）
let chFilter = 'all';
export function getChFilter() { return chFilter; }
export function setChFilter(v) { chFilter = v; }

/**
 * 自动创作进行中不整页 rerender（会拆掉观察流），侧栏用这个补丁跟作业同步。
 * 由骨架层注册、由打磨/自动创作层调用——故必须经 setter 传递，不能各模块各持一份。
 */
let livePatchChapterList = () => {};
export function getLivePatch() { return livePatchChapterList; }
export function setLivePatch(fn) { livePatchChapterList = typeof fn === 'function' ? fn : () => {}; }

/** 章节状态归一化：把十余种后端状态收敛成 4 个展示态 */
export function chapterListState(c) {
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
export function runStatsBar() {
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
