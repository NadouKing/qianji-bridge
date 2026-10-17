# 工具与能力说明

> 以下内容对应仓库当前实现，不代表所有钱迹客户端版本均通过验证。

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

## 项目来源

先感谢钱迹和这些开源作者。本项目在已有工作上继续完善，保留来源和许可证。

| 来源 | 与本项目的关系 |
|---|---|
| [钱迹官网](https://www.qianjiapp.com/) · [官方使用指南](https://docs.qianjiapp.com/) | 钱迹是实际保存、同步和展示账目的应用；本项目对接它的服务，协议行为参考 Android 客户端实现 |
| [fangzhengjin/qianji-mcp](https://github.com/fangzhengjin/qianji-mcp) | 本仓库直接 fork 的 TypeScript 上游，提供 MCP 服务、登录认证、同步缓存和基础账单操作 |
| [apsuadwf 的分类与标签贡献（PR #3）](https://github.com/fangzhengjin/qianji-mcp/pull/3) | 移植其中两个提交的分类与标签管理能力，保留作者信息，继续修复和验证 |
| [ljq29/MCP_qianji](https://github.com/ljq29/MCP_qianji) | 调研和试用过的 Python 实现，作为功能与使用体验参考；当前服务仍以 TypeScript 上游为基础 |

**这是个人维护的非官方项目，不是钱迹官方推出的 MCP 服务。** 它通过钱迹私有 HTTP API 工作，接口可能随客户端升级变化；上面的开源项目也不能视为钱迹官方背书。
