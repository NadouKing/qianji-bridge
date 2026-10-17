# 部署与配置

本文包含本地启动、Docker、MCP 绑定、环境变量和数据库配置。个人使用优先采用 SQLite 与仅本机监听；公网部署请同时阅读[安全说明](security.md)。

## 快速开始

### 1. 生成超级管理员 PAT

服务启动时必须提供一枚超级管理员 PAT：

```bash
bun -e "import { randomBytes } from 'node:crypto'; console.log('mt_pat_' + randomBytes(32).toString('hex'))"
```

请立即保存输出结果，服务不会自动显示或找回这枚 PAT。

### 2. 启动服务

个人本地使用可以直接运行源码，需要 Bun 1.3.14 或更高版本。在仓库根目录执行：

```bash
bun install --frozen-lockfile
```

Windows PowerShell：

```powershell
$env:QIANJI_MCP_ADMIN_PAT = 'mt_pat_替换为刚才生成的完整PAT'
$env:QIANJI_MCP_PUBLIC_URL = 'http://127.0.0.1:3000'
bun run start
```

macOS / Linux Shell：

```bash
QIANJI_MCP_ADMIN_PAT='mt_pat_替换为刚才生成的完整PAT' \
QIANJI_MCP_PUBLIC_URL='http://127.0.0.1:3000' bun run start
```

默认仅监听本机，SQLite 文件为 `data/qianji.db`。保持服务进程运行，再连接 AI 客户端。


### 也可以使用 Docker

在仓库根目录构建本 fork 的代码：

```bash
docker build -t qianji-bridge:local .
docker run --rm --name qianji-bridge \
  -p 127.0.0.1:3000:3000 \
  -v qianji-mcp-data:/data \
  -e QIANJI_MCP_ADMIN_PAT='mt_pat_...' \
  -e QIANJI_MCP_PUBLIC_URL='http://127.0.0.1:3000' \
  qianji-bridge:local
```

容器内部监听 `0.0.0.0:3000`，上例仅向宿主机本地地址映射端口，SQLite 数据库保存在 `/data/qianji.db`。

远程部署时，通过 HTTPS 反向代理转发到服务，并将 `QIANJI_MCP_PUBLIC_URL` 改为 MCP Client 实际访问的基础地址，例如 `https://mcp.example.com`。上例的端口映射适用于宿主机上的代理；其他部署方式需按代理所在位置配置网络。

绑定页面也必须通过该公开地址访问。`POST /connect` 优先校验 `Origin`，缺失时校验 `Referer` 是否与该公开地址同源，同时拒绝 `Sec-Fetch-Site` 标记的跨站请求；反向代理应保留这些来源头，无来源头的客户端仍须提供有效的一次性 `ticket`。

主分支合并后，现有工作流会构建并推送以下镜像标签；未合并的 PR 请使用上面的本地构建：

```text
ghcr.io/nadouking/qianji-bridge:latest
ghcr.io/nadouking/qianji-bridge:<7-character-commit-id>
```



### 3. 连接 AI 客户端

MCP 地址为：

```text
http://127.0.0.1:3000/mcp
```

请求必须携带 PAT：

```http
Authorization: Bearer mt_pat_...
```

MCP Client 必须支持配置自定义 `Authorization` Header。

首次调用业务工具时，支持 URL Elicitation 的 Client 会返回钱迹账号连接链接，链接只关联当前 PAT，10 分钟内有效，绑定成功后立即失效，请在有效期内打开并登录。

连接提示会同时提供可点击的 Markdown 链接和下一行完整原始 URL，如果微信等内置浏览器拦截链接，可复制原始 URL 到系统浏览器访问。

首次连接时填写钱迹账号和密码，未解绑的后续重新登录只填写密码，页面会显示不可编辑的脱敏账号。服务端保存原登录账号并拒绝切换到其他钱迹 UID。无需再次填写 PAT。一次性 `ticket` 位于 URL query，后端在返回页面前校验其有效性，页面读取后会立即从地址栏移除。部署时不应在访问日志中记录 query 参数。

服务生成的 PAT、`ticket` 和 `nextCursor` 正文只包含连续的小写十六进制字符，固定开头前缀中的分隔符不受此限制，避免移动端复制时在正文中断开选区。

密码会在浏览器内转换为 UTF-8 小写 MD5，Bun 服务不会收到明文密码。

绑定完成后重新调用原工具，钱迹登录状态失效时，工具会再次要求连接。

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
|---|---:|---|---|
| `QIANJI_MCP_ADMIN_PAT` | 是 | 无 | 超级管理员 PAT，必须以 `mt_pat_` 开头，后接至少 32 个随机字符 |
| `QIANJI_MCP_PUBLIC_URL` | 否 | `http://<host>:<port>` | MCP Client 实际访问的基础地址，只能包含协议、主机和可选端口 |
| `QIANJI_MCP_HOST` | 否 | `127.0.0.1` | HTTP 监听地址，Docker 镜像默认为 `0.0.0.0` |
| `QIANJI_MCP_PORT` | 否 | `3000` | HTTP 监听端口 |
| `QIANJI_MCP_DATABASE_PATH` | 否 | `data/qianji.db` | SQLite 文件路径，Docker 镜像默认为 `/data/qianji.db` |
| `QIANJI_MCP_DATABASE_URL` | 否 | 无 | PostgreSQL 或 MySQL 连接 URL，设置后不使用 SQLite |
| `QIANJI_MCP_API_SERVER` | 否 | `https://api.qianjiapp.com` | 钱迹 API 基础地址，只能包含 HTTP(S) 协议和主机 |
| `QIANJI_MCP_DEBUG_LOG_PATH` | 否 | 关闭 | 钱迹上游请求日志的 JSONL 文件路径，可能包含未脱敏的个人资料和账单，仅限短时排查，详见[调试日志说明](#debug-logs) |


### 数据库与钱迹 API 线路

### 数据库

数据库是服务内部保存登录令牌、账号绑定、同步进度和账单缓存的地方，不是交给 AI 的 Excel 账单。

默认 SQLite 就是一个本地数据库文件，无需额外安装数据库。个人使用可保持默认配置；PostgreSQL / MySQL 是部署时的可选替代方案，不影响“把 Excel 交给 AI 核对”的流程。

外部数据库支持：

```text
postgres://user:password@host/database
postgresql://user:password@host/database
mysql://user:password@host/database
```

MySQL 最低版本为 8.0.16。

服务启动时会连接并初始化数据库，连接失败会终止启动，不会自动回退到 SQLite，也不会在数据库之间搬运已有数据。

无论使用哪种数据库，当前都只应运行一个 qianji-bridge 实例，SQLite 文件不能由多个实例共享。

### 钱迹 API 线路

可配置的钱迹官方线路包括：

```text
https://api.qianjiapp.com
https://qianji.xxoojoke.com
https://qianjiga.litangkj.com
```

服务不会自动切换线路。
