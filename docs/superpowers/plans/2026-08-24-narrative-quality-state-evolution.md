# Narrative Quality and Same-Version State Evolution Implementation Plan

> **For agentic workers:** if the environment provides an execution skill such as `superpowers:subagent-driven-development` or `superpowers:executing-plans`, use it to implement this plan task-by-task. Otherwise execute the tasks directly in this session, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent formulaic long-form degradation and make every prose rewrite atomically update or invalidate all dependent narrative state before automatic writing can continue.

**Architecture:** Treat manuscript prose as the authority and summaries, facts, characters, foreshadows, memory, outline alignment, pattern signatures, and vectors as rebuildable projections. A bounded context planner replaces the ever-growing full-history prompt, while strict outline/completion gates and a small evidence-backed lesson ledger replace prompt accretion. Recommendation recovery builds prose and projection candidates in shadow, validates their hashes and evidence, and performs one atomic swap.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, `node:test`, existing LLM router and SQLite store; no new agent-runtime dependency.

**Status:** Completed on 2026-08-24. Full verification: 1158/1158 tests passed; isolated V0.100 database migration, one-chapter pilot, narrative-state API, and HTTP smoke passed; production manuscript hash remained unchanged.

---

## File map

- Create `server/engine/narrative_state.js`: revision lifecycle, strict projection extraction, shadow validation, atomic projection materialization, and automatic-writing readiness gate.
- Create `server/engine/narrative_patterns.js`: deterministic structural signatures, recent-pattern comparison, and chapter pattern persistence.
- Create `server/engine/narrative_lessons.js`: scoped, evidence-backed lessons learned from verified external/editorial outcomes.
- Create `server/llm/context_planner.js`: bounded creative context assembled from stable materials, two recent chapters, current preceding scenes, compact state, and retrieval.
- Modify `server/db/schema.sql` and `server/db/store.js`: revision, shadow projection, pattern, lesson, and entity-baseline persistence APIs.
- Modify `server/engine/settle.js`: split extraction from projection application so normal settlement and full replay use one materializer.
- Modify `server/engine/polish.js`: never refresh a settlement hash while preserving stale results; unmanaged rewrites mark state stale.
- Modify `server/engine/recommendation_recovery.js`: extract and validate shadow projections before one atomic prose/state swap; store verified lessons only after global review.
- Modify `server/engine/outline.js` and `server/engine/prompts.js`: require a dramatic contract, detect repeated causal skeletons, remove mandatory stock surface actions, and stop soft-passing structurally incomplete outlines.
- Modify `server/engine/write.js`, `server/llm/cache.js`, and `server/engine/pipeline.js`: use bounded creative context, increase per-scene fulfillment, block short chapters before settlement, and block writing when state is stale.
- Modify `web/js/views/workshop.js` and `web/css/app.css`: show state-rebuild progress/failure separately from prose rewriting.
- Modify `tests/v099_release_feedback.test.js`, `tests/v043c.test.js`, and create `tests/v100_narrative_state.test.js` plus `tests/v100_quality_context.test.js`.
- Modify `README.md`, `AGENTS.md`, `docs/harness-evaluation-v099.md`, `server/version.js`, and `package.json` for V0.100.0.

### Task 1: Add revision, projection, pattern, lesson, and baseline persistence

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `server/db/store.js`
- Test: `tests/v100_narrative_state.test.js`

- [x] **Step 1: Write the failing persistence test**

```js
test('narrative revision persists shadow projections and only one valid head', () => {
  const book = store.books.create({ title: '同版测试' });
  const chapter = store.chapters.create(book.id, null, 1, { title: '第一章' });
  const first = store.narrativeRevisions.create(book.id, {
    fromChapter: 1, throughChapter: 1, status: 'building', sourceHash: 'source-a', reason: 'test',
  });
  store.chapterProjections.set(first.id, book.id, chapter.id, {
    chapterIdx: 1, sourceHash: 'chapter-a', payload: { summary: '第一章发生一件事' },
  });
  assert.equal(store.chapterProjections.list(first.id).length, 1);
  store.narrativeRevisions.complete(first.id, { sourceHash: 'source-a', manifest: { chapters: [1] } });
  assert.equal(store.narrativeRevisions.current(book.id).id, first.id);
  const second = store.narrativeRevisions.create(book.id, {
    fromChapter: 1, throughChapter: 1, status: 'stale', sourceHash: 'source-b', reason: 'rewrite',
  });
  assert.equal(store.narrativeRevisions.blocking(book.id).id, second.id);
});
```

