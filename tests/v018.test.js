// V0.18 测试：服务商预设切换/正文模型档位/DeepSeek 专属参数开关（OpenCode Go 兼容）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v018-'));
process.env.NOVEL_DATA_DIR = tmp;

let cfg, client;

before(async () => {
  cfg = await import('../server/config.js');
  client = await import('../server/llm/client.js');
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } });

test('V0.18: 默认配置——官方服务商 + 正文用 Flash（V4 Pro 预览版弱于 Flash）', () => {
  const g = cfg.getGlobal();
  assert.equal(g.provider, 'deepseek_official');
  assert.equal(g.writingModel, 'flash');
  const write = cfg.resolveRoute('write');
  assert.equal(write.model, 'deepseek-v4-flash', '正文默认应走 Flash');
  const revise = cfg.resolveRoute('revise');
  assert.equal(revise.model, 'deepseek-v4-flash');
  const outline = cfg.resolveRoute('chapter_outline');
  assert.equal(outline.model, 'deepseek-v4-flash');
  const settle = cfg.resolveRoute('settle');
  assert.equal(settle.model, 'deepseek-v4-flash');
});

test('V0.18: writingModel=pro 时正文/修订切 Pro，其他任务不变', () => {
  cfg.saveGlobal({ writingModel: 'pro' });
  assert.equal(cfg.resolveRoute('write').model, 'deepseek-v4-pro');
  assert.equal(cfg.resolveRoute('revise').model, 'deepseek-v4-pro');
  assert.equal(cfg.resolveRoute('chapter_outline').model, 'deepseek-v4-flash');
  cfg.saveGlobal({ writingModel: 'flash' }); // 恢复
});

test('V0.18: 用户显式覆盖某任务模型时，不受档位影响', () => {
  cfg.saveGlobal({ routes: { write: { model: 'my-custom-writer', temperature: 0.5, maxTokens: 2000, label: '自定义正文' } } });
  assert.equal(cfg.resolveRoute('write').model, 'my-custom-writer');
  assert.equal(cfg.resolveRoute('write').temperature, 0.5);
  assert.equal(cfg.resolveRoute('revise').model, 'deepseek-v4-flash');
  // undefined 覆盖 → JSON.stringify 丢弃该键，等效清除
  cfg.saveGlobal({ routes: undefined });
});

test('V0.18: 切换 OpenCode Go 预设——baseUrl/专属参数/模型映射', () => {
  const preset = cfg.PROVIDER_PRESETS.opencode_go;
  assert.equal(preset.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(preset.deepseekParams, false);
  cfg.saveGlobal({ provider: 'opencode_go', baseUrl: preset.baseUrl, deepseekParams: preset.deepseekParams });
  // 模型 ID 映射（两端同名，映射不改变；若未来改名则按预设）
  assert.equal(cfg.resolveRoute('write').model, 'deepseek-v4-flash');
  assert.equal(cfg.resolveRoute('chapter_outline').model, 'deepseek-v4-flash');
  // providerInfo 返回预设信息
  const info = cfg.providerInfo();
  assert.equal(info.id, 'opencode_go');
  assert.equal(info.deepseekParams, false);
  cfg.saveGlobal({ provider: 'deepseek_official', baseUrl: 'https://api.deepseek.com', deepseekParams: true }); // 恢复
});

test('V0.18: buildRequestBody——deepseekParams 开关控制专属参数', () => {
  const base = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, maxTokens: 100, stream: true, jsonMode: true, thinking: 'enabled', reasoningEffort: 'max', userId: 'bk-1' };
  // 官方：全量专属参数
  const full = client.buildRequestBody({ ...base, deepseekParams: true });
  assert.deepEqual(full.thinking, { type: 'enabled' });
  assert.equal(full.reasoning_effort, 'max');
  assert.deepEqual(full.stream_options, { include_usage: true });
  assert.equal(full.user_id, 'bk-1');
  assert.deepEqual(full.response_format, { type: 'json_object' });
  // OpenCode Go 等兼容端点：只留标准字段（response_format 保留，兼容端点普遍支持）。
  // V0.33：reasoning_effort 改为无条件发送——兼容端点实测支持且用于抑制 flash 深度推理（防输出截断）
  const compat = client.buildRequestBody({ ...base, deepseekParams: false });
  assert.equal(compat.thinking, undefined);
  assert.equal(compat.reasoning_effort, 'max');
  assert.equal(compat.stream_options, undefined);
  assert.equal(compat.user_id, undefined);
  assert.deepEqual(compat.response_format, { type: 'json_object' });
  assert.equal(compat.model, 'deepseek-v4-flash');
  assert.equal(compat.max_tokens, 100);
});
