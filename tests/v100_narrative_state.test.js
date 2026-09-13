import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v100-narrative-state-'));
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const {
  assertNarrativeStateReady,
  manuscriptSourceHash,
  markNarrativeStateStale,
  narrativeStateStatus,
  prepareAndCommitNarrativeRevision,
  validateNarrativeProjection,
} = await import('../server/engine/narrative/narrative_state.js');
const { settleChapter } = await import('../server/engine/pipeline/settle.js');

const sha256 = value => createHash('sha256').update(String(value || '')).digest('hex');

function completedChapter(bookId, idx, text = `第${idx}章正文。`.repeat(80), volumeId = null) {
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

function strictPlan({ completedChapterIdx = 1, nextChapterIdx = null } = {}) {
  return {
    book_state: {
      actual_through_chapter: completedChapterIdx,
 actual_story_state: '主角已经烧掉退路文书并进入山道。',
      future_direction: '承担断路后的生存代价，并查清山道尽头旗号的来历。',
      next_reader_gain: '让选择的即时后果落地，并获得一条改变路线判断的新信息。',
 evidence: [{ chapter: completedChapterIdx, quote: '主角烧掉退路文书' }],
    },
    volumes: [{
      volume_idx: 1, status: nextChapterIdx ? 'in_progress' : 'completed',
 actual_summary: '主角亲手断路并进入山道。',
      actual_arc: '人物从守住旧路转为主动承担突围责任。',
      remaining_direction: nextChapterIdx ? '承接山道困局，兑现断路代价。' : '本卷实际结果已经落定。',
 evidence: [{ chapter: completedChapterIdx, quote: '主角烧掉退路文书' }],
    }],
    next_chapters: nextChapterIdx ? [{
      chapter: nextChapterIdx,
      goal: '处理断路后第一轮追击',
      conflict: '保护伤员与抢在追兵前抵达山口不可兼得',
      bridge_from_actual: '退路已毁，十人只能继续深入山道',
      reader_gain: '看见断路选择造成的具体生存成本',
 reader_pull: '山口旗号的主人将迫使主角重新判断敌友',
    }] : [],
  };
}

test('V0.100 revision store persists shadow projections and exposes a blocking stale head', () => {
  const book = store.books.create({ title: '同版状态测试' });
  const chapter = completedChapter(book.id, 1);
  const revision = store.narrativeRevisions.create(book.id, {
    fromChapter: 1,
    throughChapter: 1,
    status: 'building',
    sourceHash: 'source-a',
    reason: 'test',
  });
  store.chapterProjections.set(revision.id, book.id, chapter.id, {
    chapterIdx: 1,
    sourceHash: 'chapter-a',
    payload: { summary: '第一章发生一件事' },
  });

  assert.equal(store.chapterProjections.list(revision.id).length, 1);
  store.narrativeRevisions.complete(revision.id, {
    sourceHash: 'source-a', manifest: { chapters: [1] },
  });
  assert.equal(store.narrativeRevisions.current(book.id).id, revision.id);

  const stale = store.narrativeRevisions.create(book.id, {
    parentId: revision.id,
    fromChapter: 1,
    throughChapter: 1,
    status: 'stale',
    sourceHash: 'source-b',
    reason: 'rewrite',
  });
  assert.equal(store.narrativeRevisions.blocking(book.id).id, stale.id);
});

test('V0.100 unmanaged rewrite state blocks automatic creation instead of blessing old projections', () => {
  const book = store.books.create({ title: '陈旧投影测试' });
  completedChapter(book.id, 1);

  const revision = markNarrativeStateStale(book.id, {
    fromChapter: 1,
    reason: 'completed prose changed',
    changedChapters: [1],
  });

  assert.equal(revision.status, 'stale');
  assert.throws(
    () => assertNarrativeStateReady(book.id),
    error => error.code === 'NARRATIVE_STATE_STALE' && /第1章/.test(error.message),
  );
});

test('V0.100 legacy books with completed prose must establish a same-version ledger before continuing', () => {
  const legacy = store.books.create({ title: '旧书升级门测试' });
  completedChapter(legacy.id, 1);

  const status = narrativeStateStatus(legacy.id);
  assert.equal(status.status, 'legacy');
  assert.equal(status.requiresRebuild, true);
  assert.equal(status.completedChapters, 1);
  assert.equal(status.ready, false);
  assert.throws(
    () => assertNarrativeStateReady(legacy.id),
    error => error.code === 'NARRATIVE_STATE_LEGACY' && /先重建/.test(error.message),
  );

  const fresh = store.books.create({ title: '空白新书不应误拦' });
  const freshStatus = narrativeStateStatus(fresh.id);
  assert.equal(freshStatus.status, 'legacy');
  assert.equal(freshStatus.requiresRebuild, false);
  assert.equal(freshStatus.ready, true);
  assert.doesNotThrow(() => assertNarrativeStateReady(fresh.id));
});

test('V0.100 repeated unmanaged edits merge every changed chapter into one blocking rebuild', () => {
  const book = store.books.create({ title: '连续编辑登记测试' });
  completedChapter(book.id, 1);
  completedChapter(book.id, 2);

  const first = markNarrativeStateStale(book.id, {
    fromChapter: 2,
    reason: '第二章先被编辑',
    changedChapters: [2],
  });
  const merged = markNarrativeStateStale(book.id, {
    fromChapter: 1,
    reason: '第一章随后被编辑',
    changedChapters: [1],
  });

  assert.equal(merged.id, first.id, '同一批未重建编辑应合并，不能堆出互相遮蔽的 stale 头');
  assert.equal(merged.from_chapter, 1);
  assert.deepEqual(merged.manifest.changed_chapters, [1, 2]);
  assert.equal(merged.source_hash, manuscriptSourceHash(book.id));
});

function strictProjection(text, { summary = '主角烧掉退路文书，带十人进入山道。' } = {}) {
 const evidence = '主角烧掉退路文书';
  assert.ok(text.includes(evidence));
  return {
    summary,
    rolling_update: summary,
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
      evidence,
 scenes: [{ id: 's1', beat: '主角烧掉文书，带队进入山道', evidence }],
    },
 facts: [{ subject: '主角', predicate: '烧掉', object: '退路文书', evidence }],
 character_updates: [{ name: '主角', changes: ['位置=山道'], evidence }],
    character_notes: [],
    character_emotional: [],
 timeline: [{ event: '主角烧掉退路文书并带队突围', evidence }],
    foreshadow_actions: [],
 memory_entries: [{ category: 'scene', name: '', content: '主角亲手断掉退路', evidence }],
    new_entities: [],
  };
}

