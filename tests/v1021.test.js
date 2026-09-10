// V0.102.1：自动创作续跑自愈——同版失配自动重建、已规划卷禁止重生、
// 开篇已过后冻结宪章/开篇蓝图、章纲拦观察-记录微循环。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const store = await import('../server/db/store.js');
const {
  assertNarrativeStateReady,
  ensureNarrativeStateReady,
  manuscriptSourceHash,
  narrativeStateStatus,
  prepareAndCommitNarrativeRevision,
} = await import('../server/engine/narrative_state.js');
const { generateNextVolume } = await import('../server/engine/continuation.js');
const { generateOpeningBlueprint } = await import('../server/engine/opening.js');
const { buildStoryPromiseProfile, ensureStoryPromiseProfile, storyPromiseStatus } = await import('../server/engine/story_promise.js');
const { validateChapterHorizon, compileChapterHorizon, formatChapterHorizonText } = await import('../server/engine/horizon.js');

const sha256 = value => createHash('sha256').update(String(value || '')).digest('hex');
const ANCHOR = '主角烧掉退路文书';

function completedChapter(bookId, idx, text = `${ANCHOR}，带十个人当夜冲出营门。`.repeat(40), volumeId = null) {
  const chapter = store.chapters.create(bookId, volumeId, idx, {
    title: `第${idx}章`, status: 'done', wordCount: text.length,
  });
  store.scenes.create(chapter.id, 1, { content: text, status: 'done' });
  store.summaries.set(chapter.id, bookId, `第${idx}章摘要`);
  store.chapterSettlements.set(bookId, chapter.id, {
    contentHash: sha256(text), result: { summary: `第${idx}章摘要` },
  });
  return chapter;
}

function strictProjection(text) {
  assert.ok(text.includes(ANCHOR));
  return {
 summary: '主角烧掉退路文书，带十人进入山道。',
 rolling_update: '主角烧掉退路文书并进入山道。',
    outline_actual: {
      goal: '烧掉退路文书并突围',
      conflict: '退路与抢先突围不可兼得',
 dramatic_question: '主角敢不敢亲手断掉退路？',
      counterforce: '同伴反对且追兵逼近',
      turn: '斥候已经看见文书',
      irreversible_change: '文书被烧，十人进入陌生山道',
      choice_cost: '失去原路撤回的可能',
      reader_gain: '突围路线与责任升级',
      reader_pull: '山道尽头出现宋军旗号',
      evidence: ANCHOR,
 scenes: [{ id: 's1', beat: '主角烧掉文书，带队进入山道', evidence: ANCHOR }],
    },
 facts: [{ subject: '主角', predicate: '烧掉', object: '退路文书', evidence: ANCHOR }],
 character_updates: [{ name: '主角', changes: ['位置=山道'], evidence: ANCHOR }],
    character_notes: [],
    character_emotional: [],
 timeline: [{ event: '主角烧掉退路文书并带队突围', evidence: ANCHOR }],
    foreshadow_actions: [],
 memory_entries: [{ category: 'scene', name: '', content: '主角亲手断掉退路', evidence: ANCHOR }],
    new_entities: [],
  };
}

function strictPlan({ completedChapterIdx = 1 } = {}) {
  return {
    book_state: {
      actual_through_chapter: completedChapterIdx,
 actual_story_state: '主角已经烧掉退路文书并进入山道。',
      future_direction: '承担断路后的生存代价。',
      next_reader_gain: '让选择的即时后果落地。',
      evidence: [{ chapter: completedChapterIdx, quote: ANCHOR }],
    },
    volumes: [{
      volume_idx: 1, status: 'in_progress',
 actual_summary: '主角亲手断路并进入山道。',
      actual_arc: '从守住旧路转为主动承担突围责任。',
      remaining_direction: '承接山道困局。',
      evidence: [{ chapter: completedChapterIdx, quote: ANCHOR }],
    }],
    next_chapters: [],
  };
}

const rebuildOpts = {
  projectionImpl: async ({ text }) => strictProjection(text),
  planImpl: async () => ({ ...strictPlan(), volumes: [] }),
  reindex: false,
};

test('V0.102.1 自动创作遇正文指纹失配必须就地重建，不得把 need_human 当终态', async () => {
  const book = store.books.create({ title: '同版自愈测试' });
  const text = `${ANCHOR}，带十个人当夜冲出营门。`.repeat(40);
  const chapter = completedChapter(book.id, 1, text);
  await prepareAndCommitNarrativeRevision(book.id, rebuildOpts);
  store.scenes.update(store.scenes.list(chapter.id)[0].id, { content: `${text}又改了一个字。` });
  assert.equal(narrativeStateStatus(book.id).status, 'mismatch');
  assert.throws(() => assertNarrativeStateReady(book.id), error => error.code === 'NARRATIVE_SOURCE_MISMATCH');

  const events = [];
  const ready = await ensureNarrativeStateReady(book.id, {
    ...rebuildOpts,
    onEvent: event => events.push(event),
  });
  assert.equal(ready.ok, true);
  assert.doesNotThrow(() => assertNarrativeStateReady(book.id));
  assert.equal(narrativeStateStatus(book.id).status, 'ready');
  assert.equal(manuscriptSourceHash(book.id), store.narrativeRevisions.current(book.id).source_hash);
  assert.ok(events.some(event => event.type === 'stage' && /重建/.test(event.message || '')));
});

