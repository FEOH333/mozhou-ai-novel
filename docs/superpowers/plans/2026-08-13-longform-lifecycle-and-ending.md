# Longform Lifecycle and Ending System Implementation Plan

> **For agentic workers:** if the environment provides an execution skill such as `superpowers:subagent-driven-development` or `superpowers:executing-plans`, use it to implement this plan task-by-task. Otherwise execute the tasks directly in this session, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic early-middle, middle, late-middle, ending, and finale controls so automatic creation keeps escalating, converges debts before the ending, and cannot mark a book complete until its core promises are actually settled.

**Architecture:** Add a focused `longform_lifecycle.js` domain module that derives the current book stage from planned/completed volumes, owns stage duties, builds a structured payoff ledger, validates volume outlines, and reports ending readiness. Existing outline, review, continuation, and pilot modules consume this single source of truth; AI prompts receive the resulting contract, while deterministic checks remain authoritative. Store the ending blueprint as dynamic material plus compact settings metadata so it survives restarts without changing the database schema.

**Tech Stack:** Node.js ES modules, built-in `node:test`, `node:sqlite`, existing prompt/router/store infrastructure.

---

### Task 1: Lifecycle domain model

**Files:**
- Create: `server/engine/longform_lifecycle.js`
- Test: `tests/v111.test.js`

- [ ] **Step 1: Write failing stage-classification tests**

Create fixtures with twelve planned volumes and assert that volumes 1-2 are `opening`, 3-4 are `early_middle`, 5-7 are `middle`, 8-9 are `late_middle`, 10-11 are `ending`, and 12 is `finale`. Add a generic ten-volume fixture and assert the proportional fallback covers the same ordered stages.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/v111.test.js`

Expected: FAIL because `server/engine/longform_lifecycle.js` does not exist.

- [ ] **Step 3: Implement the deterministic lifecycle contract**

Export `LONGFORM_STAGES`, `resolveBookStage(bookId, options)`, `buildLifecycleContext(bookId, options)`, and `lifecyclePromptText(context)`. Each stage must define its purpose, required turn, payoff duty, arc budget, hook policy, and forbidden shortcuts. Prefer explicit `lifecycle_stage` metadata in a volume outline, then the twelve-volume historical phase mapping, then proportional volume position.

- [ ] **Step 4: Add stage-aware outline validation tests**

Assert that late-middle/ending outlines reject `new_major_arcs` entries, ending outlines reject missing `arcs_closed`/`hooks_paid`, and finale outlines reject missing `final_choice`, `irreversible_cost`, `core_promise_payoff`, `world_settlement`, and `closing_image`.

- [ ] **Step 5: Implement `validateLifecycleVolumeOutline` and make tests GREEN**

Run: `node --test tests/v111.test.js`

Expected: PASS, including deterministic issue codes such as `LATE_MAJOR_ARC_OPENED`, `ENDING_PAYOFF_MISSING`, and `FINALE_SETTLEMENT_MISSING`.

### Task 2: Persistent payoff ledger and ending readiness

**Files:**
- Modify: `server/engine/longform_lifecycle.js`
- Test: `tests/v112.test.js`

- [ ] **Step 1: Write failing payoff-ledger tests**

Build books with open foreshadows, open long/super pleasure hooks, open story arcs, unresolved contract promises, and no ending blueprint. Assert the ledger categorizes them as `core_promise`, `story_arc`, `foreshadow`, `reader_promise`, and `ending_form` obligations without treating short next-chapter hooks as blockers.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/v112.test.js`

Expected: FAIL because `buildPayoffLedger` and `endingReadiness` are not implemented.

- [ ] **Step 3: Implement deterministic blocker calculation**

Export `buildPayoffLedger(bookId)`, `endingReadiness(bookId, options)`, `endingBlueprintText(bookId)`, and `ensureEndingBlueprint(bookId, options)`. Read existing `contract_promises`, `story_arcs`, `foreshadows`, `pleasure_hooks`, protagonist arc, contract, book outline, and recent chapter summaries. Only blocking classes prevent completion; short hooks may remain as sequel-facing residue, while active main arcs, high-importance foreshadows, long/super promises, and the core ending form must close.

- [ ] **Step 4: Persist an explicit ending blueprint**

Store structured JSON in `public_materials(kind='ending_blueprint')` and compact generation metadata in `books.settings_json.longformLifecycle`. The blueprint schema must include `core_promise`, `final_opposition`, `final_choice`, `irreversible_cost`, `protagonist_settlement`, `relationship_settlements`, `world_settlement`, `historical_settlement`, `closing_image`, and `last_chapter_mode`.

- [ ] **Step 5: Make payoff-ledger tests GREEN**

Run: `node --test tests/v112.test.js`

Expected: PASS for both blocked and closure-ready fixtures.

### Task 3: Prompt and outline integration

**Files:**
- Modify: `server/engine/prompts.js`
- Modify: `server/engine/outline.js`
- Modify: `server/engine/continuation.js`
- Test: `tests/v111.test.js`

- [ ] **Step 1: Add failing prompt-contract assertions**

Assert volume and chapter outline prompts contain the current lifecycle stage, stage turn, arc budget, required payoff list, and forbidden shortcuts. Assert ending/finale prompts do not say “故事远未结束” and do not require a new cliffhanger in the final chapter.

- [ ] **Step 2: Inject lifecycle context into volume and chapter planning**

Pass `lifecycleText` into `volumeOutlineInstruction`, `chapterOutlineInstruction`, and `nextVolumeInstruction`. Extend volume JSON with `lifecycle_stage`, `stage_turn`, `arcs_advanced`, `arcs_closed`, `hooks_paid`, `new_major_arcs`, and `ending_delivery`; merge these fields into stored volume outlines.

