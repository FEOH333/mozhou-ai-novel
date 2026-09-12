# V0.77 全面质量与可靠性升级实施计划

> **执行约束：** 每项实现先补能复现问题的失败测试，再做最小修复；任何用户数据修复都必须先备份、先 dry-run、后显式应用并再次执行 SQLite 完整性检查。

**目标：** 让“创建作品 → 点击开始自动创作 → 自动续写到完本”成为真实可达、可恢复、不会静默漏章或污染长期记忆的主路径，并为现有《示例玄幻长篇》提供可审计、可回滚的数据修复能力。

**架构原则：** 保留零构建、原生 Web、`node:http`、`node:sqlite` 与现有 REST/SSE 契约；只做向后兼容的表/索引增量迁移。将章节生命周期明确为“规划/写作中/部分完成/结算完成”，派生数据只在正文完整时事务性落库；所有长耗时写操作按作品加互斥租约。创作质量规则继续由 0.75 成长模块与 0.76 世界展开模块负责，但先修正它们依赖的事实、章节、卷序和派生状态数据源。

**技术栈：** Node.js ESM、`node:test`、`node:http`、`node:sqlite`、原生 HTML/CSS/JavaScript。

---

## 阶段 0：恢复基线与审计证据

### 任务 0.1：冻结现状并验证可恢复性

**文件：**

- 备份目录：`C:\AIcoding\_project_backups\AI小说写作工具\20260809-103444-pre-takeover-v076`
- 仓库：`C:\AIcoding\AI小说写作工具`

1. 保存完整 Git bundle、未提交工作树归档和独立 SQLite 副本。
2. 对源数据库和备份数据库执行 `PRAGMA integrity_check`。
3. 校验备份 SHA-256 与 Git bundle。
4. 在 `codex/comprehensive-quality-overhaul` 隔离分支冻结原有 0.75/0.76 改动。
5. 记录 `npm test`、全文件 `node --check`、测试覆盖率和 `npm audit` 基线。

### 任务 0.2：形成可追溯审计报告

**文件：**

- 新建：`docs/audits/2026-08-09-comprehensive-audit.md`

1. 记录代码、接口、UI、数据、成品小说五类发现。
2. 每项包含严重度、触发路径、证据位置、用户影响、回归测试和兼容策略。
3. 区分“代码缺陷”“既有数据损坏”“成品内容质量问题”，避免把正文评价误当程序事实。

## 阶段 1：阻止继续写坏（P0）

### 任务 1.1：修复场景重试后漏写后续场景

**文件：**

- 修改：`tests/v029.test.js`
- 修改：`server/engine/pipeline.js`

1. 在现有双场景故障测试中断言场景 2 最终为 `done/revised` 且正文非空。
2. 运行 `node --test tests/v029.test.js`，确认当前实现因重试成功后的 `return` 而失败。
3. 将成功重试后的函数退出改为继续下一个场景。
4. 重跑单测并确认通过。

### 任务 1.2：禁止不完整章节审校、结算和标记完成

**文件：**

- 修改：`tests/pipeline.test.js`
- 修改：`tests/v021.test.js`
- 修改：`server/engine/pipeline.js`
- 修改：`server/engine/pilot.js`

1. 新增“终态场景失败”测试：后续场景可以保留，但不得调用结算，不得把章节标为 `done/settled`。
2. 引入明确的 `partial` 结果与章节状态；事件必须说明可自动续跑。
3. pilot 对同章做有界补写，持续失败时停止向后写作并给出可恢复状态，避免洞后续写。
4. 将旧的轻量场景补写改为完整章节流程，使补写成功后重新审校与结算。
5. 验证中断后再次运行会跳过已完成场景并只补缺失部分。

### 任务 1.3：使章结算原子化并防止同正文重复结算

**文件：**

- 修改：`server/db/schema.sql`
- 修改：`server/db/store.js`
- 修改：`server/engine/settle.js`
- 新建：`tests/v077_settlement.test.js`

1. 新增事务帮助器测试：中途抛错后事实、时间线、摘要、角色状态均回滚。
2. 新增同一正文重复调用结算测试：事实、时间线、关系、滚动摘要不能重复。
3. 用向后兼容的 `chapter_settlements` 指纹记录正文哈希和结算结果。
4. LLM 抽取在事务外完成；所有数据库应用和章节 `settled` 状态在同一事务内提交。
5. 旧库已有摘要且章节已完成时建立兼容基线，不重复消费或重复落库。

