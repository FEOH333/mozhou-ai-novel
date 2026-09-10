# 墨舟 · AI 小说写作工具

> 本地运行、AI 本位的长篇中文网文自动创作系统。
> 从灵感一路自动写到完本——不是"AI 帮你写一段"，而是一条**可恢复、可审校、可结算**的长篇生产线。

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D23.4-brightgreen.svg)](https://nodejs.org/)

---

## 这是什么

墨舟把"写一本长篇网文"拆成了一条**有状态的流水线**：

```
灵感提级 → 书契约 / 开篇承诺画像 → 开篇结构候选与匿名比较
     → 世界 / 人物设定 → 书纲 → 卷纲 → 章纲 → 场景正文
     → 连续性审校 → 最小修订 → 覆盖检查 → 原子结算
     → 阶段审阅 / 打磨 → 完本判定
```

每一步的产物**落库、可追溯、可回滚**。它解决的是长篇创作真正的痛点：

| 痛点 | 墨舟的做法 |
| --- | --- |
| 写着写着人设崩了 | 角色卡单一真源（性格/说话方式分列），活性档案随章增长 |
| 前后矛盾、伏笔忘了回收 | 伏笔台账 + 跨章复读窗口 + 覆盖检查，超期自动老化或转长期线 |
| 大纲和正文越走越远 | 正文是权威源，摘要/事实/人物/伏笔只是**投影**；换版必须整体切换 |
| AI 味、模板句、复读 | 反模板化戏剧契约 + 句式族轮换 + 词根重复检测 + 零套话词表 |
| 一章写崩整本重来 | 候选正文先在影子版本验证，失败保留整套旧版本 |
| 跑一半断了要重来 | 服务端后台作业持久化，浏览器只是观察面；断线可重放、可恢复 |
| 成本失控 | 提示词缓存分层（恒定前缀 + 动态尾部）、成本双口径视图、注入上限护栏 |

---

## 快速开始

### 环境要求

- **Node.js ≥ 23.4**（依赖内置 `node:sqlite`，纯 JS、无构建步骤、ESM）
- 首次运行会下载本地 embedding 模型（约 100MB），之后离线可用

### 安装与启动

```bash
git clone <this-repo>
cd ai-novel-writer
npm install          # 只有 @huggingface/transformers 一个依赖

cp data-config.example.json data/config.json
cp secrets.env.example secrets.env
# 编辑 secrets.env，填入你自己的模型 API Key

start.bat            # Windows 一键启动（推荐）
# 或
npm start            # 任意平台： http://127.0.0.1:8770
```

> **Windows 提示**：`start.bat` 会把服务器跑在当前窗口前台，**关掉窗口即停止服务**，不会再留隐藏进程。

### 配置模型

`data/config.json` 只需填一个 OpenAI 兼容端点（**密钥建议留空，走环境变量**）：

```json
{
  "baseUrl": "https://your-endpoint/v1",
  "apiKey": "",
  "model": "your-model-name"
}
```

支持**双端点自动切换**：写入 `backup.baseUrl` / `backup.apiKey` 后，主端点失败会自动降级，调用记录会标注实际来源。

### 用环境变量管理密钥（推荐）

**不要在配置文件里写明文 Key**。填进环境变量即可：

```bash
# Git Bash / macOS / Linux
cp secrets.env.example secrets.env   # secrets.env 已被 .gitignore 排除
# 编辑 secrets.env 填入真实 Key，然后：
source secrets.env
npm start
```

```powershell
# PowerShell（当前会话）
$env:NOVEL_API_KEY = "sk-xxxxxxxx"
$env:NOVEL_BACKUP_API_KEY = "sk-yyyyyyyy"   # 可选，备用端点
npm start

# 持久化（重开终端生效）
setx NOVEL_API_KEY "sk-xxxxxxxx"
```

优先顺序为 **环境变量 > `config.json`**，且环境变量提供的密钥**绝不会被回写磁盘**——即使在设置页点了「保存」，`config.json` 里落盘的仍是原来那串（空）值。密钥只存在于环境变量里。

> ⚠️ `data/` 与 `secrets.env` 均已在 `.gitignore` 中，密钥不会进版本库。

### 无 Key 试用

```bash
NOVEL_MOCK_LLM=1 npm start    # 确定性 mock，全流程可跑通、零成本
```

---

## 常用命令

```bash
npm start                        # 启动服务
npm test                         # 全量测试（1500+ 用例）
npm run doctor                   # 只读体检：结构、连续性、一致性
npm run audit:recovery           # 返工进度只读审计
```

隔离数据目录（多本书 / 多套配置互不干扰）：

```bash
NOVEL_DATA_DIR=./data-experiment npm start
```

---

## 数据与环境变量

| 变量 | 作用 |
| --- | --- |
| `NOVEL_API_KEY` | 主端点密钥，覆盖 `config.json` 的 `apiKey`（推荐用这个，不落盘） |
| `NOVEL_BACKUP_API_KEY` | 备用端点密钥，覆盖 `config.json` 的 `backup.apiKey` |
| `NOVEL_DATA_DIR` | 数据目录，默认 `./data`（含 `novel.db` + `config.json`） |
| `NOVEL_MOCK_LLM=1` | 走确定性 mock 模型，用于测试与零成本试跑 |
| `NOVEL_NO_OPEN=1` | 启动后不自动打开浏览器 |
| `NOVEL_HISTORICAL_ERA_TEMPLATE=1` | 为历史题材启用内置年代阶段表（见下文） |

---

## 历史题材：年代阶段表是**开关**，不是书名匹配

内置一套「南宋末年架空史实流」15 卷年代阶段骨架（1241 少年流亡 → 1294 新格局落定），
提供逐年年份窗、主角年龄、阶段任务、真实人物登场窗与史实越界校验。

**启用方式（三选一）**：

1. 书级设置：`settings.historicalEraTemplate = true`
2. 环境变量：`NOVEL_HISTORICAL_ERA_TEMPLATE=1`
3. 简介中同时写明起点年与地理锚点（如「淳祐元年」+「钓鱼城」）

设为 `false` 可显式关闭。**任何具体作品名都不会成为框架开关**——这是本项目的开发铁律之一。

---

## 项目结构

```
server/
  engine/          创作流水线：大纲、场景、审校、修订、结算、叙事版本
  data/            工艺文件：文学纪律、题材包、史实锚点、红线数字
  db/              schema.sql + store.js（node:sqlite，含迁移）
  llm/             模型调用：路由、缓存分层、韧性重试、成本计量
  maintenance/     通用维护工具：doctor、回填、修补（均支持 dry-run）
web/               前端：原生 JS + CSS，无构建
tests/             1500+ 用例（node:test）
```

---

## 开发约定

参与开发前请先读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。几条最重要的：

- **提示词文件是工艺文件**：文学纪律要写"要实现的叙事效果 + 当前场景可用材料"，
  不写规则墙、不塞库存动作范例。
- **禁止硬编码一次性特判**：题材特性必须收敛为配置开关；具体书名永不进框架。
- **禁止绕过既有框架**：状态变更走状态机、正文落库走校验闸，不新增直写入口。
- **禁止动缓存前缀**：恒定前缀与动态注入分层严格，新纪律只进最后一条 user 指令。
- **写审同源**：同一条纪律同时注入写作与审校指令；注入必可检。
- **改工具优先**：审读发现的问题优先转成确定性防线或纪律文本，直接改稿只是例外。

---

## 许可证

**AGPL-3.0**（GNU Affero General Public License v3.0）。

这意味着：

- ✅ 你可以自由使用、修改、分发本项目
- ✅ 你可以在自建服务中修改后内部使用
- ⚠️ 一旦你**分发**修改版，必须以同样协议开源你的修改
- ⚠️ **把墨舟改造成在线服务对外提供（哪怕只提供 API），也必须公开你的全部源码**

这就是 AGPL 与 GPL 的关键差别（第 13 条：网络交互同样构成"分发"）。
目的很直接：**不让任何人把墨舟套个壳就变成闭源商业服务。**

完整条款见 [`LICENSE`](./LICENSE)。

---

## 已知边界

- 面向**中文长篇网文**优化，短篇/其他语种非目标场景。
- 需要自备模型 API；本项目不含模型权重，也只内置一个轻量本地 embedding 用于检索。
- 大批量生成会消耗可观 token，请先在小规模书上验证成本。
