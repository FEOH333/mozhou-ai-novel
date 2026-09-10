// V0.94.2：卷体检「体检 C」误报根因修复——parse_failed ≠ 质量 C
// 实况：本作卷3《弦纹》8/14 两次卷审输出解析失败（fail-closed 落 status='failed' + 兜底 grade C），
// UI 不分流把失败渲染成红色「体检 C」，用户误读为质量判定。
// 修复三件：① router 把 volume_review 纳入 jsonMode 截断重试集（根因：长报告截断零重试）；
// ② outline.js 体检 tag/详情按 status 分流（failed→「体检失败·待补审」）；
// ③ 行为闭环：failed 记录进补审候选（自愈路径）+ 故障解除后重审恢复。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 必须在任何 server 模块加载前设置（store.js 在模块加载时读取 NOVEL_DATA_DIR）
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v139-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();

async function makeReviewedBook() {
  const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
  const b = store.books.create({ title: '卷审失败书', genre: '玄幻', blurb: 'x' });
  const v = store.volumes.create(b.id, 1, { title: '第一卷', goal: '下山', status: 'outlined' });
  const c1 = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'done' });
  const c2 = store.chapters.create(b.id, v.id, 2, { title: '第二章', status: 'done' });
  store.summaries.set(c1.id, b.id, '主角下山遇敌');
  store.summaries.set(c2.id, b.id, '主角立威');
  store.scenes.create(c1.id, 1, { content: '第一章正文', status: 'done' });
  store.scenes.create(c2.id, 1, { content: '第二章正文', status: 'done' });
  return { store, b, v };
}

describe('V0.94.2 卷体检 parse_failed 误报修复', () => {
  test('router：volume_review 必须在 jsonMode 截断重试集内（根因：长报告截断零重试）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/llm/router.js'), 'utf8');
    const m = src.match(/PLANNING_TASKS = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'PLANNING_TASKS 集合应存在');
    const tasks = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.ok(tasks.includes('volume_review'),
      `卷审阅输出整卷结构化 JSON 报告，截断应与书纲同权重试；当前集合：${tasks.join(',')}`);
  });

  test('UI：体检 tag 必须按 status 分流——failed 显示「体检失败」而非兜底 C 级', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/js/views/outline.js'), 'utf8');
    assert.ok(src.includes("rev.status === 'failed'"), '体检 tag 应先判 status=failed 再渲染');
    assert.ok(src.includes('体检失败·待补审'), 'failed 记录应显示「体检失败·待补审」而非「体检 C」');
    assert.ok(src.includes("rev.status === 'needs_attention'"), '修订被拦状态应有区分展示');
    assert.ok(src.includes('parse_failed'), '详情区应对 parse_failed 记录给明确说明（此前渲染空白块）');
  });

  test('行为闭环：解析失败落 failed + 兜底 C（非质量判定）→ 进补审候选 → 故障解除重审恢复', async () => {
    const { store, b, v } = await makeReviewedBook();
    const { runVolumeReview, reviewDueVolumes } = await import(pathToFileURL(path.join(ROOT, 'server/engine/volumereview.js')));

 // ① 注入解析故障（复现本作卷3 实况：输出截断不可解析）
    process.env.NOVEL_VOLREVIEW_PARSEFAULT = '1';
    const r1 = await runVolumeReview(b.id, v.id, {});
    assert.equal(r1.failed, true, '解析失败应 fail-closed 返回 failed 标记');
    assert.equal(r1.grade, 'C', '兜底 grade 为 C（占位，非质量结论）');
    const rec1 = store.volumeReviews.list(b.id)[0];
    assert.equal(rec1.status, 'failed', '落库 status=failed（UI 据此分流为「体检失败」）');
    assert.ok(rec1.report_json.includes('parse_failed'), '报告应带 parse_failed 标记');

    // ② failed 卷进补审候选（V0.67 自愈路径——下次自动创作启动时自动重审）
    const due = reviewDueVolumes(b.id);
    assert.ok(due.some(d => d.id === v.id && d.reason.includes('重试')), 'failed 完成卷应列为补审候选');

    // ③ 故障解除后重审恢复（幂等覆盖，不留 failed 残留）
    delete process.env.NOVEL_VOLREVIEW_PARSEFAULT;
    const r2 = await runVolumeReview(b.id, v.id, {});
    assert.notEqual(r2.failed, true, '故障解除后重审应成功解析');
    const rec2 = store.volumeReviews.list(b.id)[0];
    assert.notEqual(rec2.status, 'failed', '重审后 status 不再是 failed');
    assert.equal(rec2.grade, 'B', '恢复正常质量判定（mock 卷审为 B）');
    assert.equal(store.volumeReviews.list(b.id).length, 1, '重审幂等覆盖不新增记录');
  });
});