### 任务 1.4：修复流式截断被当成正常完成

**文件：**

- 修改：`server/llm/client.js`
- 新建：`tests/v077_streaming.test.js`

1. 用永不继续的可控流复现 idle timeout。
2. 断言超时必须抛出带稳定错误码的异常，不能把部分文本当完整响应。
3. 将定时器状态与 reader 结束状态分离；由超时主动抛错，而不是依赖 `reader.cancel()` 抛错。
4. 验证 AbortSignal、正常 `[DONE]`、网络断开、空流四条路径。

### 任务 1.5：归档必须先验证再删除历史

**文件：**

- 修改：`server/engine/archive.js`
- 修改：`tests/v016.test.js` 或新建 `tests/v077_archive.test.js`

1. 构造不可解析归档响应，断言滚动摘要与历史均保持不变。
2. 要求归档结果满足结构和必保清单校验后，才进入数据库事务。
3. 在同一事务内保存归档、更新摘要、删除对应历史。
4. 校验失败发出可重试错误，不以 `{}` 静默覆盖。

## 阶段 2：修复长期记忆与成长/世界展开上游数据

### 任务 2.1：统一“最近事实”语义

**文件：**

- 修改：`server/db/store.js`
- 修改：`server/engine/factbook.js`
- 修改：`server/engine/audit.js`
- 修改：`server/engine/archive.js`
- 修改：`server/engine/recovery.js`
- 修改：`server/engine/settle.js`
- 新建：`tests/v077_facts.test.js`

1. 插入超过窗口大小且时间戳相同/不同的事实，证明当前 `DESC + slice(-N)` 选中了最旧事实。
2. 增加显式 `facts.recent(bookId, {status, limit})`，排序固定为 `created_at DESC, rowid DESC`。
3. 替换审校、归档、恢复、结算和无命中检索中的反向切片。
4. 对相关性同分项保留新事实优先。

### 任务 2.2：入口去重与正确归档事实

**文件：**

- 修改：`tests/v068.test.js`
- 修改：`server/engine/factbook.js`
- 修改：`server/db/store.js`

1. 将“同义谓词 + 同对象不重复建”测试改成真实契约：第二次 `created=0`。
2. `applyFacts` 在写入前跳过完全等价事实，并报告 `skipped`。
3. 超上限事实使用 `archived` 状态，不再伪装成带 `superseded_by=undefined` 的冲突替代。
4. 保留旧 `superseded` 数据可读，不做破坏性迁移。

### 任务 2.3：健康快照按章节更新而非重复堆积

**文件：**

- 修改：`server/db/store.js`
- 修改：`server/engine/recovery.js`
- 修改：`server/engine/pleasure.js`
- 新建：`tests/v077_health.test.js`

1. 复现同章重复记录导致漂移滑窗被一个章节占满，以及 `chapterHealth.add()` 不返回记录导致 note 丢失。
2. 增加按 `chapter_id` 的 upsert；保留 `chapter_id IS NULL` 的测试/全局事件追加语义。
3. 让快感审计与健康记录更新同一行。
4. 漂移窗口按不同章节 idx 取最近状态。

### 任务 2.4：实体更新只合并、不覆盖丰富卡片

**文件：**

- 修改：`server/engine/settle.js`
- 新建：`tests/v077_entities.test.js`

1. 用已有丰富地点/势力卡 + 新抽取浅卡复现字段丢失。
2. 深/浅合并卡片，仅以非空新值补充或更新对应字段。
3. 首次/最近登场章节保持单调正确。

## 阶段 3：真正可用的一键主路径与并发控制

### 任务 3.1：让无章节新书也能点击“开始自动创作”

**文件：**

- 修改：`web/js/views/workshop.js`
- 新建：`tests/v077_workshop.test.js`

1. 提取自动创作控制卡，使它不依赖当前章节。
2. 空书写作台显示主按钮与“将自动生成契约/设定/卷纲/章节”的说明。
3. 保留已有章节页面的按钮、目标章数、自动打磨选项和 SSE 进度。
4. 用可导入的渲染函数或轻量 DOM 测试验证空章节分支确实包含 pilot 按钮。

### 任务 3.2：为每本书增加服务端写作租约

**文件：**

- 新建：`server/jobs/book-lease.js`
- 修改：`server/index.js`
- 新建：`tests/v077_http.test.js`