test('V0.100 strict projection rejects claims whose evidence is absent from current prose', () => {
 const text = '主角烧掉退路文书，带十个人当夜冲出营门。';
  const payload = strictProjection(text);
  payload.facts[0].evidence = '正文里根本没有的证据';
  assert.throws(
    () => validateNarrativeProjection(payload, text, { idx: 1 }),
    error => error.code === 'PROJECTION_EVIDENCE_MISSING',
  );
});

test('V0.100 shadow projection failure leaves old prose and derived facts untouched', async () => {
  const book = store.books.create({ title: '影子失败测试', genre: '历史' });
 const oldText = '主角守住旧营门，退路文书仍在案上。'.repeat(70);
  const chapter = completedChapter(book.id, 1, oldText);
  store.facts.create(book.id, { subject: '退路文书', predicate: '状态', object: '仍在案上', sourceChapter: 1 });
 const newText = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);

  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    rewrites: new Map([[chapter.id, newText]]),
    reason: 'test failure',
    projectionImpl: async () => { throw Object.assign(new Error('bad projection'), { code: 'PROJECTION_INVALID' }); },
  }), /bad projection/);

  assert.equal(store.chapters.fullText(chapter.id), oldText);
  assert.equal(store.facts.active(book.id)[0].object, '仍在案上');
  assert.equal(store.narrativeRevisions.blocking(book.id), null);
});

