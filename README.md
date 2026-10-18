# qianji-bridge

让 AI 通过 MCP 查询、核对和管理钱迹账单的自托管桥接服务。

> [!IMPORTANT]
> **非官方项目。** 本项目通过钱迹私有 HTTP API 工作，可能受钱迹客户端或服务端更新影响。请妥善保护登录凭据、PAT 和个人账单数据。

## 功能

- **账单与对账**：查询、统计、创建、修改和删除账单，处理转账、退款和报销。
- **目录与预算**：查询或管理账本关联信息、分类、标签及预算。
- **账号与同步**：通过 PAT 认证连接钱迹账号，本地缓存账单并按需刷新。
- **AI 辅助整理**：配合支持 MCP 和文件读取的 AI 客户端，核对微信、支付宝或银行导出的账单，再决定写入。

本服务不负责解析 Excel/PDF、OCR、自动上传附件或替用户确定分类规则。写入会修改钱迹真实数据，建议先让 AI 展示待写入清单并核对重复项。

完整功能与工具名称见[工具与能力说明](docs/features.md)。

批量对账可用配套的[本地对账客户端](docs/reconciliation.md)：解析微信 XLSX／支付宝 CSV、生成只读候选、批量查询详情，并在明确授权后使用私人回执串行执行写入计划。

## 快速开始

需要 [Bun](https://bun.sh/) **1.3.14 或更高版本**，以及支持 **Streamable HTTP** 和自定义 Authorization Header 的 MCP 客户端。

### 1. 安装依赖

```bash
bun install --frozen-lockfile
```

### 2. 生成管理员 PAT

```bash
bun -e "import { randomBytes } from 'node:crypto'; console.log('mt_pat_' + randomBytes(32).toString('hex'))"
```

请安全保存生成的 PAT，不要将其提交至仓库。

### 3. 启动服务

Windows PowerShell：

```powershell
$env:QIANJI_MCP_ADMIN_PAT = 'mt_pat_替换为生成的完整PAT'
$env:QIANJI_MCP_PUBLIC_URL = 'http://127.0.0.1:3000'
bun run start
```

macOS / Linux：

```bash
QIANJI_MCP_ADMIN_PAT='mt_pat_替换为生成的完整PAT' \
QIANJI_MCP_PUBLIC_URL='http://127.0.0.1:3000' bun run start
```

默认只监听本机，数据使用 SQLite 保存于 `data/qianji.db`。

### 4. 连接 MCP 客户端

- **MCP 地址**：`http://127.0.0.1:3000/mcp`
- **请求头**：`Authorization: Bearer mt_pat_...`

首次调用业务工具时，支持 URL Elicitation 的客户端会提供钱迹账号绑定链接。完成绑定后重新调用工具即可。其他客户端是否支持该交互取决于其 MCP 实现。

Docker、公网 HTTPS、数据库和环境变量配置见[部署与配置](docs/deployment.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [工具与能力说明](docs/features.md) | 功能清单、验证基线与已知限制 |
| [部署与配置](docs/deployment.md) | 本地/Docker 启动、MCP 连接、环境变量与数据库 |
| [使用说明](docs/usage.md) | 查询、写入、批量操作、金额及同步规则 |
| [安全说明](docs/security.md) | 凭据管理、账号隔离、登录安全与调试日志 |
| [兼容性与验收记录](docs/compatibility-4.5.4.md) | Android 4.5.4-1234 联调细节与验证记录 |
| [开发工作流](docs/development-workflow.md) | 分支、工作目录与协作规范 |

## 开发

使用 TypeScript + Bun。贡献前请阅读 [AGENTS.md](AGENTS.md) 和[开发工作流](docs/development-workflow.md)。

```bash
bun run dev
bun run typecheck
bun test
```

本仓库的功能、部署和兼容性以**当前分支代码与实际运行版本**为准；合并 PR 不等于已部署更新。

## 来源与许可证

本项目基于 [fangzhengjin/qianji-mcp](https://github.com/fangzhengjin/qianji-mcp) 继续开发，非钱迹官方项目；相关贡献与参考项目见[项目来源](docs/features.md#项目来源)。

遵循 [MIT License](LICENSE)，保留原作者及贡献者版权信息。