1. 同时发起两个同书 pilot/flow/write/polish 请求，第二个必须得到 `409 BOOK_BUSY`。
2. 不同作品可以并行。
3. 正常完成、异常、客户端断开三条路径都必须释放租约。
4. 返回当前任务类型和开始时间，前端展示“本书已有自动任务在运行”。

### 任务 3.3：统一前端 SSE 控制器生命周期

**文件：**

- 修改：`web/js/state.js`
- 修改：`web/js/app.js`
- 修改：`web/js/views/workshop.js`

1. 用控制器集合替代单个 `state._activeSSE`。
2. 页面切换取消本页全部流；单个流结束只移除自己。
3. 按钮恢复、AbortError、服务端 error 事件均有一致反馈。

### 任务 3.4：修复 pilot 停止、续写和打磨接线

**文件：**

- 修改：`server/engine/pilot.js`
- 修改：`server/engine/continuation.js`
- 修改：`tests/v030.test.js`
- 修改：`tests/v044.test.js`
- 新建：`tests/v077_pilot.test.js`

1. 行为测试证明 `smoothTransitions` 在完本打磨后实际执行，而不是因未导入被 catch。
2. 达到恢复轮数上限时设置终止状态，真正退出外层循环。
3. 安全章数上限优先于未回收伏笔，避免无限续卷。
4. `written` 分离为已完成总数、本轮新增数、失败数，维护任务只按本轮成功章触发。
5. 未完成缺口存在时禁止生成下一卷。

## 阶段 4：HTTP、安全、备份与兼容性

### 任务 4.1：建立可测试的服务器工厂与真实 HTTP 测试

**文件：**

- 修改：`server/index.js`
- 新建：`server/version.js`
- 新建：`tests/v077_http.test.js`

1. 提取 `createAppServer()`；仅直接运行入口时监听端口和安装进程信号处理。
2. 测试中监听随机端口，真实请求 health/settings/static/404/body-limit/SSE。
3. API 错误保留现有 JSON/SSE 结构和错误码。

### 任务 4.2：绝不回传 API Key，并补齐设置协议保存

**文件：**

- 修改：`server/index.js`
- 修改：`tests/v077_http.test.js`

1. 配置测试密钥后 GET `/api/settings`，断言响应序列化文本不含完整密钥且无 `apiKey` 字段。
2. 保留 `hasApiKey` 和掩码；极短密钥也不得完整出现在掩码中。
3. 将 `protocol` 纳入 PUT allowlist 并验证保存/回读。
4. 给 API 与静态资源增加 `nosniff`、referrer、frame 和兼容的 CSP 头。

### 任务 4.3：校验父子资源归属

**文件：**

- 修改：`server/index.js`
- 修改：`tests/v077_http.test.js`

1. 为卷、章、场景、角色、地点、物品、势力、伏笔、快照建立统一 ownership helper。
2. 使用 A 书路径访问 B 书资源必须返回 404/409，且数据库不变化。
3. 所有写路由优先校验父资源，再调用引擎。

### 任务 4.4：统一一致性备份

**文件：**

- 修改：`server/db/store.js`
- 修改：`server/index.js`
- 新建：`tests/v077_backup.test.js`

1. 测试 `NOVEL_DATA_DIR` 下的活动数据库才是备份源。
2. 启动每日备份复用 WAL checkpoint 后的一致性快照逻辑，不再直接复制硬编码 `ROOT/data/novel.db`。
3. 备份写临时文件、完整性校验通过后原子改名；保留策略可测试。

### 任务 4.5：统一版本与文档

**文件：**

- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`server/version.js`
- 修改：`web/index.html`
- 修改：`README.md`
- 新建：`升级报告-V0.77.txt`

1. health、UI、package、README 只使用一个 V0.77 版本源或自动同步校验。
2. README 更新真实测试数、启动方式、备份位置、一键流程、恢复语义和已知依赖风险。
3. 不宣称未被行为测试覆盖的能力。

## 阶段 5：规划/重写/归档的派生数据一致性

### 任务 5.1：卷纲重生成不得重复追加章节

**文件：**

- 修改：`server/engine/outline.js`
- 修改：`tests/v036.test.js`
- 新建：`tests/v077_outline.test.js`

1. 对已有卷连续生成两次卷纲，断言章节数与全书 idx 唯一。
2. 默认复用该卷已有章节，按卷内位置更新未写章；只有明确追加模式才创建新章。
3. 已完成章节正文和 ID 不变。