test('V0.100 successful revision atomically changes prose, facts, summary, character state and outline alignment', async () => {
  const book = store.books.create({ title: '原子换版测试', genre: '历史' });
  store.materials.set(book.id, 'outline', '【原书纲】守住旧营门，再沿旧路撤退。');
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '守住旧营门', outline: { goal: '守住旧营门', chapters: [] },
  });
 const oldText = '主角守住旧营门，退路文书仍在案上。'.repeat(70);
  const chapter = completedChapter(book.id, 1, oldText, volume.id);
  const nextChapter = store.chapters.create(book.id, volume.id, 2, {
    title: '山道', status: 'planned',
    outline: { goal: '沿旧路撤退', conflict: '旧冲突', scenes: [{ id: 'old', beat: '沿旧路返回' }] },
  });
 store.characters.create(book.id, { name: '主角', card: { role: '主角' }, tier: 'protagonist' });
  store.facts.create(book.id, { subject: '退路文书', predicate: '状态', object: '仍在案上', sourceChapter: 1 });
  // V0.100.16：正文形态与真实稿一致（多段）——引擎闸会对零换行超长候选重分段。
  const newText = '主角烧掉退路文书，带十个人当夜冲出营门。\n\n'.repeat(70).trim();

  const result = await prepareAndCommitNarrativeRevision(book.id, {
    rewrites: new Map([[chapter.id, newText]]),
    reason: 'recommendation recovery',
    projectionImpl: async ({ text }) => strictProjection(text),
    planImpl: async () => strictPlan({ nextChapterIdx: 2 }),
  });

  assert.equal(result.status, 'valid');
  assert.equal(store.chapters.fullText(chapter.id), newText);
 assert.equal(store.summaries.get(chapter.id).summary, '主角烧掉退路文书，带十人进入山道。');
  assert.equal(store.facts.active(book.id)[0].object, '退路文书');
 assert.match(store.characters.list(book.id).find(item => item.name === '主角').state_json, /山道/);
  assert.equal(store.chapters.outline(chapter.id)._narrative_revision.id, result.revisionId);
  assert.equal(store.chapterSettlements.get(chapter.id).content_hash, sha256(newText));
  assert.match(store.materials.get(book.id, 'outline').content, /当前叙事版本对齐/);
  assert.match(store.materials.get(book.id, 'outline').content, /烧掉退路文书并进入山道/);
  const volumeOutline = JSON.parse(store.volumes.get(volume.id).outline_json);
  assert.equal(volumeOutline._narrative_revision.state, 'aligned');
  assert.match(volumeOutline.remaining_direction, /断路代价/);
  const nextOutline = store.chapters.outline(nextChapter.id);
  assert.equal(nextOutline._narrative_revision.state, 'stale');
  assert.match(nextOutline.reconcile_seed.bridge_from_actual, /退路已毁/);
  assert.equal(nextOutline.scenes, undefined, '旧版未来场景不得继续潜伏在待写章节中');
  assert.match(store.books.settings(book.id).narrativePlan.futureDirection, /生存代价/);
  assert.equal(store.narrativeRevisions.blocking(book.id), null);
});

test('V0.100 plan reconciliation failure leaves prose, book outline and volume outline on the old version', async () => {
  const book = store.books.create({ title: '规划影子失败测试', genre: '历史' });
  store.materials.set(book.id, 'outline', '旧书纲逐字保留');
  const volume = store.volumes.create(book.id, 1, {
    title: '旧卷', goal: '旧目标', outline: { goal: '旧目标', marker: 'old-volume-plan' },
  });
 const oldText = '主角守住旧营门，退路文书仍在案上。'.repeat(70);
  const chapter = completedChapter(book.id, 1, oldText, volume.id);
 const newText = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);

  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    rewrites: new Map([[chapter.id, newText]]),
    projectionImpl: async ({ text }) => strictProjection(text),
    planImpl: async () => { throw Object.assign(new Error('plan invalid'), { code: 'PLAN_RECONCILE_INVALID' }); },
  }), /plan invalid/);

  assert.equal(store.chapters.fullText(chapter.id), oldText);
  assert.equal(store.materials.get(book.id, 'outline').content, '旧书纲逐字保留');
  assert.match(store.volumes.get(volume.id).outline_json, /old-volume-plan/);
});