- [x] **Step 2: Run the test and verify the APIs are missing**

Run: `node --test tests/v100_narrative_state.test.js`

Expected: FAIL because `store.narrativeRevisions` and `store.chapterProjections` are undefined.

- [x] **Step 3: Add the tables and store APIs**

Add idempotent schema and migration DDL for:

```sql
CREATE TABLE IF NOT EXISTS narrative_revisions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  parent_id TEXT,
  from_chapter INTEGER NOT NULL,
  through_chapter INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('building','ready','applying','valid','stale','failed')),
  source_hash TEXT NOT NULL,
  reason TEXT DEFAULT '',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  error TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_narrative_revision_book
  ON narrative_revisions(book_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chapter_projections (
  revision_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(revision_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS narrative_patterns (
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL,
  revision_id TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL,
  features_json TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(book_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS narrative_lessons (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  lesson_key TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('provisional','active','retired')),
  problem TEXT NOT NULL,
  positive_target TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  scope_start INTEGER,
  scope_end INTEGER,
  confidence REAL NOT NULL DEFAULT 0.5,
  uses INTEGER NOT NULL DEFAULT 0,
  outcome_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(book_id, lesson_key)
);

CREATE TABLE IF NOT EXISTS narrative_entity_baselines (
  book_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(book_id, entity_kind, entity_id)
);
```

Implement `store.narrativeRevisions`, `store.chapterProjections`, `store.narrativePatterns`, `store.narrativeLessons`, and `store.narrativeEntityBaselines` with parsed JSON on reads, enum validation on writes, and transaction-safe updates.

- [x] **Step 4: Run the persistence test**

Run: `node --test tests/v100_narrative_state.test.js`

Expected: PASS.

- [x] **Step 5: Commit the persistence layer**

```bash
git add server/db/schema.sql server/db/store.js tests/v100_narrative_state.test.js
git commit -m "feat: add versioned narrative projection storage"
```

### Task 2: Replace full-history creative prompts with a bounded context planner

**Files:**
- Create: `server/llm/context_planner.js`
- Modify: `server/engine/write.js`
- Modify: `server/engine/outline.js`
- Modify: `server/engine/settle.js`
- Test: `tests/v100_quality_context.test.js`

- [x] **Step 1: Write failing bounded-context tests**

```js
test('creative context excludes old full prose while retaining two recent chapters and current preceding scenes', () => {
  const fixture = makeFiveChapterBook();
  const messages = assembleCreativeMessages(fixture.book.id, [{ role: 'user', content: '写当前场景' }], {
    chapterId: fixture.chapters[4].id,
    sceneId: fixture.currentScene.id,
    recentChapterCount: 2,
  });
  const joined = messages.map(message => message.content).join('\n');
  assert.doesNotMatch(joined, /第一章独有旧句|第二章独有旧句/);
  assert.match(joined, /第三章独有句|第四章独有句/);
  assert.match(joined, /当前章前一场景独有句/);
  assert.ok(estimateTokens(joined) < 30_000);
});
```

- [x] **Step 2: Run the test and verify it fails**

Run: `node --test tests/v100_quality_context.test.js`

Expected: FAIL because `assembleCreativeMessages` does not exist.

- [x] **Step 3: Implement the planner**

Implement this public contract in `server/llm/context_planner.js`:

```js
export function assembleCreativeMessages(bookId, tailMessages = [], {
  chapterId,
  sceneId = null,
  recentChapterCount = 2,
  maxProseChars = 16_000,
} = {}) {
  const fixed = fixedPrefixMessages(bookId);
  const chapter = store.chapters.get(chapterId);
  const previous = store.chapters.list(bookId)
    .filter(item => item.idx < chapter.idx && isCompletedChapter(item))
    .slice(-recentChapterCount)
    .map(item => `【第${item.idx}章正文】\n${store.chapters.fullText(item.id)}`);
  const currentPrefix = store.scenes.list(chapterId)
    .filter(scene => (!sceneId || scene.idx < store.scenes.get(sceneId).idx) && scene.content)
    .map(scene => `【本章已写场景${scene.idx}】\n${scene.content}`);
  const visible = trimNewestBlocks([...previous, ...currentPrefix], maxProseChars);
  const tails = appendContextToFirstUser(tailMessages, visible.length
    ? `【近期正文窗口】\n${visible.join('\n\n')}`
    : '');
  return appendArchiveMemory(fixed, tails, bookId);
}
```

