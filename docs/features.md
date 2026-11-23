# 工具与能力说明

> 以下内容对应仓库当前实现，不代表所有钱迹客户端版本均通过验证。

## 现在能做什么

以下是当前仓库的功能入口。实际服务提供的工具及参数以客户端 `listTools()` 返回为准。

| 使用场景 | 工具 |
|---|---|
| 账号登录与解绑 | `connect_qianji`、`disconnect_qianji` |
| 查询基础数据 | `list_books`、`list_book_members`、`list_assets`、`list_categories`、`list_tags`、`get_user_info` |
| 查询借入或借出详情 | `list_debt_accounts` |
| 查询、统计与刷新账单 | `list_bills`、`get_bill`、`get_bills`、`get_bill_statistics`、`refresh_cache` |
| 查询预算使用情况 | `get_budget` |
| 设置单项总预算或分类预算 | `set_budget` |
| 普通收支或待报销支出批量创建与修改 | `create_bills`、`update_bills` |
| 删除普通收支、待报销支出、转账或还款 | `delete_bills` |
| 转账与信用卡还款 | `create_transfer`、`update_transfer` |
| 查询周期设置、创建固定转账周期任务及暂停或恢复任务 | `list_repeat_tasks`、`create_repeat_transfer`、`set_repeat_task_enabled` |
| 显式启用的本机恢复 | `recover_asset_bills`、`rebuild_reimbursement`、`recover_debt_wallet`、`restore_bill_category`、`restore_asset_balance`、`discard_unused_wallet` |
| 退款 | `create_refund`、`update_refund`、`delete_refund` |
| 报销 | `reimburse_bills`、`delete_reimbursement`、`cancel_reimbursements` |
| 分类管理 | `create_categories`、`create_subcategories`、`update_categories`、`delete_categories`、`check_category_deletion`、`move_category`、`reorder_categories`、`list_category_icons` |
| 标签管理 | `create_tag_groups`、`delete_tag_groups`、`create_tags`、`update_tags`、`delete_tags`、`archive_tags`、`reorder_tags`、`reorder_tag_groups` |
| 持久请求回执 | `get_operation_status`，启用后业务写入必须传 `requestId`，修改或关联已有账单还需 `expectedBills` |
| 已结束操作的限定复核 | `verify_rejected_bill_operation`、`verify_future_repeat_creation`、`verify_debt_creation`、`verify_debt_deletion` |
| 图片上传与关联 | `upload_bill_image`、`set_bill_images` |
| 账本、资产基础管理及标签组改名 | `get_catalog_object`、`manage_catalog_object` |
| 通用周期创建、编辑与删除未执行设置 | `create_repeat_task`、`update_repeat_task`、`delete_unused_repeat_task` |
| CSV/JSON 摘要导出 | `export_bills` |
| 账号时区 | `get_time_zone`、`set_time_zone` |
| 原生借贷及未来分期 | `get_debt_details`、`manage_debt`、`list_installments`、`manage_installment` |
| PAT 管理，仅超级管理员 | `list_pats`、`create_pat`、`delete_pat` |

## 验证范围与已知限制

当前适配和联调基线为 Android **4.5.4-1234**，不是对所有钱迹版本、平台和参数组合的兼容承诺。详细过程见[兼容性与验收记录](compatibility-4.5.4.md)。

- 常用收支、转账、信用卡还款、退款、报销、分类/标签管理、跨币种和月预算已在授权的测试资源上验证，并核对写入后的金额和余额
- 普通账单图片可通过详情返回的链接读取；超长图可能被 CDN 以图片面积过大拒绝处理，返回链接不代表下载一定成功
- 年度预算设置、父子分类预算写入及部分异常登录状态只有离线覆盖
- 目录编辑、周期、分期、分页导出、时区、借贷本金和附件的上线前验收范围见[隔离服务验收记录](capability-upgrade.md)
- 新建资产和新借贷限明确 CNY，分期限独立 CNY 信用账户及未来起始日期；尚不支持历史分期回补、提前还款、修改已生成分期账单或跨币种借贷
- 分类“连账单删除”不会回滚账户余额；需要回滚时应先正常删除账单、核对余额，再删除空分类
- `list_tags` 仍不展示空标签组，已知组 ID 可用 `get_catalog_object` 查询并改名；删除标签后历史账单可能保留旧标签 ID
- 预算设置需读取并提交完整期间列表，服务会保留其他额度并回读核对，但无法保证与 App 同时编辑时的原子性