test('V0.100 normal settlement extends the valid revision and invalidates only the immediate next outline', async () => {
  const book = store.books.create({ title: '正常续写同版测试', genre: '历史' });
  store.materials.set(book.id, 'outline', '原书纲长期方向');
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '穿过山道', outline: { goal: '穿过山道', chapters: [] },
  });
  const chapter1 = completedChapter(
    book.id, 1,
 '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70),
    volume.id,
  );
  const chapter2 = store.chapters.create(book.id, volume.id, 2, {
    title: '追兵', status: 'planned', outline: { goal: '摆脱追兵', conflict: '救人还是赶路' },
  });
  const initial = await prepareAndCommitNarrativeRevision(book.id, {
    projectionImpl: async ({ text }) => strictProjection(text),
    planImpl: async () => strictPlan({ nextChapterIdx: 2 }),
    reindex: false,
  });

 const chapter2Text = '追兵逼近时，主角留下自己的马，把受伤斥候扶上马背。'.repeat(70);
  store.chapters.update(chapter2.id, {
    status: 'drafted',
    outline: {
      goal: '摆脱追兵', conflict: '救人还是赶路',
      reader_gain: '看见断路决定的第一笔代价', reader_pull: '山口出现陌生旗号',
 scenes: [{ id: 's1', beat: '主角弃马救下斥候', target_words: 1000 }],
      _narrative_revision: { id: initial.revisionId, state: 'aligned' },
    },
  });
  store.scenes.create(chapter2.id, 1, { content: chapter2Text, status: 'done', targetWords: 1000 });
  const chapter3 = store.chapters.create(book.id, volume.id, 3, {
    title: '山口', status: 'planned', outline: { goal: '旧版山口计划', scenes: [{ beat: '旧场景不得沿用' }] },
  });

  await settleChapter(book.id, chapter2.id, {
    data: {
      facts: [], character_updates: [], character_notes: [], character_emotional: [],
      timeline: [], foreshadow_actions: [], new_entities: [], memory_entries: [],
 summary: '主角弃马救下受伤斥候，追兵因此进一步逼近。',
 rolling_update: '主角为救人失去坐骑，队伍被迫徒步赶往山口。',
    },
  });

  const extended = store.narrativeRevisions.current(book.id);
  assert.notEqual(extended.id, initial.revisionId);
  assert.equal(extended.parent_id, initial.revisionId);
  assert.equal(extended.through_chapter, 2);
  assert.equal(store.chapterProjections.list(extended.id).length, 2, '正常结算也应延伸可回放证据链');
  assert.equal(store.chapterSettlements.get(chapter2.id).result.narrativeRevision, extended.id);
  assert.equal(store.books.settings(book.id).narrativePlan.actualThroughChapter, 2);
  assert.match(store.materials.get(book.id, 'outline').content, /已写至：第2章/);
  const nextOutline = store.chapters.outline(chapter3.id);
  assert.equal(nextOutline._narrative_revision.state, 'stale');
  assert.match(nextOutline.reconcile_seed.bridge_from_actual, /弃马救下受伤斥候/);
  assert.equal(nextOutline.scenes, undefined);
  assert.doesNotThrow(() => assertNarrativeStateReady(book.id));
  assert.equal(narrativeStateStatus(book.id).status, 'ready');
});

test('V0.100 a valid revision whose completed prose changed out of band is rejected by source fingerprint', async () => {
  const book = store.books.create({ title: '指纹失配测试' });
 const text = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  const chapter = completedChapter(book.id, 1, text);
  await prepareAndCommitNarrativeRevision(book.id, {
    projectionImpl: async ({ text: current }) => strictProjection(current),
    planImpl: async () => ({ ...strictPlan(), volumes: [] }),
    reindex: false,
  });
  store.scenes.update(store.scenes.list(chapter.id)[0].id, { content: `${text}被绕过门禁改了一个字。` });
  assert.equal(narrativeStateStatus(book.id).status, 'mismatch');
  assert.throws(
    () => assertNarrativeStateReady(book.id),
    error => error.code === 'NARRATIVE_SOURCE_MISMATCH',
  );
});

