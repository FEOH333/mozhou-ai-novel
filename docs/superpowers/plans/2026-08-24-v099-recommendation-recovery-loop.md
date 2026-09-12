# V0.99.0 推流反馈闭环与前 20 章质量返工 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with tests first. Do not rewrite any published chapter until the user explicitly confirms the recovery action in the UI. Preserve unrelated working-tree files.

**Goal:** 将番茄推荐评估结果、公开发布进度与作品数据变成自动创作可追踪的动态反馈，并提供一个先诊断质量曲线、再有证据地返工前 20 章、最后生成线上同步清单的安全闭环。

**Architecture:** 保留现有确定性创作流水线，不嵌入 DSH、Pi 或其他通用 agent runtime。新增一个领域内的 observe → plan → bounded act → independent verify → checkpoint 闭环：发布档案负责观察平台状态，动态 L4 提示负责让所有创作/审核看到同一份事实，推荐返工运行负责生成质量曲线、逐章工单、候选重写和双向盲审，数据库负责恢复与审计。所有公开页面抓取都经过严格 URL 白名单、超时和体积限制；失败只降级为可见状态，不阻断本地创作。

**Tech Stack:** Node.js ESM、`node:http`、`node:sqlite`、原生 `fetch`、现有 SSE/前端组件与 Node test runner；不新增生产依赖。

---

## Task 1: 固化外部框架取舍与产品契约

- [x] 在 `docs/harness-evaluation-v099.md` 记录 DSH、Pi、LangGraph、Mastra、OpenAI Agents 的能力、成熟度、与现有流水线的重叠及迁移成本。
- [x] 明确结论：不接入通用 runtime；借鉴可观测、计划、有限行动、独立验证和检查点思想，实现小说领域专用闭环。
- [x] 记录本项目既有 DSH 编辑实验的事实：并行调度能提量，但没有让《示例历史长篇》通过推荐评估，不能把编排能力等同于内容质量。
- [x] 在文档中列出重新评估接入框架的触发条件：需要跨工具自主行动、现有状态机无法表达的动态分支、至少两种生产模型/供应商稳定可用，以及有可重复质量基准证明收益。

## Task 2: 先写发布反馈领域模型的失败测试

**Files:**

- Create: `tests/v099_release_feedback.test.js`
- Modify after RED: `server/db/schema.sql`
- Modify after RED: `server/db/store.js`
- Create after RED: `server/engine/publication_feedback.js`

- [x] 测试只接受 `https://fanqienovel.com/page/<数字>`，拒绝非 HTTPS、子域欺骗、路径/query 注入和非番茄域，防止 SSRF。
- [x] 测试能够从真实形态的 `window.__INITIAL_STATE__` 脚本中解析书名、作品 ID、字数、页面读者数、末章标题/ID、发布时间和已发布章节数。
- [x] 测试花括号出现在 JSON 字符串内时仍可正确提取，缺字段或页面结构漂移时返回显式错误。
- [x] 测试发布档案、推荐评估历史、数据快照与返工运行均按 `book_id` 隔离、可追溯且级联清理。
- [x] 测试推荐剩余次数为 0—3，指标非负、百分比为 0—100，未知状态被拒绝。
- [x] 运行 `node --test tests/v099_release_feedback.test.js` 并确认因模块/表缺失而 RED，而不是测试语法错误。

## Task 3: 实现发布档案、平台同步与动态反馈

**Files:**

- Modify: `server/db/schema.sql`
- Modify: `server/db/store.js`
- Create: `server/engine/publication_feedback.js`