Keep `assembleMessages` for non-creative compatibility, but switch `writeScene` and `generateChapterOutline` to `assembleCreativeMessages`. Switch settlement extraction to `assembleReviewMessages`, because the settlement prompt already contains the exact chapter prose and structured prior state.

- [x] **Step 4: Verify bounded context and existing cache tests**

Run: `node --test tests/v100_quality_context.test.js tests/v016.test.js tests/v029.test.js`

Expected: PASS; stable system/public-material prefix remains first, and old prose is absent from creative requests.

- [x] **Step 5: Commit the context planner**

```bash
git add server/llm/context_planner.js server/engine/write.js server/engine/outline.js server/engine/settle.js tests/v100_quality_context.test.js
git commit -m "refactor: bound long-form creative context"
```

### Task 3: Add dramatic contracts and structural-pattern detection

**Files:**
- Create: `server/engine/narrative_patterns.js`
- Modify: `server/engine/outline.js`
- Modify: `server/engine/prompts.js`
- Modify: `server/engine/settle.js`
- Test: `tests/v100_quality_context.test.js`

- [x] **Step 1: Write failing outline and repetition tests**

```js
test('outline gate rejects null dramatic fields and a repeated causal skeleton', () => {
  const recentPatterns = [
    { signature: 'observe>adult_verify>record>distant_signal' },
    { signature: 'observe>adult_verify>record>distant_signal' },
  ];
  const outline = completeOutline({
    dramatic_question: '', counterforce: null, irreversible_change: '', choice_cost: '', reader_gain: '',
  });
  const issues = chapterOutlineQualityIssues(outline, {
    chapterLength: 5000,
    recentPatterns,
  });
  assert.ok(issues.some(issue => issue.code === 'OUTLINE_DRAMATIC_CONTRACT_MISSING' && issue.hard));
  assert.ok(issues.some(issue => issue.code === 'OUTLINE_STRUCTURE_REPEATED' && issue.hard));
});
```

- [x] **Step 2: Run the test and verify it fails**

Run: `node --test tests/v100_quality_context.test.js`

Expected: FAIL because the current quality gate ignores those fields and recent patterns.

- [x] **Step 3: Implement deterministic signatures and strict outline requirements**

Implement:

```js
export function narrativePatternFeatures({ outline = {}, text = '' } = {}) {
  return {
    opening: classifyOpening(text),
    initiative: classifyInitiative(outline, text),
    counterforce: classifyCounterforce(outline),
    resolution: classifyResolution(outline, text),
    artifact: dominantArtifact(outline, text),
    ending: classifyEnding(text, outline.reader_pull || outline.ending_hook),
  };
}

export function narrativePatternSignature(input) {
  const f = narrativePatternFeatures(input);
  return [f.opening, f.initiative, f.counterforce, f.resolution, f.artifact, f.ending].join('>');
}
```

Require non-empty `dramatic_question`, `counterforce`, `turn`, `irreversible_change`, `choice_cost`, `reader_gain`, and `reader_pull` on newly generated outlines. Allow explicit `low_conflict_reason` only for daily/setup chapters. Compare the prospective signature with the last five persisted patterns and hard-reject the third use of the same four-or-more feature skeleton.

Update the JSON schema in `chapterOutlineInstruction` to request these fields. Remove the mandatory “adult verifies / bodily stock reaction / every ending is a crisis” surface recipes; express success as causal change and reader effect. Persist the final signature after settlement.

- [x] **Step 4: Verify outline quality behavior**

Run: `node --test tests/v100_quality_context.test.js tests/v0971.test.js tests/v137.test.js`

Expected: PASS; existing complete outlines remain valid after test fixtures add the dramatic contract, incomplete/null outlines fail closed.

- [x] **Step 5: Commit the dramatic contract**

```bash
git add server/engine/narrative_patterns.js server/engine/outline.js server/engine/prompts.js server/engine/settle.js tests/v100_quality_context.test.js tests/v0971.test.js tests/v137.test.js
git commit -m "feat: detect repeated narrative skeletons"
```

### Task 4: Make length a pre-settlement completion gate

