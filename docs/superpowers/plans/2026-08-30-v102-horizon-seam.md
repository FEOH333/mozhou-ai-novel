# V0.102 卷缝与长线压力 Implementation Plan

> **For agentic workers:** execute tasks directly in this session.

**Goal:** 卷大纲和章细纲必须编译上一卷实际出口、停滞弧与有界兑付队列，而不是灌入全量台账。

**Files:** `server/engine/horizon.js`；`outline.js` / `prompts.js` / `pleasure.js` / `volumereview.js` / `pilot.js`；`tests/v1020.test.js`

## Done

1. 纪律：`HORIZON_SEAM_TEXT`（机制+量化，无库存动作范例）
2. 编译器：`compileVolumeSeam` / `validateVolumeSeam` / `compileChapterHorizon` / `hooksDueToAge`
3. 槽位：卷纲 `seamText`、章纲 `horizonText`，只进 L4
4. 台账：short/medium 超期 expire 不转伏笔；章纲伏笔 ≤6
5. 卷审：pilot 开跑只审最近完成未审卷（`maxVolumes: 1`）；懒生成下一卷前补审上一卷
6. 测试：`tests/v1020.test.js`；v143 同步短线老化约定
