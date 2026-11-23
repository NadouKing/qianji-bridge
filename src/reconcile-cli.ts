import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { operationErrorCode } from "./errors.ts";
import {
  billFingerprint, executeJournal, importSchema, OperationFailure, planHash, planSchema, privatePath, proposeMatches,
  rulesSchema, writePrivateJson, type LedgerBill, type ServerReceipts, type WritePlan,
} from "./reconciliation.ts";

const billSchema = z.object({
  id: z.string(), bookId: z.string(), time: z.number(), type: z.number(), money: z.number(),
  discount: z.number().optional(), assetId: z.string().nullable(), remark: z.string(),
  currencyConversion: z.unknown().optional(),
}).passthrough();
const snapshotSchema = z.object({
  version: z.literal(1), accountUid: z.string(), bookId: z.string(), fetchedAt: z.string(),
  range: z.object({ startTime: z.number().int(), endTime: z.number().int() }),
  bills: z.array(billSchema),
}).passthrough();
type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const help = `Local reconciliation (read-only unless apply --apply):
  import INPUT.csv|INPUT.xlsx --output PRIVATE.json [--python PYTHON]
  snapshot --book ID --from YYYY-MM-DD --through YYYY-MM-DD --output PRIVATE.json
  match --input PRIVATE.json [--input OTHER.json] --snapshot PRIVATE.json --rules PRIVATE.json --output PRIVATE.json
  details --ids ID,ID --output PRIVATE.json [--fresh]
  apply --plan PRIVATE.json --journal PRIVATE.json [--apply]

Connection: QIANJI_MCP_URL (or QIANJI_MCP_PUBLIC_URL), QIANJI_MCP_PAT.
Import: Python 3 standard library, BILL_PYTHON or --python selects executable.
All outputs must be outside Git. apply without --apply only validates the plan.
No alias learning or automatic write-plan generation. Review refunds, combined payments and all candidates.`;

function options(args: string[]) {
  const allowed = new Set(["output", "python", "book", "from", "through", "input", "snapshot", "rules", "ids", "fresh", "plan", "journal", "apply"]);
  const result = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error("Unknown option");
    const value = ["fresh", "apply"].includes(key) ? "true" : args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing option value");
    if (key !== "input" && result.has(key)) throw new Error("Duplicate option");
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  const require = (name: string) => {
    const value = result.get(name)?.[0];
    if (!value) throw new Error("Required option missing: --" + name);
    return value;
  };
  return { values: result, positional, require, has: (name: string) => result.has(name) };
}
function day(value: string, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use YYYY-MM-DD dates");
  const time = Date.parse(value + "T00:00:00+08:00");
  if (!Number.isFinite(time) || new Date(time + 8 * 3600000).toISOString().slice(0, 10) !== value) throw new Error("Invalid calendar date");
  return time / 1000 + (end ? 86399 : 0);
}
const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
async function connect<T>(operation: (call: Call, names: ReadonlySet<string>) => Promise<T>) {
  const base = process.env.QIANJI_MCP_URL ?? process.env.QIANJI_MCP_PUBLIC_URL;
  const token = process.env.QIANJI_MCP_PAT;
  if (!base || !token) throw new Error("Configure QIANJI_MCP_URL and QIANJI_MCP_PAT");
  const url = new URL(base);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Use HTTPS or loopback HTTP for MCP");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Do not put credentials or tickets in MCP URL");
  url.pathname = url.pathname.replace(/\/$/, "");
  if (!url.pathname.endsWith("/mcp")) url.pathname += "/mcp";
  const client = new Client({ name: "qianji-reconcile", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => token } }));
    const names = new Set((await client.listTools()).tools.map(t => t.name));
    const call: Call = async (name, args) => {
      if (!names.has(name)) throw new Error("Required MCP tool unavailable: " + name);
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new OperationFailure(result);
      let data = result.structuredContent;
      if (!data) for (const item of result.content ?? []) if (item.type === "text") {
        try { data = JSON.parse(item.text); break; } catch { /* Try next content item. */ }
      }
      if (!data || typeof data !== "object") throw new Error("MCP returned no structured result");
      return data as Record<string, unknown>;
    };
    return await operation(call, names);
  } finally { await client.close(); }
}

