# Automatic Quality Root Guards Implementation Plan

> **For agentic workers:** Execute this plan task by task with strict test-driven development. Do not modify published chapters 1-18. Keep chapter 34 paused until every blocking guard and data migration passes.

**Goal:** Eliminate the root causes behind repeated semantic scenes, editorial language leaking into prose, stale constraints and story memory, outline/prose drift, frozen long arcs, and contradictory finale stages; then minimally repair only the confirmed defects already present in unpublished chapters 19-34.

**Architecture:** Add deterministic, book-agnostic hygiene and lifecycle invariants at the context-selection, quality-gate, settlement, audit, and doctor layers. Store constraints with explicit scope and supersession keys; keep editorial instructions out of factual story memory; prefer actual completed-chapter state over obsolete planned beats; compute lifecycle stages from the real volume structure. A transactional maintenance script will clean the current book only after the generic guards are active.

**Tech Stack:** Node.js ESM, node:sqlite, node:test, existing Express/SQLite application

---

### Task 1: Freeze current failures as regression tests

**Files:**
- Create: `tests/v0972.test.js`
- Read: `tests/v0971.test.js`
- Read: `server/engine/rules.js`
- Read: `server/db/store.js`
- Read: `server/engine/longform_lifecycle.js`

- [ ] Add failing tests for scoped and superseded constraints, including recovery feedback that must expire.
- [ ] Add failing tests for editorial/meta narration and contaminated story-memory detection.
- [ ] Add failing tests for same-scene event restarts: time regression, repeated briefing, and repeated wound treatment.
- [ ] Add failing tests proving completed-chapter audits prefer actual beats/summaries over stale planned beats.
- [ ] Add failing tests proving 15 concrete volumes override a stale configured count of 12 and only volume 15 can be finale.
- [ ] Run `node --test tests/v0972.test.js` and verify each new test fails for the intended missing behavior.

### Task 2: Introduce scoped constraint hygiene

**Files:**
- Modify: `server/db/store.js`
- Modify: constraint producers found by `rg "constraints\\.(add|recentText)" server`
- Test: `tests/v0972.test.js`

- [ ] Add backward-compatible columns for scope start/end and stable constraint key.
- [ ] Make keyed writes supersede older versions instead of accumulating duplicates.
- [ ] Filter context by chapter scope; unscoped recovery/audit feedback must not become permanent global law.
- [ ] Deduplicate selected rules and enforce the character budget across every source.
- [ ] Pass the current chapter index from outline/write/audit context callers.
- [ ] Run the focused constraint tests until green.

### Task 3: Separate editorial memory from story facts

**Files:**
- Modify: `server/engine/rules.js`
- Modify: settlement/rolling/fact context modules selected after code inspection
- Modify: `server/maintenance/doctor.js`
- Test: `tests/v0972.test.js`

- [ ] Implement a conservative editorial-voice detector for prose and a stricter contamination detector for summaries/facts.
- [ ] Reject or quarantine contaminated generated memory before it is reinjected into future prompts.
- [ ] Extend prompts to demand positive, factual summaries rather than negative writing instructions.
- [ ] Expose contamination as a blocking doctor finding.
- [ ] Run focused tests and existing rules tests.

### Task 4: Detect semantic duplicate events and continuity resets

**Files:**
- Modify: `server/engine/rules.js`
- Modify: `server/engine/audit.js`
- Modify: `server/maintenance/doctor.js`
- Test: `tests/v0972.test.js`

- [ ] Add high-confidence checks for within-scene chronological resets and duplicated event signatures.
- [ ] Add audit instructions for paraphrased duplicate scenes, entity send-away/reappearance, injury/travel timing, and knowledge-source regression.
- [ ] Make these checks block settlement or automatic continuation where confidence is high.
- [ ] Add doctor reporting with chapter and scene locations.
- [ ] Run focused tests until green.

### Task 5: Make completed prose the continuity authority

**Files:**
- Modify: `server/engine/audit.js`
- Modify: `server/engine/alignment.js`
- Modify: relevant outline/context modules
- Test: `tests/v0972.test.js`

- [ ] For completed chapters, prefer `actual_beat` or factual summary over obsolete planned beats.
- [ ] Preserve original plans separately while storing actual outcomes after settlement/alignment.
- [ ] Add doctor checks for year/era and planned/actual metadata drift.
- [ ] Ensure future creation consumes actual outcomes, not rejected versions.
- [ ] Run focused and alignment tests.

### Task 6: Enforce lifecycle and long-arc invariants

**Files:**
- Modify: `server/engine/longform_lifecycle.js`
- Modify: `server/maintenance/doctor.js`
- Test: `tests/v0972.test.js`

- [ ] Derive total volume count from the maximum meaningful concrete volume and configured plan.
- [ ] Remove title-specific stage logic from the generic engine.
- [ ] Require monotonic stages, exactly one finale, and finale only on the last volume.
- [ ] Report frozen ranks/roles, long-running unresolved investigations, and stale character/arc activity as review findings without inventing plot.
- [ ] Run lifecycle tests until green.

### Task 7: Transactionally repair the current book state

**Files:**
- Create: `server/maintenance/repair-demo-v0972.js`
- Create: `tmp-demo-review/patches-v0972.json`
- Modify: `tmp-demo-review/patches-v0971-v05.json`
- Modify: `server/maintenance/repair-demo-v0971-prose.js`
- Test: `tests/v0972.test.js`

- [ ] Implement dry-run by default, explicit `--apply`, server-port guard, SQLite backup, JSON snapshot, transaction, idempotency, and post-checks.
- [ ] Deactivate/scope stale constraints and replace editorial summaries/facts with positive factual records.
- [ ] Reconcile the intended 15-volume structure so only volume 15 is finale.
- [ ] Remove the three meta-editorial sentences from the old patch source so reruns cannot restore them.
- [ ] Apply only high-confidence unpublished-prose fixes: chapter 26 knowledge regression, chapter 27 pronoun/time bridge, chapter 29 duplicate briefing/treatment, chapter 31-33 meta leakage and injury/cart/flag continuity.
- [ ] Do not modify chapters 1-18 and do not generate chapter 34 scenes 2-4.
- [ ] Run dry-run twice and prove identical results; then stop port 8770 if needed and apply once.

### Task 8: Verify, document, and release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/version.js`
- Modify: `web/index.html`
- Modify: `AGENTS.md`
- Modify: audit documentation if findings changed

- [ ] Run `node --test tests/v0972.test.js`.
- [ ] Run the full test suite with `npm test`.
- [ ] Run doctor, `PRAGMA integrity_check`, chapter hashes, published-chapter hash comparison, conflict scan, health scan, and next-breakpoint check.
- [ ] Confirm chapter 34 remains incomplete and paused after scene 1.
- [ ] Update version and constitution lessons/file map.
- [ ] Review `git diff`, stage only task-owned changes, and create a Conventional Commit.
- [ ] Hand off with exact repairs, remaining literary judgments, and the required restart instruction for `start.bat` / port 8770.
