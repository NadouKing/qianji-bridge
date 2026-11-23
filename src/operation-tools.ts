import type { McpServer, CallToolResult, InputRequiredResult, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { errorResult, type ExpectedBill } from "./operation-journal.ts";
import type { MoneyTrackService } from "./qianji-service.ts";
import { POSITIVE_ID_PATTERN, MAX_JAVA_LONG_ID_LENGTH } from "./ids.ts";

type Callback = (input: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>;
const identityTools = new Set(["connect_qianji", "disconnect_qianji", "create_pat", "delete_pat", "refresh_cache"]);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe("稳定请求号，同一业务重发必须使用原编号");
const expectedBills = z.array(z.strictObject({
  billId: z.string().regex(POSITIVE_ID_PATTERN).max(MAX_JAVA_LONG_ID_LENGTH).describe("写前需核验的账单 ID"),
  hash: z.string().regex(/^[a-f0-9]{64}$/).describe("get_bills 返回的版本指纹"),
})).max(100).describe("已审核的原账单指纹，修改及关联源账单必须覆盖");

/** Extend actual tool schemas; no alternate unvalidated upstream write path. */
export function installOperationTools(server: McpServer, service: MoneyTrackService, accountId: () => Promise<number>) {
  const register = server.registerTool.bind(server);
  server.registerTool = ((...registration: Parameters<McpServer["registerTool"]>) => {
    const [name, config, callback] = registration;
    if (config.annotations?.readOnlyHint !== false || identityTools.has(name)) return register(name, config, callback);
    const schema = config.inputSchema;
    if (!(schema instanceof z.ZodObject)) throw new Error(`Write tool ${name} requires an object schema`);
    const outputSchema = config.outputSchema;
    if (!(outputSchema instanceof z.ZodType)) throw new Error(`Write tool ${name} requires an output schema`);
    const inputSchema = schema.safeExtend({ requestId: requestId.optional(), expectedBills: expectedBills.optional() }).meta(schema.meta() ?? {});
    const invoke = callback as unknown as Callback;
    return register(name, { ...config, inputSchema, outputSchema }, async (input: Record<string, unknown>, ctx: ServerContext) => {
      const { requestId: id, expectedBills: expected, ...args } = input as Record<string, unknown>;
      try {
        return await service.runOperation(await accountId(), id as string | undefined, name, args,
          expected as ExpectedBill[] | undefined, () => invoke(args, ctx));
      } catch (error) { return errorResult(error); }
    });
  }) as typeof server.registerTool;
  register("get_operation_status", {
    description: "只读查询原请求的持久回执，不重发写入，notFound 不证明原调用已结束",
    inputSchema: z.strictObject({ requestId }),
    outputSchema: z.object({ operation: z.object({
      requestId, state: z.enum(["notFound", "pending", "confirmed", "uncertain", "notExecuted", "reviewed", "awaitingConfirmation"]).describe("持久状态，awaitingConfirmation 表示钱迹要求确认报销迁移，pending 或 uncertain 仍需核实，reviewed 表示经专用复核关闭"),
      tool: z.string().optional().describe("原工具名称"),
      updatedAt: z.number().int().optional().describe("回执更新时间，Unix 秒"),
      result: z.unknown().optional().describe("原工具回执，可能包含部分成功或未核实错误"),
    }).describe("当前账号的原请求回执") }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ requestId: id }) => {
    try {
      const output = { operation: await service.operationStatus(await accountId(), id) };
      return { structuredContent: output, content: [{ type: "text", text: JSON.stringify(output) }] };
    } catch (error) { return errorResult(error); }
  });
  register("verify_rejected_bill_operation", {
    description:"只读回查上游明确拒绝的普通账单修改，原参数及全部账单指纹相符且账单未变才记录未执行，保留失败回执，不重发写入，不能解除超时或部分成功",
    inputSchema:z.strictObject({requestId,
      originalTool:z.union([z.literal("set_bill_images").describe("附件编辑"),z.literal("update_bills").describe("普通账单编辑"),z.literal("update_transfer").describe("转账编辑")]).describe("原请求工具"),
      originalArguments:z.record(z.string(),z.unknown()).meta({required:[]}).describe("原请求业务参数，不含 requestId 和 expectedBills"),
      expectedBills,
    }),
    outputSchema:z.record(z.string(),z.unknown()).describe("复核后的原回执及未变化账单编号"),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async ({requestId: id,originalTool,originalArguments,expectedBills: expected})=>{
    try {
      const output=await service.verifyRejectedBillOperation(await accountId(),id,originalTool,originalArguments,expected);
      return {structuredContent:output,content:[{type:"text",text:JSON.stringify(output)}]};
    }catch(error){return errorResult(error);}
  });
  register("verify_future_repeat_creation", {
    description:"复核创建接口已返回但回读未确认的未来周期，需原参数且唯一匹配创建时间窗内未执行设置，拒绝超时、已生成账单及模糊匹配，保留原失败回执且不重发创建",
    inputSchema:z.strictObject({requestId,originalArguments:z.record(z.string(),z.unknown()).meta({required:[]}).describe("原 create_repeat_task 业务参数，不含 requestId 和 expectedBills"),
      expectedBills,taskId:z.string().regex(POSITIVE_ID_PATTERN).max(MAX_JAVA_LONG_ID_LENGTH).describe("查询实际目录后确认的周期任务 ID")}),
    outputSchema:z.record(z.string(),z.unknown()).describe("原请求复核状态及当前未执行周期设置"),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async({requestId:id,originalArguments,expectedBills:expected,taskId})=>{
    try {const output=await service.verifyFutureRepeatCreation(await accountId(),id,originalArguments,expected,taskId);return {structuredContent:output,content:[{type:"text",text:JSON.stringify(output)}]};}
    catch(error){return errorResult(error);}
  });
  register("verify_debt_creation", {
    description:"复核接口已返回但回读未确认的新借贷，需原参数、唯一的起始本金账单及调用方已核对的资金余额，不重发创建，不处理超时或后续借贷操作，保留原失败回执",
    inputSchema:z.strictObject({requestId,originalArguments:z.record(z.string(),z.unknown()).meta({required:[]}).describe("原 manage_debt 创建业务参数，不含 requestId 和 expectedBills"),expectedBills,
      debtId:z.string().regex(POSITIVE_ID_PATTERN).max(MAX_JAVA_LONG_ID_LENGTH).describe("实际新建借贷 ID"),expectedCashBalanceAfter:z.number().finite().describe("根据写前余额及原本金核对出的写后资金余额，不能直接照抄当前余额")}),
    outputSchema:z.record(z.string(),z.unknown()).describe("原请求复核状态、借贷版本、起始账单及已核对资金余额"),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async({requestId:id,originalArguments,expectedBills:expected,debtId,expectedCashBalanceAfter})=>{
    try {const output=await service.verifyDebtCreation(await accountId(),id,originalArguments,expected,debtId,expectedCashBalanceAfter);return {structuredContent:output,content:[{type:"text",text:JSON.stringify(output)}]};}
    catch(error){return errorResult(error);}
  });
  register("verify_debt_deletion", {
    description:"只读复核已返回但回读未确认的本金循环删除，须原参数、原指纹、全部账单和借贷已消失以及独立核对的资金余额，不重发删除、不改余额、不处理超时",
    inputSchema:z.strictObject({requestId,originalArguments:z.record(z.string(),z.unknown()).meta({required:[]}).describe("原 manage_debt deleteSettled 业务参数"),expectedBills,
      cashBalances:z.array(z.strictObject({assetId:z.string().regex(POSITIVE_ID_PATTERN).max(MAX_JAVA_LONG_ID_LENGTH).describe("原本金账单涉及的资金账户"),balance:z.number().finite().describe("由写前余额及已核实的删除影响独立计算的写后余额，不能直接照抄当前余额")})).min(1).max(100).describe("全部受影响资金账户的独立余额核对")}),
    outputSchema:z.record(z.string(),z.unknown()).describe("原请求 reviewed 回执及已核实删除范围和余额"),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async({requestId:id,originalArguments,expectedBills:expected,cashBalances})=>{
    try{const output=await service.verifyDebtDeletion(await accountId(),id,originalArguments,expected,cashBalances);return {structuredContent:output,content:[{type:"text",text:JSON.stringify(output)}]};}catch(error){return errorResult(error);}
  });
}
