// V0.33：OpenCode Go 非流式长生成超时修复 + 推理预算修复
// ①非流式请求不再受 connectTimeout（20s）竞速限制——OpenAI 兼容端点非流式响应头=生成完成
// ②reasoning_effort 无条件发送（deepseekParams=false 也能抑制 flash 深度推理，防输出截断）
// ③旧 config resilience（20s/180s）启动时自动升级
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

describe('V0.33 非流式超时与推理预算修复', () => {
  test('buildRequestBody：deepseekParams=false 时 reasoning_effort 仍发送', async () => {
    const { buildRequestBody } = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    const body = buildRequestBody({
      model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.7, maxTokens: 100,
      stream: false, jsonMode: true, thinking: 'disabled', reasoningEffort: 'low',
      userId: 'bk-1', deepseekParams: false,
    });
    assert.equal(body.reasoning_effort, 'low', 'reasoning_effort 应无条件发送');
    assert.equal(body.thinking, undefined, 'deepseekParams=false 不发 thinking');
    assert.equal(body.user_id, undefined, 'deepseekParams=false 不发 user_id');
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  test('buildRequestBody：deepseekParams=true 时 thinking 为对象形式且 reasoning_effort 发送', async () => {
    const { buildRequestBody } = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    const body = buildRequestBody({
      model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.7, maxTokens: 100,
      stream: true, jsonMode: false, thinking: 'enabled', reasoningEffort: 'high',
      userId: 'bk-1', deepseekParams: true,
    });
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.user_id, 'bk-1');
    assert.equal(body.stream_options.include_usage, true);
  });

  test('buildRequestBody：qwenParams（阿里云百炼）按组合校验下发 enable_thinking/reasoning_effort', async () => {
    const { buildRequestBody } = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    // 端点强校验：enable_thinking=false 时 reasoning_effort 必须为 'none'，否则 400
    const off = buildRequestBody({
      model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'x' }], temperature: 0.7, maxTokens: 100,
      stream: true, jsonMode: false, thinking: 'disabled', reasoningEffort: 'high',
      deepseekParams: false, qwenParams: true,
    });
    assert.equal(off.enable_thinking, false);
    assert.equal(off.reasoning_effort, 'none', '关思考必须归一为 none（端点组合校验）');
    assert.equal(off.thinking, undefined, 'qwen 端点不发 DeepSeek thinking 对象');
    assert.equal(off.stream_options.include_usage, true, '流式必须请求 usage 帧（缓存命中统计）');
    const on = buildRequestBody({
      model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'x' }], temperature: 0.7, maxTokens: 100,
      stream: false, jsonMode: false, thinking: 'enabled', reasoningEffort: 'medium',
      deepseekParams: false, qwenParams: true,
    });
    assert.equal(on.enable_thinking, true);
    assert.equal(on.reasoning_effort, 'medium', '开思考透传档位');
    assert.equal(on.stream_options, undefined, '非流式不发 stream_options');
  });

  test('DEFAULT_ROUTES 全部任务含 reasoningEffort/maxTokens 充足（V0.46：effort 按任务类型分类）', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    const tasks = Object.keys(DEFAULT_ROUTES);
    assert.ok(tasks.length >= 17, `任务数 ${tasks.length}`);
    for (const [task, def] of Object.entries(DEFAULT_ROUTES)) {
      // V0.46：思考型任务 effort high/medium，写作/抽取型 low——只要求显式存在与合法
      assert.ok(['low', 'medium', 'high'].includes(def.reasoningEffort), `${task} reasoningEffort 应合法，实际 ${def.reasoningEffort}`);
      assert.ok(def.maxTokens >= 2000, `${task} maxTokens 应 >= 2000（防推理吃预算截断）`);
      assert.ok(def.thinking !== undefined, `${task} 应有显式 thinking`);
    }
    // 重点任务（V0.46 质量最优默认）
    assert.equal(DEFAULT_ROUTES.idea_amplify.maxTokens, 10000, 'idea_amplify maxTokens 10000（thinking 预算）');
    assert.equal(DEFAULT_ROUTES.book_outline.thinking, 'enabled', 'book_outline 应默认开思考');
    assert.equal(DEFAULT_ROUTES.write.thinking, 'disabled', 'write 应默认关 thinking（正文流利输出，防 reasoning 吃预算截断）');
    // V0.95.3 终值：write/revise effort low（medium 在 OpenCode Go 端点全烧推理零正文，ch27 实证）+ maxTokens 16000
    assert.equal(DEFAULT_ROUTES.write.reasoningEffort, 'low', 'write effort low（V0.95.3 终值——正文型任务端点稳定形态）');
    assert.ok(DEFAULT_ROUTES.write.maxTokens >= 16000, 'write maxTokens 应 >= 16000（high 推理留输出余量）');
  });

  test('旧 config resilience（20s/180s）启动时自动升级为 60s/300s', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v033-'));
    const oldEnv = process.env.NOVEL_DATA_DIR;
    process.env.NOVEL_DATA_DIR = tmp;
    fs.mkdirSync(path.join(tmp, '..', 'x'), { recursive: true });
    // 写旧 config
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
      provider: 'opencode_go',
      resilience: { connectTimeoutMs: 20000, idleTimeoutMs: 45000, totalTimeoutMs: 180000, maxRetries: 3 },
    }));
    // V0.73：?ts= 强制新模块实例——config.js 可能已被同文件其他测试 import（client.js 间接），
    // 模块缓存使 CONFIG_FILE 指向首个加载时的目录，改 env 后 getGlobal 读到的是旧路径。
    const { getGlobal } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')).href + '?ts=' + Date.now());
    const g = getGlobal();
    assert.equal(g.resilience.connectTimeoutMs, 60000, 'connectTimeout 应升级为 60000');
    assert.equal(g.resilience.totalTimeoutMs, 300000, 'totalTimeout 应升级为 300000');
    // 新版值不受影响
    process.env.NOVEL_DATA_DIR = oldEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
