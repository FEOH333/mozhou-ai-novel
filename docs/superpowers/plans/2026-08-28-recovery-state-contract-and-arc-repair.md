# 推荐返工状态合同与整段协同修复 Implementation Plan

> **For agentic workers:** if the environment provides an execution skill such as `superpowers:subagent-driven-development` or `superpowers:executing-plans`, use it to implement this plan task-by-task. Otherwise execute the tasks directly in this session, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复推荐返工在中断恢复、跨运行候选、连败冻结和多章重构中的状态错误，使一次返工始终忠于当前诊断方案、保留完整候选血缘，并以整段因果蓝图协调相邻章节后再原子落盘。

**Architecture:** 将“运行策略、工单身份、候选血缘、局部验证、全局验证”拆成显式状态合同；失败运行的候选只保留为可审计材料，不能因一个 `accepted` 字符串跨方案自动放行。诊断仍以五章批次完成正文取证，但增加一次全范围综合规划；候选按章节顺序写入内存中的 prospective manuscript，使后章看到前章已通过的候选。传输层把后台任务与浏览器连接解耦，同时提供明确的服务端取消入口。

**Tech Stack:** Node.js ESM、`node:sqlite`、原生 `fetch`/SSE、Node test runner、原生前端 JavaScript；不新增生产依赖。

---

## Scope boundary

本计划只处理当前阻塞更新的“推荐诊断与返工”子系统。番茄公开章节同步、作品指标扩展、自动创作经验融合与 harness 最终取舍在本计划完成并验证后分别审计；不得借此计划改写《示例历史长篇》正文或清理用户现有未跟踪文件。

## File map

- Create `server/engine/recovery_contract.js`: 纯函数状态合同；生成工单指纹、运行策略、候选血缘和冻结键。
- Modify `server/db/schema.sql`: 为返工运行增加持久执行策略；旧数据库默认安全降级。
- Modify `server/db/store.js`: 迁移、解析、创建和更新执行策略。
- Modify `server/engine/recommendation_recovery.js`: 使用合同完成新鲜度检查、候选复用、冻结、全局状态和 rolling prospective manuscript。
- Modify `server/engine/prompts.js`: 增加全范围返工蓝图综合提示和校验所需字段。
- Modify `server/engine/publication_feedback.js`: 驾驶舱只把真正可恢复的运行标为可执行，并呈现局部/全局候选状态。
- Create `server/jobs/recovery-jobs.js`: 管理与浏览器连接无关、但可以显式取消的返工控制器。
- Modify `server/index.js`: 注册/查询/取消后台返工任务；断连不取消，用户操作可以取消。
- Modify `web/js/api.js` and `web/js/views/workshop.js`: 持久传递 fresh 策略、显示候选来源与部分完成、提供停止按钮。
- Create `tests/v1007_recovery_contract.test.js`: 状态合同和正式事故回归。
- Extend `tests/v099_release_feedback.test.js`: 整体诊断、滚动相邻上下文、冻结与完成语义。
- Extend `tests/v0991_recovery_transport.test.js`: 后台任务断连/取消行为测试，替代纯源码字符串断言。

### Task 1: 用纯状态合同重现本次事故

**Files:**

- Create: `tests/v1007_recovery_contract.test.js`
- Create after RED: `server/engine/recovery_contract.js`

- [ ] **Step 1: 写 fresh 策略必须跨重试持久的失败测试**

```js
test('fresh 运行中断后恢复仍禁止旧运行候选和旧失败账本', () => {
  const persisted = normalizeRecoveryPolicy({ candidateReuse: 'none', rejectionHistory: 'none' });
  const resumed = resolveRecoveryPolicy(persisted, { candidateReuse: 'exact_cross_run' });
  assert.deepEqual(resumed, { candidateReuse: 'none', rejectionHistory: 'none' });
});
```

- [ ] **Step 2: 写工单目标变化必须产生不同身份的失败测试**

```js
test('同章同 action 但目标或证据不同，不是同一工单', () => {
  const oldOrder = { chapter: 17, action: 'tune', objective: '压缩站香段', evidence: ['站了半炷香'] };
  const newOrder = { chapter: 17, action: 'tune', objective: '增加辨迹实战案例', evidence: ['只报所见'] };
  assert.notEqual(recoveryWorkOrderFingerprint(oldOrder), recoveryWorkOrderFingerprint(newOrder));
});
```

- [ ] **Step 3: 写候选来源必须跨检查点保存的失败测试**

