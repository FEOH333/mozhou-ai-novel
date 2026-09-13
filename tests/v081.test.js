// V0.78 细纲根因问题彻底修复：设定冲突/事实编造/大纲偏离等 high → replan 而非 revise
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v081-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.78 细纲根因问题 replan', () => {
  test('①hasOutlineRootIssue：细纲根因 high 问题 → true', async () => {
    const { hasOutlineRootIssue } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    // 事实编造（老幺未登记）→ replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '事实编造', severity: 'high', quote: 'x' }] }), true);
    // 大纲偏离（正文与细纲不符）→ replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '大纲偏离', severity: 'high', quote: 'x' }] }), true);
    // 设定冲突 → replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '设定冲突', severity: 'high', quote: 'x' }] }), true);
    // 事实矛盾 → replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '事实矛盾', severity: 'high', quote: 'x' }] }), true);
    // 时间线冲突 → replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '时间线冲突', severity: 'high', quote: 'x' }] }), true);
    // 角色矛盾 → replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '角色矛盾', severity: 'high', quote: 'x' }] }), true);
    // 纯文本问题（语句质量）→ 不 replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '语句质量', severity: 'high', quote: 'x' }] }), false);
    // low 级细纲问题 → 不 replan
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '事实编造', severity: 'low', quote: 'x' }] }), false);
    // 无 issues → false
    assert.equal(hasOutlineRootIssue({ issues: [] }), false);
  });

  test('②runChapterFlow 正常流程不破坏（mock 审校 accept → done）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    const b = store.books.create({ title: '正常书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
    store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [{ pov: '李尘', location: '镇', beat: '事件', target_words: 300 }] } });
    const r = await runChapterFlow(b.id, ch.id, {});
    assert.ok(['done'].includes(r.status), `应正常完成，实际 ${r.status}`);
  });

  test('③textFixable 不再包含细纲根因类型（正文修订只处理文本级）', async () => {
    // 从源码确认 textFixable 不含细纲根因——通过 pipeline 的行为间接验证
    // 这里验证 hasOutlineRootIssue 覆盖了所有原 textFixable 中的细纲类型
    const { hasOutlineRootIssue } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    const rootTypes = ['设定冲突', '时间线冲突', '角色矛盾', '事实编造', '事实矛盾', '大纲偏离'];
    for (const t of rootTypes) {
      assert.equal(hasOutlineRootIssue({ issues: [{ type: t, severity: 'high' }] }), true, `${t} 应触发 replan`);
    }
  });
});