test('V0.100 completed chapters beyond the valid revision are a coverage gap, not a ready book', async () => {
  const book = store.books.create({ title: '账本覆盖缺口测试' });
 const text1 = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  completedChapter(book.id, 1, text1);
  await prepareAndCommitNarrativeRevision(book.id, {
    projectionImpl: async ({ text: current }) => strictProjection(current),
    planImpl: async () => ({ ...strictPlan(), volumes: [] }),
    reindex: false,
  });
  completedChapter(book.id, 2, '第二章从旧工具导入，却没有进入叙事版本账本。'.repeat(70));

  const status = narrativeStateStatus(book.id);
  assert.equal(status.status, 'mismatch');
  assert.equal(status.coverageGap, true);
  assert.equal(status.requiresRebuild, true);
  assert.equal(status.ready, false);
  assert.throws(
    () => assertNarrativeStateReady(book.id),
    error => error.code === 'NARRATIVE_STATE_COVERAGE_GAP'
      && error.fromChapter === 2
      && error.throughChapter === 2,
  );
});

test('V0.100 projection reset preserves designed entities but removes old-prose ghost entities', () => {
  const book = store.books.create({ title: '实体设定态测试' });
  const designed = store.characters.create(book.id, {
 name: '主角', tier: 'protagonist', firstChapter: 1,
    personality: '寡言但会承担责任',
    card: { role: '主角', narrative_notes: ['旧正文派生注记不得进入基线'] },
    state: { 位置: '旧稿营门' },
  });
  store.characters.create(book.id, {
    name: '灰衣人', firstChapter: 1,
    card: { role: '（由正文取证，待完善）', source: 'narrative_projection' },
    state: { 位置: '旧稿暗巷' },
  });
  const designedLocation = store.locations.create(book.id, {
    name: '钓鱼城', card: { role: '长期舞台' }, state: { 状态: '旧稿受损' },
  });
  store.locations.create(book.id, {
    name: '旧稿临时山洞', firstChapter: 1,
    card: { source: 'narrative_projection', detail: '只在旧稿出现' },
  });

  store.resetNarrativeProjectionState(book.id, { throughChapter: 1 });

 assert.deepEqual(store.characters.list(book.id).map(row => row.name), ['主角']);
  assert.deepEqual(JSON.parse(store.characters.get(designed.id).state_json), {});
  assert.doesNotMatch(store.characters.get(designed.id).card_json, /旧正文派生注记/);
  assert.deepEqual(store.locations.list(book.id).map(row => row.name), ['钓鱼城']);
  assert.deepEqual(JSON.parse(store.locations.get(designedLocation.id).state_json || '{}'), {});
});

test('V0.100 an all-cleared rewrite can rebuild a clean empty baseline and then settle chapter one in order', async () => {
  const book = store.books.create({ title: '空白重写基线测试' });
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '重新出发',
    outline: { goal: '重新出发', actual_summary: '旧稿结果', chapters: [{ goal: '旧动态目标', scenes: [{ beat: '旧场景' }] }] },
  });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '第一章', status: 'planned',
    outline: { year: 1241, goal: '旧动态目标', scenes: [{ beat: '旧场景' }] },
  });
  store.facts.create(book.id, { subject: '旧稿人物', predicate: '位于', object: '旧营门', sourceChapter: 1 });
  markNarrativeStateStale(book.id, {
    fromChapter: 1, changedChapters: [1], reason: '全部正文已打回',
  });

  const empty = await prepareAndCommitNarrativeRevision(book.id, {
    projectionImpl: async () => { throw new Error('空白基线不应调用章节取证模型'); },
    planImpl: async () => { throw new Error('空白基线不应调用规划模型'); },
    reindex: false,
  });

  assert.equal(empty.status, 'valid');
  assert.equal(store.narrativeRevisions.current(book.id).manifest.empty_baseline, true);
  assert.equal(store.facts.active(book.id).length, 0);
  assert.equal(store.chapters.outline(chapter.id).year, 1241, '作者锁定的历史坐标应保留');
  assert.equal(store.chapters.outline(chapter.id).scenes, undefined, '旧动态场景必须清除');
  assert.doesNotThrow(() => assertNarrativeStateReady(book.id));

 const text = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  store.scenes.create(chapter.id, 1, { content: text, status: 'done', targetWords: 1000 });
  store.chapters.update(chapter.id, {
    status: 'drafted',
    outline: {
      year: 1241, goal: '烧掉退路文书并突围', conflict: '退路与抢先突围不可兼得',
      reader_gain: '看到选择立刻改变生路', reader_pull: '山道尽头旗号不明',
 scenes: [{ id: 's1', beat: '主角烧掉文书并突围', target_words: 1000 }],
    },
  });
  await settleChapter(book.id, chapter.id, {
    data: {
      facts: [], character_updates: [], character_notes: [], character_emotional: [],
      timeline: [], foreshadow_actions: [], new_entities: [], memory_entries: [],
 summary: '主角烧掉退路文书，带十人进入山道。',
 rolling_update: '主角亲手断路，队伍只能沿山道继续。',
    },
  });
  const firstRevision = store.narrativeRevisions.current(book.id);
  assert.equal(firstRevision.parent_id, empty.revisionId);
  assert.equal(firstRevision.through_chapter, 1);
  assert.equal(store.chapterProjections.list(firstRevision.id).length, 1);
});