**Files:**
- Modify: `server/engine/write.js`
- Modify: `server/engine/prompts.js`
- Modify: `server/engine/pipeline.js`
- Modify: `tests/v043c.test.js`
- Test: `tests/v100_quality_context.test.js`

- [x] **Step 1: Write the failing no-settlement-on-short-chapter test**

```js
test('short chapter becomes quality_blocked before settlement mutates facts', async () => {
  const fixture = makeWrittenChapter({ lengthProfile: 5000, text: '短正文'.repeat(400) });
  await assert.rejects(
    runChapterFlow(fixture.book.id, fixture.chapter.id, fixture.mockOptions),
    error => error.code === 'CHAPTER_LENGTH_BLOCKED',
  );
  assert.equal(store.chapters.get(fixture.chapter.id).status, 'quality_blocked');
  assert.equal(store.chapterSettlements.get(fixture.chapter.id), undefined);
  assert.equal(store.facts.list(fixture.book.id).length, 0);
});
```

- [x] **Step 2: Run the test and verify current soft-debt behavior fails it**

Run: `node --test tests/v100_quality_context.test.js`

Expected: FAIL because the current pipeline settles and marks `done` before checking length.

- [x] **Step 3: Move and strengthen the gate**

Set scene minimum to `max(700, round(target_words * 0.85))`, keeping the existing bounded continuation repair. Immediately before `settleChapter`, run `checkChapterLength`; when below floor, call `blockQualityGate` with code `CHAPTER_LENGTH_BLOCKED`, preserve all prose, and stop. Delete the old post-settlement “remember to make later chapters longer” debt path.

- [x] **Step 4: Verify length healing and blocking**

Run: `node --test tests/v043c.test.js tests/v015.test.js tests/v100_quality_context.test.js`

Expected: PASS; `v043c` asserts `0.85`, short prose never creates a settlement, and normal self-healing still works.

- [x] **Step 5: Commit the completion gate**

```bash
git add server/engine/write.js server/engine/prompts.js server/engine/pipeline.js tests/v043c.test.js tests/v100_quality_context.test.js
git commit -m "fix: block short chapters before settlement"
```

### Task 5: Split settlement extraction from materialization

**Files:**
- Modify: `server/engine/settle.js`
- Modify: `server/engine/prompts.js`
- Test: `tests/v100_narrative_state.test.js`

- [x] **Step 1: Write failing materializer parity and stale-evidence tests**

```js
test('strict projection requires every derived claim to quote current prose', () => {
  const text = '主角烧掉退路文书，十个人当夜冲出营门。';
  assert.throws(() => validateNarrativeProjection({
    summary: '主角决定突围',
    outline_actual: validActualOutline(),
    facts: [{ subject: '主角', predicate: '烧掉', object: '退路文书', evidence: '正文没有这句话' }],
    character_updates: [], timeline: [], foreshadow_actions: [], memory_entries: [], new_entities: [],
  }, text), error => error.code === 'PROJECTION_EVIDENCE_MISSING');
});

test('normal settlement and replay materializer produce the same summary, fact, timeline and memory rows', () => {
  const projection = validProjectionFixture();
  applySettlementProjection(book.id, chapter.id, projection, { revisionId: 'rev-test' });
  assert.equal(store.summaries.get(chapter.id).summary, projection.summary);
  assert.equal(store.facts.active(book.id)[0].object, projection.facts[0].object);
  assert.equal(store.timeline.list(book.id)[0].event, projection.timeline[0].event);
});
```

- [x] **Step 2: Run and verify failure**

Run: `node --test tests/v100_narrative_state.test.js`

Expected: FAIL because extraction, validation, and database mutation are one inseparable function.

- [x] **Step 3: Refactor settlement**

Export these contracts:

```js
export async function extractSettlementProjection(bookId, chapterId, options = {}) { /* LLM only */ }
export function validateNarrativeProjection(payload, chapterText, chapter) { /* pure, evidence-backed */ }
export function applySettlementProjection(bookId, chapterId, payload, options = {}) { /* synchronous DB only */ }
export async function settleChapter(bookId, chapterId, options = {}) {
  const payload = options.data
    ? validateLegacyOrStrictProjection(options.data, store.chapters.fullText(chapterId), store.chapters.get(chapterId))
    : await extractSettlementProjection(bookId, chapterId, options);
  const settled = store.transaction(() => applySettlementProjection(bookId, chapterId, payload));
  await refreshProjectionSideEffects(bookId, chapterId);
  return settled;
}
```