- [x] 新增 `publication_profiles`：平台链接、审核阶段、剩余次数、编辑反馈、疑似质量拐点、公开边界、同步状态、待同步章节和返工状态。
- [x] 新增 `recommendation_reviews` 追加式历史，保留每次审核结果而非覆盖事实。
- [x] 新增 `publication_metrics` 追加式快照，区分曝光前的自然零数据与得到真实曝光后的弱表现。
- [x] 新增 `recommendation_recovery_runs`，保存运行范围、质量曲线、工单、已完成/拒绝章节、快照 ID、错误与恢复状态。
- [x] 实现严格番茄 URL 解析、带 AbortController 的抓取、响应体上限、内容校验和 `__INITIAL_STATE__` 平衡括号提取。
- [x] 将公开章节列表与本地章节比较，保存公开边界；已发布正文有变化时累积线上同步清单。
- [x] 生成唯一的动态反馈上下文：审核失败是 P0 内容质量结论；楔子不能抵消第 7—20 章注水；前 1—6 章只是疑似基线而非自动合格；曝光前读者数为 0 不作负面推断；禁止虚构平台阈值和成功概率。
- [x] 运行聚焦测试直至 GREEN。

## Task 4: 先写推荐返工闭环的失败测试

**Files:**

- Extend: `tests/v099_release_feedback.test.js`
- Create after RED: `server/engine/recommendation_recovery.js`
- Modify after RED: `server/engine/prompts.js`
- Modify after RED: `server/engine/polish.js`

- [x] 测试默认返工范围为第 1—20 章，质量曲线将第 1—6 章标成“疑似基线待验证”、第 7—20 章标成“高风险待严审”，但最终以证据评分而非先验决定是否重写。
- [x] 测试诊断输出必须包含逐章有效事件、不可逆变化、人物代价、承诺兑现、重复/注水证据与章末追读力，且引用原文证据。
- [x] 测试发布章节在没有 `confirmedPublishedRewrite` 时绝不进入重写；确认后必须先创建恢复快照。
- [x] 测试候选新稿必须通过长度/空壳/连续性硬校验与两次 A/B 顺序互换的盲审；两次均明确选中新稿才可替换。
- [x] 测试任一轮盲审没有明确提升时保留旧稿、记录拒绝理由，不因“已经花了 Token”而落盘。
- [x] 测试通过替换的已发布章节进入线上同步清单，并且运行结果能从数据库恢复。
- [x] 测试全局复核必须检查 1—20 章推进密度曲线，不允许二十个局部可读章节组合成仍然注水的长段落。
- [x] 运行聚焦测试并观察预期 RED。

## Task 5: 实现质量曲线、工单、重写与独立验证

**Files:**

- Create: `server/engine/recommendation_recovery.js`
- Modify: `server/engine/prompts.js`
- Modify: `server/engine/polish.js`
- Modify: `server/llm/client.js`（仅为 mock LLM 增加可验证的协议输出）

- [x] 用高推理路由生成全局质量曲线和逐章工单，解析严格 JSON，引用必须能在原文定位。
- [x] 工单区分保留、微调、重构三种建议，禁止根据章号直接判罪；第 7—20 章的高风险先验只提高审查强度。
- [x] 重写沿用现有 `revise` 路由，输出完整章节并通过现有确定性改写校验。
- [x] 候选在模型盲审前先过确定性文风闸；旧稿已有 AI 模板腔/动作母题时必须减少，旧稿无命中时候选不得新增。
- [x] 使用现有评审路由进行候选 A/B 与 B/A 两轮盲审，校验双方引用、维度得分和明确胜者；位置偏差或结论矛盾即拒绝。
- [x] 每章只有在硬校验和双向盲审同时通过时才调用安全落盘函数；任何异常均保留原文。
- [x] 运行前创建快照，运行后统一重建历史、生成改动 diff 与线上同步清单。
- [x] 普通全书润色默认跳过已发布边界；只有专用返工按钮能在确认后处理已发布稿。
- [x] 运行聚焦测试直至 GREEN，并运行相关旧版 opening/polish 测试防止回归。

## Task 6: 接入写作、审核、提纲和自动驾驶的同源反馈

**Files:**

- Modify: `server/engine/outline.js`
- Modify: `server/engine/write.js`
- Modify: `server/engine/audit.js`
- Modify: `server/engine/pilot.js`
- Modify: `server/engine/prompts.js`

