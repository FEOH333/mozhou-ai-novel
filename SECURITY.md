# 安全策略

## 报告漏洞

**请不要用公开 Issue 报告安全问题。**

请通过以下任一渠道私下报告：

1. **GitHub 私密漏洞报告**（推荐）：本仓库 **Security** 标签页 → *Report a vulnerability*
2. 邮件：在 GitHub 个人主页 <https://github.com/FEOH333> 联系

报告中请尽量包含：

- 漏洞类型与影响范围（例如：可被 Web 页面读取本地文件？可绕过授权调用接口？）
- 复现步骤（最小可复现示例）
- 受影响的版本或 commit
- 你评估的严重程度
- 如有可能，附上修复建议

**我会在 7 天内给出首次回复。** 确认修复后，如果你愿意，会在发布说明中致谢。

---

## 安全模型与已知边界

墨舟是**本地单机运行**工具，不是面向公网的服务。理解它的安全边界很重要：

### 信任假设

| 假设 | 说明 |
| --- | --- |
| **服务只监听本机** | 默认绑定 `127.0.0.1:8770`，设计上不暴露到公网 |
| **使用者 = 本机用户** | 没有账号体系；能量访问 `127.0.0.1:8770` 的人即拥有全部权限 |
| **数据库是本机私产** | `data/novel.db` 含你的全部创作内容与 API 调用记录 |

### 这意味着

- **不要把服务暴露到公网**。若确实需要远程访问，请自行在反向代理层加上认证（HTTP Basic / mTLS / VPN），并注意 WebSocket 端点同样需要保护。
- **不要在多用户共享的机器上裸跑服务**。本机其他用户可以直接读写 `data/`。
- **API Key 请走环境变量**，不要写进 `data/config.json`。见下文。

### 密钥处理

自 V0.109.1 起支持从环境变量注入密钥：

```bash
export NOVEL_API_KEY="sk-xxxxxxxx"          # 主端点
export NOVEL_BACKUP_API_KEY="sk-yyyyyyyy"   # 备用端点（可选）
```

特性与保证：

- 优先顺序为**环境变量 > `config.json`**，仅在环境变量非空时生效
- 环境变量提供的密钥**绝不会被回写磁盘**——即使在 Web 设置页点击「保存」，`config.json` 中落盘的仍是原值
- 空字符串或纯空白的环境变量**不构成覆盖**，不会被误清空成空 Key

若曾把真实 Key 写进 `data/config.json`，仅清空文件**不等于**密钥失效，请务必去服务商后台**吊销并重签**。

---

## 依赖

本项目仅有一个直接运行时依赖：

- `@huggingface/transformers` —— 本地 embedding 推理（默认模型 `bge-small-zh-v1.5`）

模型权重在首次运行时从 Hugging Face 下载。若你处在受限网络环境，可关闭 embedding（配置项 `embedding.enabled: false`），系统会自动降级为关键词检索，不影响写作主流程。

我们保持依赖面尽可能小；引入新依赖的 PR 需要充分理由。

### 关于 `sharp` 的传递依赖

`@huggingface/transformers` 会带入 `sharp`（图像解码库）。**墨舟只使用文本 embedding（`feature-extraction`），从不触碰图像解码路径**，因此 `sharp` 的图像处理漏洞在本项目中不可被外部输入触发。

即便如此，我们仍通过 `package.json` 的 `overrides` 把 `sharp` 锁定在修复了 libvips / libheif 相关 CVE 的版本，保持 `npm audit` 零告警：

```json
"overrides": {
  "sharp": "^0.35.4"
}
```

若你在自己的 fork 中调整该字段，请重新运行 `npm audit` 确认告警未回归。

---

## 安全相关配置

本仓库已启用以下 GitHub 安全能力：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Secret scanning | ✅ 启用 | 自动检测误提交的凭据 |
| Push protection | ✅ 启用 | 在推送前拦截含密钥的提交 |
| Private vulnerability reporting | ✅ 启用 | Security 标签页下的私密报告入口 |
| Dependabot security updates | ✅ 启用 | 依赖漏洞自动提 PR |

---

## 支持的版本

项目处于活跃开发中，**仅对最新提交提供安全修复**。请始终使用 `main` 分支的最新版本。