```js
test('跨运行候选复制后保留原始运行与验证层级', () => {
  const provenance = normalizeCandidateProvenance({
    sourceRunId: 'old-run', sourceDiagnosisFingerprint: 'old-diagnosis',
    sourceWorkOrderFingerprint: 'old-order', validationState: 'local_passed',
  }, { checkpointRunId: 'new-run' });
  assert.equal(provenance.sourceRunId, 'old-run');
  assert.equal(provenance.checkpointRunId, 'new-run');
  assert.equal(provenance.validationState, 'local_passed');
});
```

- [ ] **Step 4: 运行测试并确认 RED**

Run: `node --test tests/v1007_recovery_contract.test.js`

Expected: FAIL，因为 `server/engine/recovery_contract.js` 尚不存在。

- [ ] **Step 5: 实现最小纯函数合同**

```js
export const RECOVERY_CONTRACT_VERSION = 'recovery-contract-v1007.1';

export function recoveryWorkOrderFingerprint(order = {}) {
  return sha256(stableJson({
    version: RECOVERY_CONTRACT_VERSION,
    chapter: Number(order.chapter), action: String(order.action || ''),
    objective: normalize(order.objective), reason: normalize(order.reason),
    evidence: [...new Set((order.evidence || []).map(normalize))].sort(),
  }));
}

export function resolveRecoveryPolicy(persisted, requested) {
  const current = normalizeRecoveryPolicy(persisted);
  if (current.candidateReuse === 'none' || current.rejectionHistory === 'none') return current;
  return tightenPolicy(current, requested);
}
```

- [ ] **Step 6: 运行测试并确认 GREEN**

Run: `node --test tests/v1007_recovery_contract.test.js`

Expected: PASS。

### Task 2: 持久化运行策略且旧库安全迁移

**Files:**

- Modify: `server/db/schema.sql:531-548`
- Modify: `server/db/store.js:28-150,459-470,619-688`
- Extend: `tests/v1007_recovery_contract.test.js`

- [ ] **Step 1: 写存储层 RED 测试**

```js
test('返工运行保存 execution_policy，更新请求只能收紧不能放宽', () => {
  const run = store.recommendationRecoveryRuns.create(book.id, {
    executionPolicy: { candidateReuse: 'none', rejectionHistory: 'none' },
  });
  assert.equal(run.execution_policy.candidateReuse, 'none');
  const resumed = store.recommendationRecoveryRuns.update(run.id, {
    executionPolicy: { candidateReuse: 'exact_cross_run', rejectionHistory: 'compatible' },
  });
  assert.equal(resumed.execution_policy.candidateReuse, 'none');
});
```

- [ ] **Step 2: 运行测试并确认缺列/缺映射 RED**

Run: `node --test tests/v1007_recovery_contract.test.js`

Expected: FAIL，运行行没有 `execution_policy`。

- [ ] **Step 3: 增加兼容列与迁移**

```sql
execution_policy_json TEXT NOT NULL DEFAULT '{}',
```

`migrate()` 对旧库执行：

```js
if (!recoveryColumns.has('execution_policy_json')) {
  db().exec("ALTER TABLE recommendation_recovery_runs ADD COLUMN execution_policy_json TEXT NOT NULL DEFAULT '{}'");
}
```

旧运行解析为空策略时默认 `same_run/compatible`，绝不默认允许跨运行候选。

- [ ] **Step 4: 在 create/update/row parser 接入策略并保持只可收紧**

- [ ] **Step 5: 运行聚焦测试并确认 GREEN**

Run: `node --test tests/v1007_recovery_contract.test.js tests/v099_release_feedback.test.js`

Expected: PASS。

### Task 3: 撤销“全局失败候选等于已验证候选”的旧策略

**Files:**

- Modify: `server/engine/recommendation_recovery.js:904-1112,1346-1360,1459-1501`
- Extend: `tests/v1007_recovery_contract.test.js`
- Modify: `tests/v099_release_feedback.test.js:1496-1818`

- [ ] **Step 1: 写真实事故 RED 测试**

```js
test('整段复核 fail 的旧运行候选不得跨新诊断零调用复用', async () => {
  // runOne 的候选局部盲审通过，但 globalReview=fail。
  // runTwo 的同章 action 相同、objective 不同。
  const result = await executeRecommendationRecovery(book.id, runTwo.id, {
    runTaskImpl, projectionImpl: projection,
  });
  assert.equal(reusedEvents.length, 0);
  assert.equal(rewriteCallsForRunTwo, 1);
  assert.notEqual(result.candidates[0].provenance.sourceRunId, runOne.id);
});
```

