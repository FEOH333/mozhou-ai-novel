// web/js/views/costs.js —— 成本面板：命中率 / 费用 / 节省 / 日志
'use strict';
import { get } from '../api.js';
import { el, fmt, fmtMoney, fmtPct, fmtTokens, fmtTime, pageHead } from '../ui.js';
import { checkCacheHealth, state } from '../app.js'; // V0.71：补导入 state（此前漏导入 → 成本页点击即 ReferenceError "state is not defined"）

const TASK_LABELS = {
  write: '场景正文', revise: '修订重写', audit: '一致性审校', audit_repair: '审校格式修复',
  chapter_outline: '章细纲', volume_outline: '卷大纲', book_outline: '书级大纲',
  worldbuild: '设定/世界观', book_settings: '设定生成', book_contract: '书契约',
  settle: '章结算', polish: '打磨', coverage: '覆盖检查',
  pleasure_audit: '快感审计', attraction: '吸引力门', signing: '签约模拟',
  idea_amplify: '灵感提级', names: '取名', roster_tidy: '角色库整理',
  narrative_plan_reconcile: '叙事规划对账', opening_compose: '开篇方案',
  opening_audit: '开篇审校', opening_compare: '开篇比较',
  recommendation_diagnose: '返工诊断', recommendation_rewrite: '返工改写',
  recommendation_review: '返工复核',
};
const taskLabel = (task) => TASK_LABELS[task] || task;

