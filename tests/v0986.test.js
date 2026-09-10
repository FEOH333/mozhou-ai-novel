// V0.98.6 免费档上限校准：maxTokensFloor + UI 钳制放宽
// 实证（ox-alpha-free，2026-08-22，全部走流式通道）：max_tokens 128k 被接受；
// 上下文 73.6 万 token 完整通过（"1M 上下文"属实）；思考不可调高（medium→400、
// high 大任务烧穿、/messages 流式只发空心跳帧）——详见 AGENTS.md §6.4（端点适配与传输韧性）。
import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('V0.98.6 免费档输出预算下限：规划/审校任务抬到 16000，其他服务商不受影响', async () => {
  const { PROVIDER_PRESETS, resolveRoute, saveGlobal } = await import('../server/config.js');
  assert.equal(PROVIDER_PRESETS.opencode_go_free.maxTokensFloor, 16000);

  saveGlobal({ provider: 'opencode_go_free' });
  try {
    assert.equal(resolveRoute('summarize', {}).maxTokens, 16000, '2000 预算的小任务抬到下限');
    assert.equal(resolveRoute('write', {}).maxTokens, 16000, '正文任务原值即下限，不被调低');
    const boosted = resolveRoute('chapter_outline', {});
    assert.ok(boosted.maxTokens >= 16000, '细纲预算不低于下限');
    // 用户显式调高的预算不因下限回落
    saveGlobal({ routes: { summarize: { maxTokens: 24000 } } });
    assert.equal(resolveRoute('summarize', {}).maxTokens, 24000);
  } finally {
    saveGlobal({ provider: 'deepseek_official', routes: {} });
  }
  assert.equal(resolveRoute('coverage', {}).maxTokens, 6000, '无下限预设保持任务默认值（coverage 原值 6000）');
});

test('V0.98.6 设置页 max_tokens 钳制放宽到 32000（端点实测 128k 可用）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'web/js/views/settings.js'), 'utf8');
  assert.ok(src.includes('Math.min(32000, Math.max(256, parseInt(r.maxInput.value)'));
  assert.ok(!src.includes('Math.min(16000, Math.max(256'), '旧 16000 钳制不得残留');
});
