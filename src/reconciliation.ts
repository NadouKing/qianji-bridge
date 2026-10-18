import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { Database } from "bun:sqlite";

export const recordSchema = z.object({
  id: z.string().min(1), source: z.enum(["wechat", "alipay"]), sourceRow: z.number().int().positive(),
  orderId: z.string(), time: z.number().int().positive(), merchant: z.string(), item: z.string(),
  direction: z.string(), amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.literal("CNY"), paymentMethod: z.string(), status: z.string(), kind: z.string(), note: z.string(),
});
export const importSchema = z.object({ version: z.literal(1), source: z.string(), records: z.array(recordSchema) });
export type SourceRecord = z.infer<typeof recordSchema>;
export interface LedgerBill {
  id: string; bookId: string; time: number; type: number; money: number; discount?: number;
  assetId: string | null; remark: string; currencyConversion?: unknown;
}
export const rulesSchema = z.object({
  accounts: z.array(z.object({ contains: z.string().min(1), assetId: z.string().regex(/^[1-9]\d*$/) })).default([]),
  aliases: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) })).default([]),
});
export type MatchRules = z.infer<typeof rulesSchema>;
const norm = (s: string) => s.replace(/[\s（）()·，,。.\-—_]/g, "").toLowerCase();
function named(source: string, remark: string): boolean {
  const a = norm(source), b = norm(remark);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}
function assetFor(record: SourceRecord, rules: MatchRules) {
  const ids = [...new Set(rules.accounts.filter(r => record.paymentMethod.includes(r.contains)).map(r => r.assetId))];
  return ids.length === 1 ? ids[0] : undefined;
}
function merchantFor(record: SourceRecord, rules: MatchRules) {
  const targets = [...new Set(rules.aliases.filter(a => a.source === record.merchant).map(a => a.target))];
  return targets.length === 1 ? targets[0]! : record.merchant;
}
const expense = (r: SourceRecord) => r.direction === "支出" && ["支付成功", "交易成功"].includes(r.status) && r.amountMinor > 0;
function cents(bill: LedgerBill) {
  return Math.round((bill.money - (bill.discount ?? 0)) * 100);
}

/** Produces evidence candidates only; never decides ledger writes or learns aliases. */
export function proposeMatches(records: SourceRecord[], bills: LedgerBill[], rules: MatchRules, windowDays = 35) {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) throw new Error("Invalid date window");
  if (new Set(records.map(r => r.id)).size !== records.length) throw new Error("Duplicate source IDs across imports");
  const window = windowDays * 86400;
  const eligible = bills.filter(b => [0, 5].includes(b.type) && !b.currencyConversion);
  const byAmount = new Map<string, LedgerBill[]>();
  for (const bill of eligible) {
    const key = JSON.stringify([bill.assetId, cents(bill)]);
    byAmount.set(key, [...(byAmount.get(key) ?? []), bill]);
  }
  const rows = records.map(record => {
    const assetId = assetFor(record, rules);
    const merchant = merchantFor(record, rules);
    const excluded = record.amountMinor === 0 || /关闭|失败|免押|解冻/.test(record.status);
    const candidates = expense(record) && assetId ? (byAmount.get(JSON.stringify([assetId, record.amountMinor])) ?? []).filter(b =>
      b.assetId === assetId && cents(b) === record.amountMinor && Math.abs(b.time - record.time) <= window,
    ).map(b => ({
      billId: b.id,
      evidence: ["account", "amount", "date-window", ...(named(merchant, b.remark) || named(record.item, b.remark) ? ["name"] : [])],
      secondsApart: b.time - record.time,
    })).sort((a, b) => b.evidence.length - a.evidence.length || Math.abs(a.secondsApart) - Math.abs(b.secondsApart)) : [];
    return { sourceId: record.id, assetId: assetId ?? null,
      status: excluded ? "excluded" : candidates.length ? "candidate" : "needs_review",
      reason: excluded ? "closed-failed-zero-or-preauthorization" : !assetId ? "account-not-unambiguously-mapped" :
        !expense(record) ? "refund-income-transfer-or-other-status" : candidates.length ? "verify-evidence-and-attachments" : "check-aggregates-or-other-sources",
      candidates };
  });
  const grouped = new Map<string, SourceRecord[]>();
  for (const r of records.filter(expense)) {
    const assetId = assetFor(r, rules);
    if (!assetId) continue;
    const key = JSON.stringify([assetId, merchantFor(r, rules)]);
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }
  const aggregates = [];
  // Bounded contiguous windows, not arbitrary subsets fitted to a desired total.
  for (const [key, input] of grouped) {
    const [assetId, merchant] = JSON.parse(key) as [string, string];
    const items = input.toSorted((a, b) => a.time - b.time);
    for (let end = 1; end < items.length; end++) {
      let total = items[end]!.amountMinor;
      for (let start = end - 1; start >= 0 && end - start < 100; start--) {
        if (items[end]!.time - items[start]!.time > window) break;
        total += items[start]!.amountMinor;
        for (const bill of (byAmount.get(JSON.stringify([assetId, total])) ?? []).filter(b =>
          named(merchant, b.remark) && Math.abs(b.time - items[end]!.time) <= 86400)) {
          aggregates.push({ billId: bill.id, sourceIds: items.slice(start, end + 1).map(r => r.id),
            amountMinor: total, status: "candidate", evidence: ["account", "name", "contiguous-sum", "end-date"] });
        }
      }
    }
  }
  return { version: 1, rows, aggregates,
    note: "Candidates can overlap. Review composition, refunds, cross-channel funding and attachments before accepting; no automatic write plan." };
}