function references(value: unknown, ids = new Set<string>(), books = new Set<string>()) {
  if (Array.isArray(value)) for (const item of value) references(item, ids, books);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if ((key === "billId" || key.endsWith("BillId")) && typeof item === "string") ids.add(item);
    else if ((key === "billIds" || key.endsWith("BillIds")) && Array.isArray(item)) {
      for (const id of item) if (typeof id === "string") ids.add(id);
    } else if (key === "bookId" && typeof item === "string") books.add(item);
    else references(item, ids, books);
  }
  return { ids, books };
}
export async function checkWriteScope(plan: WritePlan, call: Call) {
  const user = (await call("get_user_info", {})).user as { id?: string } | undefined;
  if (user?.id !== plan.accountUid) throw new Error("Plan belongs to another account");
  await checkRemainingWrites(plan, call);
}

async function checkRemainingWrites(plan: WritePlan, call: Call) {
  if (plan.operations.length === 0) return;
  const { ids, books } = references(plan.operations);
  const expected = new Map(plan.expectedBills.map(b => [b.billId, b.hash]));
  if ([...ids].some(id => !expected.has(id))) throw new Error("Every referenced bill needs a reviewed fingerprint from details");
  for (const book of books) if (!plan.bookIds.includes(book)) throw new Error("Plan references another book");
  for (const operation of plan.operations) {
    if (operation.tool === "create_bills") {
      const bills = operation.arguments.bills;
      if (!Array.isArray(bills) || bills.length === 0 || bills.some(b =>
        !b || typeof b.bookId !== "string" || !plan.bookIds.includes(b.bookId))) throw new Error("Every new bill needs an explicit allowed bookId");
    }
    if (operation.tool === "create_transfer" &&
      (typeof operation.arguments.bookId !== "string" || !plan.bookIds.includes(operation.arguments.bookId))) {
      throw new Error("Every new transfer needs an explicit allowed bookId");
    }
  }
  await call("refresh_cache", {});
  const allIds = [...ids];
  for (let i = 0; i < allIds.length; i += 100) {
    const result = await call("get_bills", { billIds: allIds.slice(i, i + 100) });
    const parsed = billDetails.parse(result.results);
    const requested = allIds.slice(i, i + 100);
    if (parsed.length !== requested.length || parsed.some((r, index) =>
      r.billId !== requested[index] || typeof r.bill?.bookId !== "string" || !plan.bookIds.includes(r.bill.bookId))) {
      throw new Error("Source bill missing or outside allowed books");
    }
    for (const row of parsed) if (detailFingerprint(row) !== expected.get(row.billId)) {
      throw new Error("A reviewed bill changed; refresh details and review the plan again");
    }
  }
}

