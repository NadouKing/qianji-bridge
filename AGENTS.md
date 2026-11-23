# qianji-bridge 开发导航

本仓库是 `NadouKing/qianji-bridge` 个人 fork，提供钱迹的 HTTP MCP 服务。

- 修改前阅读 [分支与工作目录规范](docs/development-workflow.md)，核对当前仓库、远端、工作区及已有 PR；先更新主分支，再创建任务分支。
- [README](README.md) 是导航入口。[部署说明](docs/deployment.md)维护启动、配置与镜像发布方法。工具参数、返回值和校验以注册处的 Schema 与实现为准。[模型运行说明](src/server-instructions.md)维护选工具、授权与跨工具流程，使用及恢复细节见[使用说明](docs/usage.md)和[本地对账客户端](docs/reconciliation.md)。个人合计、备注与分类习惯由 `bookkeeping-habits` 维护。
- 维护工具时沿用现有入口。`src/http-server.ts` 处理 HTTP 和 PAT，`src/mcp-server.ts` 注册工具，`src/qianji-service.ts` 处理同步与业务约束，`src/qianji-client.ts` 对接钱迹。本地对账客户端通过 MCP 调用，业务写入沿用服务侧的权限、回执和核验链路。
- 保留本 fork 的附件图片链接能力、PAT 认证及账号隔离；不顺带重置到上游或调整实际部署。
- 凭据、数据库、账单、附件、真实响应和运行日志不进入 Git 或公开 PR；本仓库为公开仓库。
- 保护现有本地修改和运行数据；源码维护授权不包含真实记账、删除账单、部署或重启服务。
- 只运行与改动相称的验证，区分离线测试和真实业务运行；未经明确要求，不合并或发布。
