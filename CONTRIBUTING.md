# 贡献指南

感谢你有兴趣为墨舟做贡献。这个项目对"什么样的改动是好的"有比较明确的立场，请先花几分钟读完。

---

## 0. 快速上手

```bash
git clone https://github.com/FEOH333/mozhou-ai-novel.git
cd mozhou-ai-novel
npm install
npm test              # 应当全绿；这是提交前的底线
```

- Node.js **≥ 23.4**（依赖内置 `node:sqlite`）
- 项目**无构建步骤**：纯 ESM JavaScript，改完直接跑

---

## 1. 提交前必须通过

```bash
npm test
```

- 全量测试必须全绿，**不接受**"只是某个无关用例挂了"。
- 新行为必须**先写失败测试（RED）→ 再实现（GREEN）**。没有测试的功能改动不予合入。
- 修 bug 时，先补一个能复现该 bug 的用例，再修。

---

## 2. 本项目的六条铁律

违反任何一条的 PR 都会被要求返工，不论功能多么有用。

### ① 提示词是工艺文件，不是规则墙

文学纪律要写清楚**本场人物要做出什么选择、局面发生什么变化、读者得到什么**。

- ✅ 「主角必须在这里付出一个不可逆的代价，代价要与前面铺好的依恋直接挂钩」
- ❌ 「主角应握紧拳头、指节发麻」——这是替模型代写，且会变成每章复读的库存句

**机械红线才量化**（篇幅、格式、重复率）；文学目标不给固定正例。
零 AI 套话：不禁/仿佛/宛如/嘴角勾起一抹弧度/命运的齿轮……

### ② 禁止硬编码一次性特判

**任何具体作品的书名、人物名、章节号都不许进框架代码。**

题材特性必须收敛为**配置开关**（`genre` / `settings`）。历史上有过把书名当开关的事故，
现在 `isHistoricalSampleBook` 走的是 `settings.historicalEraTemplate` 显式开关注入，
而不是书名正则——请勿回退。

```
// ❌ 反面
if (book.title === '某本书') { ... }
// ✅ 正面
if (book.settings?.someFeature === true) { ... }
```

### ③ 禁止绕过既有框架

- 完成态判定只用 `chapter_status.isCompletedChapter`
- 章节状态只经 `transitionChapterStatus` 状态机
- 正文落库只走 `writeScene → reviseScene → validateChapterRewrite → applyValidatedChapterRewrite`
  （场景级走 `applyValidatedSceneRewrite`，同源同闸）
- **不新增直写 store 的 HTTP 入口**；不为同一状态造第二套写法

### ④ 禁止动提示词缓存前缀

- **L1 system**（`buildSystemPrompt`）与 **L2 公共材料**（`buildPublicMaterials`）是**恒定前缀**
- **L3/L4 纪律注入**全部动态，只出现在**最后一条 user 消息**
- 新增纪律只进 L3/L4；正文草稿垫到指令最末

改 `buildSystemPrompt` 前请先确认这是维护者明确要求的改动。

### ⑤ 写审同源

同一条纪律文本必须**同时注入写作指令与审校指令**。
新增或修改任何纪律，都要保证：写作时拦得住、审校时抓得出、自愈时修得回。

### ⑥ 单一真源

同一事实的两套写法必然发散。新功能设计先问：

> 这个事实的真源在哪？谁只是它的视图？

典型红线：量化阈值与词表统一从 `redlines.js` import，禁止第二份数字；
角色性格只存 `personality` 列，不在 `card_json` 双写。

---

## 3. 框架扩展范式（新增文学能力/约束的标准动作）

新增约束不是"往提示词里加一句话"，而是走五件套：

1. **纪律文本** —— 在 `server/data/literary_techniques.js`（通用纪律）、
   `creative_packs.js`（题材包/风格/词表）或 `history.js`（史实锚点）定义 `XXX_TEXT` 常量
2. **槽位注入** —— 在 `server/engine/prompts.js` 对应指令函数加参数与注入位；
   引擎侧加 `buildXxxContext(...)` 纯函数
3. **确定性校验** —— 可本地判定的进 `rules.js` / `audit.js` / `*_guardrails.js`；
   需 LLM 判定的进审校 typeEnum（新 issue type 必须进记债路由）
4. **台账/落库** —— 需跨章记账的加表（`schema.sql` + `store.js` 迁移）；
   状态进 `materials`（动态）或 `settings_json`，**不进公共前缀**
5. **测试** —— 每个行为变化一个断言，先 RED 后 GREEN；
   再加一条"**非该题材零影响**"回归

---

## 4. 代码风格

- **纯 ESM**，`'use strict'` 不写（模块默认严格模式）
- 无构建、无转译：只写 Node 23.4+ 能直接跑的原生 JS
- 注释用中文，**注释解释"为什么"，不复述"做了什么"**
- 版本号只在 `package.json` 与架构文档里维护，**不要在提示词里硬编码版本号**

---

## 5. 数据库改动

- 表结构改动写进 `server/db/schema.sql`，并在 `store.js` 提供幂等迁移
- 迁移必须能对**既有生产库**安全执行；破坏性变更需要维护脚本（默认 dry-run，`--apply` 才写）
- 维护脚本统一在 `server/maintenance/`，须满足：
  - 默认只读扫描，`--apply` 才落库
  - 备份 + 事务 + 幂等
  - **不硬编码具体作品 id**：走 `--book <bookId>` 或 `NOVEL_BOOK_ID`
  - 需写库时拒绝在服务运行中执行（WAL 竞态）

---

## 6. 不要做的事

- ❌ 不要 `git stash`（**尤其 `-u`**）——本项目历史上因此永久丢失过 git 对象
- ❌ 不要删 `.git/objects/pack/` 下的任何文件
- ❌ 不要提交 `data/`、`*.log`、`tmp-*`、真实 Key
- ❌ 不要引入新的运行时依赖（唯一的正当依赖是本地 embedding）
- ❌ 不要为了让测试变绿而放宽断言或加 `skip`

---

## 7. 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(outline): 卷纲支持按承诺章数硬校验
fix(recovery): 恢复路径不再对已有卷纲的卷重烧大纲
docs(readme): 补充 AGPL-3.0 说明
test(v108): 覆盖人物活性回填的幂等性
```

---

## 8. 提 PR 前自查

- [ ] `npm test` 全绿
- [ ] 新行为有对应测试，且是 RED → GREEN 得到的
- [ ] 没有把具体书名/人名/章节号写进框架代码
- [ ] 新增纪律同时进了写作与审校指令，且有断言验证注入存在
- [ ] 没有改动 L1/L2 缓存前缀
- [ ] 非该题材的回归测试仍通过

---

## 许可证

本项目采用 **AGPL-3.0**。提交贡献即表示你同意你的贡献以同一协议授权。
