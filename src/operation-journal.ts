import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CallToolResult, InputRequiredResult } from "@modelcontextprotocol/server";
import { AppError, operationErrorCode, safeError } from "./errors.ts";
import { billFingerprint, privatePath } from "./reconciliation.ts";
import { writeObservation } from "./write-context.ts";

type Result = CallToolResult | InputRequiredResult;
type State = "pending" | "confirmed" | "uncertain" | "notExecuted" | "reviewed" | "awaitingConfirmation";
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
    const db = new Database(await privatePath(path), { readonly: true, strict: true });
    try {
      const row = db.query<Row, [string]>("SELECT * FROM operations WHERE request_id = ?").get(requestId);
      return row ? {
        requestId, tool: row.tool, state: row.state, updatedAt: row.updated_at,
        result: row.result === null ? null : JSON.parse(row.result),
      } : { requestId, state: "notFound" as const };
    } finally { db.close(); }
  }

  private checkRejection(row: Row | null, tool: string, args: unknown) {
    if (!row || row.tool!==tool || row.hash!==billFingerprint({tool,args})) throw new AppError("REQUEST_ID_CONFLICT","原请求工具、参数或账单指纹不一致");
    if (!["set_bill_images","update_bills","update_transfer"].includes(tool) || row.state!=="uncertain") throw new AppError("OPERATION_REVIEW_UNSUPPORTED","仅能复核已结束且被明确拒绝的普通账单修改");
    if (operationErrorCode(JSON.parse(row.result ?? "null")) !== "WRITE_FAILED") throw new AppError("OPERATION_REVIEW_UNSUPPORTED","超时、部分成功或未知错误不能自动解除门禁");
  }

  async assertExplicitRejection(uid: string, requestId: string, tool: string, args: unknown) {
    const db=new Database(await privatePath(this.path(uid)),{readonly:true,strict:true});
    try {this.checkRejection(db.query<Row,[string]>("SELECT * FROM operations WHERE request_id=?").get(requestId),tool,args);}
    finally {db.close();}
  }

  async confirmExplicitRejection(uid: string, requestId: string, tool: string, args: unknown) {
    const db=new Database(await privatePath(this.path(uid)),{strict:true});
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=EXTRA;");
    try {db.transaction(()=>{
      this.checkRejection(db.query<Row,[string]>("SELECT * FROM operations WHERE request_id=?").get(requestId),tool,args);
      db.exec("CREATE TABLE IF NOT EXISTS rejection_reviews (request_id TEXT PRIMARY KEY, reviewed_at INTEGER NOT NULL, evidence_hash TEXT NOT NULL)");
      const now=Math.floor(Date.now()/1000);
      db.query("INSERT INTO rejection_reviews VALUES (?,?,?)").run(requestId,now,billFingerprint(args));
      // Preserve the original error. Replaying this request still returns that error without dispatch.
      db.query("UPDATE operations SET state='notExecuted',updated_at=? WHERE request_id=?").run(now,requestId);
    }).immediate();} finally {db.close();}
  }

  async completedCreation(uid: string, requestId: string, tool: "create_repeat_task" | "manage_debt", args: unknown) {
    const db=new Database(await privatePath(this.path(uid)),{readonly:true,strict:true});
    try {
      const row=db.query<Row,[string]>("SELECT * FROM operations WHERE request_id=?").get(requestId);
      if (!row || row.tool!==tool || row.hash!==billFingerprint({tool:row.tool,args})) throw new AppError("REQUEST_ID_CONFLICT","原创建请求参数不一致");
      if(row.state!=="uncertain" || operationErrorCode(JSON.parse(row.result ?? "null"))!=="WRITE_CONFIRMATION_FAILED") throw new AppError("OPERATION_REVIEW_UNSUPPORTED","只能复核创建接口已返回但回读未确认的请求，不处理超时或仍执行中的请求");
      return {hash:row.hash,updatedAt:row.updated_at};
    }finally{db.close();}
  }

  async recordRepeatCreationReview(uid: string, requestId: string, original: {hash:string;updatedAt:number}, verified: unknown, kind="unexecutedFutureTaskMatched") {
    const db=new Database(await privatePath(this.path(uid)),{strict:true});
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=EXTRA;");
    try {db.transaction(()=>{
      const row=db.query<Row,[string]>("SELECT * FROM operations WHERE request_id=?").get(requestId);
      if(!row || row.state!=="uncertain" || row.hash!==original.hash || row.updated_at!==original.updatedAt) throw new AppError("OPERATION_REVIEW_CONFLICT","原请求状态已变化");
      db.exec("CREATE TABLE IF NOT EXISTS operation_reviews (request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, reviewed_at INTEGER NOT NULL, verified_result TEXT NOT NULL)");
      const now=Math.floor(Date.now()/1000);
      db.query("INSERT INTO operation_reviews VALUES (?,?,?,?)").run(requestId,kind,now,JSON.stringify(verified));
      db.query("UPDATE operations SET state='reviewed',updated_at=? WHERE request_id=?").run(now,requestId);
    }).immediate();}finally{db.close();}
  }

  async execute(uid: string, requestId: string, tool: string, args: unknown,
    preflight: () => Promise<void>, action: () => Promise<Result>, reimbursementBeforeConfirmation?: unknown): Promise<Result> {
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
        // Older versions recorded this explicit rejection as uncertain. Require the exact
        // old payload and response before allowing that same request to continue.
        const resume = old?.tool === "reimburse_bills" && tool === old.tool && reimbursementBeforeConfirmation !== undefined &&
          old.hash === billFingerprint({ tool, args: reimbursementBeforeConfirmation }) &&
          (old.state === "awaitingConfirmation" || (old.state === "uncertain" &&
            operationErrorCode(JSON.parse(old.result ?? "null")) === "QIANJI_REIMBURSEMENT_UPGRADE_REQUIRED"));
        if (old && !resume) {
          if (old.hash !== hash || old.tool !== tool) throw new AppError("REQUEST_ID_CONFLICT", "请求号已用于不同内容，禁止覆盖原回执");
          if (old.state === "confirmed" || old.state === "notExecuted" || old.state === "reviewed" || old.state === "awaitingConfirmation") return JSON.parse(old.result!) as Result;
          throw new AppError("OPERATION_UNCERTAIN", "原请求仍在执行或结果待核实，请查询原请求状态，不得换号重发");
        }
        if (reimbursementBeforeConfirmation !== undefined && !resume) {
          throw new AppError("REIMBURSEMENT_CONFIRMATION_REQUIRED", "先查询原报销请求的迁移提示，经用户确认后沿用原请求号继续");
        }
        const pending = db.query("SELECT 1 FROM operations WHERE request_id <> ? AND state IN ('pending','uncertain') LIMIT 1").get(requestId);
        if (pending) throw new AppError("ACCOUNT_OPERATION_PENDING", "当前账号有待核实写入，先核实原请求，不发送新写入");
        const now = Math.floor(Date.now() / 1000);
        if (resume) db.query("UPDATE operations SET hash=?, state='pending', result=NULL, updated_at=? WHERE request_id=?").run(hash, now, requestId);
        else db.query("INSERT INTO operations VALUES (?, ?, ?, 'pending', NULL, ?)").run(requestId, tool, hash, now);
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
      const observation = { sent: false };
      try { result = await writeObservation.run(observation, action); }
      catch (error) { result = errorResult(error); }
      const confirmed = "content" in result && !result.isError;
      const needsConsent = tool === "reimburse_bills" && reimbursementBeforeConfirmation === undefined &&
        operationErrorCode(result) === "QIANJI_REIMBURSEMENT_UPGRADE_REQUIRED";
      persist(confirmed ? "confirmed" : needsConsent ? "awaitingConfirmation" : observation.sent ? "uncertain" : "notExecuted", result);
      return result;
    } finally { db.close(); }
  }
}

export function errorResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: safe.code, message: safe.message } }) }] };
}
