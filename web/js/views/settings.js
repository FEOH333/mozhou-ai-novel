// web/js/views/settings.js —— 设置（V0.109 改版：双 API 通道 + 锚点导航 + 模块化分组）
// 结构：状态条 → ①API 通道（主/备双栏）→ ②API 韧性 → ③写作与质量 → ④自动恢复
//       → ⑤模型路由（分组 tab）→ ⑥Embedding → ⑦数据 → 操作日志
'use strict';
import { get, put, post, del } from '../api.js';
import { el, toast, pageHead, confirmDialog } from '../ui.js';
import { state, refreshGlobal, lastBookId } from '../app.js';

const clamp = (v, min, max, dflt) => { const n = parseInt(v); if (Number.isNaN(n)) return dflt; return Math.min(max, Math.max(min, n)); };

/** V0.109：页首锚点导航（点击滚动定位到对应区块；路由区在折叠区内先展开再滚） */
function settingsNav() {
  const items = [
    ['#sec-channel', 'API 通道'],
    ['#sec-resilience', '韧性'],
    ['#sec-writing', '写作与质量'],
    ['#sec-recovery', '自动恢复'],
    ['#sec-routes', '模型路由'],
    ['#sec-embedding', '向量检索'],
    ['#sec-data', '数据与日志'],
  ];
  return el('nav', { class: 'settings-nav' },
    ...items.map(([href, label]) => el('a', {
      href, text: label,
      onclick: (ev) => {
        ev.preventDefault();
        // 路由区藏在 details 折叠内：折叠时目标不在文档流位置 → scrollIntoView 滚到顶部（冒烟实证）。
        // 先展开折叠再滚动。
        const section = document.querySelector(href);
        const fold = section?.closest('details');
        if (fold && !fold.open) fold.open = true;
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    })),
  );
}

/** V0.109：顶部状态条——主端点健康徽章 + 备用通道状态徽章（类名对齐既有 tag 体系） */
function statusBadgeRow(s) {
  const h = s._llmHealth || {};
  const rate = h.recentSuccessRate ?? h.successRate;
  const tripped = (h.circuits || []).filter(c => c.state === 'OPEN');
  const mainCls = tripped.length ? 'tag high' : (rate !== null && rate < 70 ? 'tag medium' : 'tag done');
  const mainText = tripped.length ? '主通道：熔断中（自动恢复）'
    : (rate !== null ? `主通道：近 ${rate}% 成功` : '主通道：暂无调用数据');
  const bk = s.backup || {};
  let bkCls = 'tag low'; let bkText = '备用通道：未启用';
  if (bk.enabled) {
    bkText = s.hasBackupApiKey
      ? `备用通道：${s.backupProviderLabel || 'DeepSeek 官方'} · ${s.backupResolvedModel || '待解析'}`
      : '备用通道：已启用但未填 Key（不生效）';
    bkCls = s.hasBackupApiKey ? 'tag done' : 'tag medium';
  }
  return el('div', { class: 'status-badge-row' },
    el('span', { class: mainCls, text: mainText }),
    el('span', { class: bkCls, text: bkText }),
    el('span', { class: 'small muted grow', text: s.peakHint || '' }),
  );
}

/** 连接测试按钮（主/备通道共用；channel 决定测试目标） */
function testButton(channel, keyInputId, resultId, extraBody = {}) {
  return el('button', { class: 'sm', text: '测试连接', onclick: async (ev) => {
    const btn = ev.currentTarget; btn.disabled = true;
    const box = document.getElementById(resultId);
    box.className = 'test-result'; box.textContent = '测试中…（验证 Key/地址/模型对话，约几秒）';
    try {
      const body = {
        apiKey: document.getElementById(keyInputId)?.value.trim() || undefined,
        ...extraBody(),
      };
      if (channel === 'backup') body.channel = 'backup';
      const r = await post('/api/settings/test', body);
      if (r.ok) {
        const models = (r.models || []).join('、') || '（接口未返回模型列表）';
        box.className = 'test-result ok';
        box.textContent = `连接成功（${r.latencyMs}ms）：${r.message}；可用模型：${models.slice(0, 120)}${r.chatErr ? `；对话测试：${r.chatErr}` : ''}`;
      } else {
        box.className = 'test-result fail';
        box.textContent = `${r.error}${r.latencyMs ? `（${r.latencyMs}ms）` : ''}`;
      }
    } catch (e) {
      box.className = 'test-result fail';
      box.textContent = `测试请求失败：${e.message}`;
    }
    btn.disabled = false;
  } });
}

export async function renderSettings(view) {
  view.innerHTML = ''; // V0.29 修复：服务商切换重渲染时防整页叠加
  const s = await get('/api/settings');
  state.settings = s;

  view.append(pageHead('icon:settings:设置', '双 API 通道（主/备自动切换）、模型路由、写作与韧性参数、向量检索与数据备份'));
  view.append(settingsNav());
  view.append(statusBadgeRow(s));

  // ============ ① API 通道（V0.109：主/备双栏） ============
  const bk = s.backup || {};
  const dsParamsCheckbox = el('input', { type: 'checkbox', id: 'set-dsparams', checked: s.deepseekParams });

  // ---- 主通道栏 ----
  const providerRadioName = 'provider';
  const mainCol = el('div', { class: 'channel-col' },
    el('h4', { text: '主通道（日常使用）' }),
    el('label', { text: '服务商（OpenAI 兼容端点）' }),
    el('div', { class: 'preset-row' },
      ...Object.entries(s.providers || {}).map(([id, p]) =>
        el('label', { class: 'preset-card' + (s.provider === id ? ' active' : '') },
          el('input', { type: 'radio', name: providerRadioName, value: id, checked: s.provider === id }),
          el('div', { class: 'preset-title', text: p.label }),
          el('div', { class: 'small muted', text: p.desc }),
        ),
      ),
    ),
    el('label', { class: 'mt', text: `API Key（${s.providerLabel || 'DeepSeek'}）` }),
    el('input', { type: 'password', id: 'set-apikey', placeholder: s.hasApiKey ? `${s.apiKeyMasked}（留空保持不变）` : 'sk-…', autocomplete: 'off' }),
    el('div', { class: 'small muted mt', text: `${s.keyHint || ''} Key 只保存在本地 data/config.json。` }),
    el('label', { class: 'mt', text: 'API 地址（一般无需修改）' }),
    el('input', { type: 'text', id: 'set-baseurl', value: s.baseUrl }),
    el('label', { class: 'mt', text: '正文模型档位（write/revise）' }),
    el('div', { class: 'preset-row' },
      ...Object.entries(s.writingModelPresets || {}).map(([id, p]) =>
        el('label', { class: 'preset-card' + (s.writingModel === id ? ' active' : '') },
          el('input', { type: 'radio', name: 'writingModel', value: id, checked: s.writingModel === id }),
          el('div', { class: 'preset-title', text: p.label }),
          el('div', { class: 'small muted', text: p.desc }),
        ),
      ),
    ),
    el('label', { class: 'mt', text: 'API 格式（协议）' }),
    el('select', { id: 'set-protocol', class: 'mono' },
      el('option', { value: 'chat', text: 'Chat Completions（默认推荐，缓存稳定）', selected: (s.protocol ?? 'chat') === 'chat' }),
      el('option', { value: 'auto', text: '自动探测（兼容性测试用）', selected: s.protocol === 'auto' }),
      el('option', { value: 'responses', text: 'Responses API（需确认缓存支持）', selected: s.protocol === 'responses' }),
      el('option', { value: 'messages', text: 'Anthropic Messages（自带思考块）', selected: s.protocol === 'messages' }),
    ),
    el('label', { class: 'mt', style: 'display:inline-flex;align-items:center;gap:6px' }, dsParamsCheckbox,
      ' 发送 DeepSeek 专属参数（官方开启；OpenCode Go 等兼容端点关闭）'),
    el('div', { class: 'row-gap', style: 'margin-top:10px' },
      el('button', { class: 'primary sm', text: '保存主通道', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          await put('/api/settings', {
            provider: document.querySelector(`input[name=${providerRadioName}]:checked`)?.value || 'deepseek_official',
            writingModel: document.querySelector('input[name=writingModel]:checked')?.value || 'flash',
            deepseekParams: dsParamsCheckbox.checked,
            protocol: document.getElementById('set-protocol').value || 'chat',
            baseUrl: document.getElementById('set-baseurl').value.trim(),
            apiKey: document.getElementById('set-apikey').value.trim() || undefined,
          });
          toast('主通道已保存');
          await refreshGlobal();
          renderSettings(view);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
      testButton('main', 'set-apikey', 'set-test-result', () => ({
        baseUrl: document.getElementById('set-baseurl').value.trim(),
      })),
    ),
    el('div', { id: 'set-test-result', class: 'test-result mt' }),
  );

  // 服务商切换联动（填 baseUrl + 参数开关，不整页重渲染打断输入）
  mainCol.querySelectorAll(`input[name=${providerRadioName}]`).forEach(inp => {
    inp.addEventListener('change', () => {
      const preset = s.providers[inp.value];
      if (preset) {
        document.getElementById('set-baseurl').value = preset.baseUrl;
        dsParamsCheckbox.checked = preset.deepseekParams;
      }
      mainCol.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
      inp.closest('.preset-card').classList.add('active');
      toast('已切换服务商预设，点击「保存主通道」生效', 'info', 4000);
    });
  });
  mainCol.querySelectorAll('input[name=writingModel]').forEach(inp => {
    inp.addEventListener('change', () => {
      mainCol.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
      inp.closest('.preset-card').classList.add('active');
    });
  });

  // ---- 备用通道栏（V0.109）----
  const bkEnabled = el('input', { type: 'checkbox', id: 'set-bk-enabled', checked: bk.enabled === true });
  const bkKeyInput = el('input', {
    type: 'password', id: 'set-bk-apikey', autocomplete: 'off',
    placeholder: s.hasBackupApiKey ? `${s.backupApiKeyMasked}（留空保持不变）` : 'sk-…（DeepSeek Key）',
  });
  const bkModelInput = el('input', {
    type: 'text', id: 'set-bk-model', class: 'mono', style: 'width:100%',
    value: bk.modelMap?.flash || 'deepseek-v4.1-flash-expires-on-0910',
    title: '模型 ID 过期后（如 0910），DeepSeek 会发布正式名——届时在此改成新 ID 即可',
  });
  const backupCol = el('div', { class: 'channel-col channel-backup' },
    el('h4', { text: '备用通道（自动切换）' }),
    el('label', { style: 'display:inline-flex;align-items:center;gap:6px' }, bkEnabled,
      ' 启用自动切换（主通道卡顿/失效时自动切到备用，恢复后自动切回）'),
    el('div', { class: 'small muted mt', text: `默认 DeepSeek 官方（api.deepseek.com），Key 在 platform.deepseek.com 获取。当前备用模型：${s.backupResolvedModel || '未配置'}。` }),
    el('label', { class: 'mt', text: '备用 API Key' }),
    bkKeyInput,
    el('label', { class: 'mt', text: '备用模型 ID（V4.1 Flash 内测：deepseek-v4.1-flash-expires-on-0910）' }),
    bkModelInput,
    el('div', { class: 'small muted mt', text: '切换策略：主通道失败 → 本次请求立即改走备用（写作不中断）；备用接管 5 分钟内新请求直走备用；每 60 秒探测主通道，恢复即自动切回；备用连续失败 3 次自身熔断。' }),
    el('div', { class: 'row-gap', style: 'margin-top:10px' },
      el('button', { class: 'primary sm', text: '保存备用通道', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const model = bkModelInput.value.trim() || 'deepseek-v4.1-flash-expires-on-0910';
          await put('/api/settings', {
            backup: {
              enabled: bkEnabled.checked,
              provider: 'deepseek_official',
              apiKey: bkKeyInput.value.trim() || undefined,
              modelMap: { flash: model, pro: model },
            },
          });
          toast('备用通道已保存');
          await refreshGlobal();
          renderSettings(view);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
      testButton('backup', 'set-bk-apikey', 'set-bk-test-result', () => ({
        backupProvider: 'deepseek_official',
        backupModel: bkModelInput.value.trim(),
      })),
    ),
    el('div', { id: 'set-bk-test-result', class: 'test-result mt' }),
  );

  view.append(el('section', { id: 'sec-channel', class: 'card' },
    el('h3', { text: 'API 通道' }),
    el('div', { class: 'channel-grid' }, mainCol, backupCol),
  ));

  // ============ ② API 韧性（独立成卡，前置） ============
  view.append(el('section', { id: 'sec-resilience', class: 'card' },
    el('h3', { text: 'API 韧性' }),
    el('div', { class: 'small muted mb', text: '空闲超时自动中断卡死请求 → 指数退避重试（429/5xx/网络/卡死）→ 连续失败熔断；主通道故障时自动切备用通道（见上方）。' }),
    el('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap' },
      el('label', { class: 'small', text: '总超时(ms)' }),
      el('input', { type: 'number', id: 'set-total-timeout', value: s.resilience?.totalTimeoutMs ?? 420000, min: '30000', max: '600000', step: '10000', style: 'width:110px' }),
      el('label', { class: 'small', text: '空闲超时(s)' }),
      el('input', { type: 'number', id: 'set-idle-timeout', value: (s.resilience?.idleTimeoutMs ?? 60000) / 1000, min: '5', max: '120', style: 'width:70px' }),
      el('label', { class: 'small', text: '重试次数' }),
      el('input', { type: 'number', id: 'set-retries', value: s.resilience?.maxRetries ?? 3, min: '0', max: '5', style: 'width:60px' }),
      el('label', { class: 'small', text: '熔断阈值' }),
      el('input', { type: 'number', id: 'set-cb-threshold', value: s.resilience?.circuitBreaker?.threshold ?? 3, min: '1', max: '10', style: 'width:60px' }),
    ),
    el('div', { class: 'small muted mt', text: '切换行为（固定）：备用接管 5 分钟 / 回切探测 60 秒 / 备用熔断 3 连败。' }),
    el('button', { class: 'primary sm mt', text: '保存韧性参数', onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        await put('/api/settings', {
          resilience: {
            totalTimeoutMs: clamp(document.getElementById('set-total-timeout').value, 30000, 600000, 420000),
            idleTimeoutMs: clamp(document.getElementById('set-idle-timeout').value, 5, 120, 60) * 1000,
            maxRetries: clamp(document.getElementById('set-retries').value, 0, 10, 3),
            circuitBreaker: { ...((s.resilience || {}).circuitBreaker || {}), threshold: parseInt(document.getElementById('set-cb-threshold').value) || 3 },
          },
        });
        toast('韧性参数已保存');
        await refreshGlobal();
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false;
    } }),
  ));

  // ============ ③ 写作与质量（语义相邻分组） ============
  view.append(el('section', { id: 'sec-writing', class: 'card' },
    el('h3', { text: '写作与质量' }),
    el('div', { class: 'split' },
      el('div', {},
        el('label', { text: '历史堆预算（tokens）' }),
        el('input', { type: 'number', id: 'set-budget', value: s.contextBudgetTokens ?? 500000, step: '50000' }),
        el('div', { class: 'small muted mt', text: '超过预算后建议归档或新开续卷（1M 上下文上限，默认 500K 留余量）。' }),
        el('label', { class: 'mt', text: '每章最大修订轮数' }),
        el('input', { type: 'number', id: 'set-revise', value: s.maxReviseRounds ?? 3, min: '0', max: '5' }),
        el('label', { class: 'mt', text: '世界书注入预算（tokens）' }),
        el('input', { type: 'number', id: 'set-wbbudget', value: s.worldbookBudgetTokens ?? 4000, step: '500' }),
      ),
      el('div', {},
        el('label', { text: '细纲确认方式' }),
        el('select', { id: 'set-autoconfirm' },
          el('option', { value: 'true', text: '自动确认（AI 本位，推荐）', selected: (s.autoConfirmOutline ?? true) === true }),
          el('option', { value: 'false', text: '人工确认（每章要等人点确认）', selected: (s.autoConfirmOutline ?? true) === false }),
        ),
        el('div', { class: 'small muted mt', text: '改成人工确认会把观察者变成审批者——自动创作会卡住。' }),
        el('label', { class: 'mt', text: '上下文归档策略（超长书防降智）' }),
        el('select', { id: 'set-archivestrategy' },
          el('option', { value: 'auto', text: '自动归档（推荐）', selected: (s.archiveStrategy || 'auto') === 'auto' }),
          el('option', { value: 'prompt', text: '提示后归档', selected: s.archiveStrategy === 'prompt' }),
          el('option', { value: 'off', text: '关闭', selected: s.archiveStrategy === 'off' }),
        ),
      ),
      el('div', {},
        el('label', { text: '保留最近章数（不压缩）' }),
        el('input', { type: 'number', id: 'set-keeprecent', value: s.keepRecentChapters ?? 15, min: '2', max: '50' }),
        el('label', { class: 'mt', text: '归档触发比例（历史/预算）' }),
        el('input', { type: 'number', id: 'set-archiveratio', value: s.archiveRatio ?? 0.85, step: '0.05', min: '0.5', max: '0.99' }),
        el('label', { class: 'mt', text: '缓存命中率告警阈值' }),
        el('input', { type: 'number', id: 'set-cachewarn', value: s.cacheWarnRatio ?? 0.7, step: '0.05', min: '0', max: '1' }),
      ),
    ),
    el('button', { class: 'primary sm mt', text: '保存写作参数', onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        await put('/api/settings', {
          contextBudgetTokens: clamp(document.getElementById('set-budget').value, 10000, 1000000, 500000),
          autoConfirmOutline: document.getElementById('set-autoconfirm').value === 'true',
          maxReviseRounds: clamp(document.getElementById('set-revise').value, 0, 5, 3),
          cacheWarnRatio: parseFloat(document.getElementById('set-cachewarn').value) || 0.7,
          worldbookBudgetTokens: parseInt(document.getElementById('set-wbbudget').value) || 4000,
          archiveStrategy: document.getElementById('set-archivestrategy').value,
          keepRecentChapters: clamp(document.getElementById('set-keeprecent').value, 2, 50, 15),
          archiveRatio: parseFloat(document.getElementById('set-archiveratio').value) || 0.85,
        });
        toast('写作参数已保存');
        await refreshGlobal();
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false;
    } }),
  ));

  // ============ ④ 自动恢复（恢复类参数自成一块） ============
  view.append(el('section', { id: 'sec-recovery', class: 'card' },
    el('h3', { text: '自动恢复' }),
    el('div', { class: 'split' },
      el('div', {},
        el('label', { text: '连续失败章数（触发全局诊断）' }),
        el('input', { type: 'number', id: 'set-consecutive', value: s.consecutiveFailures ?? 2, min: '1', max: '5' }),
        el('label', { class: 'mt', text: '近3章 high 问题阈值' }),
        el('input', { type: 'number', id: 'set-highissue', value: s.highIssueThreshold ?? 3, min: '1', max: '10' }),
        el('label', { class: 'mt', text: '最大恢复轮数（超限暂停）' }),
        el('input', { type: 'number', id: 'set-maxrecovery', value: s.maxRecoveryRounds ?? 3, min: '0', max: '5' }),
      ),
      el('div', {},
        el('label', { text: '逐章吸引力门模式' }),
        el('select', { id: 'set-attraction' },
          el('option', { value: 'soft', text: 'soft（番茄 hard，其他零成本）', selected: (s.attractionGate || 'soft') === 'soft' }),
          el('option', { value: 'hard', text: 'hard（每章 LLM 判定）', selected: s.attractionGate === 'hard' }),
          el('option', { value: 'off', text: 'off（关闭）', selected: s.attractionGate === 'off' }),
        ),
        el('label', { class: 'mt', text: '签约评审触发字数' }),
        el('input', { type: 'number', id: 'set-signing', value: s.signingReviewCharThreshold ?? 25000, min: '5000', step: '5000' }),
        el('label', { class: 'mt', text: '开篇蓝图覆盖章数' }),
        el('input', { type: 'number', id: 'set-blueprint', value: s.openingBlueprintChapters ?? 20, min: '5', max: '40' }),
      ),
    ),
    el('button', { class: 'primary sm mt', text: '保存恢复参数', onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        await put('/api/settings', {
          consecutiveFailures: parseInt(document.getElementById('set-consecutive').value) || 2,
          highIssueThreshold: parseInt(document.getElementById('set-highissue').value) || 3,
          maxRecoveryRounds: clamp(document.getElementById('set-maxrecovery').value, 0, 5, 3),
          attractionGate: document.getElementById('set-attraction').value,
          signingReviewCharThreshold: parseInt(document.getElementById('set-signing').value) || 25000,
          openingBlueprintChapters: clamp(document.getElementById('set-blueprint').value, 5, 40, 20),
        });
        toast('恢复参数已保存');
        await refreshGlobal();
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false;
    } }),
  ));

  // ============ ⑤ 模型路由（V0.109：分组 tab，29 任务不再一屏长表） ============
  const pm = (s.providers?.[s.provider]?.models) || {};
  const flashName = pm.flash || 'flash 档';
  const proName = pm.pro || 'pro 档';
  const providerModels = () => {
    const preset = (s.providerPresets || {})[s.provider] || {};
    const m = preset.models || {};
    return [...new Set([m.flash, m.pro, m.flash41, 'deepseek-v4-flash', 'deepseek-v4-pro', 'kimi-k2.6', 'glm-5', 'minimax-m3'])].filter(Boolean);
  };
  // 路由分组（与 DEFAULT_ROUTES 注释分类同构）
  const ROUTE_GROUPS = [
    { id: 'plan', label: '规划思考型', tasks: ['worldbuild', 'book_outline', 'book_contract', 'book_settings', 'pleasure_plan', 'idea_amplify', 'contract_score', 'volume_outline_rewrite', 'book_outline_rewrite', 'narrative_plan_reconcile', 'cast_design', 'roster_tidy', 'location_tidy', 'mid_story_review', 'foreshadow_closure'] },
    { id: 'flow', label: '高频流程型', tasks: ['volume_outline', 'chapter_outline', 'audit', 'audit_repair', 'volume_review', 'ending_check', 'next_volume', 'era_context', 'opening_blueprint', 'story_promise', 'opening_diagnosis', 'opening_strategy', 'opening_candidate', 'opening_candidate_audit', 'opening_candidate_compare', 'attraction', 'signing_review', 'promise_check', 'growth_remedy', 'world_progress'] },
    { id: 'write', label: '写作型', tasks: ['write', 'revise'] },
    { id: 'light', label: '轻量抽取型', tasks: ['coverage', 'settle', 'archive', 'summarize', 'pleasure_audit', 'book_title', 'chapter_rename', 'volume_rename'] },
  ];
  const routeRows = {};
  const routeTableFor = (taskIds) => el('table', { class: 'route-table' },
    el('thead', {}, el('tr', {},
      el('th', { text: '任务' }), el('th', { text: '模型' }), el('th', { text: '温度' }), el('th', { text: 'max_tokens' }), el('th', { text: '思考模式' }), el('th', { text: '思考强度' }),
    )),
    el('tbody', {}, ...(taskIds
      .filter(task => s.defaults?.[task])
      .map(task => {
        const def = s.defaults[task];
        const cur = s.routes?.[task] || {};
        const tempInput = el('input', { type: 'number', step: '0.1', min: '0', max: '2', style: 'width:70px', value: cur.temperature ?? def.temperature });
        const maxInput = el('input', { type: 'number', step: '500', min: '200', style: 'width:100px', value: cur.maxTokens ?? def.maxTokens });
        const thinkSel = el('select', { style: 'width:90px' },
          el('option', { value: 'disabled', text: '关闭', selected: (cur.thinking ?? def.thinking ?? 'disabled') === 'disabled' }),
          el('option', { value: 'enabled', text: '开启', selected: (cur.thinking ?? def.thinking ?? 'enabled') === 'enabled' }),
        );
        const effortSel = el('select', { style: 'width:90px' },
          el('option', { value: 'low', text: 'low', selected: (cur.reasoningEffort ?? def.reasoningEffort ?? 'medium') === 'low' }),
          el('option', { value: 'medium', text: 'medium', selected: (cur.reasoningEffort ?? def.reasoningEffort ?? 'medium') === 'medium' }),
          el('option', { value: 'high', text: 'high', selected: (cur.reasoningEffort ?? def.reasoningEffort ?? 'medium') === 'high' }),
        );
        const row = { tempInput, maxInput, thinkSel, effortSel };
        routeRows[task] = row;
        const displayModel = (s.resolvedModels || {})[task] || cur.model || def.model;
        const sel = el('select', { class: 'mono', style: 'max-width:185px' });
        for (const mid of providerModels()) {
          sel.append(el('option', { value: mid, text: mid, selected: displayModel === mid }));
        }
        if (![...sel.options].some(o => o.value === displayModel)) {
          sel.append(el('option', { value: displayModel, text: displayModel + '（自定义）', selected: true }));
        }
        const input = el('input', { class: 'mono', type: 'text', style: 'width:110px', placeholder: '或输入 ID', value: '' });
        input.addEventListener('input', () => { if (input.value.trim()) sel.value = input.value.trim(); });
        row.modelSel = sel;
        return el('tr', {},
          el('td', { class: 'small', text: def.label || task }),
          el('td', {}, el('div', { class: 'model-cell' }, sel, input)),
          el('td', {}, tempInput),
          el('td', {}, maxInput),
          el('td', {}, thinkSel),
          el('td', {}, effortSel),
        );
      }))),
  );
  // 分组 tab 容器
  const tabButtons = el('div', { class: 'settings-nav route-group-tabs' });
  const tabBody = el('div', { class: 'mt' });
  const activateGroup = (groupId) => {
    tabButtons.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.group === groupId));
    tabBody.innerHTML = '';
    const group = ROUTE_GROUPS.find(g => g.id === groupId);
    if (!Object.entries(s.defaults || {}).length) {
      tabBody.append(el('div', { class: 'muted', text: '服务端未返回任务列表——请重启服务器（关闭 start.bat 窗口后重新双击）后刷新页面' }));
      return;
    }
    if (group) tabBody.append(routeTableFor(group.tasks));
  };
  for (const g of ROUTE_GROUPS) {
    tabButtons.append(el('a', {
      href: 'javascript:void(0)', text: g.label, 'data-group': g.id,
      onclick: (ev) => { ev.preventDefault(); activateGroup(g.id); },
    }));
  }
  activateGroup(ROUTE_GROUPS[0].id);

  const routesCard = el('section', { id: 'sec-routes', class: 'card' },
    el('h3', { text: '模型路由（高级 · 按任务分组）' }),
    el('div', { class: 'small muted mb', text: `正文建议用 ${proName}（文笔），规则/审校/结算用 ${flashName}（控成本）。模型与当前实际生效值相同时不保存——服务商切换后默认路由自动跟随新预设。` }),
    tabButtons, tabBody,
    el('div', { class: 'row mt' },
      el('button', { class: 'primary sm', text: '保存路由', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const routes = {};
        for (const [task, r] of Object.entries(routeRows)) {
          const isWriting = task === 'write' || task === 'revise';
          const entry = {
            temperature: Math.min(2, Math.max(0, parseFloat(r.tempInput.value) || 0.7)),
            maxTokens: Math.min(32000, Math.max(256, parseInt(r.maxInput.value) || 4000)),
            thinking: r.thinkSel?.value || 'disabled',
            reasoningEffort: r.effortSel?.value || 'medium',
          };
          const effectiveModel = (s.resolvedModels || {})[task] || s.defaults[task]?.model;
          if (!isWriting && r.modelSel?.value && r.modelSel.value !== effectiveModel) {
            entry.model = r.modelSel.value;
          }
          routes[task] = entry;
        }
        try {
          await put('/api/settings', { routes });
          toast('路由已保存');
          await refreshGlobal();
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
      el('button', { class: 'sm', text: '重置默认', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          await put('/api/settings', { routes: {} });
          toast('已重置为默认路由');
          await refreshGlobal();
          renderSettings(view);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
    ),
  );
  view.append(el('details', { class: 'fold' },
    el('summary', {}, '高级 · 模型路由（每个任务单独配置）'),
    routesCard,
  ));

  // ============ ⑥ Embedding（结构保留） ============
  const emb = el('section', { id: 'sec-embedding', class: 'card' },
    el('h3', { text: '本地向量检索（embedding）' }),
  );
  const embStatus = await get(`/api/embedding/status`).catch(() => ({ status: {} }));
  const indexBookId = state.book?.id || lastBookId();
  const st = embStatus.status || {};
  emb.append(
    el('div', { class: 'row' },
      el('span', { class: 'tag ' + (st.ready ? 'done' : (st.error ? 'high' : 'outlined')), text: st.ready ? '已就绪' : (st.error ? '不可用（已降级为关键词检索）' : (st.loading ? `加载中 ${st.progress || 0}%` : '未初始化')) }),
      el('span', { class: 'small muted grow', text: `模型：${st.model || 'Xenova/bge-small-zh-v1.5'}（约 100MB，首次自动下载）｜向量数：${embStatus.vectors || 0}` }),
      el('button', { class: 'sm', text: '初始化 / 重试', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '加载中…';
        try {
          const r = await post(`/api/embedding/init`, { force: true });
          toast(r.status?.ready ? 'embedding 就绪' : '初始化失败：' + (r.status?.error || '未知'));
        } catch (e) { toast('初始化失败：' + e.message, 'error'); }
        btn.disabled = false; btn.textContent = '初始化 / 重试';
      } }),
      indexBookId ? el('button', { class: 'sm', text: '重建向量索引', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '索引中…';
        try {
          const r = await post(`/api/books/${indexBookId}/embedding/index`);
          toast(`索引完成：${r.indexed || 0} 条`);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false; btn.textContent = '重建向量索引';
      } }) : el('div', { class: 'small muted', text: '打开过作品后可在此重建该书向量索引。' }),
    ),
    st.error ? el('div', { class: 'small muted mt', text: '失败原因：' + st.error + '。没有向量检索时工具自动使用关键词检索，功能不受影响。' }) : null,
  );
  view.append(emb);

  // ============ ⑦ 数据与日志（结构保留） ============
  const dataCard = el('section', { id: 'sec-data', class: 'card' },
    el('h3', { text: '数据' }),
    el('div', { class: 'row' },
      el('button', { class: 'sm', text: '备份数据库', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const r = await post('/api/backup', {});
          toast(`已备份：${r.file}`);
        } catch (e) { toast(e.message, 'error'); }
        btn.disabled = false;
      } }),
      el('span', { class: 'small muted', text: '所有数据保存在本地 data/ 目录（novel.db），可直接复制备份。' }),
    ),
  );
  view.append(dataCard);

  // ---- 操作日志（保留） ----
  view.append(el('hr', {}), el('h3', { text: '操作日志' }));
  const logCard = el('div', { class: 'card' });
  const refreshLogs = async (category) => {
    const q = category ? `?category=${category}&limit=500` : '?limit=500';
    const r = await get(`/api/logs${q}`);
    logCard.innerHTML = '';
    logCard.append(
      el('div', { class: 'row mb' },
        el('span', { class: 'grow small muted', text: `共 ${r.total} 条（自动保留最近 2000 条）` }),
        el('select', { onchange: (ev) => refreshLogs(ev.target.value) },
          el('option', { value: '', text: '全部类别' }),
          el('option', { value: 'api', text: 'API 请求' }),
          el('option', { value: 'llm', text: 'AI 调用' }),
          el('option', { value: 'flow', text: '流程事件' }),
        ),
        el('button', { class: 'sm', text: '清空日志', onclick: async () => {
          if (!(await confirmDialog('确定清空全部操作日志？'))) return;
          await del('/api/logs');
          toast('日志已清空');
          refreshLogs();
        } }),
      ),
    );
    const tbl = el('table', { class: 'log-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: '时间' }), el('th', { text: '类别' }), el('th', { text: '操作' }),
        el('th', { text: '结果' }), el('th', { text: '耗时' }),
      )),
      el('tbody'),
    );
    const tbody = tbl.querySelector('tbody');
    for (const it of r.items) {
      const t = new Date(it.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const cls = it.level === 'error' ? 'tag tag-error' : it.level === 'warn' ? 'tag tag-warn' : 'tag';
      tbody.append(el('tr', {},
        el('td', { class: 'small muted', text: t }),
        el('td', {}, el('span', { class: cls, text: it.category })),
        el('td', { class: 'small', text: it.op }),
        el('td', { class: 'small', text: it.result + (it.detail ? ' ' + it.detail : '') }),
        el('td', { class: 'small muted', text: it.durationMs != null ? `${it.durationMs}ms` : '' }),
      ));
    }
    if (!r.items.length) tbody.append(el('tr', {}, el('td', { colspan: 5, class: 'muted', text: '暂无日志' })));
    logCard.append(tbl);
  };
  view.append(logCard);
  refreshLogs();
}
