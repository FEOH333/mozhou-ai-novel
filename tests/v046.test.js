// V0.46 思考模式分类默认测试：思考型任务 enabled + 写作/抽取型 disabled，maxTokens 充足
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v046-'));

describe('V0.46 思考模式质量最优默认', () => {
  test('思考型任务默认 thinking enabled + effort high/medium + maxTokens 充足', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    // V0.95.3：audit 与三判定门+快感审计回退 disabled+low——OpenCode Go 端点 medium 思考
    // 实证致 verdict 漂移/截断/预算全耗（ch27 卡章）；判定门确定性优先
    const thinkingTasks = ['worldbuild', 'book_outline', 'book_contract', 'book_settings', 'pleasure_plan', 'idea_amplify', 'contract_score', 'volume_outline_rewrite', 'book_outline_rewrite',
      'volume_outline', 'chapter_outline', 'volume_review', 'ending_check', 'next_volume', 'mid_story_review'];
    for (const t of thinkingTasks) {
      const r = DEFAULT_ROUTES[t];
      assert.ok(r, `任务 ${t} 应有路由`);
      assert.equal(r.thinking, 'enabled', `${t} 应默认开启思考`);
      assert.ok(r.reasoningEffort === 'high' || r.reasoningEffort === 'medium', `${t} effort 应为 high/medium，实际 ${r.reasoningEffort}`);
      assert.ok(r.maxTokens >= 3000, `${t} maxTokens 应 >=3000（防 thinking 截断），实际 ${r.maxTokens}`);
    }
    // V0.95.3：audit 回退 disabled+low+16000——审校是每章硬卡点，medium 思考量随上下文复杂度
    // 不可控（ch27 连续截断卡章实证），稳定性优先；四个软门保留开思考
    const auditRoute = DEFAULT_ROUTES['audit'];
    assert.equal(auditRoute.thinking, 'disabled', 'audit disabled（V0.95.3 硬卡点稳定优先）');
    assert.equal(auditRoute.reasoningEffort, 'low', 'audit effort low');
    assert.ok(auditRoute.maxTokens >= 16000, `audit maxTokens 应 >=16000，实际 ${auditRoute.maxTokens}`);
  });

  test('写作/抽取型任务默认 thinking disabled（正文流利输出防截断）', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    // V0.95.3：三判定门+快感审计回退 disabled（与 audit 同款端点实证）
    const disabledTasks = ['write', 'revise', 'settle', 'archive', 'coverage', 'summarize', 'book_title', 'chapter_rename', 'volume_rename',
      'attraction', 'signing_review', 'promise_check', 'pleasure_audit'];
    for (const t of disabledTasks) {
      const r = DEFAULT_ROUTES[t];
      assert.ok(r, `任务 ${t} 应有路由`);
      assert.equal(r.thinking, 'disabled', `${t} 应默认关闭 thinking（正文流利输出防截断）`);
    }
    // V0.95.3 终值：write/revise effort low——OpenCode Go 端点 medium 全烧推理零正文（ch27 实证），
    // 正文质量靠指令/纪律/审校闭环
    for (const t of ['write', 'revise']) {
      assert.equal(DEFAULT_ROUTES[t].reasoningEffort, 'low', `${t} effort low（V0.95.3 终值）`);
    }
    for (const t of ['settle', 'archive', 'coverage', 'summarize', 'book_title', 'chapter_rename', 'volume_rename',
      'attraction', 'signing_review', 'promise_check', 'pleasure_audit']) {
      assert.equal(DEFAULT_ROUTES[t].reasoningEffort, 'low', `${t} effort low（轻量抽取/判定门确定性）`);
    }
  });

  test('所有任务都有显式 thinking 字段（无隐式默认）', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    for (const [t, r] of Object.entries(DEFAULT_ROUTES)) {
      assert.ok(r.thinking !== undefined, `${t} 应有显式 thinking`);
      assert.ok(r.reasoningEffort !== undefined, `${t} 应有显式 reasoningEffort`);
    }
  });

  test('mock 冒烟：thinking enabled 任务 runTask 正常（book_outline）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runTask } = await import(pathToFileURL(path.join(ROOT, 'server/llm/router.js')));
    const b = store.books.create({ title: '思考书', genre: '玄幻', blurb: 'x' });
    const res = await runTask({ task: 'book_outline', bookId: b.id, messages: [{ role: 'user', content: '生成书级大纲' }], jsonMode: true });
    assert.ok(res.content, 'mock 应正常返回');
  });
});
