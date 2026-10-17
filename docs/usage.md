# 使用与部署参考

[返回项目首页](../README.md)

详细说明工具、部署配置、写入规则与凭据管理；功能验证记录见[兼容性与验收](compatibility-4.5.4.md)。

## 现在能做什么

以下功能以当前检出的代码为准；未合并分支或本地改动不会自动出现在已部署服务中。当前普通用户有 **42 个工具**，超级管理员额外有 **3 个 PAT 管理工具**。

| 使用场景 | 工具 |
|---|---|
| 账号登录与解绑 | `connect_qianji`、`disconnect_qianji` |
| 查询基础数据 | `list_books`、`list_book_members`、`list_assets`、`list_categories`、`list_tags`、`get_user_info` |
| 查询借入或借出详情 | `list_debt_accounts` |
| 查询、统计与刷新账单 | `list_bills`、`get_bill`、`get_bill_statistics`、`refresh_cache` |
| 查询预算使用情况 | `get_budget` |
| 设置单项总预算或分类预算 | `set_budget` |
| 普通收支或待报销支出批量创建与修改 | `create_bills`、`update_bills` |
| 删除普通收支、待报销支出、转账或还款 | `delete_bills` |
| 转账与信用卡还款 | `create_transfer`、`update_transfer` |
| 退款 | `create_refund`、`update_refund`、`delete_refund` |
| 报销 | `reimburse_bills`、`delete_reimbursement`、`cancel_reimbursements` |
| 分类管理 | `create_categories`、`create_subcategories`、`update_categories`、`delete_categories`、`check_category_deletion`、`move_category`、`reorder_categories`、`list_category_icons` |
| 标签管理 | `create_tag_groups`、`delete_tag_groups`、`create_tags`、`update_tags`、`delete_tags`、`archive_tags`、`reorder_tags`、`reorder_tag_groups` |
| PAT 管理，仅超级管理员 | `list_pats`、`create_pat`、`delete_pat` |

## 验证范围与已知限制

当前适配和联调基线为 Android **4.5.4-1234**，不是对所有钱迹版本、平台和参数组合的兼容承诺。详细过程见[兼容性与验收记录](compatibility-4.5.4.md)。

- 常用收支、转账、信用卡还款、退款、报销、分类/标签管理、跨币种和月预算已在授权的测试资源上验证，并核对写入后的金额和余额
- 普通账单图片可通过详情返回的链接读取；超长图可能被 CDN 以图片面积过大拒绝处理，返回链接不代表下载一定成功
- 年度预算设置、父子分类预算写入及部分异常登录状态只有离线覆盖；其他客户端平台与容器部署未在本轮完成验收
- 尚无创建账本、创建/编辑资产、上传附件、标签组改名等工具；服务提供债务查询，但不覆盖 App 的所有债务管理操作
- 分类“连账单删除”不会回滚账户余额；需要回滚时应先正常删除账单、核对余额，再删除空分类
- 空标签组暂不在查询结果中显示；删除标签后历史账单可能保留旧标签 ID
- 预算设置需读取并提交完整期间列表，服务会保留其他额度并回读核对，但无法保证与 App 同时编辑时的原子性

2026-10-18 预算功能回归：**193 项通过、1 项跳过**，类型检查通过。跳过的是 PostgreSQL / MySQL 的实库集成测试，因为没有配置专用测试数据库。SQLite 和离线业务测试已经运行；外部数据库尚未实测，不影响默认 SQLite 下的记账流程。

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

### Docker 部署

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

## 使用要点

### 核对与写入

- 需要按账本、资产、分类、标签或成员筛选，或者写入时缺少可信 ID，才调用对应查询工具获取，不得猜测或构造 ID
- 使用 `list_bills` 批量盘点、查重或只读对账，需要完整筛选范围时继续翻页到 `nextCursor=null`，批量判断转账方向时直接读取摘要的 `fromId` 和 `targetId`，需要资产名称时只调用一次 `list_assets` 建立 ID 映射
- 列表字段无歧义时不要逐条调用 `get_bill`，只有重复或近似候选、关系冲突、摘要缺失字段或用户要求完整记录时才读取单笔详情，写入成功后直接使用写入工具返回的完整账单
- 钱迹在其他设备发生变化后，调用 `refresh_cache` 获取最新数据
- 需要查看账单附件时，读取 `get_bill` 的 `bill.imageUrls`：按原顺序返回 HTTPS 图片读取地址，没有附件时为 `[]`；账单列表保持精简，不附带图片地址。服务返回地址，由具备图像读取能力的客户端按需下载或展示，不提供 OCR，也不修改附件
- 创建、修改、退款、报销和删除操作会直接写入钱迹，请先确认参数

### 账单附件图片

