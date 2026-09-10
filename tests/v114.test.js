// V0.92 硬完本门：AI 不得绕过债务，安全上限不得冒充完本
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v114-ending-gate-'));
const ROOT = process.cwd();

const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const continuation = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));
const lifecycle = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform_lifecycle.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));

function makeLongEnoughBook(title = '完本门测试书') {
  const book = store.books.create({
    title, genre: '玄幻', blurb: '主角已达成核心目标，故事收束',
    settings: { longformLifecycle: { plannedVolumes: 10 } },
  });
  store.materials.set(book.id, 'contract', '【书契约】主角已达成核心目标，故事收束');
  const endingDelivery = {
    final_opposition: '旧王朝最后的禁军', final_choice: '交出王印', irreversible_cost: '失去王位',
    core_promise_payoff: '百姓不再被旧王朝征作奴隶', protagonist_settlement: '从独行者成为守望者',
    relationship_settlements: ['送别战友'], world_settlement: '新议会开始运转', historical_settlement: '不适用',
    closing_image: '开篇破灯重新点亮', last_chapter_mode: '余波、安顿、主题回声、闭幕意象',
  };
  const volume = store.volumes.create(book.id, 10, {
    title: '终卷', goal: '完成终局', status: 'done',
    outline: {
      lifecycle_stage: 'finale', stage_turn: '交出王印并完成新秩序交接',
      arcs_advanced: [], arcs_closed: [], hooks_paid: [], new_major_arcs: [], ending_delivery: endingDelivery,
    },
  });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '灯还亮着', status: 'done' });
  store.scenes.create(chapter.id, 1, { content: '百姓见证新秩序建立，主角交出王印，回到旧街点亮破灯。'.repeat(250), status: 'done' });
  lifecycle.ensureEndingBlueprint(book.id, { data: { ...endingDelivery, core_promise: '百姓不再被旧王朝征作奴隶' } });
  store.volumeReviews.upsert(book.id, volume.id, {
    grade: 'A', status: 'done', issues: [],
    report: {
      goal_met: true,
      stage_progress: { stage: 'finale', duty_met: true, note: '终局与余波均已落地' },
      arc_movement: { closed: [], advanced: [] }, payoff_movement: { paid: [] },
      ending_readiness: { ready: true, missing: [] },
    },
  });
  return { book, volume, chapter };
}

describe('V0.92 硬完本门', () => {
  test('字数够且普通伏笔清空，仍有主线弧时必须继续且不调用 AI', async () => {
    const { book } = makeLongEnoughBook('主线未闭合书');
    store.storyArcs.create(book.id, { name: '旧王朝主线', type: '主线', openedChapter: 1, targetChapter: 1 });
    const result = await continuation.shouldContinueBook(book.id, { minChars: 1000 });
    assert.equal(result.shouldContinue, true);
    assert.equal(result.ai, undefined, '本地硬债务应先拦截，不把裁决权交给 AI');
    assert.match(result.reason, /主线|故事弧|旧王朝/);
  });

  test('达到章节安全上限但未收束时只暂停人工检查，不得当成全书完成', () => {
    const { book, volume } = makeLongEnoughBook('上限未完书');
    store.storyArcs.create(book.id, { name: '未完主线', type: '主线', openedChapter: 1, targetChapter: 2 });
    store.chapters.create(book.id, volume.id, 2, { title: '未完', status: 'done' });
    const result = continuation.localEndingCheck(book.id, { minChars: 1000, maxChapters: 2 });
    assert.equal(result.shouldContinue, false);
    assert.equal(result.needsHuman, true);
    assert.equal(result.finished, false);
    assert.match(result.reason, /上限.*未完本|未收束.*上限/);
  });

  test('结构化债务全清、终卷实际通过体检后才允许 AI 做最后语义确认', async () => {
    const { book } = makeLongEnoughBook('可完本书');
    const local = continuation.localEndingCheck(book.id, { minChars: 1000 });
    assert.equal(local.done, false, local.reason);
    const result = await continuation.shouldContinueBook(book.id, { minChars: 1000 });
    assert.equal(result.shouldContinue, false);
    assert.equal(result.needsHuman, false);
    assert.equal(result.ai.finished, true);
  });

  test('低重要度余韵伏笔不单独阻止结构完整的终卷完本', () => {
    const { book } = makeLongEnoughBook('低重要余韵书');
    store.foreshadows.create(book.id, {
      desc: '远处仍有炊烟升起的开放余韵', status: 'planted', importance: 'low', plantedChapter: 1,
    });
    const local = continuation.localEndingCheck(book.id, { minChars: 1000 });
    assert.equal(local.done, false, local.reason);
  });
});

describe('V0.92 最后一章模式', () => {
  test('终章细纲允许无下一章悬念，强制余波、安顿、主题回声与闭幕意象', () => {
    const text = prompts.chapterOutlineInstruction({
      bookTitle: '终章书', chapterIdx: 100, recentSummaries: [], activeForeshadows: [], forgottenForeshadows: [],
      approachingForeshadows: [], retrieved: [], futureChapters: [], lifecycleText: '阶段ID：finale｜阶段：终卷与完本',
      finalChapterMode: true,
    });
    assert.match(text, /最后一章模式/);
    assert.match(text, /余波.*人物安顿.*主题回声.*闭幕意象/);
    assert.match(text, /ending_hook.*null/);
    assert.doesNotMatch(text, /结尾场景留钩子；不推进/);
  });
});