test('V0.100.1 projection evidence failure gets exactly one feedback retry then succeeds on verbatim correction', async () => {
  const book = store.books.create({ title: '投影反馈纠正测试', genre: '历史' });
  store.materials.set(book.id, 'outline', '【原书纲】带上银簪，翻青林坳南下。');
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '南逃', outline: { goal: '南逃', chapters: [] },
  });
 const text = '主角烧掉退路文书。母亲揭开包袱角，把银簪搁进去，又用帕子包了两层。'.repeat(30);
  completedChapter(book.id, 1, text, volume.id);
  let calls = 0;
  let seenFeedback = null;
  const result = await prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test feedback retry',
    projectionImpl: async ({ text: current, feedback }) => {
      calls += 1;
      const payload = strictProjection(current);
      if (calls === 1) {
 // 实测 ch2 实证：模型把「母亲」误写成「她」——逐字与分段对齐都不命中
        const bad = '她揭开包袱角，把银簪搁进去，又用帕子包了两层。';
        payload.outline_actual.evidence = bad;
        return payload;
      }
      seenFeedback = feedback;
      return payload;
    },
    planImpl: async () => strictPlan({}),
    reindex: false,
  });
  assert.equal(result.status, 'valid');
  assert.equal(calls, 2, '首次证据判废后必须带反馈重答一次');
  assert.match(String(seenFeedback?.error || ''), /逐字定位/);
  assert.ok(String(seenFeedback?.badContent || '').includes('她揭开包袱角'), '反馈必须带上被拒的原输出');
});

test('V0.100.1 projection evidence failure twice in a row stays fail-closed', async () => {
  const book = store.books.create({ title: '投影二次失败测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '突围', outline: { goal: '突围', chapters: [] },
  });
 const text = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  completedChapter(book.id, 1, text, volume.id);
  let calls = 0;
  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test double failure',
    projectionImpl: async ({ text: current }) => {
      calls += 1;
      const payload = strictProjection(current);
 payload.outline_actual.evidence = '主角拔出刀冲向元军大营。';
      return payload;
    },
    planImpl: async () => strictPlan({}),
    reindex: false,
  }), /缺少可在当前正文逐字定位的证据/);
  assert.equal(calls, 2, '只准反馈纠正一次，第二次仍错立即停止，不得无界重试烧费');
  assert.ok(!store.narrativeRevisions.current(book.id), '失败重建不得留下可用版本');
});

test('V0.100.1 orphaned in-flight revisions (process killed mid-build) are failed on startup heal', () => {
  const book = store.books.create({ title: '悬挂版本自愈测试' });
  completedChapter(book.id, 1);
  const building = store.narrativeRevisions.create(book.id, {
    fromChapter: 1, throughChapter: 1, status: 'building', sourceHash: 'source-x', reason: '进程被杀前的重建',
  });
  assert.equal(store.narrativeRevisions.blocking(book.id).id, building.id, 'building 是阻塞头');

  const healed = store.narrativeRevisions.failOrphanedInFlight();

  assert.ok(healed >= 1, '至少自愈本测试的悬挂版本');
  const after = store.narrativeRevisions.get(building.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /进程中断|未提交/);
  assert.equal(store.narrativeRevisions.blocking(book.id), null, '自愈后不再阻塞重建');
});

