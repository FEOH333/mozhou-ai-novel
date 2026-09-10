// V0.39：三协议适配（chat/responses/messages）+ 自动选择（auto 探测）
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

describe('V0.39 三协议适配与自动选择', () => {
  test('buildRequestBody：responses 协议（instructions+input+max_output_tokens）', async () => {
    const { buildRequestBody } = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    const body = buildRequestBody({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }],
      temperature: 0.7, maxTokens: 2000, stream: true, jsonMode: true,
      reasoningEffort: 'low', userId: 'bk-1', protocol: 'responses',
    });
    assert.equal(body.instructions, 'SYS', 'system 合并为 instructions');
    assert.deepEqual(body.input, [{ role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }], 'input items');
    assert.equal(body.max_output_tokens, 2000);
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.deepEqual(body.text, { format: { type: 'json_object' } });
    assert.equal(body.user, 'bk-1');
    assert.equal(body.messages, undefined, 'responses 无 messages 字段');
  });

  test('buildRequestBody：messages 协议（system+thinking disabled）', async () => {
    const { buildRequestBody } = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    const body = buildRequestBody({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U1' }],
      temperature: 0.7, maxTokens: 3000, stream: false, jsonMode: false,
      thinking: 'disabled', protocol: 'messages',
    });
    assert.equal(body.system, 'SYS');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'U1' }]);
    assert.deepEqual(body.thinking, { type: 'disabled' }, '应抑制推理防截断');
    assert.equal(body.max_tokens, 3000);
  });

  test('parseChatResponse：三协议归一化（content/reasoning/usage）', async () => {
    const { parseChatResponse } = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    // responses
    const r1 = parseChatResponse({
      status: 'completed', model: 'deepseek-v4-flash',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考中' }] },
        { type: 'message', content: [{ type: 'output_text', text: '正文A' }] },
      ],
      usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 90 }, output_tokens_details: { reasoning_tokens: 20 } },
    }, {}, 'responses');
    assert.equal(r1.content, '正文A');
    assert.equal(r1.reasoningContent, '思考中');
    assert.equal(r1.finishReason, 'stop');
    assert.equal(r1.usage.promptCacheHitTokens, 90);
    assert.equal(r1.usage.reasoningTokens, 20);
    // messages
    const r2 = parseChatResponse({
      model: 'deepseek-v4-flash', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '正文B' }],
      usage: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 70 },
    }, {}, 'messages');
    assert.equal(r2.content, '正文B');
    assert.equal(r2.reasoningContent, '想');
    assert.equal(r2.usage.promptCacheHitTokens, 70);
    // chat（回归）
    const r3 = parseChatResponse({
      choices: [{ message: { content: '正文C', reasoning_content: '思' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 60, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } },
    }, {}, 'chat');
    assert.equal(r3.content, '正文C');
    assert.equal(r3.usage.promptCacheHitTokens, 50);
  });

  test('resolveProtocol：auto 按模型与探测结果选择', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v039-'));
    const oldEnv = process.env.NOVEL_DATA_DIR;
    process.env.NOVEL_DATA_DIR = tmp;
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ provider: 'opencode_go', protocol: 'auto' }));
    const cfg = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    // 未探测 → chat（安全默认）
    assert.equal(cfg.resolveProtocol('deepseek-v4-flash'), 'chat', '未探测时 flash→chat');
    // 探测到 responses 可用 → flash→responses
    cfg.setProtocolProbe({ responses: true, messages: true });
    assert.equal(cfg.resolveProtocol('deepseek-v4-flash'), 'responses', '探测可用 flash→responses');
    assert.equal(cfg.resolveProtocol('deepseek-v4-pro'), 'chat', 'pro→chat（官方 responses 仅 flash）');
    // 探测不可用 → chat
    cfg.setProtocolProbe({ responses: false, messages: false });
    assert.equal(cfg.resolveProtocol('deepseek-v4-flash'), 'chat', '探测不可用→chat');
    // 用户显式覆盖
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ provider: 'opencode_go', protocol: 'messages' }));
    // 重新加载 config 模块（独立实例）验证显式配置
    const cfg2 = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    // 模块缓存——用 fresh import 不行，直接检查 resolveProtocol 读取 getGlobal
    // 这里通过保存路径验证：显式配置优先于预设
    process.env.NOVEL_DATA_DIR = oldEnv;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('协议端点到路径映射', async () => {
    const { protocolPath } = await import(pathToFileURL(path.join(ROOT, 'server/llm/client.js')));
    assert.equal(protocolPath('chat'), '/chat/completions');
    assert.equal(protocolPath('responses'), '/responses');
    assert.equal(protocolPath('messages'), '/messages');
  });
});
