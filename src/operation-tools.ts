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
      requestId, state: z.enum(["notFound", "pending", "confirmed", "uncertain", "notExecuted"]).describe("持久状态，pending 或 uncertain 不表示写入失败"),
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
}