恢复工具默认关闭，需配置绝对路径的私人目录 `QIANJI_MCP_RECOVERY_ROOT`。备份只读且按当前账号隔离，不恢复凭据或覆盖整个数据库。`recover_asset_bills` 默认预览，现存普通记录只替换已删除资产的引用；缺失转账/还款需明确允许新编号恢复，保留历史日期、金额、备注和附件。备份恢复目前要求转出与转入资产的币种都与 `currency` 一致，尚不支持跨币种历史转账或还款。工具拒绝路径越界和编号冲突，完全一致的已恢复记录跳过，近似重复则停止核查。

旧退款使用专用退款工具；不能直接更新的报销到账可在明确允许新编号后用 `rebuild_reimbursement` 逐条重建，保存私人回执并核验原支出、到账分类和图片。借贷起始记录只能使用 `recover_debt_wallet`，同时修复起始记录和借贷资产的资金账户，保留原编号、结清状态及附件，即使账单已经关联新钱包也不能跳过借贷资产核验。通用关联工具拒绝借贷起始记录和利息类型，以免遗漏借贷资金账户或由上游清空分类；`restore_bill_category` 的兼容请求方式必须单独获得许可，最终以回读的分类与交易类型为准。

`restore_asset_balance` 通过客户端资产提交协议只改余额，不带 `diffparams`、不产生抵扣账单，必须提供预期当前余额与有依据的目标余额。`discard_unused_wallet` 只清理明确授权且没有任何账单关联的恢复临时钱包。恢复历史记录可能再次影响已有资产，执行后必须核对，不能用余额修改掩盖未知差额。恢复不是跨接口事务，部分失败必须先查看私人回执和最新状态，不能重放整批；账号锁也不能阻止其他设备同时编辑。`refresh_cache.fullBillSync` 可读取完整云端账单并移除失效的本地缓存，不写入或删除云端账单。

## 项目来源

先感谢钱迹和这些开源作者。本项目在已有工作上继续完善，保留来源和许可证。

| 来源 | 与本项目的关系 |
|---|---|
| [钱迹官网](https://www.qianjiapp.com/) · [官方使用指南](https://docs.qianjiapp.com/) | 钱迹是实际保存、同步和展示账目的应用；本项目对接它的服务，协议行为参考 Android 客户端实现 |
| [fangzhengjin/qianji-mcp](https://github.com/fangzhengjin/qianji-mcp) | 本仓库直接 fork 的 TypeScript 上游，提供 MCP 服务、登录认证、同步缓存和基础账单操作 |
| [apsuadwf 的分类与标签贡献（PR #3）](https://github.com/fangzhengjin/qianji-mcp/pull/3) | 移植其中两个提交的分类与标签管理能力，保留作者信息，继续修复和验证 |
| [Nevery-qiao/qianji-agent](https://github.com/Nevery-qiao/qianji-agent) | 原生借贷、分期和目录协议的交叉参考，未接入其执行器或私人数据存储 |
| [ljq29/MCP_qianji](https://github.com/ljq29/MCP_qianji) | 调研和试用过的 Python 实现，作为功能与使用体验参考；当前服务仍以 TypeScript 上游为基础 |

**这是个人维护的非官方项目，不是钱迹官方推出的 MCP 服务。** 它通过钱迹私有 HTTP API 工作，接口可能随客户端升级变化；上面的开源项目也不能视为钱迹官方背书。

协议参考来源的 MIT 声明见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
