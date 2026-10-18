# 本地批量对账

仓库提供 `bun run reconcile`，把导入、查询、候选匹配与写入回执串成可复用流程。默认只读；候选不会自动变成账单。

需要完整安装项目依赖（含客户端 SDK）和 Python 3。CSV、XLSX 在本机通过 Python 标准库解析，不上传原始文件；服务端仍只提供钱迹 MCP 能力。PDF 和 OCR 不在此客户端范围内。

## 私人目录与连接

输出文件必须放在所有 Git 工作目录之外。原始文件不会被覆盖，已有输出也不会静默覆盖。导入文件、目录快照、映射、计划、图片地址和回执都是私人资料。

PowerShell 中可使用：

```powershell
$privateDir = Join-Path $env:LOCALAPPDATA 'qianji-reconciliation'
New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
```

从现有私人配置设置 `QIANJI_MCP_URL`（也支持 `QIANJI_MCP_PUBLIC_URL`）与 `QIANJI_MCP_PAT`；不将 PAT 放在命令参数、URL、仓库或截图中。只接受 HTTPS 或回环 HTTP。账号未绑定或登录过期时通过既有 MCP 登录流程处理，CLI 不索要钱迹密码。

默认寻找 Python 3，也可用 `BILL_PYTHON` 或 `import --python <可执行文件>` 明确指定。终端仅输出数量或状态，私人结果写入指定文件。

## 导入与查询

```powershell
bun run reconcile import '<微信导出文件.xlsx>' --output "$privateDir/wechat.json"
bun run reconcile import '<支付宝导出文件.csv>' --output "$privateDir/alipay.json"
bun run reconcile snapshot --book '<当次确认的账本ID>' --from 2024-01-01 --through 2024-12-31 --output "$privateDir/snapshot.json"
```

以上日期为虚构示例，使用时填写本轮范围。导入自动识别说明行、表头、UTF-8／GB18030、CSV 引号换行与 XLSX 共享字符串。金额转为整数分，订单号保留字符串；无表头、多张候选表、重复交易或非法金额会报错。CSV 的 `sourceRow` 是逻辑记录序号，XLSX 是工作表行号。

`snapshot` 先刷新，再读取指定范围的全部分页，同时保存当前账号、资产、分类、标签与读取时间。源文件覆盖范围可以更宽，`match` 只分析快照范围，并报告范围外数量。

## 候选与附件

私人规则文件格式如下，标识和名称都是虚构示例，使用时从当次目录确认：

```json
{
  "accounts": [{"contains": "Fixture银行卡", "assetId": "11"}],
  "aliases": [{"source": "Fixture收款公司", "target": "Fixture商店"}]
}
```

`contains` 只是支付方式中的字面子串，同一条记录命中多个不同资产时不自动选择。别名只用于找候选，不是身份或交易相同的证明；不根据一次匹配自动学习。

```powershell
bun run reconcile match --input "$privateDir/wechat.json" --input "$privateDir/alipay.json" --snapshot "$privateDir/snapshot.json" --rules "$privateDir/rules.json" --output "$privateDir/review.json"
bun run reconcile details --ids '<账单ID>,<账单ID>' --fresh --output "$privateDir/details.json"
```

- 普通成功支出按账户、实扣、日期范围寻找单笔候选，名称冲突保留为候选，不判定已经记账。
- 同账户、同商户查找时间顺序上连续的合计候选，每组最多 100 笔、默认跨度 35 天，支持两种来源共同组成合计。不枚举任意子集来凑数。
- 候选可以重叠，尚未找到候选也不等于漏记。部分退款、报销、转账、理财、混合支付、不同名称的跨商户合计和跨币种留待人工核实。
- `details` 使用 `get_bills` 批量读取详情及图片地址，`--fresh` 先同步账单；查看图片仍需客户端实际下载和解码，不向 CDN 发送 PAT。
- 返回的缓存读取时间不代表同步时间；最近同步时间只记录服务当前进程确认的同步，重启后可能为 null。每条详情另附 `fingerprint`，供写入前检查是否变化。

## 写入计划与回执

候选报告不会自动生成写入计划。用户明确授权后，单独准备包含账号、账本和操作的私人计划；执行前仍需核实用途、账户、分类和重复账目。

计划格式示例（均为虚构值）：

```json
{
  "version": 1,
  "batchId": "fixture-batch",
  "accountUid": "fixture-account",
  "bookIds": ["1"],
  "expectedBills": [],
  "operations": [{
    "id": "buy-supplies",
    "tool": "create_bills",
    "arguments": {"bills": [{
      "bookId": "1", "time": 1700000000, "type": 0,
      "money": 3, "assetId": "11", "categoryId": "2", "remark": "示例用品"
    }]}
  }]
}
```

允许普通创建／修改、转账、退款及报销，不包含删除或账号管理。新增账目必须明确账本；修改及关联源账单必须提供 `expectedBills: [{"billId": "...", "hash": "..."}]`，hash 使用已审核的 `details` fingerprint。

```powershell
# 只校验计划结构，不连接服务，不写账
bun run reconcile apply --plan "$privateDir/plan.json"
# 仅在取得本次记账授权并审核计划后执行
bun run reconcile apply --plan "$privateDir/plan.json" --journal "$privateDir/receipt.json" --apply
```

写入前确认账号、刷新并核对源账本与 fingerprint；已变化时停止。检查不是远端原子锁，执行期间仍应避免同时从 App 修改相同字段。

回执在每次请求之前持久保存 pending，成功保存 confirmed。相同计划与回执再次执行会跳过已确认操作；并发使用同一回执被拒绝。超时、部分成功、响应不明或确认失败都标记 uncertain 并停止，不自动重试；错误响应保存在私人回执中，便于核对批次内已完成项。

崩溃遗留的锁或 pending、uncertain 必须先核对远端与回执，不能直接删锁、删回执或改状态后重发。人工确认后如需继续，保留原回执，为确实未执行的项目另建计划。这是同一本地回执下的防重复执行，不是跨客户端的服务端幂等保证。

## 离线验证

```sh
bun test
bun run typecheck
python -B -m unittest discover -s test -p read_bill_test.py
```

解析和恢复测试使用虚构文件、内存数据库及 mock MCP／上游响应，不连接个人服务或真实数据库。