The strict rebuild schema requires exact source evidence for facts, character changes, timeline events, foreshadow actions, memories, entities, and `outline_actual`. Normal settlement keeps legacy injected test-data compatibility but production LLM output uses the strict schema.

- [x] **Step 4: Verify settlement parity and historical tests**

Run: `node --test tests/v100_narrative_state.test.js tests/v028.test.js tests/v095.test.js tests/v122.test.js`

Expected: PASS.

- [x] **Step 5: Commit the settlement split**

```bash
git add server/engine/settle.js server/engine/prompts.js tests/v100_narrative_state.test.js
git commit -m "refactor: separate narrative extraction and projection apply"
```

### Task 6: Build shadow replay and atomic same-version swap

**Files:**
- Create: `server/engine/narrative_state.js`
- Modify: `server/db/store.js`
- Modify: `server/engine/polish.js`
- Modify: `server/engine/pipeline.js`
- Test: `tests/v100_narrative_state.test.js`

- [x] **Step 1: Write failing atomicity, stale-gate, and replay tests**

```js
test('projection failure leaves both old prose and old derived state untouched', async () => {
  const beforeText = store.chapters.fullText(chapter.id);
  const beforeFact = store.facts.active(book.id)[0].object;
  await assert.rejects(() => prepareAndCommitNarrativeRevision(book.id, {
    rewrites: new Map([[chapter.id, '新正文'.repeat(800)]]),
    reason: 'test',
    projectionImpl: async () => { throw Object.assign(new Error('bad projection'), { code: 'PROJECTION_INVALID' }); },
  }));
  assert.equal(store.chapters.fullText(chapter.id), beforeText);
  assert.equal(store.facts.active(book.id)[0].object, beforeFact);
});

test('successful revision atomically changes prose, summaries, facts, characters, outline alignment and revision head', async () => {
  const result = await prepareAndCommitNarrativeRevision(book.id, {
    rewrites,
    reason: 'recommendation recovery',
    projectionImpl: fixtureProjectionImpl,
  });
  assert.equal(result.status, 'valid');
  assert.equal(store.chapterSettlements.get(chapter.id).content_hash, sha256(store.chapters.fullText(chapter.id)));
  assert.equal(store.summaries.get(chapter.id).summary, '新稿摘要');
  assert.equal(store.chapters.outline(chapter.id)._narrative_revision.id, result.revisionId);
  assert.equal(store.narrativeRevisions.blocking(book.id), null);
});

test('automatic writing refuses an unmanaged completed-prose rewrite', async () => {
  applyValidatedChapterRewrite(book.id, chapter, changedText);
  await assert.rejects(() => runChapterFlow(book.id, nextChapter.id), error => error.code === 'NARRATIVE_STATE_STALE');
});
```

- [x] **Step 2: Run and verify current editorial-rebase behavior fails**

Run: `node --test tests/v100_narrative_state.test.js`

Expected: FAIL; current rewrite updates only the settlement hash and writing continues.

- [x] **Step 3: Implement revision preparation and atomic apply**

Implement this orchestration:

```js
export async function prepareAndCommitNarrativeRevision(bookId, {
  rewrites,
  reason,
  runTaskImpl = runTask,
  projectionImpl = extractProspectiveProjection,
  onEvent,
  signal,
}) {
  const prospective = prospectiveCompletedChapters(bookId, rewrites);
  const revision = store.narrativeRevisions.create(bookId, revisionDescriptor(prospective, rewrites, reason));
  const shadow = [];
  let priorState = emptyProjectionState();
  for (const chapter of prospective) {
    const payload = await projectionImpl({ bookId, chapter, text: chapter.text, priorState, runTaskImpl, signal });
    const validated = validateNarrativeProjection(payload, chapter.text, chapter);
    store.chapterProjections.set(revision.id, bookId, chapter.id, {
      chapterIdx: chapter.idx, sourceHash: sha256(chapter.text), payload: validated,
    });
    shadow.push({ chapter, payload: validated });
    priorState = reduceProjectionState(priorState, validated, chapter.idx);
    onEvent?.({ type: 'recovery_state_rebuild', chapter: chapter.idx, total: prospective.length });
  }
  validateShadowCompleteness(revision, prospective, shadow);
  return store.transaction(() => atomicApplyRevision(bookId, revision, rewrites, shadow));
}
```