### 任务 5.2：重规划和正文重写必须处理派生状态

**文件：**

- 修改：`server/engine/recovery.js`
- 修改：`server/engine/polish.js`
- 修改：`server/engine/volumereview.js`
- 新建：`server/engine/reconcile.js`
- 新建：`tests/v077_reconcile.test.js`

1. 建立章节派生数据清单：summary、facts、timeline、角色/实体状态、伏笔动作、健康、滚动摘要和结算指纹。
2. 重规划前保存快照，并对待重写区间做可逆失效标记，不能只删场景和 history。
3. 打磨/卷审修改正文后标记 `needs_reconcile`，按章序重建受影响派生状态后再恢复完成状态。
4. 全书打磨分段覆盖所有章节，不能只审前 15 万字符。

### 任务 5.3：草稿续写必须保留已有正文

**文件：**

- 修改：`server/engine/write.js`
- 修改：`tests/v021.test.js`

1. 故障后保存带唯一前缀的草稿。
2. 续写响应无论是否重复前缀，最终正文都必须完整保留草稿且无大段重复。
3. 历史消息只追加一份最终合并正文。

## 阶段 6：现有《示例玄幻长篇》安全修复与质量门

### 任务 6.1：只读数据医生与 dry-run 报告

**文件：**

- 新建：`server/maintenance/doctor.js`
- 新建：`tests/v077_doctor.test.js`
- 新建：`docs/audits/2026-08-09-demo2-data-quality.md`

1. 检查章节 idx 唯一性/连续性、卷归属与顺序、场景缺失、字数漂移、重复健康快照、重复时间线、结算缺失和正文近重复。
2. 对已发现的第 1 章无卷、卷 6/7 交错、修订后字数不一致、第 88/103 章近重复给出逐项证据。
3. 默认只输出 JSON/文本报告，不改库。

### 任务 6.2：可回滚地应用确定性数据修复

**文件：**

- 修改：`server/maintenance/doctor.js`
- 新建：`server/maintenance/repair.js`
- 修改：`package.json`

1. `--apply` 前自动创建独立数据库备份并校验。
2. 只自动修复有唯一正确答案的元数据：卷归属、章节 `word_count`、重复健康快照/时间线等。
3. 正文覆盖类问题优先从快照恢复；没有唯一可信来源时只隔离并报告，绝不猜写覆盖。
4. 修复在单事务内完成；前后输出 diff，结束后 `PRAGMA integrity_check`。

### 任务 6.3：开新卷前的成长/世界展开门禁

**文件：**

- 修改：`server/engine/growth.js`
- 修改：`server/engine/world_expansion.js`
- 修改：`server/engine/continuation.js`
- 修改：`tests/v075.test.js`
- 修改：`tests/v076.test.js`

1. 用现有 117 章数据跑纯本地检测，验证 0.75/0.76 remedy 未落库时状态明确。
2. 新卷生成前要求成长尺度、地图层级、势力层级与主线目标同时给出下一卷约束。
3. status 查询不得隐式写库；历史回填只有全部成功才写带版本的迁移标记。
4. 把补救材料注入卷纲、章纲、写作、审校四个环节，并记录实际消费章节。

## 阶段 7：最终验证与交付

### 任务 7.1：全量自动验证

1. 运行所有定向新增测试。
2. 运行 `npm test`。
3. 对全部项目 JS 执行 `node --check`。
4. 运行测试覆盖率，重点确认 `server/index.js`、pipeline、pilot、settle、archive、write 的行为覆盖。
5. 对临时数据库运行 doctor/repair 往返与 `PRAGMA integrity_check`。
6. 启动随机端口服务器，完成空书创建 → 自动创作 mock 冒烟 → 中断 → 续跑 → 备份 → 导出。

### 任务 7.2：现有书只读质量回归

1. 对修复前备份与修复后数据库比较章序、卷序、正文哈希、字数、事实时间分布、健康快照和重复率。
2. 不调用真实 LLM、不消耗用户额度，除非用户另行明确要求。
3. 输出“已修复 / 仍需模型重写 / 不应自动处理”三类清单。

### 任务 7.3：提交与回滚说明

1. 将引擎、HTTP/UI、数据医生按可独立回滚的 Conventional Commits 提交。
2. 每个提交前运行相关定向测试，最终提交前运行全量测试。
3. 在升级报告中写明备份路径、恢复命令、兼容变化、未解决项和下一卷建议。