- [ ] **Step 2: 写同一运行精确断点仍然零调用的保护测试**

```js
test('同一运行、同一工单、同一旧稿的 local_passed 候选可断点复用', async () => {
  assert.equal(rewriteCallsAfterResume, 0);
  assert.equal(reused.provenance.sourceRunId, run.id);
  assert.equal(reused.provenance.validationState, 'local_passed');
});
```

- [ ] **Step 3: 运行并确认第一个测试因旧候选被复用而 RED，第二个保持 GREEN**

- [ ] **Step 4: 候选序列化加入 provenance 与 validation_state**

候选最少保存：

```js
{
  sourceRunId,
  checkpointRunId,
  sourceDiagnosisFingerprint,
  sourceWorkOrderFingerprint,
  sourceBeforeHash,
  sourceNeighborFingerprint,
  contractVersion,
  validationState: 'local_passed|global_passed|global_rejected|applied'
}
```

- [ ] **Step 5: failRun 根据真实终态标注候选**

- `globalReview.verdict === 'fail'` → `global_rejected`；
- 传输/结构错误且尚未完成总审 → 保持 `local_passed`，但只允许同一运行恢复；
- 全局通过、影子投影失败 → `global_passed`，可在精确同版条件下恢复；
- 原子落盘 → `applied`。

- [ ] **Step 6: 删除旧测试中“全局失败后跨运行必须零盲审复用”的错误断言，替换为安全行为断言**

- [ ] **Step 7: 运行聚焦测试直至 GREEN**

### Task 4: 修复冻结身份与重构章死锁

**Files:**

- Modify: `server/engine/recommendation_recovery.js:1114-1150,1362-1386,1417-1427`
- Extend: `tests/v1007_recovery_contract.test.js`

- [ ] **Step 1: 写第 17 章不同目标不得继承旧失败的 RED 测试**

```js
test('同章 tune 但工单指纹变化时不冻结', async () => {
  assert.notEqual(recoveryFailureLedgerKey(oldOrder, before), recoveryFailureLedgerKey(newOrder, before));
  await executeRecommendationRecovery(book.id, newRun.id, { runTaskImpl });
  assert.equal(generateCalled, true);
});
```

- [ ] **Step 2: 写 rebuild 冻结不得等待不可能发生的“其他章落盘”的 RED 测试**

```js
test('关键 rebuild 连败后要求重新规划，而不是进入自动解冻死锁', async () => {
  await assert.rejects(
    executeRecommendationRecovery(book.id, run.id, { runTaskImpl }),
    error => error.code === 'RECOVERY_REPLAN_REQUIRED',
  );
  assert.equal(rewriteCalls, 0);
});
```

- [ ] **Step 3: 运行并确认 RED**

- [ ] **Step 4: 冻结键改为 `contractVersion + workOrderFingerprint + beforeHash`**

- [ ] **Step 5: rebuild 达阈值时将运行标为需要重新诊断，不再声称会被其他章成功自动解冻**

- [ ] **Step 6: tune 冻结仍可部分继续，但结果必须记录 unresolved 章节**

- [ ] **Step 7: 运行聚焦测试直至 GREEN**

### Task 5: 执行前拒绝过期工单并复用同一基准快照

**Files:**

- Modify: `server/engine/recommendation_recovery.js:368-473,1012-1063`
- Modify: `server/engine/publication_feedback.js:349-369`
- Extend: `tests/v1007_recovery_contract.test.js`

- [ ] **Step 1: 写正文或平台反馈变化后旧工单不得直接执行的 RED 测试**

```js
test('诊断指纹过期的 failed 运行只显示 stale，执行返回 RECOVERY_PLAN_STALE', async () => {
  store.scenes.update(scene.id, { content: changedText });
  const annotated = annotateRecoveryRunsResumability(book.id, dashboard.recoveryRuns);
  assert.equal(annotated.find(item => item.id === run.id).resumeKind, 'stale');
  await assert.rejects(executeRecommendationRecovery(book.id, run.id),
    error => error.code === 'RECOVERY_PLAN_STALE');
});
```

- [ ] **Step 2: 写同一运行重试不重复制造快照的 RED 测试**

```js
test('同一基准正文的执行重试复用原恢复快照', async () => {
  await firstFailedExecution();
  await secondFailedExecution();
  assert.equal(store.snapshots.listAll(book.id).filter(row => row.source === 'recommendation_recovery').length, 1);
});
```

- [ ] **Step 3: 运行并确认 RED**

- [ ] **Step 4: 提取 currentDiagnosisFingerprint 并在 UI 标注和执行入口共用**