`atomicApplyRevision` captures/restores entity baselines, clears only rebuildable narrative projections, applies prose without an editorial rebase, replays every completed chapter in order through `applySettlementProjection`, reconciles completed chapter outlines with `outline_actual`, marks future planned outlines stale, rebuilds history, records pattern signatures, and marks the revision valid. A changed source hash aborts with `REVISION_SOURCE_CHANGED` before any mutation.

For direct synchronous rewrite APIs, remove `_editorial_rebase`; after changing completed prose create a `stale` revision, delete the affected settlement/summary fingerprint, and return `requiresStateRebuild: true`. Add `assertNarrativeStateReady(bookId)` at the start of `runChapterFlow` before completed-chapter skipping.

- [x] **Step 4: Verify atomic replay and stale blocking**

Run: `node --test tests/v100_narrative_state.test.js tests/v122.test.js`

Expected: PASS; no test observes a mixed prose/state version.

- [x] **Step 5: Commit the state engine**

```bash
git add server/engine/narrative_state.js server/db/store.js server/engine/polish.js server/engine/pipeline.js tests/v100_narrative_state.test.js tests/v122.test.js
git commit -m "feat: atomically rebuild narrative state after rewrites"
```

### Task 7: Integrate recommendation recovery and scoped self-evolution

**Files:**
- Create: `server/engine/narrative_lessons.js`
- Modify: `server/engine/recommendation_recovery.js`
- Modify: `server/engine/write.js`
- Modify: `server/engine/outline.js`
- Modify: `server/engine/publication_feedback.js`
- Modify: `tests/v099_release_feedback.test.js`
- Test: `tests/v100_narrative_state.test.js`

- [x] **Step 1: Write failing recovery and lesson tests**

```js
test('recommendation recovery is not completed until same-version replay succeeds', async () => {
  await assert.rejects(() => executeRecommendationRecovery(book.id, run.id, {
    confirmedPublishedRewrite: true,
    runTaskImpl,
    narrativeRevisionImpl: async () => { throw new Error('projection failed'); },
  }));
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'failed');
  assert.equal(store.chapters.fullText(chapter.id), oldText);
});

test('verified recovery creates at most three scoped positive lessons for future prompts', () => {
  activateRecoveryLessons(book.id, runFixture, { revisionId: 'rev-ok' });
  const text = narrativeLessonsText(book.id, 21, { limit: 3 });
  assert.ok(text.split('\n').filter(line => line.startsWith('- ')).length <= 3);
  assert.match(text, /有效事件|不可逆变化/);
  assert.doesNotMatch(text, /分数|平台通过概率|编辑一定/);
});
```

- [x] **Step 2: Run and verify failure**

Run: `node --test tests/v099_release_feedback.test.js tests/v100_narrative_state.test.js`

Expected: FAIL because recovery currently calls `applyValidatedChapterRewrite` and completes after history-only rebuild.

- [x] **Step 3: Wire recovery through the revision engine**

After candidate and global review success, call `prepareAndCommitNarrativeRevision` with the accepted rewrite map. Do not mutate prose before that call. Emit `recovery_state_rebuild`, `recovery_state_checkpoint`, and `recovery_state_validated`; only then set recovery run `completed`.

Implement lesson conversion with stable keys:

```js
export function lessonsFromRecovery(run) {
  return run.work_orders.map(order => ({
    key: `${order.action}:${normalizePattern(order.reason)}`,
    problem: boundedProblem(order.reason),
    positiveTarget: order.rebuild_objective,
    evidence: order.evidence,
    scopeStart: run.end_chapter + 1,
    scopeEnd: run.end_chapter + 12,
    confidence: order.action === 'rebuild' ? 0.85 : 0.7,
  }));
}
```

Store lessons as provisional after evidence-backed diagnosis and activate only after global review plus valid revision. Inject only the three highest-confidence in-scope lessons into outlines and scenes, phrased as positive targets; never inject raw platform speculation or an unbounded failure log.

- [x] **Step 4: Verify recovery, published-sync marking, and lesson limits**

Run: `node --test tests/v099_release_feedback.test.js tests/v100_narrative_state.test.js`

Expected: PASS; failed projection leaves old prose, successful projection updates every dependent view and keeps published chapters on the sync list.

