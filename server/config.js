// server/config.js —— 全局配置（API Key、默认路由、参数）与作品级配置合并
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge } from './util/json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 支持测试隔离：NOVEL_DATA_DIR 环境变量覆盖数据目录
const DATA_DIR_OVERRIDE = process.env.NOVEL_DATA_DIR ? path.resolve(process.env.NOVEL_DATA_DIR) : null;
export const DATA_DIR = DATA_DIR_OVERRIDE || path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// V0.25：端口可用 NOVEL_PORT 覆盖（便于多开/测试隔离）
export const PORT = Number(process.env.NOVEL_PORT) || 8770;

/** 任务 → 默认模型/参数（正文用 pro，其余 flash；全部可被用户覆盖）。
 *  V0.32：全部任务 reasoningEffort:'low'——deepseek-v4-flash 默认 high 推理会吃掉输出预算
 *  （实测 2895/3000 tokens 被推理消耗致输出截断）；maxTokens 相应上调留足输出空间。 */
export const DEFAULT_ROUTES = {
  // V0.46 质量最优默认：按任务类型分类配置思考模式——
  //   思考型任务（规划/审校/评估/体检）：thinking enabled，低频一次性任务 effort high，高频流程任务 effort medium；
  //   写作型任务（正文/修订）：thinking disabled（流利输出 + 防 reasoning 吃输出预算截断）；
  //   抽取/轻量任务：thinking disabled + effort low。
  //   maxTokens 相应上调（thinking 会产生 reasoning tokens，防输出截断）。
  // 设置页可按任务手动覆盖。

  // ---- 思考型·一次性规划（effort high，低频高质量） ----
  worldbuild:      { model: 'deepseek-v4-flash', temperature: 0.8, maxTokens: 8000, thinking: 'enabled', reasoningEffort: 'high', label: '设定/世界观生成' },
  book_outline:    { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 12000, thinking: 'enabled', reasoningEffort: 'high', label: '书级大纲' }, // V0.95.2：12000
  book_contract:   { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 10000, thinking: 'enabled', reasoningEffort: 'high', label: '书契约' }, // V0.95.2：10000
  book_settings:   { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 12000, thinking: 'enabled', reasoningEffort: 'high', label: '设定生成' }, // V0.95.2：12000（设定是质量地基）
  pleasure_plan:   { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 10000, thinking: 'enabled', reasoningEffort: 'high', label: '书级快感计划' }, // V0.95.2：10000
  idea_amplify:    { model: 'deepseek-v4-flash', temperature: 0.8, maxTokens: 10000, thinking: 'enabled', reasoningEffort: 'high', label: '灵感诊断与提级' },
  contract_score:  { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 8000, thinking: 'enabled', reasoningEffort: 'high', label: '概念评分门' }, // V0.95.2：8000
  volume_outline_rewrite: { model: 'deepseek-v4-flash', temperature: 0.5, maxTokens: 10000, thinking: 'enabled', reasoningEffort: 'high', label: '卷大纲重写' }, // V0.95.1：6000→10000（重写整卷大纲，与 volume_outline 同量级）
  book_outline_rewrite:   { model: 'deepseek-v4-flash', temperature: 0.5, maxTokens: 10000, thinking: 'enabled', reasoningEffort: 'high', label: '书纲对齐' }, // V0.95.1：6000→10000（15 卷全书纲对齐输出长）
  narrative_plan_reconcile: { model: 'deepseek-v4-flash', temperature: 0.35, maxTokens: 12000, thinking: 'enabled', reasoningEffort: 'high', label: '返工后叙事规划对账' },
  cast_design:     { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 8000, thinking: 'enabled', reasoningEffort: 'high', label: '角色弧光补设计' }, // V0.95.2：开思考拉 high——角色弧光设计是人物质量的天花板
  roster_tidy:     { model: 'deepseek-v4-flash', temperature: 0.5, maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low', label: '角色库整理' },
  location_tidy:   { model: 'deepseek-v4-flash', temperature: 0.5, maxTokens: 4000, thinking: 'disabled', reasoningEffort: 'low', label: '地点库整理' }, // V0.71
  mid_story_review: { model: 'deepseek-v4-flash', temperature: 0.4, maxTokens: 10000, thinking: 'enabled', reasoningEffort: 'high', label: '中期审阅' }, // V0.95.2：effort→high+10000
  foreshadow_closure: { model: 'deepseek-v4-flash', temperature: 0.3, maxTokens: 5000, thinking: 'enabled', reasoningEffort: 'medium', label: '伏笔收束' }, // V0.95.2：low→medium+5000

  // ---- 思考型·高频流程（effort medium，质量与速度平衡） ----
  volume_outline:  { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 12000, thinking: 'enabled', reasoningEffort: 'high', label: '卷大纲' }, // V0.95.2：medium→high+12000（卷纲=整卷质量）
  chapter_outline: { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 15000, thinking: 'enabled', reasoningEffort: 'high', label: '章细纲' }, // V0.95.2：medium→high（细纲质量=正文质量）// V0.95.6：12000→15000（ch27 实证细纲 JSON 截断连败；PLANNING_TASKS +30% 兜底保留）
  audit:           { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 16000, thinking: 'disabled', reasoningEffort: 'low', label: '一致性审校' }, // V0.95.3：思考回退 disabled+low——审校是每章硬卡点，稳定性优先（medium 思考量随上下文复杂度不可控，16000 仍截断连续卡章实证）；预算 16000 保留
  audit_repair:    { model: 'deepseek-v4-flash', temperature: 0, maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low', label: '审校格式修复' }, // V0.95.3：2500→6000——修复器重排长 issues JSON 需与审计同量级（ch27 实证 2500 打满致二次解析报截断）
  volume_review:   { model: 'deepseek-v4-flash', temperature: 0.3, maxTokens: 12000, thinking: 'enabled', reasoningEffort: 'high', label: '卷级审阅' }, // V0.95.1 预算根修 + V0.95.2 effort→high（质量优先）
  ending_check:    { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 6000, thinking: 'enabled', reasoningEffort: 'high', label: '完本评估' }, // V0.95.2：high+6000
  next_volume:     { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 12000, thinking: 'enabled', reasoningEffort: 'high', label: '续卷大纲' }, // V0.95.2：high+12000（与 volume_outline 同权）

  // ---- 写作型（thinking disabled：流利输出 + 防截断） ----
  // V0.95.3：effort low 终值——V0.73 的 low→medium 校准在 OpenCode Go 端点被实证推翻：
  //   flash 模型 effort≥medium 时把任意 completion 预算全部烧成推理、正文为零（ch27 连环卡章），
  //   且 ch1-26 稳定期实际被 config.json 旧覆盖（V0.32 全 low 形态）保护，medium 从未真正生效。
  //   正文质量靠指令/纪律/审校闭环，不靠推理档位。
  write:           { model: 'deepseek-v4-pro',   temperature: 0.9, maxTokens: 16000, thinking: 'disabled', reasoningEffort: 'low', label: '场景正文' }, // V0.95.3 终值：effort low——ch27 连环实证 OpenCode Go 端点 flash 在 effort≥medium 时把任意 completion 预算全部烧成推理（4000/8000/16000 三档零正文、high 延迟翻倍连续超时）；回退 V0.32 稳定形态，正文质量靠指令/纪律/审校闭环
  revise:          { model: 'deepseek-v4-pro',   temperature: 0.7, maxTokens: 16000, thinking: 'disabled', reasoningEffort: 'low', label: '修订重写' }, // V0.95.3 终值：effort low（同 write——修订空结果连环卡章根因）

  // ---- V0.83：V0.80-0.82 新任务补路由（此前回退 write 路由：temp 0.9 高发散损害考据/判定/规划质量） ----
  // 历史考据：低温度高准确（史实年份/人物生死不容发散）
  era_context:     { model: 'deepseek-v4-flash', temperature: 0.3, maxTokens: 10000, thinking: 'enabled', reasoningEffort: 'high', label: '历史时代背景卡' }, // V0.95.2：high+10000（考据准确性优先）
  // 顶层规划（开篇蓝图是前20章质量天花板）：思考型高 effort
  opening_blueprint: { model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 12000, thinking: 'enabled', reasoningEffort: 'high', label: '开篇蓝图' }, // V0.95.2：12000（前20章质量天花板余量加足）
  story_promise:    { model: 'deepseek-v4-flash', temperature: 0.5, maxTokens: 8000, thinking: 'enabled', reasoningEffort: 'high', label: '书级创作宪章' },
  opening_diagnosis:{ model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 9000, thinking: 'enabled', reasoningEffort: 'high', label: '开篇实际正文诊断' },
  opening_strategy: { model: 'deepseek-v4-flash', temperature: 0.75, maxTokens: 7000, thinking: 'enabled', reasoningEffort: 'high', label: '开篇结构构思' },
  opening_candidate: { model: 'deepseek-v4-flash', temperature: 0.68, maxTokens: 8000, thinking: 'disabled', reasoningEffort: 'low', label: '开篇正文候选' },
  opening_candidate_audit: { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 7000, thinking: 'disabled', reasoningEffort: 'low', label: '开篇候选审校' },
  opening_candidate_compare: { model: 'deepseek-v4-flash', temperature: 0.1, maxTokens: 7000, thinking: 'disabled', reasoningEffort: 'low', label: '开篇匿名比较' },
  // 判定型任务：低温度稳定（判定波动会反复误判改稿）
  // V0.95.3：三判定门回退 disabled+low——audit 同款实证（medium 思考致 verdict 漂移/截断）在
  //   同端点同模型上；判定门要的是确定性，不是发散思考。预算 6000 保留。
  attraction:      { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low', label: '逐章吸引力门' }, // V0.95.3 回退
  signing_review:  { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low', label: '开篇文本发布前预审' }, // 只审文本证据，不预测平台结果
  promise_check:   { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low', label: '契约承诺核对' }, // V0.95.3 回退
  // 补救/规划型：思考型 medium
  growth_remedy:   { model: 'deepseek-v4-flash', temperature: 0.5, maxTokens: 8000, thinking: 'enabled', reasoningEffort: 'high', label: '成长补救桥段' }, // V0.95.2：high+8000
  world_progress:  { model: 'deepseek-v4-flash', temperature: 0.5, maxTokens: 8000, thinking: 'enabled', reasoningEffort: 'high', label: '世界展开补救' }, // V0.95.2：high+8000

  // ---- 抽取/轻量（thinking disabled） ----
  coverage:        { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low', label: '要点覆盖校验' }, // V0.85：3000→6000（模型输出 evidence 超长偶发截断 → 覆盖校验失败卡章）
  settle:          { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 8000, thinking: 'disabled', reasoningEffort: 'low', label: '章结算抽取' }, // V0.95.2：8000（V0.95 新增 memory_entries 输出字段）；抽取任务思考帮助小保持低耗
  archive:         { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 8000, thinking: 'disabled', reasoningEffort: 'low', label: '归档记忆融合' },
  summarize:       { model: 'deepseek-v4-flash', temperature: 0.4, maxTokens: 2000, thinking: 'disabled', reasoningEffort: 'low', label: '摘要压缩' },
  pleasure_audit:  { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 5000, thinking: 'disabled', reasoningEffort: 'low', label: '快感审计' }, // V0.95.3 回退：判定门确定性优先（同三判定门）
  book_title:      { model: 'deepseek-v4-flash', temperature: 0.9, maxTokens: 2000, thinking: 'disabled', reasoningEffort: 'low', label: 'AI 起名' },
  chapter_rename:  { model: 'deepseek-v4-flash', temperature: 0.6, maxTokens: 2000, thinking: 'disabled', reasoningEffort: 'low', label: '章节改名' },
  volume_rename:   { model: 'deepseek-v4-flash', temperature: 0.6, maxTokens: 2000, thinking: 'disabled', reasoningEffort: 'low', label: '卷改名' },
};

// V0.18：服务商预设（OpenAI 兼容端点一键切换）。
// models 映射：{flash, pro} 对应的模型 ID（两边官方目前同名；如未来改名只需改这里）。
// deepseekParams：是否发送 DeepSeek 专属参数（thinking/stream_options/user_id/reasoning_effort）。
export const PROVIDER_PRESETS = {
  deepseek_official: {
    label: 'DeepSeek 官方',
    desc: '按量计费；缓存命中输入仅 0.02 元/M（历史堆前缀复用成本极低，推荐）',
    keyHint: '可前往 platform.deepseek.com 获取 Key。',
    baseUrl: 'https://api.deepseek.com',
    models: { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro', flash41: 'deepseek-v4.1-flash-expires-on-0910' },
    deepseekParams: true,
  },
  opencode_go: {
    label: 'OpenCode Go（订阅）',
    desc: '订阅制（首月 $5、之后 $10/月）；DeepSeek V4 Flash 约 15.8 万次请求/月',
    keyHint: 'Key 在 opencode.ai/auth 登录后复制（需订阅 Go）。',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' },
    deepseekParams: false,
    protocol: 'chat', // V0.63：实测 opencode Go 的 responses 协议无前缀缓存（warm 请求 cached_tokens=0）→ 默认 chat 保缓存；auto 探测在此端点会误选 responses 致命中率暴跌
  },
  // V0.98.3：OpenCode Go 免费档（Ox Alpha Free，限时免费、1M 上下文）。高峰期易拥堵（429/中断），
  // 客户端已有分型退避重试 + 流空闲重试 + 空输出降档自愈兜底；计价记 0 元（cost.js 同步登记）。
  // V0.98.5 preferStream：实测该端点非流式长请求随机 500/503（同请求重放结果不定），
  // 流式通道独立且稳定（30k 输入 + 9000 输出全过）——默认走流式避开不稳定队列。
  // V0.98.13：思考档实测（V0.98.5/98.6 曾断言 high 烧光输出预算、medium→400——模型已换代）：
  //   low=3.3s 无思考；high=41-134s 思考拉满且 350 字段落完整输出（reasoning 348 字符与正文 1:1）；
  //   medium 仍 400（"always engages in thinking"）。结论：规划/设计类任务（thinking enabled 档）
  //   放行 high（用户实测：思考拉满才强）；判定门（low 档）保持 low；正文写作（write/revise，
  //   thinking disabled）维持关思考——正文型任务思考必吃输出预算的铁律不变。冗余代价是延迟
  //   10-40 倍：resilience 默认随之上调（connect/idle 90s、total 15min），见 DEFAULT_GLOBAL。
  opencode_go_free: {
    label: 'OpenCode Go 免费档（Ox Alpha Free）',
    desc: '限时免费模型（1M 上下文，思考拉满档更慢但更强；用得多时高峰期可能卡顿/中断，工具会自动重试）',
    keyHint: 'Key 在 opencode.ai/auth 登录后复制（与 Go 订阅同一入口，选本档即用免费模型）。',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: { flash: 'ox-alpha-free', pro: 'ox-alpha-free' },
    deepseekParams: false,
    protocol: 'chat',
    preferStream: true,
    reasoningEffortCap: 'high', // V0.98.13：high 实测可用且输出完整（思考拉满才强）；medium 仍 400→归并 high；low 判定门保持
    // V0.98.6：输出预算下限——实测该端点 max_tokens 上探 128k 均被接受；把规划/审校任务
    // 的 8k-15k 预算抬到下限，给结构化 JSON 留足余量（max_tokens 是上限不是目标，不增延迟）。
    maxTokensFloor: 16000,
  },
  // V0.100.1：OpenRouter（stealth/ox-alpha 限时免费，1M 上下文、128k 输出上限，计价记 0）。
  // 冒烟三件 2026-08-24 实测全过：/models 在列；微型补全与流式均 200（流式回 usage 帧）；
  // reasoning_effort 平铺字段 low/medium/high 全部接受——与 opencode 免费档 medium→400 不同，
  // 无需 reasoningEffortCap。免费档按日限请求数（未充值账户约 50 次/日），429 即当日额度用尽。
  openrouter: {
    label: 'OpenRouter（Ox Alpha 免费）',
    desc: '限时免费 stealth 模型（1M 上下文）；免费档有每日请求数上限，429 时次日再用或充值提额',
    keyHint: 'Key 在 openrouter.ai/keys 创建。',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: { flash: 'stealth/ox-alpha', pro: 'stealth/ox-alpha' },
    deepseekParams: false,
    protocol: 'chat',
    preferStream: true,
    maxTokensFloor: 16000,
  },
  // V0.100.2：阿里云百炼 MaaS 兼容端点（OpenRouter 免费档下架后的替换）。冒烟三件
  // 2026-08-27 实测全过：/models 在列（qwen3.8-flash）；微型补全非流式/流式均 200
  // （流式末帧回 usage，含 prompt_tokens_details.cached_tokens 命中统计）；专属参数
  // 校验严格——enable_thinking:false 时 reasoning_effort 必须为 'none'，启用时
  // low/medium/high 均接受（client.js qwenParams 分支按此组合下发）。
  aliyun_maas: {
    label: '阿里云百炼（qwen3.8-flash）',
    desc: '阿里云 MaaS 兼容端点；支持前缀缓存（命中输入价更低，usage 回报 cached_tokens）；计价为公价估算，以控制台为准',
    keyHint: 'Key 在阿里云百炼控制台获取（DASHSCOPE_API_KEY）。',
    baseUrl: 'https://ws-tdcq33zucatq1uxw.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    models: { flash: 'qwen3.8-flash', pro: 'qwen3.8-flash' },
    deepseekParams: false,
    protocol: 'chat',
    preferStream: true,
    qwenParams: true,
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    desc: '任意 OpenAI 兼容端点：one-api/new-api 类中转或其他厂商',
    keyHint: 'Key 由你的中转/服务商控制台提供。',
    baseUrl: 'https://api.deepseek.com',
    models: { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' },
    deepseekParams: true,
  },
};

// V0.18：正文模型档位。DeepSeek V4 Pro 正式版尚未发布（当前为预览版，表现不如 Flash），
// 默认全部任务用 Flash；Pro 正式版发布后切到 'pro' 即可（正文/修订自动改用 Pro）。
export const WRITING_MODEL_PRESETS = {
  flash: {
    label: '全部用 V4 Flash（当前推荐）',
    desc: 'V4 Pro 正式版未发布，预览版表现不如 Flash；Flash 也最便宜、额度最大',
  },
  pro: {
    label: 'Pro 写正文（V4 Pro 正式版发布后）',
    desc: '正文与修订重写用 V4 Pro（质量上限更高），规划/审校/结算仍用 Flash',
  },
};

export const DEFAULT_GLOBAL = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  // V0.18：服务商预设与模型档位
  provider: 'deepseek_official',   // deepseek_official | opencode_go | custom
  protocol: 'chat',                // V0.63：默认 chat（实测 opencode Go 的 responses 协议无前缀缓存，auto 探测会误选 responses → 命中率暴跌；chat 协议缓存实测 100% 命中）
  writingModel: 'flash',           // flash（推荐，当前） | pro（V4 Pro 正式版发布后）
  deepseekParams: true,            // 是否发送 DeepSeek 专属参数（thinking/user_id/stream_options）；OpenCode Go 等需关
  // V0.109：备用 API 通道（动态编排）——主端点卡顿/熔断/失效时自动切换，主端点恢复后探针回切。
  // 默认 DeepSeek 官方 V4.1 Flash 内测（2026-09-08 公告：无需改 base_url 只换模型 ID，计费与 V4 Flash 一致）。
  // 切换策略（用户已定）：请求内快切 + 粘性窗口（stickyMs 内新请求直走备用）+ 60s 探针自动回切；
  // 备用连续失败 3 次自身熔断（防双端点循环打转）；AUTH_ERROR 不切（Key 错误切了也一样错）。
  backup: {
    enabled: false,
    provider: 'deepseek_official',
    apiKey: '',
    modelMap: { flash: 'deepseek-v4.1-flash-expires-on-0910', pro: 'deepseek-v4.1-flash-expires-on-0910' },
    stickyMs: 5 * 60 * 1000,      // 粘性窗口：切换后备用持续接管时长
    probeIntervalMs: 60 * 1000,   // 回切探针最小间隔
    failureThreshold: 3,          // 备用连续失败自身熔断阈值
  },
  // 任务路由覆盖（空对象 = 全部用默认）
  routes: {},
  // 写作流程（V0.47 质量优先：不怕时间长，就怕质量差——充足冗余）
  contextBudgetTokens: 500000,   // 历史堆预算（V0.47：400K→500K，更大记忆窗口提升一致性；V4 上下文 1M 留输出余量）
  autoConfirmOutline: true,      // AI 本位：细纲默认自动确认（专家模式可关）
  maxReviseRounds: 4,            // 每章修订轮数上限（V0.47：2→3；V0.95.2：3→4，质量优先多一轮修到好）
  autoHealLength: true,          // 场景长度自愈（不足续写/超限压缩）
  // V0.21：API 韧性层（防卡顿卡死；V0.47 超时上调——长正文生成不因超时截断）
  resilience: {
    connectTimeoutMs: 90000,     // 首字节超时（V0.98.13：免费档 high 思考任务 TTFB 实测 40s+，90s 才留足冗余）
    idleTimeoutMs: 90000,        // 流空闲超时（V0.98.13：思考段流间隙比正文更长，60→90s）
    totalTimeoutMs: 900000,      // 单次请求总时长（V0.95.3：420→600s；V0.98.13：600→900s——high 思考长任务实测 134s/300字，书纲卷纲级思考+输出可达 10 分钟）
    maxRetries: 3,               // 智能重试次数（5xx/网络/卡死；4xx 不重试）
    rateLimitMaxRetries: 20,     // V0.100.1→V0.100.2：429 限流独立耐心预算 8→20（上游共享池窗口实测可持续一小时以上；20 次×退避封顶 120s ≈ 最长约 40 分钟等待/请求，等待零费用；熔断开窗等待也计入本预算。超出由断点续跑接管，终态消息提示稍后从断点继续）
    networkMaxRetries: 10,       // V0.100.2：网络中断独立耐心预算（DNS/断网/代理抖动；家用断网窗口以分钟计，快速退避无意义。退避 20s→120s 封顶 ≈ 最长约 15 分钟等待/请求）
    networkBackoffMs: 20000,     // 网络中断退避基数（×已重试次数，封顶 120s）
    circuitBreaker: { threshold: 3, openMs: 60000, maxOpenMs: 600000 }, // 连续失败熔断（开窗后由耐心预算等待恢复，不再即死）
  },
  // V0.16：上下文自动归档（防降智）
  archiveStrategy: 'auto',       // auto 自动 | prompt 提示 | off 关闭
  archiveRatio: 0.85,            // 历史 tokens ≥ budget×ratio 时归档（0.85 已留足余量，过早归档反而丢细节）
  keepRecentChapters: 15,        // 保留最近 N 章全文不归档（V0.47：10→15，更多原文保留提升细节一致）
  // V0.16：漂移检测与自动恢复
  consecutiveFailures: 2,        // 连续失败 N 章触发全局诊断
  highIssueThreshold: 3,         // 近 3 章 high 级问题 ≥ N 触发
  maxRecoveryRounds: 3,          // 最大恢复轮数（V0.47：2→3，多一次自动恢复机会再人工出口）
  // 检索（V0.47：topK 6→10，事实召回更多提升一致性）
  retrieval: { topK: 10, chunkWords: 512, overlapWords: 64 },
  worldbookBudgetTokens: 4000,   // V0.47：2000→4000，世界书注入更多设定词条（设定一致性优先）
  // embedding
  embedding: { enabled: true, model: 'Xenova/bge-small-zh-v1.5', quantized: true, remoteHost: '' },
  // 缓存告警阈值
  cacheWarnRatio: 0.7,
  // V0.80：开篇吸引力增强（番茄签约导向）
  attractionGate: 'soft',           // 逐章吸引力门：soft（番茄 hard，其他 soft）| hard | off（普通平台零成本跳过 LLM）
  signingReviewCharThreshold: 25000, // 签约模拟评审触发字数（≈ 前 15-20 章）
  openingBlueprintChapters: 20,     // 开篇蓝图覆盖章数
};


/**
 * V0.95.2：「默认值锁死」迁移对照快照——历史版本曾把当时的默认路由原样写入
 * config.json 的 routes（实测用户库 29 个任务全字段覆盖），导致此后 DEFAULT_ROUTES
 * 的任何调优被这层"假定制"挡掉。getGlobal 加载时：覆盖的字段集是任一变体的子集
 * 且值全等 → 视为从未定制 → 删除让新默认生效（有真定制差异则原样保留）。
 * 变体来源：用户库观测值（旧默认复制的实际形态）+ V0.95.1 校准前默认。
 */
const LEGACY_ROUTE_VARIANTS = {
  worldbuild: [{'model': "deepseek-v4-flash", 'temperature': 0.8, 'maxTokens': 8000, 'thinking': "enabled"}],
  book_outline: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 8000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 10000, 'thinking': "enabled", 'reasoningEffort': "high"}],
  book_contract: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 7000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 7000, 'thinking': "enabled", 'reasoningEffort': "high"}],
  book_settings: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 8000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 8000, 'thinking': "enabled", 'reasoningEffort': "high"}],
  pleasure_plan: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 7000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 7000, 'thinking': "enabled", 'reasoningEffort': "high"}],
  idea_amplify: [{'model': "deepseek-v4-flash", 'temperature': 0.8, 'maxTokens': 10000, 'thinking': "enabled"}],
  contract_score: [{'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 6000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 6000, 'thinking': "enabled", 'reasoningEffort': "high"}],
  volume_outline_rewrite: [{'model': "deepseek-v4-flash", 'temperature': 0.5, 'maxTokens': 6000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.5, 'maxTokens': 10000, 'thinking': "enabled", 'reasoningEffort': "high"}],
  book_outline_rewrite: [{'model': "deepseek-v4-flash", 'temperature': 0.5, 'maxTokens': 6000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.5, 'maxTokens': 10000, 'thinking': "enabled", 'reasoningEffort': "high"}],
  cast_design: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 4000, 'thinking': "disabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 4000, 'thinking': "disabled", 'reasoningEffort': "low"}],
  roster_tidy: [{'model': "deepseek-v4-flash", 'temperature': 0.5, 'maxTokens': 6000, 'thinking': "disabled"}],
  location_tidy: [{'model': "deepseek-v4-flash", 'temperature': 0.5, 'maxTokens': 4000, 'thinking': "disabled"}],
  mid_story_review: [{'model': "deepseek-v4-flash", 'temperature': 0.4, 'maxTokens': 4000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.4, 'maxTokens': 8000, 'thinking': "enabled", 'reasoningEffort': "medium"}],
  foreshadow_closure: [{'model': "deepseek-v4-flash", 'temperature': 0.3, 'maxTokens': 3000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.3, 'maxTokens': 3000, 'thinking': "enabled", 'reasoningEffort': "low"}],
  volume_outline: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 8000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 8000, 'thinking': "enabled", 'reasoningEffort': "medium"}],
  chapter_outline: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 12000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 12000, 'thinking': "enabled", 'reasoningEffort': "medium"}],
  audit: [{'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 6000, 'thinking': "disabled", 'reasoningEffort': "low"}],
  volume_review: [{'model': "deepseek-v4-flash", 'temperature': 0.3, 'maxTokens': 6000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.3, 'maxTokens': 12000, 'thinking': "enabled", 'reasoningEffort': "medium"}],
  ending_check: [{'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 3000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 3000, 'thinking': "enabled", 'reasoningEffort': "medium"}],
  next_volume: [{'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 5000, 'thinking': "enabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.7, 'maxTokens': 8000, 'thinking': "enabled", 'reasoningEffort': "medium"}],
  write: [{'temperature': 0.9, 'maxTokens': 12000, 'thinking': "disabled"}, {'model': "deepseek-v4-pro", 'temperature': 0.9, 'maxTokens': 12000, 'thinking': "disabled", 'reasoningEffort': "medium"}],
  revise: [{'temperature': 0.7, 'maxTokens': 12000, 'thinking': "disabled"}, {'model': "deepseek-v4-pro", 'temperature': 0.7, 'maxTokens': 12000, 'thinking': "disabled", 'reasoningEffort': "medium"}],
  coverage: [{'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 3000, 'thinking': "disabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 6000, 'thinking': "disabled", 'reasoningEffort': "low"}],
  settle: [{'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 6000, 'thinking': "disabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 6000, 'thinking': "disabled", 'reasoningEffort': "low"}],
  summarize: [{'model': "deepseek-v4-flash", 'temperature': 0.4, 'maxTokens': 2000, 'thinking': "disabled"}],
  pleasure_audit: [{'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 3000, 'thinking': "disabled"}, {'model': "deepseek-v4-flash", 'temperature': 0.2, 'maxTokens': 3000, 'thinking': "disabled", 'reasoningEffort': "low"}],
  book_title: [{'model': "deepseek-v4-flash", 'temperature': 0.9, 'maxTokens': 2000, 'thinking': "disabled"}],
  chapter_rename: [{'model': "deepseek-v4-flash", 'temperature': 0.6, 'maxTokens': 2000, 'thinking': "disabled"}],
  volume_rename: [{'model': "deepseek-v4-flash", 'temperature': 0.6, 'maxTokens': 2000, 'thinking': "disabled"}],
};

let _global = null;

/**
 * V0.109.1：密钥环境变量覆盖——磁盘上不再需要以明文保存 API Key。
 *
 * 优先顺序：环境变量 > config.json。只在环境变量**非空**时覆盖，因此：
 * - 没设环境变量的老用户完全零影响；
 * - 想改 Key 时改环境变量即可，不必动配置文件；
 * - 前端设置页仍可写 config.json，但一旦设了环境变量就以后者为准（避免两处真源打架，
 *   与项目「单一真源」原则一致）。
 *
 * 支持两个变量：
 *   NOVEL_API_KEY          → 主端点 apiKey
 *   NOVEL_BACKUP_API_KEY   → 备用端点 backup.apiKey
 */
function applySecretEnvOverrides(global) {
  const primary = String(process.env.NOVEL_API_KEY || '').trim();
  if (primary) global.apiKey = primary;
  const backup = String(process.env.NOVEL_BACKUP_API_KEY || '').trim();
  if (backup) {
    global.backup = { ...(global.backup || {}), apiKey: backup };
  }
  return global;
}

export function getGlobal() {
  if (_global) return _global;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* 首次运行无配置文件 */ }
  _global = deepMerge(DEFAULT_GLOBAL, disk);
  _global = applySecretEnvOverrides(_global);
  // V0.98.13：旧版韧性假定制迁移（V0.47 默认组合写入的 resilience 挡住 V0.95.3/V0.98.13 调优）
  _global = migrateLegacyResilience(_global);
  // V0.32：旧版持久化的韧性参数升级（V0.29 前默认 20s/180s 会误杀 OpenCode Go 非流式长生成任务，
  // 如 idea_amplify 输出 3000 tokens 生成 20-60s）；非流式请求已不受 connectTimeout 限制，
  // 但统一把连接超时/总时长提到新版默认更稳妥。
  if (_global.resilience && _global.resilience.connectTimeoutMs <= 20000 && _global.resilience.totalTimeoutMs <= 180000) {
    _global.resilience.connectTimeoutMs = 60000;
    _global.resilience.totalTimeoutMs = 300000;
  }
  // V0.95.2：解除「默认值锁死」迁移——旧版本把当时的默认路由原样写入 config.json 的 routes
  // （实测用户库：29 个任务的全字段覆盖，与旧默认逐字段一致），此后 DEFAULT_ROUTES 的任何
  // 调优（如 V0.95.1 卷审 6000→12000）都被这层"假定制"覆盖挡掉、对实际运行零生效。
  // 迁移规则：覆盖对象与 LEGACY_ROUTE_DEFAULTS 快照（V0.95.1 默认）逐字段全等 = 从未定制
  // → 删除该项让新默认生效；有任何差异（用户真改过）→ 原样保留。一次性、幂等、落盘。
  if (_global.routes && typeof _global.routes === 'object') {
    let migrated = false;
    for (const task of Object.keys(_global.routes)) {
      const override = _global.routes[task];
      if (!override || typeof override !== 'object') continue;
      const variants = LEGACY_ROUTE_VARIANTS[task];
      if (!variants) continue;
      const keys = Object.keys(override);
      const isLegacyCopy = keys.length > 0 && variants.some(v =>
        keys.every(k => k in v && override[k] === v[k]));
      if (isLegacyCopy) {
        delete _global.routes[task];
        migrated = true;
      }
    }
    if (migrated) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(_global, null, 2), { mode: 0o600 });
      } catch { /* 落盘失败仅本次会话生效（内存已迁移） */ }
    }
  }
  return _global;
}

/** 保存全局配置（apiKey 单独处理，不回显给前端） */
export function saveGlobal(patch) {
  const cur = getGlobal();
  const merged = deepMerge(cur, patch || {});
  const persisted = stripSecretEnvOverrides(merged);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  _global = merged;
  return merged;
}

/** 落盘视图：把环境变量接管过的密钥字段换回磁盘原值（读不到磁盘值则留空）。 */
function stripSecretEnvOverrides(global) {
  if (!String(process.env.NOVEL_API_KEY || '').trim()
    && !String(process.env.NOVEL_BACKUP_API_KEY || '').trim()) return global;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* 无配置即空 */ }
  const out = { ...global };
  if (String(process.env.NOVEL_API_KEY || '').trim()) out.apiKey = disk.apiKey || '';
  if (String(process.env.NOVEL_BACKUP_API_KEY || '').trim()) {
    out.backup = { ...(out.backup || {}), apiKey: disk.backup?.apiKey || '' };
  }
  return out;
}

/** 当前服务商预设信息（含默认模型映射与专属参数开关） */
export function providerInfo() {
  const g = getGlobal();
  return { id: g.provider, ...(PROVIDER_PRESETS[g.provider] || PROVIDER_PRESETS.custom) };
}

/** V0.98.4 设置页展示真源：每个任务在当前服务商下实际运行的模型名（显示即运行时真相，不显示原始默认名）。 */
export function resolvedRouteModels(g = getGlobal()) {
  return Object.fromEntries(Object.entries(DEFAULT_ROUTES).map(([task, def]) =>
    [task, resolveModelName(task, (g.routes || {})[task]?.model ?? def.model, g)]));
}

/** V0.98.4 正文模型档位文案按当前服务商实际模型名生成；flash/pro 同模型时折叠为单档（免费档场景）。 */
export function writingModelPresetsFor(g = getGlobal()) {
  const preset = PROVIDER_PRESETS[g.provider] || PROVIDER_PRESETS.custom;
  const flash = preset.models?.flash || 'deepseek-v4-flash';
  const pro = preset.models?.pro || 'deepseek-v4-pro';
  if (flash === pro) {
    return {
      flash: { label: `全部任务用 ${flash}`, desc: '当前服务商 flash/pro 映射到同一模型；如需差异化请在下方路由表手动指定。' },
    };
  }
  return {
    flash: { label: `全部用 ${flash}`, desc: '正文与其余任务同模型（当前服务商 flash 档）' },
    pro: { label: `正文用 ${pro}`, desc: `write/revise 用 ${pro}（质量上限更高），其余任务仍用 ${flash}` },
  };
}

/**
 * V0.98.5 按服务商收敛 reasoning_effort（参数跟端点走）。
 * V0.98.13 实测更新：OpenCode Go 免费档（ox-alpha-free）medium 仍 HTTP 400
 * （"always engages in thinking"），但 high 已可用且输出不被吃空（思考拉满才强）——
 * cap='high' 时 medium 归并 high（规划类任务吃满思考），low 保持（判定门确定性优先）；
 * 其他端点维持"只降不升"。
 */
const EFFORT_RANK = { low: 0, medium: 1, high: 2 };
export function capReasoningEffort(effort, g = getGlobal()) {
  const preset = PROVIDER_PRESETS[g.provider] || PROVIDER_PRESETS.custom;
  const cap = preset.reasoningEffortCap;
  const value = effort || 'high';
  if (!cap) return value;
  if (value === 'medium' && cap === 'high') return 'high'; // V0.98.13：free 档 medium→400，归并思考拉满
  return (EFFORT_RANK[value] ?? 2) > (EFFORT_RANK[cap] ?? 2) ? cap : value;
}

/**
 * V0.98.13 旧版韧性假定制迁移：V0.47 及更早版本把默认 resilience（60s/60s/420s/3 重试 + 熔断
 * 3/60s/600s）原样写入 config.json，此后调优（V0.95.3 totalTimeout 420→600s、V0.98.13 →900s、
 * V0.100.1/2 限流耐心预算 8→20）都被这层"假定制"覆盖挡掉。迁移规则：与任一已知旧默认变体
 * 逐字段全等 = 从未定制 → 替换为新默认；有任何差异（用户真改过）→ 原样保留。纯函数（可测）。
 */
export function migrateLegacyResilience(global) {
  const legacyVariants = [
    // V0.47 及更早
    {
      connectTimeoutMs: 60000, idleTimeoutMs: 60000, totalTimeoutMs: 420000, maxRetries: 3,
      circuitBreaker: { threshold: 3, openMs: 60000, maxOpenMs: 600000 },
    },
    // V0.98.13（无限流独立预算字段）
    {
      connectTimeoutMs: 90000, idleTimeoutMs: 90000, totalTimeoutMs: 900000, maxRetries: 3,
      circuitBreaker: { threshold: 3, openMs: 60000, maxOpenMs: 600000 },
    },
    // V0.100.1（限流耐心预算 8）
    {
      connectTimeoutMs: 90000, idleTimeoutMs: 90000, totalTimeoutMs: 900000, maxRetries: 3,
      rateLimitMaxRetries: 8,
      circuitBreaker: { threshold: 3, openMs: 60000, maxOpenMs: 600000 },
    },
  ];
  const current = global?.resilience;
  if (!current || typeof current !== 'object') return global;
  const keys = Object.keys(current);
  const isLegacyCopy = keys.length > 0 && legacyVariants.some(shape =>
    keys.every(k => k in shape && JSON.stringify(current[k]) === JSON.stringify(shape[k])));
  if (isLegacyCopy) {
    return { ...global, resilience: structuredClone(DEFAULT_GLOBAL.resilience) };
  }
  return global;
}

/** 协议探测结果缓存（内存；由 router 首次调用时懒探测填充） */
let protocolProbeCache = null;
export function setProtocolProbe(probe) { protocolProbeCache = probe; }
export function getProtocolProbe() { return protocolProbeCache; }
// V0.73：已实际使用过的协议（首个请求锁定）——防止 auto 模式下探测完成 chat→responses 中途
// 漂移（请求体/消息格式不同 → 历史堆前缀格式变化 → 缓存全量 miss 一次）
let usedProtocol = null;
export function setUsedProtocol(p) { if (p) usedProtocol = p; }

/**
 * V0.39：解析请求协议（chat|responses|messages）。
 * 优先级：用户显式配置 protocol > 服务商预设 protocol > auto > 已锁定协议。
 * auto 规则（实测 OpenCode Go 三协议均可用、缓存命中一致）：
 *   - 探测到 /responses 可用且任务用 flash → responses（官方主推、语义化流式事件、推理与正文天然分离）
 *   - pro 模型 → chat（DeepSeek 官方 Responses API 目前仅支持 flash）
 *   - 未探测/不可用 → chat（最成熟、全兼容、兜底）
 * V0.73：一旦某协议已被实际请求使用，auto 后续一律沿用该协议（协议漂移=前缀缓存全量重建）。
 */
export function resolveProtocol(model = '') {
  const g = getGlobal();
  const preset = PROVIDER_PRESETS[g.provider] || PROVIDER_PRESETS.custom;
  const p = g.protocol ?? preset.protocol ?? 'auto';
  if (p !== 'auto') return p;
  if (usedProtocol) return usedProtocol; // V0.73：已锁定，不再漂移
  const probe = protocolProbeCache;
  if (/pro/i.test(model)) return 'chat';
  if (probe?.responses === true && g.provider !== 'custom') return 'responses';
  return 'chat';
}

/**
 * 作品级设置合并：作品设置 > 全局路由覆盖 > 默认路由
 * V0.18：模型名按服务商预设映射；write/revise 受 writingModel 档位控制（除非用户显式覆盖了该任务模型）
 */
export function resolveRoute(task, bookSettings = {}) {
  const g = getGlobal();
  // 路由必须按字段合并；此前 task 对象被整体替换，用户只改 maxTokens 就会丢失
  // reasoningEffort/thinking，随后 router 回退 high，结构化审校把输出预算全耗在推理上。
  const fallback = DEFAULT_ROUTES[task] || DEFAULT_ROUTES.write;
  const route = {
    ...fallback,
    ...((g.routes || {})[task] || {}),
    ...((bookSettings.routes || {})[task] || {}),
  };
  // V0.98.6：服务商输出预算下限（免费档实测大 max_tokens 完全可用，见 PROVIDER_PRESETS 注释）。
  const floor = Number((PROVIDER_PRESETS[g.provider] || PROVIDER_PRESETS.custom).maxTokensFloor || 0);
  if (floor > 0) route.maxTokens = Math.max(Number(route.maxTokens) || 0, floor);
  return { ...route, model: resolveModelName(task, route.model, g, bookSettings) };
}

/** 模型名解析：默认 flash/pro 名 → 按服务商映射；用户自定义 ID 保持原样 */
export function resolveModelName(task, model, g = getGlobal(), bookSettings = {}) {
  const preset = PROVIDER_PRESETS[g.provider] || PROVIDER_PRESETS.custom;
  const map = preset.models || { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' };
  const userOverrides = { ...(g.routes || {}), ...(bookSettings.routes || {}) };
  const isWriting = task === 'write' || task === 'revise';
  // 正文任务且用户未显式覆盖 → 跟随 writingModel 档位
  if (isWriting) {
    // V0.83 防御：仅当显式覆盖了"非默认档位"的模型名才尊重覆盖——防止旧路由缓存把 pro/flash 锁死
    const u = userOverrides[task]?.model;
    const isExplicit = u && u !== 'deepseek-v4-pro' && u !== 'deepseek-v4-flash';
    if (!isExplicit) {
      return g.writingModel === 'pro' ? (map.pro || 'deepseek-v4-pro') : (map.flash || 'deepseek-v4-flash');
    }
    // 显式第三方模型名（如 glm-5/kimi）→ 尊重用户选择
    return u;
  }
  // 默认模型名 → 按服务商映射（两端目前同名；未来改名只需改 PROVIDER_PRESETS）
  if (model === 'deepseek-v4-flash') return map.flash || model;
  if (model === 'deepseek-v4-pro') return map.pro || model;
  return model;
}

/**
 * V0.100.1：连接测试的模型选择——优先当前服务商的运行时真值（§6.8：显示即运行时真相，
 * 测试同理，必须测实际会跑的那个模型）；DeepSeek 裸名仅作历史回退，最后兜底 resolved 本身。
 * 旧逻辑硬编码 DeepSeek 名单、找不到就 models[0]——在 OpenRouter 上误测无关模型，
 * 触发数据政策 404 误报"模型未开通"。
 */
export function pickTestModel(models, g = getGlobal()) {
  const list = Array.isArray(models) ? models : [];
  const resolved = resolveModelName('write', 'deepseek-v4-pro', g);
  return [resolved, 'deepseek-v4-flash', 'deepseek-v3.2', 'deepseek-chat'].find(m => list.includes(m)) || resolved || list[0];
}

/**
 * V0.109：备用通道完整调用参数解析（纯函数，router 切换引擎消费）。
 * 返回 null = 备用不可用（未启用/无 Key）；否则返回 { baseUrl, apiKey, model, deepseekParams,
 * qwenParams, protocol } —— deepseekParams/qwenParams/protocol 按备用 provider 预设重算
 * （主备服务商参数开关可以不同：阿里云 qwenParams / DeepSeek 官方 deepseekParams）。
 * 模型映射：主通道模型按主 provider 档位归属（pro 档 → 备用 pro 档；flash 系/其余 → 备用
 * flash 档）——主备模型名不同（qwen3.8-flash ≠ deepseek-v4.1-flash），按档位换算而非名字匹配。
 */
export function resolveBackupRoute(task, primaryModel, g = getGlobal(), bookSettings = {}) {
  const backup = g.backup || {};
  if (!backup.enabled || !backup.apiKey) return null;
  const preset = PROVIDER_PRESETS[backup.provider] || PROVIDER_PRESETS.deepseek_official;
  const map = backup.modelMap || {};
  // 主通道模型档位归属：主 provider 预设的 pro 档位（或名字带 pro）→ 备用 pro 档；其余（flash 系/
  // 未命中）→ 备用 flash 档。不能按备用映射值集合匹配——主备服务商模型名不同（qwen3.8-flash ≠
  // deepseek-v4.1-flash），值匹配会让主通道模型原样传到备用端点必然 404。
  // 注意：阿里云等预设 flash/pro 同名（都映射 qwen3.8-flash）——pro 档判断必须先排除"就是 flash 档值"，
  // 否则 flash 模型被误判为 pro 档。
  const primaryPreset = PROVIDER_PRESETS[g.provider] || PROVIDER_PRESETS.custom;
  const isPro = primaryModel !== primaryPreset.models?.flash && primaryModel === primaryPreset.models?.pro
    || (/-pro\b|pro$/.test(String(primaryModel || '')) && primaryModel !== primaryPreset.models?.flash);
  const model = (isPro ? map.pro : map.flash) || map.flash || primaryModel;
  return {
    baseUrl: preset.baseUrl,
    apiKey: backup.apiKey,
    model,
    deepseekParams: preset.deepseekParams !== false,
    qwenParams: preset.qwenParams === true,
    protocol: preset.protocol || 'chat',
  };
}
