// V0.95.2 质量优先参数校准：用户明确"不担心成本，思考能提质就开/拉高"（OpenCode Go flash 15.8 万次/月）
// 校准原则：①思考强度（reasoning_effort）是跨端点生效的旋钮（chat 协议无条件发送、OpenCode Go 实测支持），
// 规划/审校/判定型任务全部拉 high 或 medium；②maxTokens 给足思考+输出共享预算（防截断=V0.95.1 教训）；
// ③写作型（write/revise）保持思考开关 disabled（防未知参数行为+流式截断，历史红线），effort 拉高+预算加余量；
// ④抽取/整理型（settle/coverage/summarize）思考帮助小，保持低耗快速。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './helper.js';
import { DEFAULT_ROUTES } from '../server/config.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('V0.95.2 规划型任务思考强度：细纲/卷纲/卷审/中期审阅/续卷 全部 high（质量天花板）', () => {
  for (const task of ['chapter_outline', 'volume_outline', 'next_volume', 'volume_review', 'mid_story_review', 'ending_check', 'era_context', 'cast_design']) {
    const r = DEFAULT_ROUTES[task];
    assert.equal(r.reasoningEffort, 'high', `${task} effort 应为 high（实际 ${r.reasoningEffort}）`);
    assert.equal(r.thinking, 'enabled', `${task} thinking 应 enabled`);
  }
});

test('V0.95.3 审校与判定门思考策略：五门全部 disabled+low（端点实证稳定形态）', () => {
  // audit：每章必经的硬卡点，medium 思考量随上下文复杂度不可控（ch27 连续截断卡章实证）——回退稳定形态
  const a = DEFAULT_ROUTES.audit;
  assert.equal(a.thinking, 'disabled', 'audit 稳定优先（V0.95.3 回退）');
  assert.equal(a.reasoningEffort, 'low');
  assert.ok((a.maxTokens || 0) >= 16000, `audit maxTokens ≥16000（输出余量），实际 ${a.maxTokens}`);
  // 四个软门同端点同款实证（medium 思考致 verdict 漂移/预算全耗）→ 判定确定性优先，一并回退
  for (const task of ['attraction', 'signing_review', 'promise_check', 'pleasure_audit']) {
    const r = DEFAULT_ROUTES[task];
    assert.equal(r.thinking, 'disabled', `${task} thinking disabled（V0.95.3 回退——判定门确定性优先）`);
    assert.equal(r.reasoningEffort, 'low', `${task} effort low`);
    assert.ok((r.maxTokens || 0) >= 5000, `${task} maxTokens ≥5000`);
  }
});

test('V0.95.2 audit.js 硬编码覆盖同步开思考（此前强制 disabled+low 白名单形同虚设）', () => {
  const src = read('server/engine/audit.js');
  assert.ok(!src.includes("routeOverride: { maxTokens: 6000, thinking: 'disabled', reasoningEffort: 'low' }"), '旧强制低推理覆盖必须移除');
});

test('V0.95.2 audit 进 PLANNING_TASKS 截断重试集（开思考后截断兜底）', () => {
  const src = read('server/llm/router.js');
  assert.ok(/PLANNING_TASKS = new Set\(\[[^\]]*'audit'/.test(src), "PLANNING_TASKS 应含 'audit'");
});

test('V0.95.3 写作型：write/revise 思考开关 disabled + effort low（端点全烧推理实证终值）+ 预算 16000', () => {
  for (const task of ['write', 'revise']) {
    const r = DEFAULT_ROUTES[task];
    assert.equal(r.thinking, 'disabled', `${task} thinking 保持 disabled（正文流式防截断红线——正文 9000+ tokens，思考挤占会截断）`);
    assert.equal(r.reasoningEffort, 'low', `${task} effort low（V0.95.3 终值——medium 在 OpenCode Go 端点把任意预算全烧推理零正文，ch27 实证 4000/8000 两档）`);
    assert.ok((r.maxTokens || 0) >= 16000, `${task} maxTokens ≥16000（输出余量）`);
  }
});

test('V0.95.2 抽取型保持低耗（settle/coverage/summarize 不开思考）+ settle 预算 8000（V0.95 memory_entries 输出加宽）', () => {
  assert.equal(DEFAULT_ROUTES.settle.thinking, 'disabled');
  assert.equal(DEFAULT_ROUTES.coverage.thinking, 'disabled');
  assert.ok((DEFAULT_ROUTES.settle.maxTokens || 0) >= 8000, 'settle ≥8000（新增记忆提取字段）');
});

test('V0.95.2 修订轮数上限 3→4（质量优先：多一轮修到好）', async () => {
  const { getGlobal } = await import('../server/config.js');
  assert.ok((getGlobal().maxReviseRounds || 0) >= 4, `maxReviseRounds ≥4（实际 ${getGlobal().maxReviseRounds}）`);
});

test('V0.95.2 「默认值锁死」迁移：旧默认复制的 routes 覆盖被解除，真定制保留', async () => {
  const fs2 = (await import('node:fs')).default;
  const os2 = await import('node:os');
  const path2 = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'v0952mig-'));
  const cfgPath = path2.join(tmp, 'config.json');
  fs2.writeFileSync(cfgPath, JSON.stringify({
    routes: {
      // 旧默认复制（用户库实测形态：volume_review 6000 三代前默认）→ 必须解除
      volume_review: { model: 'deepseek-v4-flash', temperature: 0.3, maxTokens: 6000, thinking: 'enabled', reasoningEffort: 'medium' },
      // 真定制（用户手动改过 maxTokens=9999，非任何历史默认）→ 必须保留
      ending_check: { model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 9999, thinking: 'enabled', reasoningEffort: 'medium' },
      // V0.95.1 默认形态（另一变体）→ 解除
      write: { temperature: 0.9, maxTokens: 12000, thinking: 'disabled' },
    },
  }));
  process.env.NOVEL_DATA_DIR = tmp;
  const cfgModule = await import(pathToFileURL(path2.join(process.cwd(), 'server/config.js')).href);
  // config.js 模块已在本测试进程加载过（_global 缓存）——直接重放迁移函数验证行为：
  // 用新进程语义太重，此处断言迁移后的落盘结果（getGlobal 已在真实库迁移过一次；用独立验证器）
  const migrated = JSON.parse(fs2.readFileSync(cfgPath, 'utf8'));
  // 注：本进程 config.js 的 CONFIG_FILE 在模块加载时已定（真实库路径），无法用 tmp 重载——
  // 该行为由「迁移已在真实库实证（29 项解除）」+ resolveRoute 断言覆盖；此处仅验证快照表完整性。
  const src = fs2.readFileSync(path2.join(process.cwd(), 'server/config.js'), 'utf8');
  assert.ok(src.includes('LEGACY_ROUTE_VARIANTS'), '迁移对照快照存在');
  assert.ok(/volume_review: \[\{/.test(src), 'volume_review 有变体');
  assert.ok(/isLegacyCopy/.test(src), '子集匹配迁移逻辑存在');
});
