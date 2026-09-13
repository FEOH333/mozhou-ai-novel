# AGENTS.md — 给 AI 开发者的项目地图

> 本文件会被自动加载进每个 AI 会话，**每多一行都要在每次会话里付费**。
> 所以它只写"**去哪找、改什么、别踩什么**"，不重复 README（安装/配置/理念看 [`README.md`](./README.md)），
> 不重复 CONTRIBUTING（提交规范看 [`CONTRIBUTING.md`](./CONTRIBUTING.md)）。
> 详细设计文档在 [`docs/`](./docs/)。

## 一句话

本地运行的 AI 本位长篇中文网文自动创作系统。Node ≥ 23.8，纯 JS/ESM/无构建，唯一依赖 `@huggingface/transformers`。

```bash
npm start                       # http://127.0.0.1:8770
npm test                        # 全量（当前 1603 用例）
NOVEL_MOCK_LLM=1 npm test       # 确定性 mock，不烧模型
NOVEL_DATA_DIR=/tmp/x npm test  # 隔离数据目录（写测试时必用）
node server/maintenance/doctor.js --db data/novel.db --pretty   # 只读体检
```

**改完 server 代码要重启 `start.bat`** —— 运行中的 8770 进程持有旧代码，这是"改了没生效"的头号原因。

## 目录地图

```
server/
  engine/           创作引擎（按职责域分子目录，见下）
  data/             ★ 工艺文件：文学纪律、题材包、史实锚点、量化红线
  db/               store.js（node:sqlite + 迁移）与 schema.sql
  llm/              router/client/cache/context_planner/cost/resilience/tokenizer
  jobs/             后台作业与书级租约
  memory/           本地 embedding 与向量检索
  maintenance/      通用维护工具（doctor、回填、修补，均支持 dry-run）
  util/             diff/json/oplog/text
  index.js          HTTP 路由（单文件）
web/                js/(app,ui,api,views/) + css/，原生 JS 无构建
tests/              node:test，文件数即历史版本号
docs/               设计调研与开发计划（人读，AI 按需取）
```

`server/engine/` 的 7 个域（**找文件先看域，别按名字猜**）：

| 域 | 职责 | 代表文件 |
| --- | --- | --- |
| `pipeline/` | 章节生产链路：写作→审校→结算→完本 | `pipeline` `write` `audit` `settle` `continuation` `pilot` |
| `planning/` | 规划：灵感→契约→书纲→卷纲→章纲→开篇 | `outline` `horizon` `opening*` `story_promise` `volumereview` |
| `quality/` | 质量防线：确定性检测→工艺配额→打磨→快感门 | `rules` `craft_*` `polish` `pleasure` `attraction` |
| `narrative/` | 叙事资料与投影：事实/人物/伏笔/世界/时间线 | `narrative_state` `factbook` `foreshadow` `characters` `history` |
| `longform/` | 长程阶段与历史题材 | `longform_lifecycle` `historical_*` `alignment` |
| `recovery/` | 返工与恢复 | `recommendation_recovery` `recovery` `recovery_contract` |
| （根） | 跨域共享 | `prompts.js`（全部提示词） |

## 常见任务：改哪里

| 任务 | 按顺序改 |
| --- | --- |
| **加一条文学纪律** | ① `server/data/literary_techniques.js` 定义 `XXX_TEXT` → ② `server/engine/prompts.js` 加注入位（写作/审校/修订三处同源）→ ③ 能本地判定的进 `quality/rules.js` → ④ 加测试（命中 + **正常文本不误报**） |
| **加一个量化红线** | 只改 `server/data/redlines.js` 的 `REDLINES`。**禁止在别处写第二个数字**——注入与检测都 import 它 |
| **加一个新 issue 类型** | 必须同时登记 `server/data/issue_types.js`，否则 medium 命中**不触发修订自愈**（检测器沦为摆设）。`tests/v1093` 有覆盖断言守着 |
| **改提示词** | 只动 `server/engine/prompts.js`。恒定前缀（system/公共材料）不得加动态内容；新纪律只进最后一条 user 指令 |
| **加一个 HTTP 接口** | `server/index.js` + `web/js/api.js` + 对应 view。**不得新增直写 store 的入口** |
| **加前端页面** | `web/js/views/` 新增模块 + `web/js/app.js` 注册路由 |
| **加维护脚本** | `server/maintenance/`，必须支持 `--dry-run` 与备份 |

## 别踩的坑（都踩过，代价已付）

**改代码时**

- **禁止 `git stash`（尤其 `-u`）**：本库曾因一次 `git stash push -u -- <pathspec>` 删掉整个 pack，历史永久损毁。要暂存就发 wip 提交，或把文件复制到库外。
- **`.workbuddy/` 与 `secrets.env` 被 gitignore，是唯一副本**。删目录/重建仓库前必须先单独保留它们，否则记忆与密钥一起丢失且**无法从 git 恢复**。
- **改版本号要同步 5 处**：`package.json` / `package-lock.json`（顶层 + `packages[""]`）/ `server/version.js` / `web/index.html` 的 `brand-ver` / `tests/v025.test.js` 的预期值，且 `package.json.description` 尾部也带版本。漏一处 `v025` 就红。
- **不要给 `data/config.json` 写密钥**：走环境变量 `NOVEL_API_KEY`。`config.js` 的 `stripSecretEnvOverrides()` 是防回写的安全核心，改配置读写路径时必须保住。

**做批量改动时**

- **重命名/移动文件后，除 import 外还要扫"路径字符串"**：测试里有大量源码接线断言直接 `readFileSync('server/engine/x.js')`，它们不是 import，只改 import 会留下大批红。且**导入者自己移动**时，指向未移动文件的相对路径深度也会变。
- **加篇章级统计型检测器时必须带 `statistical: true`**：返工文风闸只应收"该改写单元真能改变的东西"，句长分布/段落均质这类整章指标算进闸会造成批量误杀。

**写测试时**

- **临时目录用 `path.join(os.tmpdir(), 'name-')`**，不要反斜杠拼接（POSIX 上反斜杠是合法文件名字符，Linux 会试图在根目录建目录）。
- **断言子进程 stderr 前先剥离运行时噪声**：Node 23.8~24 的 `node:sqlite` 仍打 `ExperimentalWarning`。
- **不要把 fixture 建进真实 `node_modules` 缓存目录**：会与并行测试互相干扰（`node --test` 默认 16 文件并行）。
- **分布式断言要覆盖生产链路**：只测 store 原始行发现不了投影层缺陷（项目称之为"假绿"）。

## 提交

`conventional commit` 风格；**每个版本必须提交**（未提交 = 未交付）。变更日志追加到 [`CHANGELOG.md`](./CHANGELOG.md)。