test('V0.102.1 已 outlined 且已建章的续卷禁止重生卷纲（标题保持）', async () => {
  const book = store.books.create({ title: '续卷跳过重生', genre: '玄幻' });
  store.materials.set(book.id, 'contract', '【书契约】主角逆袭');
  store.materials.set(book.id, 'world', '青云大陆');
  const v1 = store.volumes.create(book.id, 1, { title: '第一卷', goal: '开局', status: 'outlined' });
  completedChapter(book.id, 1, `${ANCHOR}。`.repeat(20), v1.id);
  completedChapter(book.id, 2, `${ANCHOR}。`.repeat(20), v1.id);
  const v2 = store.volumes.create(book.id, 2, {
    title: '钓鱼城头', goal: '守城', status: 'outlined',
    outline: {
      title: '钓鱼城头', goal: '守城', chapterCount: 2,
      chapters: [
        { idx: 1, title: '门槛水珠-KEEP', beat: '升帐请领北崖' },
        { idx: 2, title: '血染干沟-KEEP', beat: '夜袭地道作选择' },
      ],
    },
  });
  store.chapters.create(book.id, v2.id, 3, { title: '门槛水珠-KEEP', status: 'planned' });
  store.chapters.create(book.id, v2.id, 4, { title: '血染干沟-KEEP', status: 'planned' });

  const events = [];
  const result = await generateNextVolume(book.id, { onEvent: event => events.push(event) });
  assert.equal(result.idx, 2);
  assert.equal(result.skippedOutline, true);
  const titles = store.chapters.listByVolume(v2.id).map(chapter => chapter.title);
  assert.deepEqual(titles, ['门槛水珠-KEEP', '血染干沟-KEEP']);
  assert.equal(store.volumes.get(v2.id).title, '钓鱼城头');
  assert.ok(events.some(event => /跳过重生/.test(event.message || '')));
  assert.ok(!events.some(event => /生成卷大纲/.test(event.message || '')));
});

test('V0.102.1 开篇已过后角色库增长不再重写宪章与前20章蓝图', async () => {
  const book = store.books.create({ title: '开篇冻结', genre: '历史', platform: '番茄' });
  store.materials.set(book.id, 'contract', '无系统，严肃历史成长');
  store.materials.set(book.id, 'outline', '从流民到守城者');
 store.characters.create(book.id, { name: '主角', tier: 'protagonist' });
  const profile = await buildStoryPromiseProfile(book.id, {
    data: {
      premise_in_one_breath: '一个孩子在战乱中学会保护别人',
      primary_attraction_axis: '硬核守城与历史必然性的裂缝',
      secondary_axes: ['成长'],
      protagonist_now: { lack: '弱小', immediate_need: '护住家人', agency_pattern: '观察后保护' },
      payoff_ladder: { near: ['有效选择'], middle: ['守住一段墙'], long: ['守住山河'] },
      texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
      protected_elements: ['无金手指'],
      anti_promises: ['无系统'],
      author_locks: [],
      confidence: {},
    },
  });
  const blueprint = {
    hook_ladder: [{ chapter: 1, title: '庙会', hook: '灯影里的军报', payoff: '家人尚在' }],
    golden_finger: { power: '记料识纹', activate_chapter: 4, limit: '少年权限' },
    story_promise_fingerprint: profile.source_fingerprint,
  };
  const settings = JSON.parse(store.books.get(book.id).settings_json || '{}');
  settings.openingBlueprint = blueprint;
  store.books.update(book.id, { settings });

  const volume = store.volumes.create(book.id, 1, { title: '第一卷', status: 'outlined' });
  for (let idx = 1; idx <= 21; idx++) completedChapter(book.id, idx, `${ANCHOR}。第${idx}章。`.repeat(8), volume.id);
  store.characters.create(book.id, { name: '阿蛮', tier: 'supporting' });
  assert.equal(storyPromiseStatus(book.id).stale, true);

  const promise = await ensureStoryPromiseProfile(book.id);
  assert.equal(promise.ok, true);
  assert.equal(promise.frozen, true);
  assert.equal(promise.profile.primary_attraction_axis, '硬核守城与历史必然性的裂缝');

  const opening = await generateOpeningBlueprint(book.id);
  assert.equal(opening.ok, true);
  assert.equal(opening.frozen, true);
  assert.equal(opening.blueprint.hook_ladder[0].title, '庙会');
});