test('V0.100.1 startup heal never touches valid revisions', async () => {
  const book = store.books.create({ title: '有效版本保护测试', genre: '历史' });
  store.materials.set(book.id, 'outline', '【原书纲】守住旧营门。');
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '守住', outline: { goal: '守住', chapters: [] },
  });
 const text = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  completedChapter(book.id, 1, text, volume.id);
  const result = await prepareAndCommitNarrativeRevision(book.id, {
    reason: 'establish valid revision',
    projectionImpl: async ({ text: current }) => strictProjection(current),
    planImpl: async () => strictPlan({}),
    reindex: false,
  });
  assert.equal(result.status, 'valid');

  store.narrativeRevisions.failOrphanedInFlight();

  assert.equal(store.narrativeRevisions.get(result.revisionId).status, 'valid', 'valid 版本不受启动自愈影响');
  assert.equal(store.narrativeRevisions.current(book.id).id, result.revisionId);
});

test('V0.100.1 interrupted rebuild resumes from cached chapter projections instead of restarting at chapter one', async () => {
  const book = store.books.create({ title: '断点续跑测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '突围', outline: { goal: '突围', chapters: [] },
  });
 const text1 = '主角烧掉退路文书，当夜冲出营门。'.repeat(70);
 const text2 = '主角烧掉退路文书，山道尽头亮出旗号。'.repeat(70);
  completedChapter(book.id, 1, text1, volume.id);
  completedChapter(book.id, 2, text2, volume.id);

  // 第一轮：第 1 章取证成功，第 2 章连续两次给出结构残缺投影 → 整批失败关闭
  let run1Calls = 0;
  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test resume run1',
    projectionImpl: async ({ chapter, text }) => {
      run1Calls += 1;
      if (chapter.idx === 1) return strictProjection(text);
      return { summary: '坏投影' }; // 缺 outline_actual → PROJECTION_INVALID，反馈重答一次仍坏
    },
    planImpl: async () => strictPlan({ completedChapterIdx: 2 }),
    reindex: false,
  }), /outline_actual/);
  assert.equal(run1Calls, 3, '第1章一次 + 第2章首次与反馈重答各一次');
  const failed = store.narrativeRevisions.latestFailedForBase(book.id, manuscriptSourceHash(book.id));
  assert.ok(failed, '失败版本必须可按同一正文指纹找回');
  assert.equal(store.chapterProjections.list(failed.id).length, 1, '断点前已验证的投影必须保留在失败版本里');

  // 第二轮：同一份正文再点重建——第 1 章复用已验证投影，只对第 2 章重新取证
  const seen = [];
  const events = [];
  const result = await prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test resume run2',
    projectionCache: true,
    projectionImpl: async ({ chapter, text }) => { seen.push(chapter.idx); return strictProjection(text); },
    planImpl: async () => strictPlan({ completedChapterIdx: 2 }),
    reindex: false,
    onEvent: event => events.push(event),
  });
  assert.equal(result.status, 'valid');
  assert.deepEqual(seen, [2], '已验证章节必须复用断点缓存，不再消耗模型调用');
  assert.ok(
    events.some(event => event.type === 'narrative_projection_progress' && event.chapter === 1 && event.resumed === true),
    '复用断点投影必须在进度事件里带 resumed 标志，让界面区分取证与续跑',
  );
});

test('V0.100.1 resume cache is bound to the manuscript fingerprint and invalidated by prose edits', async () => {
  const book = store.books.create({ title: '断点指纹测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '突围', outline: { goal: '突围', chapters: [] },
  });
 const text1 = '主角烧掉退路文书，当夜冲出营门。'.repeat(70);
 const text2 = '主角烧掉退路文书，山道尽头亮出旗号。'.repeat(70);
  const chapter1 = completedChapter(book.id, 1, text1, volume.id);
  completedChapter(book.id, 2, text2, volume.id);
  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test fingerprint run1',
    projectionImpl: async ({ chapter, text }) => (chapter.idx === 1 ? strictProjection(text) : { summary: '坏投影' }),
    planImpl: async () => strictPlan({ completedChapterIdx: 2 }),
    reindex: false,
  }), /outline_actual/);
  const baseBefore = manuscriptSourceHash(book.id);
  assert.ok(store.narrativeRevisions.latestFailedForBase(book.id, baseBefore));

  // 章节正文在重建间隙被改动 → 旧失败缓存整批失效，全部重新取证
  const scene = store.scenes.list(chapter1.id)[0];
 store.scenes.update(scene.id, { content: `${text1}主角又回头望了一眼。` });
  assert.notEqual(manuscriptSourceHash(book.id), baseBefore);
  assert.equal(
    store.narrativeRevisions.latestFailedForBase(book.id, manuscriptSourceHash(book.id)),
    null,
    '正文指纹变化后不得找回旧失败版本',
  );

  const seen = [];
  const result = await prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test fingerprint run2',
    projectionCache: true,
    projectionImpl: async ({ chapter, text }) => { seen.push(chapter.idx); return strictProjection(text); },
    planImpl: async () => strictPlan({ completedChapterIdx: 2 }),
    reindex: false,
  });
  assert.equal(result.status, 'valid');
  assert.deepEqual(seen, [1, 2], '正文变化后所有章节必须重新取证');
});