export async function renderCosts(view, book) {
  // V0.70：竞态防护——轮询中的旧 render 不得覆盖已切换的视图（此前切页后旧 fetch 返回会清空新视图）
  let generation = 0;
  const render = async () => {
    const myGen = ++generation;
    try {
      const { aggregate, logs, rebuilds = [] } = await get(`/api/books/${book.id}/costs`);
      if (myGen !== generation || state.route?.name !== 'costs') return; // 已切页/有更新请求 → 放弃本次渲染
      view.innerHTML = '';
      const hitRatio = aggregate.hitRatio || 0;
      // V0.84：告警口径用当前书 calls（此前混用全局 state.costs?.calls——多书并行时单书重建被稀释，告警不触发）
      checkCacheHealth(hitRatio, aggregate.calls);

      view.append(pageHead('icon:coins:成本与缓存', `《${book.title || '未命名'}》·历史堆前缀复用是省钱核心：命中率越高，缓存账单越薄`));

      // V0.43：实时刷新（自动创作中每 5s 滚动更新命中率/费用）
      view.append(el('div', { class: 'small muted mb', style: 'display:flex;gap:12px;align-items:center' },
        el('span', { text: '自动每 5 秒刷新 · 正在自动创作时数据实时滚动' }),
        el('button', { class: 'sm ghost', text: '立即刷新', onclick: () => render() }),
      ));

      view.append(el('div', { class: 'kpi-row' },
        kpi('总费用', fmtMoney(aggregate.cost)),
        kpi('已节省（缓存）', fmtMoney(aggregate.saving), '若未启用缓存将花费 ' + fmtMoney(aggregate.costIfMiss)),
        // V0.93.6：双口径——近期（最近 500 条记录内有效调用）是缓存健康度实时仪表，
        // 全量累计会被历史旧版本运行（如注入未限流期）稀释成假象
        kpi('近期命中率', aggregate.recentCalls ? fmtPct(aggregate.recentHitRatio || 0) : '尚未调用', aggregate.recentCalls ? `最近 ${aggregate.recentCalls || 0} 次调用 · ${fmtTokens(aggregate.recentHit)} 命中 / ${fmtTokens(aggregate.recentMiss)} 未命中` : '开始自动创作后这里会显示缓存健康度'),
        kpi('累计命中率', aggregate.calls ? fmtPct(hitRatio) : '尚未调用', aggregate.calls ? `全部 ${fmtTokens(aggregate.totalHit)} 命中 / ${fmtTokens(aggregate.totalMiss)} 未命中` : '尚无模型调用，不是故障'),
        kpi('调用次数', fmt(aggregate.calls), `输出 ${fmtTokens(aggregate.totalCompletion)} tokens`),
      ));

      // V0.69：趋势图（按天费用 + 命中率双线）
      if (aggregate.byDay?.length >= 2) {
        view.append(el('div', { class: 'card' },
          el('h3', { text: '按天趋势（费用 / 缓存命中率）' }),
          trendChart(aggregate.byDay),
        ));
      } else {
        view.append(el('div', { class: 'card' },
          el('h3', { text: '按天趋势' }),
          el('div', { class: 'muted', text: '调用不足两天，暂无趋势。' }),
        ));
      }
      // V0.69：按任务费用条形图
      if (aggregate.byTask?.length) {
        view.append(el('div', { class: 'card' },
          el('h3', { text: '按任务费用分布（命中率色标：绿≥90% 黄≥70% 红<70%）' }),
          taskBarChart(aggregate.byTask),
        ));
      }

      // V0.43：按章节 miss 归因（谁在拖累命中率）
      if (aggregate.byChapter?.length) {
        view.append(el('div', { class: 'card' },
          el('h3', { text: '按章节命中率（miss 排行，修订/重写章会拖累后续全部调用）' }),
          el('table', {},
            el('thead', {}, el('tr', {}, el('th', { text: '章节' }), el('th', { text: '次数' }), el('th', { text: '命中率' }), el('th', { text: '未命中' }), el('th', { text: '费用' }))),
            el('tbody', {}, ...aggregate.byChapter.slice(0, 15).map(c =>
              el('tr', {},
                el('td', { text: c.chapter_idx ? `第${c.chapter_idx}章 ${c.chapter_title || ''}` : '（全局/其他）' }),
                el('td', { text: fmt(c.calls) }),
                el('td', { text: safePct(c.hit, c.miss) }),
                el('td', { class: 'small', text: fmtTokens(c.miss) }),
                el('td', { text: fmtMoney(c.cost) }),
              ),
            )),
          ),
        ));
      }

      // V0.43：缓存重建记录（原因追踪——为什么命中率被拉低）
      if (rebuilds.length) {
        view.append(el('div', { class: 'card' },
          el('h3', { text: `缓存重建记录（${rebuilds.length}）——每次重建=前缀失效，之后调用全部 miss 直到重建完成` }),
          ...rebuilds.map(r =>
            el('div', { class: 'row mb', style: 'gap:10px' },
              el('span', { class: 'tag low', text: fmtTime(r.ts) }),
              el('span', { class: 'small grow', text: r.detail || r.op }),
            ),
          ),
        ));
      }

      // 按任务聚合
      const byTask = el('div', { class: 'card' },
        el('h3', { text: '按任务统计（miss 最多的任务排前）' }),
      );
      if (!aggregate.byTask?.length) byTask.append(el('div', { class: 'muted', text: '暂无调用记录。' }));
      else {
        const tasks = [...aggregate.byTask].sort((a, b) => (b.miss || 0) - (a.miss || 0));
        byTask.append(el('table', {},
          el('thead', {}, el('tr', {}, el('th', { text: '任务' }), el('th', { text: '模型' }), el('th', { text: '次数' }), el('th', { text: '命中率' }), el('th', { text: '未命中' }), el('th', { text: '费用' }), el('th', { text: '若未命中' }))),
          el('tbody', {}, ...tasks.map(t =>
            el('tr', {},
              el('td', { text: taskLabel(t.task) }),
              el('td', { class: 'mono small', text: t.model }),
              el('td', { text: fmt(t.calls) }),
              el('td', { text: safePct(t.hit, t.miss) }),
              el('td', { class: 'small', text: fmtTokens(t.miss) }),
              el('td', { text: fmtMoney(t.cost) }),
              el('td', { class: 'muted', text: fmtMoney(t.cost_if_miss) }),
            ),
          )),
        ));
      }
      view.append(byTask);

      // 调用日志
      const lg = el('div', { class: 'card' },
        el('h3', { text: `最近调用（${logs.length}）` }),
      );
      if (!logs.length) lg.append(el('div', { class: 'muted', text: '暂无日志。' }));
      else {
        lg.append(el('div', { style: 'overflow-x:auto' },
          el('table', {},
            el('thead', {}, el('tr', {}, el('th', { text: '时间' }), el('th', { text: '任务' }), el('th', { text: '模型' }),
              el('th', { text: '命中' }), el('th', { text: '未命中' }), el('th', { text: '输出' }), el('th', { text: '费用' }), el('th', { text: '耗时' }))),
            el('tbody', {}, ...logs.map(l =>
              el('tr', {},
                el('td', { class: 'small muted', text: fmtTime(l.ts) }),
                el('td', { text: taskLabel(l.task) }),
                el('td', { class: 'mono small', text: l.model + (l.estimated ? '（估）' : '') }),
                el('td', { class: 'small', text: fmtTokens(l.prompt_hit) }),
                el('td', { class: 'small', text: fmtTokens(l.prompt_miss) }),
                el('td', { class: 'small', text: fmtTokens(l.completion) }),
                el('td', { text: fmtMoney(l.cost) }),
                el('td', { class: 'small muted', text: l.duration_ms ? (l.duration_ms / 1000).toFixed(1) + 's' : '—' }),
              ),
            )),
          ),
        ));
      }
      view.append(lg);
    } catch (e) {
      // V0.69：轮询失败不报错（服务器重启/临时不可达时静默，下轮重试）
      view.append(el('div', { class: 'card' }, el('div', { class: 'muted', text: `数据加载失败（${e.message || e}），5 秒后自动重试…` })));
    }
  };
  await render();
  // V0.43：实时轮询（5s；页面卸载自动停止——定时器由视图重建自然丢弃）
  const timer = setInterval(() => { render(); }, 5000);
  if (state._costTimers) state._costTimers.push(timer); else state._costTimers = [timer];
}

