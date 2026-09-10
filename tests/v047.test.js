// V0.47 质量优先默认值测试：冗余充足（不怕时间长，就怕质量差）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v047-'));

describe('V0.47 质量优先默认值', () => {
  test('写作 maxTokens 充足（覆盖长度自愈 1.7× 上限不截断）', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    assert.ok(DEFAULT_ROUTES.write.maxTokens >= 10000, `write maxTokens ${DEFAULT_ROUTES.write.maxTokens} 应 >=10000`);
    assert.ok(DEFAULT_ROUTES.revise.maxTokens >= 10000, `revise maxTokens ${DEFAULT_ROUTES.revise.maxTokens} 应 >=10000`);
    // 最长场景：lengthProfile 5000 字 × 1.7 = 8500 字 ≈ 11000 tokens——10000 覆盖 3500/5000 档
    assert.ok(DEFAULT_ROUTES.write.maxTokens >= 10000, 'write 防截断冗余');
  });

  test('流程冗余：修订 3 轮 / 恢复 3 轮 / 保留 15 章全文', async () => {
    const { DEFAULT_GLOBAL } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    assert.equal(DEFAULT_GLOBAL.maxReviseRounds, 4, '修订轮数应 4（V0.95.2：3→4 质量优先）');
    assert.equal(DEFAULT_GLOBAL.maxRecoveryRounds, 3, '恢复轮数应 3');
    assert.equal(DEFAULT_GLOBAL.keepRecentChapters, 15, '保留最近 15 章');
    assert.ok(DEFAULT_GLOBAL.contextBudgetTokens >= 500000, '历史堆预算 >=500K');
  });

  test('记忆/检索冗余：topK 10 / 世界书 4000 tokens / 超时 7 分钟', async () => {
    const { DEFAULT_GLOBAL } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    assert.equal(DEFAULT_GLOBAL.retrieval.topK, 10, '检索 topK 10');
    assert.equal(DEFAULT_GLOBAL.worldbookBudgetTokens, 4000, '世界书 4000 tokens');
    assert.ok(DEFAULT_GLOBAL.resilience.totalTimeoutMs >= 420000, '总超时 >=420s');
    assert.ok(DEFAULT_GLOBAL.resilience.idleTimeoutMs >= 60000, '空闲超时 >=60s');
  });
});
