# qianji-bridge

钱迹桥接服务，让 AI 帮忙核对、分类和记账。

## 来源

- [钱迹官网](https://www.qianjiapp.com/) · [官方使用指南](https://docs.qianjiapp.com/)：实际记账与数据同步服务。
- [fangzhengjin/qianji-mcp](https://github.com/fangzhengjin/qianji-mcp)：本项目直接 fork 的 TypeScript 上游。
- [apsuadwf 的 PR #3](https://github.com/fangzhengjin/qianji-mcp/pull/3)：分类与标签管理能力，移植时保留作者信息。
- [ljq29/MCP_qianji](https://github.com/ljq29/MCP_qianji)：调研、试用和功能参考的 Python 实现。

本项目为个人维护的非官方 MCP 服务，通过钱迹私有接口工作，接口可能随版本变化。

## 目的

就是为了方便记账、偷懒记账。把微信、支付宝和银行账单交给 AI，按自己的习惯核对、查重、合并和分类，拿不准的再问，确认后写进钱迹。

融集百家之长，遇到实际问题就补上需要的能力。账单文件解析、图片识别和个人规则由 AI 客户端处理，本服务负责连接钱迹。

## 功能

- **查询**：账本、资产、分类、标签、账单、统计、预算和借入借出详情。
- **记账**：收支、转账、信用卡还款、退款、报销及批量修改。
- **管理**：分类与标签的创建、修改、移动、排序和删除；总预算与分类预算设置。
- **图片**：账单详情返回附件链接，供支持图片的客户端读取。
- **认证**：PAT 访问控制、钱迹账号登录和账号间数据隔离。

当前有 42 个普通工具和 3 个管理员工具，详见[完整工具列表](docs/usage.md#现在能做什么)。

## 快速开始

安装 Bun 1.3.14 或更高版本，在仓库根目录安装依赖并生成 PAT：

```sh
bun install --frozen-lockfile
bun -e "import { randomBytes } from 'node:crypto'; console.log('mt_pat_' + randomBytes(32).toString('hex'))"
```

保存生成的 PAT，设置环境变量后启动。

Windows PowerShell：

```powershell
$env:QIANJI_MCP_ADMIN_PAT = '替换为生成的完整PAT'
bun run start
```

macOS / Linux：

```sh
QIANJI_MCP_ADMIN_PAT='替换为生成的完整PAT' bun run start
```

在支持 **Streamable HTTP** 和自定义请求头的 AI 客户端中配置：

- 地址：`http://127.0.0.1:3000/mcp`
- 请求头：`Authorization: Bearer 你的完整PAT`

让 AI 调用 `connect_qianji`，打开返回的链接登录钱迹。默认仅监听本机，使用本地 SQLite 文件，无需另装数据库。

Docker、远程部署和环境变量见[使用与部署参考](docs/usage.md#快速开始)。

## 使用边界

- 写入会直接修改钱迹数据；结果未确认时先查询核对，不要重复提交。
- 分类“连账单删除”不会恢复账户余额；需要回滚时先正常删除账单，再删除空分类。
- 支持读取已有附件链接，不支持上传附件；部分超长图会被上游拒绝处理。
- 尚不支持创建账本、创建或编辑资产。适配基线为 Android 4.5.4-1234，验证范围见[验收记录](docs/compatibility-4.5.4.md)。
- 数据库保存登录令牌、PAT 和账单缓存，请妥善保管；不要提交凭据或私人账单。公网部署使用 HTTPS。

详细金额规则、预算并发限制和失败处理见[使用要点](docs/usage.md#使用要点)。

## 开发

```sh
bun run dev
bun run typecheck
bun test
```

修改前阅读 [AGENTS.md](AGENTS.md) 和[开发规范](docs/development-workflow.md)。PostgreSQL / MySQL 集成测试需通过 `QIANJI_TEST_POSTGRES_URL` / `QIANJI_TEST_MYSQL_URL` 配置专用测试数据库，未配置时跳过。

项目更名保留 `QIANJI_MCP_*` 环境变量、`/mcp` 地址、PAT 格式和原数据卷，无需迁移运行数据。

## 许可证

[MIT](LICENSE)，保留原作者 ZhengJin 的版权声明及贡献者信息。
