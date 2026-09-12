# V0.101 自动创作质量内核 Implementation Plan

> **For agentic workers:** execute tasks directly in this session. Steps use checkbox syntax.

**Goal:** 让自动写作在第一次落笔时守住人声、章级动作配额和低谷代价，而不是写完再靠返工捞。

**Architecture:** 题材偏好槽（`craft_profile`）作为 `isHistory` 的上层配置；章级红线在场景写作时按已用余量分配（`craft_quota`）；角色语音进结构化列并写审同注入；快感调度在连续兑现后派低谷章。

**Tech Stack:** Node.js ESM、`node:sqlite`、现有提示词/审校/roster 管线；无新依赖。

---

### Task 1: 题材偏好槽

**Files:** Create `server/engine/craft_profile.js`；Test `tests/v1010.test.js`

- [x] 历史预设 strict evidence/permission、中等回报、valleyCadence=4
- [x] 玄幻预设 high reward、evidence off、permission loose
- [x] settings.craftProfile 合法枚举可覆盖，非法键忽略

### Task 2: 写时章级余量配额

**Files:** Create `server/engine/craft_quota.js`；Modify `write.js` `prompts.js`

- [x] 已用满的母题本场景禁止再写
- [x] 余量按未写场景均分，末场吃完剩余
- [x] 高频套话「顿了顿/一股/缓缓/微微」走同一把尺

### Task 3: 角色语音卡

**Files:** schema/store/characters/roster/prompts/audit/web

- [x] `speech`/`speech_forbid` 列；性格单源仍是 personality
- [x] 注入「说话/禁腔」；禁腔出现在该角色对白 → medium
- [x] roster 只填空；前端工牌可见

### Task 4: 低谷调度与碎片纪律

**Files:** `literary_techniques.js` `pleasure.js` `prompts.js` `write.js`

- [x] 连续 valleyCadence 章有回报且无低谷 → 约束下一章
- [x] 写作指令仅在约束命中时注入低谷简报（不每章重复正例句）

### Task 5: 物证阈值随偏好

**Files:** `rules.js` `audit.js`

- [x] evidenceBound=strict 时 ≥2 处升 medium；off 时不报
- [x] 非历史题材默认不误伤