- [x] 在最终用户指令 L4 注入动态反馈，不污染 L1/L2 稳定缓存前缀。
- [x] 提纲、正文写作、章审、卷审和返工使用同一 `buildPublicationFeedbackContext` 数据源，防止“写作知道、审核不知道”。
- [x] 自动驾驶开始时对过期的公开页面状态做一次非阻断刷新；抓取失败发出可见事件并继续使用最近成功快照。
- [x] 审核失败期间，新章节规划必须显式解释本章如何避免第 7—20 章已经暴露的注水模式；不能拿新增楔子或继续堆字数当作整改。
- [x] 如果已有待同步已发布章节，在 UI 和自动驾驶事件中持续提醒，但不冒充线上已经更新。
- [x] 增加测试断言动态字段只出现在最后用户消息，且写作/审核收到一致内容。

## Task 7: 提供 API 与推流质量驾驶舱

**Files:**

- Modify: `server/index.js`
- Modify: `web/js/views/workshop.js`
- Modify: `web/js/api.js`
- Modify: `web/css/app.css`

- [x] 增加发布档案读取/保存、番茄同步、推荐审核追加、数据快照追加、返工 SSE、同步清单确认 API，全部经书籍作用域校验。
- [x] 工作台增加“推流质量驾驶舱”：失败状态、剩余机会、编辑原话、质量拐点、作品链接、自动同步状态、公开/本地章节差值、公开字数和末章。
- [x] 数据录入明确区分“未获曝光”和“已获曝光”，避免把推流前 0 读者误判为内容差；保存历史而非只显示最后值。
- [x] 返工按钮明确写出会处理已发布正文，弹出范围、快照和线上同步后果确认；默认强调第 7—20 章严审，但不自动毁掉第 1—6 章。
- [x] 返工进度展示诊断、工单、候选、双向盲审、采用/拒绝和全局复核，而不是一个模糊进度条。
- [x] 显示待线上同步章节列表；用户确认线上更新后才能清除。
- [x] 补齐空状态、抓取失败、页面结构变化、同名/ID 不一致和窄屏布局。

## Task 8: 用隔离数据做端到端验证，再配置真实作品

- [x] 使用临时数据库和 mock LLM 启动隔离服务，验证驾驶舱保存、同步解析、审核历史、指标历史、已发布保护、返工流和恢复状态。
- [x] 用浏览器验证桌面与窄屏界面、确认弹窗、错误提示及进度日志。
- [x] 在修改真实数据库前创建带时间戳备份，并校验备份可打开。
- [x] 为《示例历史长篇》写入用户明确提供的事实：推荐评估失败、剩余 2 次、编辑认为前 20 章不合格，以及“前 1—6 章或勉强可用、第 7—20 章越来越水”的作者判断（标为判断而非平台原话）。
- [x] 同步 `https://fanqienovel.com/page/7673157174960327705` 并核对作品 ID/书名后保存公开边界；不自动启动正文返工。
- [x] 若公开同步失败，保留 URL、失败原因和手动重试入口，绝不伪造已发布章节数。

## Task 9: 全量验证、文档、版本和提交

- [x] 更新 `README.md`：推荐反馈、作品数据、自动发布同步、前 20 章返工及安全边界。
- [x] 更新 `AGENTS.md`：版本、文件地图、经验、技术债和本次 harness 结论。
- [x] 将 `package.json`、`package-lock.json`、`server/version.js`、`web/index.html` 升级至 `0.99.0`。
- [x] 运行 `npm test`，要求所有测试通过且无跳过新增用例。
- [x] 运行 `node server/maintenance/doctor.js`，记录完整性、外键和作品健康检查结果；既有正文问题不隐藏。
- [x] 运行 `git diff --check`、检查 `git status --short`，确保不纳入用户已有的 `.dsh-subagents/`、`.mimosa/`、`docs/tmp/`、`tmp-*` 文件。
- [x] 进行最终代码审查：无书名/作品 ID 特判、无动态信号进入 L1/L2、无未确认的已发布正文改写、无吞掉的同步错误、无未关闭计时器/AbortController。
- [x] 使用 conventional commit：`feat: V0.99.0 推流反馈闭环与前20章返工`。
- [x] 最终交付说明包括：框架取舍、真实同步结果、没有自动改稿的安全说明、测试/doctor 结果、提交号，以及需要重启 `start.bat`。