- [ ] **Step 5: 如果已有 snapshot_id 且基准正文哈希未变，复用快照；基准变化直接判计划过期**

- [ ] **Step 6: 运行聚焦测试直至 GREEN**

### Task 6: 增加全范围综合蓝图，而不是拼接五章评分

**Files:**

- Modify: `server/engine/prompts.js:1541-1595`
- Modify: `server/engine/recommendation_recovery.js:520-683`
- Extend: `tests/v099_release_feedback.test.js`

- [ ] **Step 1: 写诊断必须经过综合阶段的 RED 测试**

```js
test('五章取证完成后必须生成全范围 repair_plan 并由它派生工单', async () => {
  const run = await diagnoseRecommendationRecovery(book.id, { startChapter: 1, endChapter: 10, runTaskImpl });
  assert.equal(diagnosisBatchCalls, 2);
  assert.equal(synthesisCalls, 1);
  assert.deepEqual(run.result.repair_plan.arcs[0].chapters, [7, 8, 9, 10]);
  assert.equal(run.work_orders.find(order => order.chapter === 8).plan_arc_id, 'arc-investigation-break');
});
```

- [ ] **Step 2: 写综合输出缺章、证据无法回指或相邻目标矛盾时失败关闭的测试**

- [ ] **Step 3: 运行并确认 RED**

- [ ] **Step 4: 新增 `recommendationRecoverySynthesisInstruction`**

综合输入包含每批已验证证据、章节摘要式事件/代价/后果和上一轮全局否决；输出：

```json
{
  "arcs": [{
    "id": "arc-investigation-break",
    "chapters": [27, 28, 29, 30],
    "problem": "调查循环没有累积后果",
    "entry_state": "配角乙仍可用借口脱身",
    "exit_state": "诱饵行动迫使敌方暴露并造成实际损失",
    "causal_steps": [{"chapter": 27, "required_change": "布下诱饵"}],
    "protected_facts": ["配角乙身份尚未获得铁证"]
  }],
  "chapter_orders": [{
    "chapter": 27, "action": "rebuild", "objective": "...", "evidence": ["..."],
    "plan_arc_id": "arc-investigation-break", "depends_on": [], "must_handoff": "诱饵已布下但尚未收网"
  }]
}
```

- [ ] **Step 5: 严格验证综合工单只能引用批次取证中的真实章节与证据**

- [ ] **Step 6: 工单由综合结果生成；评分仅作证据索引，不再直接等于执行计划**

- [ ] **Step 7: 运行聚焦测试直至 GREEN**

### Task 7: 用 rolling prospective manuscript 协调相邻候选

**Files:**

- Modify: `server/engine/recommendation_recovery.js:1040-1044,1169-1389`
- Extend: `tests/v099_release_feedback.test.js`

- [ ] **Step 1: 写第 28 章必须看到候选版第 27 章尾部的 RED 测试**

```js
test('连续重构章按顺序生成，后章读取前章已通过候选接口', async () => {
  await executeRecommendationRecovery(book.id, run.id, { runTaskImpl });
  assert.match(rewritePrompts.get(28), /候选第27章独有交接锚点/);
  assert.doesNotMatch(rewritePrompts.get(28), /旧第27章交接锚点/);
});
```

- [ ] **Step 2: 写前章候选被拒时后章仍读取旧章接口的保护测试**

- [ ] **Step 3: 运行并确认 RED**

- [ ] **Step 4: 建立 `prospectiveTextByChapter`，候选 local_passed 后立即更新内存视图**

- [ ] **Step 5: 按 chapter 与 repair-plan dependencies 稳定排序工单；禁止循环依赖**

- [ ] **Step 6: 重构工单提示加入 arc entry/exit、depends_on 和 must_handoff，微调工单保持紧凑**

- [ ] **Step 7: 运行聚焦测试直至 GREEN**

### Task 8: 正确表达全局失败与部分完成

**Files:**

- Modify: `server/engine/recommendation_recovery.js:1409-1501`
- Modify: `server/engine/publication_feedback.js:349-369`
- Modify: `web/js/views/workshop.js:473-528,788-869`
- Extend: `tests/v099_release_feedback.test.js`
- Extend: `tests/v099_release_ui.test.js`

- [ ] **Step 1: 写 tune 未解决时结果为 partial 的 RED 测试**

```js
test('整段通过但仍有 tune 章未解决时明确返回 partial', async () => {
  assert.equal(result.completion, 'partial');
  assert.deepEqual(result.unresolvedChapters, [5, 17]);
});
```