const billDetails = z.array(z.object({
  billId: z.string(), bill: z.record(z.string(), z.unknown()).nullable(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
}));
const detailFingerprint = (row: z.infer<typeof billDetails>[number]) => row.fingerprint ?? (row.bill ? billFingerprint(row.bill) : null);

const receiptStatus = z.object({
  requestId: z.string(), state: z.string(), tool: z.string().optional(),
  result: z.object({ structuredContent: z.record(z.string(), z.unknown()).optional(), isError: z.boolean().optional() }).nullish(),
});
const receiptRequestId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const receiptExpectedBills = z.array(z.strictObject({
  billId: z.string().regex(/^[1-9]\d*$/), hash: z.string().regex(/^[a-f0-9]{64}$/),
})).max(100);

export async function applyWritePlan(plan: WritePlan, journal: string, call: Call, hasStatusTool: boolean) {
  await checkWriteScope({ ...plan, operations: [] }, call);
  const reviewedPlanHash = planHash(plan);
  const generatedRequestId = (operation: WritePlan["operations"][number]) =>
    "reconcile-" + billFingerprint([reviewedPlanHash, operation.id]);
  const status = async (requestId: string) => {
    const receipt = receiptStatus.parse((await call("get_operation_status", { requestId })).operation);
    if (receipt.requestId !== requestId) throw new Error("Server receipt does not match the original request");
    return receipt;
  };
  let receipts: ServerReceipts | undefined;
  if (hasStatusTool) {
    try {
      await status(generatedRequestId(plan.operations[0]!));
      const reviewed = new Map(plan.expectedBills.map(row => [row.billId, row.hash]));
      const prepared = new Map(plan.operations.map(operation => {
        const { requestId: suppliedId, expectedBills: supplied, ...args } = operation.arguments;
        const { ids } = references(args);
        const requestId = suppliedId === undefined ? generatedRequestId(operation) : receiptRequestId.parse(suppliedId);
        const expectedBills = supplied === undefined
          ? plan.expectedBills.filter(row => ids.has(row.billId)) : receiptExpectedBills.parse(supplied);
        const expected = new Map(expectedBills.map(row => [row.billId, row.hash]));
        if (expected.size !== expectedBills.length || expectedBills.some(row => reviewed.get(row.billId) !== row.hash) ||
            [...ids].some(id => !expected.has(id))) {
          throw new Error("Operation fingerprints must match the reviewed plan and cover all referenced bills");
        }
        return [operation.id, { requestId, arguments: { ...args, requestId, expectedBills } }] as const;
      }));
      if (new Set([...prepared.values()].map(request => request.requestId)).size !== prepared.size) {
        throw new Error("Each operation must have a distinct server request ID");
      }
      receipts = {
        prepare: operation => prepared.get(operation.id)!,
        confirmedResult: async (requestId, operation) => {
          // An externally chosen ID can also belong to a different payload of the same tool.
          if (requestId !== generatedRequestId(operation)) return undefined;
          const receipt = await status(requestId);
          return receipt.state === "confirmed" && receipt.tool === operation.tool && !receipt.result?.isError
            ? receipt.result?.structuredContent : undefined;
        },
      };
    } catch (error) {
      if (!(error instanceof OperationFailure) || operationErrorCode(error.detail) !== "OPERATIONS_NOT_CONFIGURED") throw error;
    }
  }
  return executeJournal(plan, journal, call, remaining => checkRemainingWrites(remaining, call), receipts);
}

export async function main(args: string[]) {
  const command = args[0];
  if (!command || command === "--help") { console.log(help); return; }
  const opts = options(args.slice(1));
  if (command === "import") {
    if (opts.positional.length !== 1) throw new Error("Provide exactly one export file");
    const output = await privatePath(opts.require("output"));
    const python = opts.values.get("python")?.[0] ?? process.env.BILL_PYTHON ?? Bun.which("python3") ?? "python";
    const helper = fileURLToPath(new URL("../scripts/read-bill.py", import.meta.url));
    const processResult = Bun.spawnSync([python, helper, resolve(opts.positional[0]!)], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    if (processResult.exitCode !== 0) throw new Error("Export parsing failed; verify Python 3, encoding and payment header");
    const imported = importSchema.parse(JSON.parse(processResult.stdout.toString("utf8")));
    await writePrivateJson(output, imported);
    console.log(JSON.stringify({ source: imported.source, records: imported.records.length }));
  } else if (command === "snapshot") {
    const output = await privatePath(opts.require("output"));
    const bookId = opts.require("book"), startTime = day(opts.require("from")), endTime = day(opts.require("through"), true);
    if (!/^(?:-1|[1-9]\d*)$/.test(bookId) || startTime > endTime) throw new Error("Invalid book or date range");
    await connect(async call => {
      await call("refresh_cache", {});
      const user = (await call("get_user_info", {})).user as { id: string };
      const [assets, categories, tags] = await Promise.all([
        call("list_assets", { includeHidden: true }), call("list_categories", { bookId }), call("list_tags", {}),
      ]);
      const bills: LedgerBill[] = [], ids = new Set(), cursors = new Set();
      let cursor: string | undefined;
      do {
        const result = await call("list_bills", cursor ? { cursor } : { bookId, startTime, endTime, limit: 100, sort: "timeAsc" });
        for (const bill of z.array(billSchema).parse(result.results)) {
          if (ids.has(bill.id)) throw new Error("Repeated bill across pages");
          if (bill.bookId !== bookId) throw new Error("Unexpected book");
          ids.add(bill.id); bills.push(bill);
        }
        if (result.nextCursor !== null && typeof result.nextCursor !== "string") throw new Error("Invalid next cursor");
        cursor = result.nextCursor as string | undefined;
        if (cursor) { if (cursors.has(cursor)) throw new Error("Repeated cursor"); cursors.add(cursor); }
      } while (cursor);
      await writePrivateJson(output, { version: 1, accountUid: user.id, bookId, fetchedAt: new Date().toISOString(),
        range: { startTime, endTime }, bills, assets, categories, tags });
      console.log(JSON.stringify({ bills: bills.length }));
    });
  } else if (command === "match") {
    const paths = opts.values.get("input");
    if (!paths?.length) throw new Error("Provide at least one --input");
    const records = (await Promise.all(paths.map(load))).flatMap(value => importSchema.parse(value).records);
    const snapshot = snapshotSchema.parse(await load(opts.require("snapshot")));
    const rules = rulesSchema.parse(await load(opts.require("rules")));
    const inScope = records.filter(r => r.time >= snapshot.range.startTime && r.time <= snapshot.range.endTime);
    const report = proposeMatches(inScope, snapshot.bills, rules);
    await writePrivateJson(opts.require("output"), { ...report, accountUid: snapshot.accountUid,
      bookId: snapshot.bookId, range: snapshot.range, outsideScope: records.length - inScope.length,
      snapshotFetchedAt: snapshot.fetchedAt });
    console.log(JSON.stringify({ rows: report.rows.length, aggregateCandidates: report.aggregates.length }));
  } else if (command === "details") {
    const output = await privatePath(opts.require("output"));
    const ids = [...new Set(opts.require("ids").split(","))];
    if (ids.length > 100 || ids.some(id => !/^[1-9]\d*$/.test(id))) throw new Error("Provide 1-100 valid bill IDs");
    await connect(async call => {
      const result = await call("get_bills", { billIds: ids, refresh: opts.has("fresh") });
      const parsed = billDetails.parse(result.results);
      await writePrivateJson(output, { ...result, results: parsed.map(row =>
        ({ ...row, fingerprint: detailFingerprint(row) })) });
      console.log(JSON.stringify({ requested: ids.length }));
    });
  } else if (command === "apply") {
    const plan = planSchema.parse(await load(opts.require("plan")));
    if (!opts.has("apply")) {
      console.log(JSON.stringify({ batchId: plan.batchId, operations: plan.operations.length, hash: planHash(plan), writes: 0 }));
      return;
    }
    const journal = await privatePath(opts.require("journal"));
    await connect(async (call, names) => {
      console.log(JSON.stringify(await applyWritePlan(plan, journal, call, names.has("get_operation_status"))));
    });
  } else throw new Error("Unknown command; use --help");
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    // Zod and upstream errors can contain private input. Do not echo them to the terminal.
    console.error(error instanceof z.ZodError ? "Invalid input schema; inspect the private file." :
      String((error as Error).message).replace(/mt_pat_[A-Za-z0-9_-]+/g, "[redacted]"));
    process.exitCode = 1;
  }
}
