import { realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, join } from "node:path";
import { Database } from "bun:sqlite";

import { AppError } from "./errors.ts";
import { parseQianjiJson } from "./qianji-client.ts";

/** Read exact records from an explicitly enabled, read-only local recovery backup. */
export function readRecoveryBackup(
  recoveryRoot: string | undefined,
  backupPath: string,
  uid: string,
  billIds: string[],
): { bills: Record<string, unknown>[]; assets: Record<string, unknown>[] } {
  if (!recoveryRoot) throw new AppError("RECOVERY_DISABLED", "本机尚未配置只读恢复备份目录", 403);
  let root: string;
  let path: string;
  try {
    root = realpathSync(recoveryRoot);
    path = realpathSync(resolve(root, backupPath));
  } catch {
    throw new AppError("RECOVERY_BACKUP_UNAVAILABLE", "恢复备份不可读取", 400);
  }
  const within = relative(root, path);
  if (!within || within === ".." || within.startsWith("../") || within.startsWith("..\\") || isAbsolute(within)) {
    throw new AppError("RECOVERY_BACKUP_FORBIDDEN", "备份必须位于本机配置的恢复目录内", 403);
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const account = db.query("SELECT id FROM accounts WHERE uid = ?").get(uid) as { id: number } | null;
    if (!account) throw new AppError("RECOVERY_ACCOUNT_MISMATCH", "备份不包含当前绑定的钱迹账号", 403);
    const query = db.query("SELECT raw_json FROM bills WHERE account_id = ? AND id = ?");
    const bills = billIds.map((id) => {
      const row = query.get(account.id, id) as { raw_json: string } | null;
      if (!row) throw new AppError("RECOVERY_BILL_MISSING", "备份中缺少请求恢复的账单", 404);
      return parseQianjiJson(row.raw_json) as Record<string, unknown>;
    });
    const catalog = db.query("SELECT data_json FROM catalog_cache WHERE account_id = ? AND kind = 'assets' AND scope = ''")
      .get(account.id) as { data_json: string } | null;
    const assets = catalog ? parseQianjiJson(catalog.data_json) : [];
    if (!Array.isArray(assets)) throw new AppError("RECOVERY_BACKUP_INVALID", "备份资产目录无效");
    return { bills, assets: assets as Record<string, unknown>[] };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("RECOVERY_BACKUP_INVALID", "恢复备份格式无效或读取失败", 400);
  } finally {
    db?.close();
  }
}

/** Only asset references may change; all other original data remains intact. */
export function remapBillAsset(raw: Record<string, unknown>, oldId: string, newId: string): Record<string, unknown> {
  const result = { ...raw };
  for (const key of ["assetid", "fromid", "targetid"]) {
    if (String(result[key]) === oldId) result[key] = newId;
  }
  return result;
}

/** Stable comparison of user-visible fields, including images and relationships. */
export function recoveryFingerprint(bill: Record<string, unknown>): string {
  const { updateTime: _, ...stable } = bill;
  stable.tagIds ??= [];
  if ("bookId" in stable) for (const key of ["assetId", "fromId", "targetId"]) stable[key] ??= null;
  return JSON.stringify(stable, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
}

/** Exclusive private receipt before destructive replacement; never overwrite or silently replay. */
export function saveRecoveryRecord(root: string, uid: string, id: string, data: unknown): void {
  if (!/^\d+$/.test(id)) throw new AppError("RECOVERY_INPUT_INVALID", "恢复记录编号无效");
  const dir = join(root, "reimbursement-recovery", createHash("sha256").update(uid).digest("hex").slice(0, 24));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { writeFileSync(join(dir, `${id}.json`), JSON.stringify(data), { flag: "wx", mode: 0o600 }); }
  catch { throw new AppError("RECOVERY_RECEIPT_EXISTS", "恢复回执已存在或无法保存，请先核对实际状态，不得重复执行", 409); }
}
