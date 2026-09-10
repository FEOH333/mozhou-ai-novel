// V0.95.1 卷体检截断根修：长报告任务输出预算校准
// 用户实证：本作卷3 补审三次全部失败——usage_logs 显示 completion 恒=6000（maxTokens 打满截断），
// extractJSON 失败 → fail-closed 落 status='failed' 循环。根因：volume_review 预算 6000（全表最低）
// + thinking enabled，却要输出整卷 10 章多维结构化报告；对照 chapter_outline（同为结构化长输出）12000。
// V0.94.2 的 +30% 截断重试（7800）杯水车薪。本测试锁定长报告任务预算下限，防回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import { DEFAULT_ROUTES } from '../server/config.js';

test('V0.95.1 卷审输出预算：volume_review maxTokens ≥12000（6000 实证三次打满截断）', () => {
  const vr = DEFAULT_ROUTES.volume_review;
  assert.ok(vr, 'volume_review 路由存在');
  assert.ok((vr.maxTokens || 0) >= 12000, `卷审 maxTokens 应 ≥12000（实际 ${vr.maxTokens}）——整卷 10 章多维报告 + thinking 推理共占输出预算`);
});

test('V0.95.1 长报告任务预算护栏：整卷/全书级结构化输出 ≥ 对应量级', () => {
  const r = DEFAULT_ROUTES;
  // 卷级大纲/重写/续卷：8-15 章规划（与 volume_outline 同量级）
  for (const task of ['volume_outline', 'volume_outline_rewrite', 'next_volume']) {
    assert.ok((r[task]?.maxTokens || 0) >= 8000, `${task} 应 ≥8000（实际 ${r[task]?.maxTokens}）`);
  }
  // 全书级：书纲/书纲对齐（15 卷多字段）
  for (const task of ['book_outline', 'book_outline_rewrite']) {
    assert.ok((r[task]?.maxTokens || 0) >= 10000, `${task} 应 ≥10000（实际 ${r[task]?.maxTokens}）`);
  }
  // 章细纲（既有 12000 不回退）
  assert.ok((r.chapter_outline?.maxTokens || 0) >= 12000, 'chapter_outline 保持 12000');
});

test('V0.95.1 中期审阅预算：mid_story_review 报告型输出 ≥8000（原 4000+thinking 同款截断风险）', () => {
  const r = DEFAULT_ROUTES;
  assert.ok((r.mid_story_review?.maxTokens || 0) >= 8000, `mid_story_review 应 ≥8000（实际 ${r.mid_story_review?.maxTokens}）`);
});

test('V0.95.1 卷审失败自愈闭环：failed 记录可被补审覆盖（runVolumeReview 幂等 upsert + reviewDueVolumes 出候选）', async () => {
  const store = await import('../server/db/store.js');
  const { reviewDueVolumes } = await import('../server/engine/volumereview.js');
  const { isCompletedChapter } = await import('../server/engine/chapter_status.js');
  const b = store.books.create({ title: '卷审自愈测试', genre: '玄幻' });
  const vol = store.volumes.create(b.id, 1, { title: '第一卷' });
  // 卷内 2 章全部完成
  for (let i = 1; i <= 2; i++) {
    const ch = store.chapters.create(b.id, vol.id, i, { title: `第${i}章`, status: 'settled' });
    store.scenes.create(ch.id, 1, { beat: 'b', content: '正文', status: 'done' });
    assert.ok(isCompletedChapter(store.chapters.get(ch.id)));
  }
  // 落一条 failed 记录（截断后的兜底形态）
  store.volumeReviews.upsert(b.id, vol.id, { grade: 'C', report: { parse_failed: true }, issues: [], status: 'failed' });
  const due = reviewDueVolumes(b.id);
  assert.ok(due.some(d => d.id === vol.id), 'failed 卷必须进补审候选（用户点补审/自动创作触发即重审）');
});