完整账单（包括写入成功后返回的账单）包含 `imageUrls`，例如：

```json
{
  "imageUrls": [
    "https://billimg.qianjiapp.com/example-image-key!webporigin",
    "https://billimg.qianjiapp.com/example-image-key_hg!huge"
  ]
}
```

以上为虚构示例地址。地址按 Android 客户端 `Bill.getImageUrl(key, 2)` 规则生成：图片对象键以 `_hg` 结尾时使用 `!huge`，否则使用 `!webporigin`，并将当前图片 CDN 升级为 HTTPS。仅拼接裸对象键可能无法读取。该规则依赖钱迹客户端及当前 CDN，未来可能变化。

已知边界：超长图片可能被钱迹 CDN 以 `image area too large` 拒绝处理，即使链接生成正确也无法打开。本轮样本在 App 中也无法读取；服务不提供绕过访问限制的原图下载，也不能保证所有长图可用。

图片地址的查询沿用原账单的账号访问控制，但返回后应视为私人资料，不公开传播或发送给无关第三方。客户端访问 CDN 时不应附带 MCP PAT、钱迹登录凭据或 cookie。服务不会为构造图片地址发起额外网络请求。

### 分类与标签的批量写入

批量操作按输入顺序执行，不是远端事务。参数先整体校验；若中途失败，`WRITE_PARTIAL` 消息会给出从 1 开始的 `completed`（已完成）、`unconfirmed`（结果未确认）与 `notAttempted`（尚未执行）序号。已完成项不得重试；未确认项需先查询核对，禁止直接重试整个批次。缓存清理失败时先调用 `refresh_cache`。

分类删除的转移目标不能出现在本批次待删除分类中，`transferTo` 与 `deleteBills=true` 不可同时指定。删除分类会同步受影响账单并失效余额缓存；若同步失败，先用 `refresh_cache` 再核对账单和统计。

分类的 `deleteBills=true` 路径会删除账单，但不回滚资产余额（Android 4.5.4 接口实测）；刷新缓存不会修复该差额。如需回滚余额，先核对范围并通过 `delete_bills` 删除账单，再删除空分类。有子分类时须先处理子分类，服务端会拒绝直接删除父分类。

分类改名和标签局部更新会先读取最新目录，补齐未改动字段再提交；请避免在提交期间从其他客户端同时编辑同一项。删除标签组会将组内标签移到默认组；空标签组暂不显示在 `list_tags` 的分组列表中。

分类移动会先读取当前层级：一级降为二级和二级提升为一级使用层级调整接口，二级分类换父级使用移动接口。非空分类删除必须选择转移或删除其账单，省略两者会被服务端拒绝。账单查询中 `categoryId` 是精确筛选；需要包含子分类时使用 `categoryIds` 和 `includeSubcategories`。

### 调用时需要注意

- 钱迹业务 ID 始终使用十进制字符串，包括 `"-1"` 等特殊值
- `list_bills` 不筛选时传空对象 `{}`，默认每页 20 条，最多 100 条
- `list_books` 和 `list_assets` 可用 `nameKeyword` 按不区分大小写的名称字面子串缩小范围，`list_assets` 默认不返回余额和信用额度，只有明确需要余额或额度时才传 `includeBalances: true`
- 借入或借出详情使用钱迹独立接口 `list_debt_accounts`，`list_assets` 可能包含 type 5 债务记录基础资产条目，但不能替代详细信息，也不要自行聚合两类响应
- `list_bills.remarkKeyword` 按不区分大小写的备注字面子串筛选
- 请求下一页时只传上一页的 `nextCursor`，不要重复传筛选条件或 `limit`
- `bookId: "-1"` 只表示钱迹默认账本，`categoryId` 不接受 `"-1"`
- `create_bills`、`update_bills`和 `delete_bills` 即使只操作一笔也使用单项列表，级联删除在对应 `deletions[]` 项中显式设置 `cascadeRelatedBills: true`
- 批量写入只部分成功时，错误会按输入序号列出逐项结果，成功项已经写入，不得重试
- `set_budget` 必须指定 `bookId`、`period`、`target` 和本位币 `amount`，`target` 为 `{ "kind": "total" }` 或 `{ "kind": "category", "categoryId": "…" }`，0 清除此项额度，不删除账单
- 钱迹预算写入接口替换整个期间的预算列表，服务会先读取最新完整定义、合并单项修改、提交并回读核对其他额度；这不是跨客户端原子操作，请避免在 App 同时改预算，结果未确认时先用 `get_budget` 查询

`money`、`fee` 和 `discount` 均使用币种主单位，不使用分、美分等最小货币单位。

| 输入 | 实际含义 |
|---|---:|
| `CNY 8100` | 8100 元 |
| `USD 63` | 63 美元 |
| `JPY 500` | 500 日元 |