- [x] **Step 5: Commit recovery integration**

```bash
git add server/engine/narrative_lessons.js server/engine/recommendation_recovery.js server/engine/write.js server/engine/outline.js server/engine/publication_feedback.js tests/v099_release_feedback.test.js tests/v100_narrative_state.test.js
git commit -m "feat: turn verified recovery into scoped narrative learning"
```

### Task 8: Expose state-rebuild progress and document the harness decision

**Files:**
- Modify: `web/js/views/workshop.js`
- Modify: `web/css/app.css`
- Modify: `docs/harness-evaluation-v099.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `server/version.js`
- Modify: `package.json`
- Test: `tests/v100_quality_context.test.js`

- [x] **Step 1: Write failing source/UI assertions**

```js
test('recovery UI distinguishes prose review from projection rebuild', () => {
  const source = readFileSync('web/js/views/workshop.js', 'utf8');
  assert.match(source, /recovery_state_rebuild/);
  assert.match(source, /重建摘要、人物、伏笔、时间线与大纲投影/);
  assert.match(source, /recovery_state_validated/);
});
```

- [x] **Step 2: Run and verify failure**

Run: `node --test tests/v100_quality_context.test.js`

Expected: FAIL because the UI currently jumps from global prose review directly to completed.

- [x] **Step 3: Add progress messages and update documentation/version**

Map events to explicit user-facing lines:

```js
if (event === 'recovery_state_rebuild') {
  return `重建摘要、人物、伏笔、时间线与大纲投影：第 ${data.chapter}/${data.total} 章`;
}
if (event === 'recovery_state_validated') {
  return `正文与派生状态已通过同版本校验，正在原子生效`;
}
```

Update `docs/harness-evaluation-v099.md` with primary-source links and the final decision: do not embed DeepSeek Harness, Pi, LangGraph, or OpenAI Agents SDK as a second runtime; adopt checkpointed shadow state, bounded actions, replay, independent validation, and tracing internally. Explain that DSH is developer-preview/plugin-oriented, Pi is a minimal general loop, and LangGraph/OpenAI Agents provide useful persistence/session patterns but no narrative-domain state semantics.

Bump to `0.100.0` / `V0.100.0`. Document the three separate quality claims: deterministic invariant pass, model literary review, and real platform/reader outcome; never present the first two as proof of the third.

- [x] **Step 4: Run focused and full verification**

Run: `node --test tests/v100_quality_context.test.js tests/v100_narrative_state.test.js tests/v099_release_feedback.test.js`

Expected: PASS.

Run: `npm test`

Expected: all suites pass with zero failures.

- [x] **Step 5: Perform isolated real-book verification**

Use a temporary `NOVEL_DATA_DIR` containing a copy of the production database. Verify:

```powershell
$env:NOVEL_DATA_DIR = $isolatedDataDir
node server/maintenance/doctor.js --db "$isolatedDataDir\novel.db" --pretty
node server/maintenance/verify-narrative-state.js --book bk-demo-history --read-only
```

Expected: the read-only verifier reports all completed chapter hashes, identifies legacy editorial rebases as requiring a future revision, reports bounded-context estimates, and does not alter prose. Compare the production manuscript SHA-256 before and after; they must match.

- [x] **Step 6: Restart and smoke-test the local server**

Stop only the process listening on `127.0.0.1:8770`, restart with `start.bat`, then verify `/api/health` and the publication dashboard. Confirm no `fetch failed`, mixed-version completion, or stale-state continuation message is possible.

- [x] **Step 7: Commit the release**

```bash
git add web/js/views/workshop.js web/css/app.css docs/harness-evaluation-v099.md README.md AGENTS.md server/version.js package.json package-lock.json tests/v100_quality_context.test.js
git commit -m "feat: release V0.100.0 narrative quality overhaul"
```

## Self-review

- Spec coverage: the plan covers formulaic-quality causes, bounded context, incomplete outlines, short chapters, same-version rebuilding of settings-derived views, future-plan invalidation, recovery learning, UI visibility, Agent-framework evaluation, production-data protection, documentation, versioning, tests, restart, and commit.
- Placeholder scan: no `TBD`, `TODO`, deferred implementation, or unspecified “write tests” steps remain.
- Type consistency: revision statuses, table/API names, `prepareAndCommitNarrativeRevision`, projection hashes, and recovery injection hooks are consistent across tasks.
