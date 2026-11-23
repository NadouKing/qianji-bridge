import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CallToolResult, InputRequiredResult } from "@modelcontextprotocol/server";
import { AppError, safeError } from "./errors.ts";
import { billFingerprint, privatePath } from "./reconciliation.ts";

type Result = CallToolResult | InputRequiredResult;
type State = "pending" | "confirmed" | "uncertain" | "notExecuted";
interface Row { request_id: string; tool: string; hash: string; state: State; result: string | null; updated_at: number }
export interface ExpectedBill { billId: string; hash: string }

/** Single-host durable journal shared by all PATs for the same upstream UID.
 * A committed pending row is also the cross-process account gate. Never expire it
 * by wall time: an old HTTP request might still complete at the remote server.
 */
export class OperationJournal {
  private readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("Operations directory must be absolute");
    this.root = root;
  }

  private path(uid: string) {
    return join(this.root, createHash("sha256").update(uid).digest("hex") + ".sqlite");
  }

  async status(uid: string, requestId: string) {
    const path = this.path(uid);
    if (!existsSync(path)) return { requestId, state: "notFound" as const };
    const db = new Database(path, { readonly: true, strict: true });
    try {
      const row = db.query<Row, [string]>("SELECT * FROM operations WHERE request_id = ?").get(requestId);
      return row ? {
        requestId, tool: row.tool, state: row.state, updatedAt: row.updated_at,
        result: row.result === null ? null : JSON.parse(row.result),
      } : { requestId, state: "notFound" as const };
    } finally { db.close(); }
  }

  async execute(uid: string, requestId: string, tool: string, args: unknown,
    preflight: () => Promise<void>, action: () => Promise<Result>): Promise<Result> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw new AppError("INVALID_REQUEST_ID", "请求号格式无效");
    const path = await privatePath(this.path(uid));
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    chmodSync(path, 0o600);
    const db = new Database(path, { strict: true });
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON;");
    db.exec("CREATE TABLE IF NOT EXISTS operations (request_id TEXT PRIMARY KEY, tool TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)");
    const hash = billFingerprint({ tool, args });
    try {
      const existing = db.transaction(() => {
        const old = db.query<Row, [string]>("SELECT * FROM operations WHERE request_id=?").get(requestId);
        if (old) {
          if (old.hash !== hash || old.tool !== tool) throw new AppError("REQUEST_ID_CONFLICT", "请求号已用于不同内容，禁止覆盖原回执");
          if (old.state === "confirmed" || old.state === "notExecuted") return JSON.parse(old.result!) as Result;
          throw new AppError("OPERATION_UNCERTAIN", "原请求仍在执行或结果待核实，请查询原请求状态，不得换号重发");
        }
        const pending = db.query("SELECT 1 FROM operations WHERE state IN ('pending','uncertain') LIMIT 1").get();
        if (pending) throw new AppError("ACCOUNT_OPERATION_PENDING", "当前账号有待核实写入，先核实原请求，不发送新写入");
        db.query("INSERT INTO operations VALUES (?, ?, ?, 'pending', NULL, ?)").run(requestId, tool, hash, Math.floor(Date.now()/1000));
        return undefined;
      }).immediate();
      if (existing) return existing;
      const persist = (state: State, result: Result) => db.query("UPDATE operations SET state=?, result=?, updated_at=? WHERE request_id=?")
        .run(state, JSON.stringify(result), Math.floor(Date.now()/1000), requestId);
      try { await preflight(); }
      catch (error) {
        const result = errorResult(error);
        persist("notExecuted", result);
        return result;
      }
      let result: Result;
      try { result = await action(); }
      catch (error) { result = errorResult(error); }
      // The callback can contain several upstream calls. Any error or elicitation
      // after entry is conservatively uncertain, never interpreted as rollback.
      const confirmed = "content" in result && !result.isError;
      persist(confirmed ? "confirmed" : "uncertain", result);
      return result;
    } finally { db.close(); }
  }
}

export function errorResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: safe.code, message: safe.message } }) }] };
}