- 普通支出：`money` 对应 APP 主金额输入框，只支持 `discount`，实际扣款为 `money - discount`，收入不支持手续费或优惠
- 转账或信用卡还款：`money` 对应 APP 主金额输入框，`fee` 和 `discount` 不能同时大于 0，手续费包含在 `money` 中，优惠从实际转出金额扣减
- 跨币种写入会使用账号已开启的多币种配置，`get_user_info.baseCurrency` 是当前本位币，账单 `currencyConversion` 是写入时的历史换算，不会按当前价格重算
- 业务金额必须大于 0、不超过 `9,999,999,999.99` 且最多两位小数，手续费和优惠不能大于 `money`
- 账号需要迁移新版报销时，首次 `reimburse_bills` 会明确提示迁移影响，向用户说明“迁移后旧版本将不能继续使用报销”并取得明确同意后，使用相同业务参数并将 `confirmReimbursementUpgrade` 设为 `true` 重试，服务器只会在钱迹明确要求时迁移并重试一次，不会为已升级账号主动迁移

### 数据同步

- 首次查询账单时，服务会自动同步钱迹数据
- 后续查询优先读取本地缓存，跨设备修改后可调用 `refresh_cache`
- 写操作会在远端成功后同步确认

> [!IMPORTANT]
> 写后确认失败不表示远端已经回滚，账单或目录按提示调用 `refresh_cache` 后核对，预算直接调用 `get_budget` 回读；不要盲目重复写入。

### 写入额度

| 用户状态 | 单次最多使用标签 | 每日成功写入次数 |
|---|---:|---:|
| 有效 VIP | 8 个 | 不限 |
| 非 VIP 或过期 VIP | 1 个 | 15 次 |

每日额度按 `Asia/Shanghai` 自然日和钱迹 UID 计算，同一 UID 的多枚 PAT 共享额度，批量报销和关联删除分别按一次调用计数。

## 安全须知

登录时，网页将密码转换为 MD5 后交给服务转发给钱迹；当前实现不将密码或密码 MD5 持久化到数据库。登录成功后保存钱迹返回的登录令牌、账号标识和设备标识。MD5 是摘要，不是可代替 HTTPS 的加密保护；该摘要在此协议中可能被重放用于登录。登录令牌与 MCP PAT 也都需要按凭据保管。

> [!CAUTION]
> PAT 在数据库中明文保存，完整 Token 仅在创建时返回一次，数据库、备份、PAT 创建结果和相关模型会话都必须按凭据管理。

- `QIANJI_MCP_ADMIN_PAT` 对应唯一的超级管理员，也可以绑定钱迹账号
- 普通 PAT 由 `create_pat` 创建，默认有效期为 90 天，也可以设为永不过期
- 钱迹账号连接链接使用 10 分钟有效的一次性凭证，绑定成功后，同一 PAT 尚未使用的连接链接也会失效
- `connect_qianji` 可主动获取首次登录或同账号重新登录链接，`disconnect_qianji` 需确认后解绑当前 PAT，账号无其他 PAT 使用时会删除其全部本地缓存、账单和同步状态，但不会删除钱迹云端数据
- 服务端保存原登录账号用于后续只输入密码的重新登录，该字段不进入 MCP 输出或日志，并随最后一个 PAT 解绑产生的账号删除一起清理
- 删除 PAT 会立即撤销认证，关联账号不再被其他 PAT 使用时还会删除其全部本地数据，但不会清除备份或会话中的历史内容
- 不要在日志、工单或聊天记录中公开完整 PAT

> [!WARNING]
> 公网部署必须通过 Nginx 等反向代理提供 HTTPS，HTTP 会暴露可重放的 PAT 和钱迹密码 MD5，只适合受信网络。

<a id="debug-logs"></a>
### 调试日志

启用 `QIANJI_MCP_DEBUG_LOG_PATH` 后：

- 会记录钱迹请求地址、表单请求体、HTTP 状态和响应体
- 名称包含 `token` 的表单字段和 JSON 字段会替换为 `[REDACTED]`，JSON 对象与数组会递归处理
- 登录接口的请求体和响应体会整体替换为 `[REDACTED]`
- 其他接口中的 `uid`、个人资料、资产、账单金额和备注等不会脱敏，非 JSON 内容会保留原文，不能将日志视为已全面脱敏的数据

调试日志只应短时开启，不要直接上传到公开工单或聊天。服务会将日志文件权限设为仅所有者可读写，但不负责日志轮转；请自行设置轮转和保留期限，排查结束后取消 `QIANJI_MCP_DEBUG_LOG_PATH` 并重启服务，再清理日志及其副本。