test('V0.102.1 上卷观察-记录循环时，本章细纲再写观察记册必须拒', () => {
  const brief = compileChapterHorizon({
    chapterIdx: 35,
    exitLine: '第34章《狼烟》：蒙哥入蜀，北崖值夜',
    staleArcs: [{ name: '秦月感情线' }],
    duePayoffs: [{ desc: '明日升帐军议' }],
    microLoop: true,
  });
  const text = formatChapterHorizonText(brief);
  assert.match(text, /观察-记录|观察痕迹/);
  const rejected = validateChapterHorizon({
    goal: '把脚印写入工册',
 scenes: [{ beat: '主角观察北崖脚印并记入工册，等候王坚复核' }],
  }, brief);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some(issue => issue.code === 'CHAPTER_MICRO_LOOP'));

  const passed = validateChapterHorizon({
    goal: '请领北崖守段并当场设障',
 scenes: [{ beat: '王坚升帐，主角带着蒙哥军报请领北崖，下令封干沟' }],
  }, brief);
  assert.equal(passed.ok, true, passed.issues.map(i => i.message).join(';'));
});

test('V0.102.1 非历史题材：已规划续卷同样跳过重生（零特判）', async () => {
  const book = store.books.create({ title: '都市跳过', genre: '都市' });
  store.materials.set(book.id, 'contract', '都市成长');
  const v1 = store.volumes.create(book.id, 1, { title: '卷一', status: 'outlined' });
  completedChapter(book.id, 1, `${ANCHOR}。`.repeat(12), v1.id);
  const v2 = store.volumes.create(book.id, 2, {
    title: '卷二', status: 'outlined',
    outline: { title: '卷二', chapters: [{ idx: 1, title: 'KEEP-都市', beat: '摊牌' }] },
  });
  store.chapters.create(book.id, v2.id, 2, { title: 'KEEP-都市', status: 'planned' });
  const result = await generateNextVolume(book.id, {});
  assert.equal(result.skippedOutline, true);
  assert.equal(store.chapters.listByVolume(v2.id)[0].title, 'KEEP-都市');
});

test('V0.102.1 管线写章入口改为 ensureNarrativeStateReady，断言闸仍留给结算', () => {
  const pipeline = fs.readFileSync('server/engine/pipeline.js', 'utf8');
  const settle = fs.readFileSync('server/engine/settle.js', 'utf8');
  assert.match(pipeline, /ensureNarrativeStateReady/);
  assert.match(pipeline, /await ensureNarrativeStateReady\(/);
  assert.doesNotMatch(pipeline, /assertNarrativeStateReady\(/);
  assert.match(settle, /assertNarrativeStateReady\(/);
});

test('V0.102.1 旧投影对换版后正文仍能逐字定位则复用，不重取证', async () => {
  const book = store.books.create({ title: '投影复用测试' });
  const text = `${ANCHOR}，带十个人当夜冲出营门。`.repeat(40);
  const chapter = completedChapter(book.id, 1, text);
  let projectionCalls = 0;
  const counting = {
    projectionImpl: async ({ text: current }) => {
      projectionCalls += 1;
      return strictProjection(current);
    },
    planImpl: async () => ({ ...strictPlan(), volumes: [] }),
    reindex: false,
    projectionCache: true,
  };
  await prepareAndCommitNarrativeRevision(book.id, counting);
  store.scenes.update(store.scenes.list(chapter.id)[0].id, { content: `${text}夜色更深。` });
  projectionCalls = 0;
  await ensureNarrativeStateReady(book.id, { ...counting, onEvent() {} });
  assert.equal(projectionCalls, 0, '旧投影仍可定位时不得重取证');
  assert.doesNotThrow(() => assertNarrativeStateReady(book.id));
});

test('V0.102.1 自动自愈取证两轮仍无证据时落地确定性投影，不把全书停死', async () => {
  const book = store.books.create({ title: '降级投影测试' });
  completedChapter(book.id, 1, `${ANCHOR}，带十个人当夜冲出营门。`.repeat(40));
  const events = [];
  const fail = async () => {
    const error = new Error('正文里根本没有的证据');
    error.code = 'PROJECTION_EVIDENCE_MISSING';
    throw error;
  };
  await ensureNarrativeStateReady(book.id, {
    projectionImpl: fail,
    planImpl: async () => ({ ...strictPlan(), volumes: [] }),
    reindex: false,
    onEvent: event => events.push(event),
  });
  assert.doesNotThrow(() => assertNarrativeStateReady(book.id));
  assert.ok(events.some(event => event.type === 'narrative_projection_degraded'));
});