- [ ] **Step 3: Enforce lifecycle validation during volume-outline retry**

Combine `validateLifecycleVolumeOutline` with existing historical validation. A lifecycle contract failure must regenerate the volume outline with precise issue codes; it must not silently store an outline that opens a major arc in the ending runway or omits finale settlements.

- [ ] **Step 4: Make focused planning tests GREEN**

Run: `node --test tests/v111.test.js tests/v112.test.js`

Expected: PASS.

### Task 4: Stage-specific reviews and convergence automation

**Files:**
- Modify: `server/engine/volumereview.js`
- Modify: `server/engine/prompts.js`
- Modify: `server/engine/polish.js`
- Modify: `server/engine/pilot.js`
- Test: `tests/v113.test.js`

- [ ] **Step 1: Write failing review-flow tests**

Assert volume-review context exposes lifecycle stage duties and payoff debt. Assert review output stores `stage_progress` and `ending_readiness`. Assert pilot runs a lifecycle checkpoint after each completed volume and emits an event that states whether the book should expand, turn, converge, or settle.

- [ ] **Step 2: Upgrade volume review to assess the whole-book duty**

Extend `volumeReviewInstruction` and stored reports with `stage_progress`, `arc_movement`, `payoff_movement`, `new_debt`, and `ending_readiness`. A locally good volume that misses its whole-book stage duty must receive a P1 planning work order instead of an A grade with zero issues.

- [ ] **Step 3: Replace generic ten-chapter review wording with stage-aware review**

Pass lifecycle context and ledger data to `midStoryReviewInstruction`. Persist future adjustments under the stage name so a newer stage review supersedes stale earlier advice instead of accumulating contradictory constraints.

- [ ] **Step 4: Add the volume checkpoint to pilot**

After volume review/foreshadow planning, call `ensureEndingBlueprint` when entering `ending` or `finale`, emit `lifecycle_checkpoint`, and persist a concise `longform_lifecycle` material consumed by the next volume and chapter plans.

- [ ] **Step 5: Make review-flow tests GREEN**

Run: `node --test tests/v113.test.js`

Expected: PASS.

### Task 5: Hard completion gate and graceful final chapter

**Files:**
- Modify: `server/engine/continuation.js`
- Modify: `server/engine/prompts.js`
- Modify: `server/engine/pilot.js`
- Test: `tests/v114.test.js`
- Test: `tests/v044.test.js`

- [ ] **Step 1: Write failing completion-gate tests**

Assert a book with sufficient words and no ordinary foreshadows still continues when a main story arc, long reader promise, or ending-form obligation is open. Assert AI `finished=true` cannot override deterministic blockers. Assert a configured safety cap pauses with `needsHuman=true` instead of emitting `book_done` for an unfinished book.

- [ ] **Step 2: Integrate `endingReadiness` before AI evaluation**

Update `localEndingCheck` to return blockers and runway details. Only closure-ready books may reach `aiEndingCheck`; only an AI-positive answer plus a second deterministic recheck may return `shouldContinue=false`.

- [ ] **Step 3: Correct safety-cap semantics**

At `maxChapters`/`maxContinuations`, return a paused/manual-review result rather than treating the cap as narrative completion. Pilot must emit `need_human` and never `book_done` when readiness blockers remain.

- [ ] **Step 4: Enforce final-chapter mode**

In the finale's last chapter require aftermath, relationship/world settlement, motif echo, and a closing image. Prohibit a new main conflict, unexplained time jump, or mandatory next-chapter cliffhanger.

- [ ] **Step 5: Make completion tests GREEN**

Run: `node --test tests/v044.test.js tests/v114.test.js`

Expected: PASS.

### Task 6: Upgrade the live Dasong book and verify

**Files:**
- Create: `server/maintenance/upgrade-demo-lifecycle.js`
- Modify: `server/engine/historical_longform.js`
- Modify: `README.md`
- Test: `tests/v115.test.js`

- [ ] **Step 1: Write failing Dasong lifecycle assertions**

Assert all twelve historical phases carry a generic lifecycle stage and explicit stage duty. Assert phase 12 contains the exact core-promise payoff, final moral choice, costs, political/military/world settlements, relationship settlements, and the ordinary-child closing image.

- [ ] **Step 2: Enrich the twelve historical phases**

Map volumes 1-2 to opening, 3-4 to early-middle, 5-7 to middle, 8-9 to late-middle, 10-11 to ending, and 12 to finale. Add irreversible turns, required closures, and new-major-arc budgets to each phase while preserving existing year/age/history constraints.

- [ ] **Step 3: Back up and upgrade the live book**

Use the existing SQLite online backup helper before mutation. The maintenance script must update only 《示例历史长篇》: merge lifecycle metadata into volumes 1-12, write the ending blueprint and lifecycle material, seed missing core story arcs with correct future activation windows, preserve all completed prose, and create a revision snapshot.

- [ ] **Step 4: Run the focused and full suites**

Run: `node --test tests/v111.test.js tests/v112.test.js tests/v113.test.js tests/v114.test.js tests/v115.test.js`

Expected: PASS.

Run: `npm test`

Expected: all suites pass with zero failures.

- [ ] **Step 5: Inspect the live database and restart the service**

Verify `PRAGMA integrity_check`, completed chapter hashes, planned chapter states, twelve lifecycle stages, ending blueprint schema, and no premature active future arcs. Restart the local service and verify `/api/health` returns HTTP 200.