- [ ] **Step 2: 写 global fail 后候选显示“局部通过/整段否决”，不得显示“已验证”的 UI RED 测试**

- [ ] **Step 3: 运行并确认 RED**

- [ ] **Step 4: 结果增加 `completion`、`unresolvedChapters`、`candidateStatsByValidation`**

- [ ] **Step 5: 驾驶舱和 toast 使用“全部完成/部分落盘/局部通过但整段未通过”三种语义**

- [ ] **Step 6: 运行聚焦测试直至 GREEN**

### Task 9: 后台任务可断连继续，也可被作者明确取消

**Files:**

- Create: `server/jobs/recovery-jobs.js`
- Modify: `server/index.js:148-174,932-967`
- Modify: `web/js/api.js:114-130`
- Modify: `web/js/views/workshop.js:788-869`
- Extend: `tests/v0991_recovery_transport.test.js`

- [ ] **Step 1: 写断开观察者不会 abort、显式 cancel 会 abort 的 RED 测试**

```js
test('返工后台控制器与 SSE 观察者解耦', () => {
  const job = recoveryJobs.start(book.id, run.id, 'execute');
  job.detachObserver('browser-1');
  assert.equal(job.signal.aborted, false);
  recoveryJobs.cancel(book.id, run.id);
  assert.equal(job.signal.aborted, true);
});
```

- [ ] **Step 2: 写同一 run 重复启动幂等返回活动任务、不同 run 返回 BOOK_BUSY 的测试**

- [ ] **Step 3: 运行并确认 RED**

- [ ] **Step 4: 实现进程内任务注册表，并以数据库运行记录作为可恢复进度真源**

- [ ] **Step 5: 增加 `GET .../jobs/current` 与 `POST .../:runId/cancel`，取消后运行状态为 cancelled、旧稿不落盘**

- [ ] **Step 6: 前端进行中状态提供“停止返工”按钮；页面刷新只断开观察，不冒充取消**

- [ ] **Step 7: 用真实 HTTP 服务测试断开客户端后任务仍推进检查点，再调用 cancel 确认停止**

- [ ] **Step 8: 运行聚焦测试直至 GREEN**

### Task 10: 版本、文档与完整验收

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `server/version.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `web/index.html`

- [ ] **Step 1: 更新宪章中的候选状态合同，删除“动作一致即可跨运行复用”的旧规则**

- [ ] **Step 2: 文档说明 fresh 策略持久、候选血缘、部分完成和停止行为**

- [ ] **Step 3: 更新版本单一真源并运行版本测试**

- [ ] **Step 4: 运行聚焦测试**

Run: `node --test tests/v1007_recovery_contract.test.js tests/v099_release_feedback.test.js tests/v099_release_ui.test.js tests/v0991_recovery_transport.test.js`

Expected: 全部 PASS，无 warning。

- [ ] **Step 5: 运行全量测试**

Run: `npm test`

Expected: 全部 PASS，无新增跳过。

- [ ] **Step 6: 只读检查正式数据库**

Run: `node server/maintenance/doctor.js --db data/novel.db --pretty`

Expected: SQLite integrity 与 foreign key 通过；不得执行任何正文修复或数据库写入。

- [ ] **Step 7: 审计正式运行记录而不启动返工**

确认当前 8 月 28 日运行仍为 failed、正文哈希未变化、旧候选只作为历史材料展示，不再被新策略自动采用。

- [ ] **Step 8: 运行 `git diff --check` 和 `git status --short`，只提交本计划列出的文件**

- [ ] **Step 9: conventional commit**

```bash
git commit -m "fix(recovery): make repair state durable and arc-aware"
```

- [ ] **Step 10: 提醒用户完全关闭旧的 8770 进程并重新启动 `start.bat`**

运行中服务早于代码提交，绝不能用旧进程的行为冒充新版本验证。

---

## Self-review

- Spec coverage: 覆盖 fresh 策略丢失、旧候选跨方案复用、来源洗平、不同工单错误冻结、重构冻结死锁、过期工单、重复快照、五章拼接诊断、相邻候选互不可见、局部/全局状态混淆、部分完成误报以及断连后无取消入口。
- Placeholder scan: 本计划没有 TBD/TODO；每项行为都有明确文件、失败测试、实现合同和运行命令。
- Type consistency: `execution_policy`、`candidateReuse`、`rejectionHistory`、`provenance`、`validationState`、`repair_plan`、`completion` 在各任务中保持同名；旧 `reusePriorCandidates` 仅作为 HTTP 向后兼容输入，不能放宽持久策略。