/** 防除零/NaN 的命中率格式化 */
function safePct(hit, miss) {
  const h = hit || 0, m = miss || 0;
  if (h + m === 0) return '—';
  return fmtPct(h / (h + m));
}

/**
 * V0.69 按天趋势图（纯 SVG：费用柱 + 命中率折线）
 * @param {Array<{day:string,cost:number,hit:number,miss:number}>} days
 */
function trendChart(days) {
  const W = 720, H = 180, PAD = 34;
  const maxCost = Math.max(...days.map(d => d.cost || 0), 1);
  const x = (i) => PAD + (i / Math.max(days.length - 1, 1)) * (W - PAD * 2);
  const yCost = (v) => H - PAD - (v / maxCost) * (H - PAD * 2);
  const rate = (d) => ((d.hit || 0) + (d.miss || 0)) > 0 ? (d.hit || 0) / ((d.hit || 0) + (d.miss || 0)) : 0;
  const yRate = (v) => H - PAD - v * (H - PAD * 2);
  // 折线点
  const linePts = days.map((d, i) => `${x(i).toFixed(1)},${yRate(rate(d)).toFixed(1)}`).join(' ');
  // 柱
  const bars = days.map((d, i) => {
    const bh = Math.max((d.cost || 0) / maxCost * (H - PAD * 2), 2);
    return `<rect x="${(x(i) - 9).toFixed(1)}" y="${(yCost(d.cost || 0)).toFixed(1)}" width="18" height="${bh.toFixed(1)}" rx="2" style="fill:var(--gold);opacity:.5"/>`;
  }).join('');
  const labels = days.map((d, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" style="fill:var(--text-3)">${d.day.slice(5)}</text>`).join('');
  const rateTexts = days.map((d, i) => `<text x="${x(i).toFixed(1)}" y="${(yRate(rate(d)) - 6).toFixed(1)}" text-anchor="middle" font-size="9" style="fill:${rate(d) >= 0.9 ? 'var(--green)' : rate(d) >= 0.7 ? 'var(--amber)' : 'var(--red)'}">${Math.round(rate(d) * 100)}%</text>`).join('');
  return el('div', { style: 'overflow-x:auto' },
    el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, style: 'min-width:640px' },
      el('g', { innerHTML: bars + (linePts ? `<polyline points="${linePts}" fill="none" style="stroke:var(--green)" stroke-width="2"/>` : '') + rateTexts + labels }),
    ),
    el('div', { class: 'small muted mt', text: '柱=当日费用（元） · 绿线=当日缓存命中率' }),
  );
}

/**
 * V0.69 按任务费用条形图（命中率色标）
 */
function taskBarChart(byTask) {
  const maxCost = Math.max(...byTask.map(t => t.cost || 0), 1);
  const rows = [...byTask].sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 12);
  return el('div', {}, ...rows.map(t => {
    const rate = (t.hit || 0) + (t.miss || 0) > 0 ? (t.hit || 0) / ((t.hit || 0) + (t.miss || 0)) : 0;
    const w = Math.max((t.cost || 0) / maxCost * 100, 1);
    const color = rate >= 0.9 ? 'var(--green)' : rate >= 0.7 ? 'var(--amber)' : 'var(--red)';
    return el('div', { class: 'row mb', style: 'gap:8px;align-items:center' },
      el('span', { class: 'small', style: 'width:120px;flex:none;text-align:right', text: taskLabel(t.task) }),
      el('div', { class: 'grow', style: 'background:var(--bg-soft);border-radius:4px;height:16px;overflow:hidden' },
        el('div', { style: `width:${w}%;height:100%;background:${color};border-radius:4px` }),
      ),
      el('span', { class: 'mono small', style: 'width:110px;flex:none', text: `${fmtMoney(t.cost)} · ${Math.round(rate * 100)}%` }),
    );
  }));
}

function kpi(label, num, sub) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'num', text: num }),
    el('div', { class: 'lbl', text: label }),
    sub ? el('div', { class: 'small muted', text: sub }) : null,
  );
}