test('V0.100.1 structurally invalid projection gets exactly one feedback retry like evidence failures', async () => {
  const book = store.books.create({ title: '投影结构重答测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '突围', outline: { goal: '突围', chapters: [] },
  });
 const text = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  completedChapter(book.id, 1, text, volume.id);
  let calls = 0;
  let seenFeedback = null;
  const result = await prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test invalid retry',
    projectionImpl: async ({ text: current, feedback }) => {
      calls += 1;
      if (calls === 1) return { summary: '只有摘要' }; // 缺 outline_actual → PROJECTION_INVALID
      seenFeedback = feedback;
      return strictProjection(current);
    },
    planImpl: async () => strictPlan({}),
    reindex: false,
  });
  assert.equal(result.status, 'valid');
  assert.equal(calls, 2, '结构残缺投影也必须带反馈重答一次，且只准一次');
  assert.equal(seenFeedback?.kind, 'invalid');
  assert.match(String(seenFeedback?.error || ''), /outline_actual/);
});

test('V0.100.1 plan reconciliation evidence failure gets exactly one feedback retry then succeeds', async () => {
  const book = store.books.create({ title: '规划校准重答测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '突围', outline: { goal: '突围', chapters: [] },
  });
 const text = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  completedChapter(book.id, 1, text, volume.id);
  let calls = 0;
  let seenFeedback = null;
  const result = await prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test plan feedback retry',
    projectionImpl: async ({ text: current }) => strictProjection(current),
    planImpl: async ({ feedback }) => {
      calls += 1;
      if (calls === 1) {
 // 实测：卷级实际状态证据「今夜先让他入土。活人明日再谈去处。」无法在第5章定位
        const bad = strictPlan({});
        bad.volumes[0].evidence = [{ chapter: 1, quote: '今夜先让他入土。活人明日再谈去处。' }];
        return bad;
      }
      seenFeedback = feedback;
      return strictPlan({});
    },
    reindex: false,
  });
  assert.equal(result.status, 'valid');
  assert.equal(calls, 2, '规划校准证据判废后必须带反馈重答一次，不得直接杀死整批');
  assert.match(String(seenFeedback?.error || ''), /无法在第1章当前正文定位/);
  assert.ok(String(seenFeedback?.badContent || '').includes('今夜先让他入土'), '反馈必须带被拒输出');
});

test('V0.100.1 plan reconciliation failure twice in a row stays fail-closed', async () => {
  const book = store.books.create({ title: '规划校准二次失败测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, {
    title: '第一卷', goal: '突围', outline: { goal: '突围', chapters: [] },
  });
 const text = '主角烧掉退路文书，带十个人当夜冲出营门。'.repeat(70);
  completedChapter(book.id, 1, text, volume.id);
  let calls = 0;
  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    reason: 'test plan double failure',
    projectionImpl: async ({ text: current }) => strictProjection(current),
    planImpl: async () => {
      calls += 1;
      const bad = strictPlan({});
      bad.volumes[0].evidence = [{ chapter: 1, quote: '不存在的引文句子' }];
      return bad;
    },
    reindex: false,
  }), /无法在第1章当前正文定位/);
  assert.equal(calls, 2, '规划校准同样只准重答一次，第二次仍错立即 fail-closed');
  assert.ok(!store.narrativeRevisions.current(book.id), '失败重建不得留下可用版本');
});