/** Reject private output anywhere inside a Git checkout, including symlinked parents. */
export async function privatePath(path: string) {
  const target = resolve(path);
  let ancestor = dirname(target);
  const missing: string[] = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  let check = ancestor;
  while (true) {
    let exists = false;
    try { await access(join(check, ".git")); exists = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) throw new Error("Private output must be outside every Git checkout");
    const parent = dirname(check);
    if (parent === check) break;
    check = parent;
  }
  const directory = join(ancestor, ...missing);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = join(directory, basename(target));
  try {
    if ((await lstat(result)).isSymbolicLink()) throw new Error("Private output cannot be a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}
export async function writePrivateJson(path: string, value: unknown, replace = false) {
  const target = await privatePath(path);
  const temporary = replace ? target + "." + randomUUID() + ".tmp" : target;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  if (replace) await rename(temporary, target);
}

const operationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  tool: z.enum(["create_bills", "update_bills", "create_transfer", "update_transfer", "create_refund", "update_refund", "reimburse_bills"]),
  arguments: z.record(z.string(), z.unknown()),
});
export const planSchema = z.object({
  version: z.literal(1), batchId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  accountUid: z.string().min(1), bookIds: z.array(z.string().regex(/^(?:-1|[1-9]\d*)$/)).min(1),
  expectedBills: z.array(z.object({ billId: z.string().regex(/^[1-9]\d*$/), hash: z.string().regex(/^[a-f0-9]{64}$/) })).default([]),
  operations: z.array(operationSchema).min(1).max(100),
}).superRefine((p, ctx) => {
  if (new Set(p.operations.map(o => o.id)).size !== p.operations.length) ctx.addIssue({ code: "custom", message: "Duplicate operation IDs" });
  if (new Set(p.expectedBills.map(b => b.billId)).size !== p.expectedBills.length) ctx.addIssue({ code: "custom", message: "Duplicate bill fingerprints" });
});
export type WritePlan = z.infer<typeof planSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k =>
    JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(value);
}
export function planHash(plan: WritePlan) { return createHash("sha256").update(canonical(plan)).digest("hex"); }
export function billFingerprint(bill: unknown) { return createHash("sha256").update(canonical(bill)).digest("hex"); }
interface Journal {
  version: 1; hash: string; batchId: string;
  operations: Array<{ id: string; status: "pending" | "confirmed" | "uncertain"; result?: unknown; failure?: unknown }>;
}
export class OperationFailure extends Error {
  readonly detail: unknown;
  constructor(detail: unknown) { super("MCP operation failed; review the private journal"); this.detail = detail; }
}
/** Persist before every call. Unknown/partial results never replay, including after restart. */
export async function executeJournal(
  plan: WritePlan, path: string,
  execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  beforeExecute?: (remaining: WritePlan) => Promise<void>,
) {
  const target = await privatePath(path);
  const databasePath = await privatePath(target + ".sqlite");
  const lockPath = target + ".lock";
  const lock = await open(lockPath, "wx", 0o600);
  let database: Database | undefined;
  try {
    // SQLite's native VFS handles crash-safe commits on Windows as well as POSIX.
    // The JSON file is a readable mirror, never the authority for replay decisions.
    try { const file = await open(databasePath, "wx", 0o600); await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    database = new Database(databasePath, { strict: true });
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA fullfsync = ON;");
    database.exec("CREATE TABLE IF NOT EXISTS receipt (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)");
    const stored = database.query<{ payload: string }, []>("SELECT payload FROM receipt WHERE id = 1").get();
    let journal: Journal;
    try {
      journal = JSON.parse(stored?.payload ?? await readFile(target, "utf8")) as Journal;
      if (journal.version !== 1 || journal.hash !== planHash(plan) || journal.batchId !== plan.batchId) throw new Error("Journal does not match plan");
      if (!Array.isArray(journal.operations) || journal.operations.some((entry, i) =>
        entry.id !== plan.operations[i]?.id || entry.status !== "confirmed")) {
        throw new Error("Batch has an uncertain result; reconcile the remote ledger before any further write");
      }
      if (journal.operations.length > plan.operations.length) throw new Error("Invalid journal");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journal = { version: 1, hash: planHash(plan), batchId: plan.batchId, operations: [] };
    }
    const persist = async () => {
      database!.query("INSERT INTO receipt (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload")
        .run(JSON.stringify(journal));
      await writePrivateJson(target, journal, true);
    };
    await persist();
    const remaining = plan.operations.slice(journal.operations.length);
    // Hold the same lock while checking only work that has not already succeeded.
    await beforeExecute?.({ ...plan, operations: remaining });
    for (const operation of remaining) {
      const entry: Journal["operations"][number] = { id: operation.id, status: "pending" };
      journal.operations.push(entry);
      await persist();
      try {
        entry.result = await execute(operation.tool, operation.arguments);
        entry.status = "confirmed";
        await persist();
      } catch (error) {
        entry.status = "uncertain";
        entry.failure = error instanceof OperationFailure ? error.detail : { message: "Request or confirmation failed" };
        // Partial success is also uncertain. Preserve successful earlier operations and stop.
        await persist();
        throw new Error("Operation result uncertain; stopped without retry. Inspect the journal and refreshed ledger.");
      }
    }
    return { batchId: journal.batchId, confirmed: journal.operations.length };
  } finally {
    database?.close();
    await lock.close();
    await unlink(lockPath);
  }
}
