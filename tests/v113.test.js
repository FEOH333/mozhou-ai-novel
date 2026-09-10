// V0.92 生命周期接入卷体检、中期审阅与台账回写
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v113-lifecycle-review-'));
const ROOT = process.cwd();

const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const lifecycle = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform_lifecycle.js')));
const volumeReview = await import(pathToFileURL(path.join(ROOT, 'server/engine/volumereview.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));

function makeLateMiddleBook() {
  const book = store.books.create({
    title: '汇流测试书', genre: '玄幻', blurb: '主角终将推翻旧秩序',
    settings: { longformLifecycle: { plannedVolumes: 10 } },
  });
  store.materials.set(book.id, 'contract', '【书契约】核心卖点：主角推翻旧秩序');
  let target;
  for (let idx = 1; idx <= 10; idx++) {
    const volume = store.volumes.create(book.id, idx, {
      title: `卷${idx}`, goal: idx === 8 ? '让三条战线汇流' : `目标${idx}`,
      status: idx === 8 ? 'done' : 'planned',
      outline: {
        lifecycle_stage: lifecycle.resolveBookStage(book.id, { volumeIdx: idx, totalVolumes: 10 }).id,
        stage_turn: idx === 8 ? '三条战线汇流' : `阶段转折${idx}`,
        arcs_advanced: [], arcs_closed: [], hooks_paid: [], new_major_arcs: [], ending_delivery: {},
      },
    });
    if (idx === 8) target = volume;
  }
  const chapter = store.chapters.create(book.id, target.id, 71, { title: '三河同流', status: 'done' });
  store.scenes.create(chapter.id, 1, { content: '主角让三路人马在河口会师，并揭开旧秩序的粮道命门。'.repeat(50), status: 'done' });
  store.summaries.set(chapter.id, book.id, '三路战线在河口会师，旧秩序的粮道命门暴露。');
  return { book, volume: target, chapter };
}

describe('V0.92 阶段型卷体检', () => {
  test('卷体检上下文包含全书阶段职责、阶段转折与当前兑付债务', () => {
    const { book, volume } = makeLateMiddleBook();
    store.storyArcs.create(book.id, { name: '旧秩序主线', type: '主线', openedChapter: 1, targetChapter: 90 });
    const ctx = volumeReview.buildVolumeReviewContext(book.id, volume);
    assert.equal(ctx.lifecycle.stage.id, 'late_middle');
    assert.match(ctx.lifecycleText, /中后期/);
    assert.match(ctx.lifecycleText, /必须发生的阶段转折/);
    assert.match(ctx.payoffDebt, /旧秩序主线/);
  });

  test('卷体检报告持久化阶段推进、弧线运动、兑付运动与完本准备度', async () => {
    const { book, volume } = makeLateMiddleBook();
    const result = await volumeReview.runVolumeReview(book.id, volume.id, {});
    assert.equal(result.report.stage_progress.duty_met, true);
    assert.ok(result.report.arc_movement);
    assert.ok(result.report.payoff_movement);
    assert.ok(result.report.ending_readiness);
    const stored = JSON.parse(store.volumeReviews.byVolume(book.id, volume.id).report_json);
    assert.equal(stored.stage_progress.stage, 'late_middle');
  });

  test('卷体检确认的闭合与兑付会回写弧线、期待和伏笔台账', () => {
    const { book, volume } = makeLateMiddleBook();
    const arc = store.storyArcs.create(book.id, { name: '粮道暗线', type: '暗线', openedChapter: 10, targetChapter: 71 });
    const hook = store.pleasureHooks.create(book.id, { desc: '粮道命门终会暴露', kind: 'long', status: 'open', plantedChapter: 10, dueChapter: 71 });
    const clue = store.foreshadows.create(book.id, { desc: '粮车车辙朝河口集中', status: 'advanced', importance: 'high', plantedChapter: 20 });
    const result = lifecycle.reconcileLifecycleLedger(book.id, volume.id, {
      arc_movement: { closed: ['粮道暗线'], advanced: [] },
      payoff_movement: { paid: ['粮道命门终会暴露', '粮车车辙朝河口集中'] },
    });
    assert.equal(result.arcsClosed, 1);
    assert.equal(store.storyArcs.get(arc.id).status, 'closed');
    assert.equal(store.pleasureHooks.get(hook.id).status, 'paid');
    assert.equal(store.foreshadows.get(clue.id).status, 'paid_off');
  });

  test('中期审阅提示按阶段检查，而非所有章节重复同一套五问', () => {
    const text = prompts.midStoryReviewInstruction({
      bookTitle: '阶段审阅书', chapterCount: 70, lifecycleText: '阶段ID：late_middle｜阶段：中后期', payoffDebt: '主线A未闭合',
    });
    assert.match(text, /阶段ID：late_middle/);
    assert.match(text, /阶段职责是否完成/);
    assert.match(text, /开放债务是否净减少/);
  });
});

