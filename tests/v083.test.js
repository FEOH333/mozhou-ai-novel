// V0.79 彻底修复：纯文本级问题（AI 味词）修订后仍存在 → 记债放行不卡死 + 卡章自动修复机制
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v083-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.79 纯文本 AI 味问题记债放行 + 卡章自动修复', () => {
  test('①纯语句质量问题修订后仍存在 → 记债放行，不 QUALITY_GATE_FAILED', async () => {
    process.env.NOVEL_AUDIT_TEXTFAULT = '1'; // 审校持续报"语句质量"（AI 味词）
    try {
      const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
      const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
      const b = store.books.create({ title: 'AI味书', genre: '玄幻', blurb: 'x' });
      store.materials.set(b.id, 'contract', 'x');
      const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
      const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
      store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [{ pov: '林晚', location: '巷口', beat: '事件', target_words: 300 }] } });
      // 走 runChapterFlow：修订 1 轮 → 再审校仍报语句质量 → textOnly 记债放行（defer）→ 继续结算
      const r = await runChapterFlow(b.id, ch.id, {});
      assert.ok(['done', 'settled'].includes(r.status), `纯文本问题不应卡死全书，实际 ${r.status}`);
    } finally {
      delete process.env.NOVEL_AUDIT_TEXTFAULT;
    }
  });

  test('②细纲根因问题不受 textOnly 影响（仍 replan）', async () => {
    process.env.NOVEL_AUDIT_FAULT = '1'; // 审校报"事实编造"（细纲根因）
    try {
      const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
      const { hasOutlineRootIssue } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
      // textOnly 只针对语句质量/文学性；细纲根因仍判定 replan
      assert.equal(hasOutlineRootIssue({ issues: [{ type: '事实编造', severity: 'high' }] }), true);
    } finally {
      delete process.env.NOVEL_AUDIT_FAULT;
    }
  });

  test('③hasOutlineRootIssue 与 textOnly 分类正交：AI 味词不进 replan', async () => {
    const { hasOutlineRootIssue } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '语句质量', severity: 'medium' }] }), false, '语句质量 → 不 replan（走 textOnly 放行）');
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '文学性', severity: 'medium' }] }), false, '文学性 → 不 replan');
  });
});
