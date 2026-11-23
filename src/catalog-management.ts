import type { DataStore, QianjiAccount } from "./data-store.ts";
import type { QianjiClient } from "./qianji-client.ts";
import { AppError } from "./errors.ts";
import { billFingerprint } from "./reconciliation.ts";
import { publicBook, publicAssetGroups, publicTagGroup, cachedBillObject } from "./qianji-mappers.ts";
import { requireNonnegativeMoney } from "./bill-rules.ts";

export type CatalogObjectKind = "book" | "asset" | "tagGroup";
export type CatalogCommand =
  | { action: "createBook"; name: string }
  | { action: "updateBook"; id: string; expectedVersion: string; name?: string; visible?: boolean }
  | { action: "createAsset"; name: string; kind: "cash" | "credit"; balance: number; includeInTotal: boolean; statementDay?: number; paymentDay?: number }
  | { action: "updateAsset"; id: string; expectedVersion: string; name?: string; remark?: string; includeInTotal?: boolean; visible?: boolean }
  | { action: "renameTagGroup"; id: string; expectedVersion: string; name: string }
  | { action: "deleteEmpty"; kind: "book" | "asset"; id: string; expectedVersion: string };

function kindOf(command: CatalogCommand): CatalogObjectKind {
  if (command.action === "deleteEmpty") return command.kind;
  return command.action.endsWith("Book") ? "book" : command.action.endsWith("Asset") ? "asset" : "tagGroup";
}
async function read(client: QianjiClient, account: QianjiAccount, kind: CatalogObjectKind) {
  return kind === "book" ? client.listBooks(account, true) : kind === "asset" ? client.listAssets(account, true) : client.listTagGroups(account);
}
const idOf = (row: Record<string, unknown>, kind: CatalogObjectKind) => String(row[kind === "book" ? "bookid" : "id"]);
function publicObject(row: Record<string, unknown>, kind: CatalogObjectKind, includeBalances = false) {
  const object = kind === "book" ? publicBook(row) : kind === "tagGroup" ? publicTagGroup(row) :
    (publicAssetGroups([row], includeBalances, "CNY", Date.now())[0]!.children as Record<string, unknown>[])[0]!;
  return { object, version: billFingerprint(row) };
}
function owned(row: Record<string, unknown>, account: QianjiAccount) {
  if (String(row.userid) !== account.uid) throw new AppError("CATALOG_OWNER_MISMATCH", "仅支持管理当前账号拥有的对象");
}
function name(value: string, max: number) {
  if (!value.trim() || value !== value.trim() || value.length > max) throw new AppError("INVALID_CATALOG_NAME", `名称必须为 1 至 ${max} 个字符且不含首尾空白`);
}
export async function getCatalogObject(client: QianjiClient, account: QianjiAccount, kind: CatalogObjectKind, id: string, includeBalances = false) {
  const row = (await read(client, account, kind)).find(row => idOf(row, kind) === id);
  if (!row) throw new AppError("CATALOG_OBJECT_NOT_FOUND", "目录对象不存在", 404);
  return publicObject(row, kind, includeBalances);
}

/** Manage only native catalog APIs. Existing rows are read afresh and version-checked. */
export async function manageCatalog(client: QianjiClient, store: DataStore, account: QianjiAccount, command: CatalogCommand, sync: () => Promise<void>) {
  const kind = kindOf(command);
  if ("name" in command && command.name !== undefined) name(command.name, kind === "book" ? 15 : kind === "tagGroup" ? 10 : 40);
  const before = await read(client, account, kind);
  const id = "id" in command ? command.id : undefined;
  const old = id === undefined ? undefined : before.find(row => idOf(row, kind) === id);
  if (id !== undefined) {
    if (!old || id === "-1" || id === "") throw new AppError("CATALOG_OBJECT_NOT_FOUND", "对象不存在或不支持修改默认对象");
    if (!("expectedVersion" in command) || command.expectedVersion !== billFingerprint(old)) throw new AppError("CATALOG_VERSION_CONFLICT", "目录对象已变化，请重新读取版本");
    owned(old, account);
  }
  if ("name" in command && command.name !== undefined && before.some(row => row.name === command.name && idOf(row, kind) !== id)) throw new AppError("CATALOG_NAME_EXISTS", "同名对象已存在，请使用现有对象或明确其他名称");
  let expected: Record<string, unknown> = {};
  let removed = false;
  try {
    if (command.action === "createBook") {
      expected = { name: command.name };
      await client.submitBook(account, {name: command.name, cover: "--", type: -1, range: null});
    } else if (command.action === "updateBook") {
      if ((command.name !== undefined) === (command.visible !== undefined)) throw new AppError("INVALID_CATALOG_PATCH", "每次只修改账本名称或显示状态之一");
      expected = {name: command.name ?? old!.name, visible: command.visible === undefined ? old!.visible : Number(command.visible)};
      if (command.name !== undefined) await client.submitBook(account, {bookid: id, name: command.name, cover: old!.cover ?? "--", type: old!.type, range: old!.range ?? null});
      else if (Number(old!.visible) !== Number(command.visible)) await client.toggleBookVisibility(account, id!);
    } else if (command.action === "createAsset") {
      requireNonnegativeMoney(Math.abs(command.balance), "初始余额");
      if (command.kind === "credit" && (![command.statementDay, command.paymentDay].every(n => Number.isInteger(n) && n! >= 1 && n! <= 31))) throw new AppError("INVALID_CREDIT_DATES", "信用账户必须明确提供账单日和还款日，范围 1 至 31");
      const credit = command.kind === "credit";
      expected = {name: command.name, money: command.balance, type: credit ? 2 : 1, stype: credit ? 200 : 11, currency: "CNY", incount: Number(command.includeInTotal)};
      await client.submitAssetBalance(account, {id: -1, userid: account.uid, ...expected,
        icon: `http://res3.qianjiapp.com/assetv2/asset_icon_${credit ? "creditother" : "cash"}.png`, color: credit ? "3168C2" : "E45644",
        loan: null, credit: credit ? {limit: -1, statedate: command.statementDay, paydate: command.paymentDay, paydate2: String(command.paymentDay)} : null,
        createtime: 0, status: 0, extra: null, sort: 0, lastpaytime: null, remark: null,
      }, command.balance);
    } else if (command.action === "updateAsset") {
      if (![1, 2, 3, 4].includes(Number(old!.type))) throw new AppError("ASSET_TYPE_UNSUPPORTED", "借贷或其他特殊资产须使用专用工具");
      if (command.visible !== undefined && [command.name, command.remark, command.includeInTotal].some(v => v !== undefined)) throw new AppError("INVALID_CATALOG_PATCH", "显示状态与其他资产字段分开修改");
      const next = {...old!};
      if (command.name !== undefined) next.name = command.name;
      if (command.remark !== undefined) next.remark = command.remark;
      if (command.includeInTotal !== undefined) next.incount = Number(command.includeInTotal);
      expected = {name: next.name, money: next.money, type: next.type, stype: next.stype, credit: next.credit, loan: next.loan, incount: next.incount, remark: next.remark};
      if (command.visible !== undefined) {
        if (![0, 2].includes(Number(old!.status))) throw new AppError("ASSET_STATE_UNSUPPORTED", "只支持正常或隐藏资产的显示状态修改");
        expected.status = command.visible ? 0 : 2;
        if (old!.status !== expected.status) await client.toggleAssetVisibility(account, id!);
      } else await client.submitAssetBalance(account, next, Number(old!.money));
    } else if (command.action === "renameTagGroup") {
      expected = {name: command.name, tags: old!.tags};
      await client.renameTagGroup(account, id!, command.name);
    } else {
      await sync();
      const bills = await store.listBills(account.id, {limit: 1_000_000_000});
      if (bills.some(row => {
        const raw = cachedBillObject(row);
        return (kind === "book" ? [raw.bookid] : [raw.assetid, raw.fromid, raw.targetid]).some(value => String(value) === id);
      })) throw new AppError("CATALOG_OBJECT_NOT_EMPTY", "对象仍有关联账单，不能删除");
      const tasks = await client.listRepeatTasks(account);
      if (tasks.some(task => {
        const data = task.data as Record<string, unknown>;
        return (kind === "book" ? [data.bookid] : [data.fromid, data.targetid]).some(value => String(value) === id);
      })) throw new AppError("CATALOG_OBJECT_IN_USE", "对象仍被周期任务引用");
      // Deletion of assets also needs installment, loan and shared-credit checks;
      // keep it closed until those catalogs are integrated and verified.
      if (kind === "asset") throw new AppError("ASSET_DELETE_UNSUPPORTED", "资产删除需完整检查借贷、分期及共享额度关系，当前保留资产");
      await client.deleteEmptyBook(account, id!); removed = true;
    }
    const after = await read(client, account, kind);
    if (removed) {
      if (after.some(row => idOf(row, kind) === id)) throw new AppError("WRITE_CONFIRMATION_FAILED", "目录删除后仍查到原对象");
      return {deleted: true, id};
    }
    const candidates = id ? after.filter(row => idOf(row, kind) === id) : after.filter(row => !before.some(old => idOf(old, kind) === idOf(row, kind)));
    const found = candidates[0];
    if (candidates.length !== 1 || !found || Object.entries(expected).some(([key, value]) => billFingerprint(found[key] ?? null) !== billFingerprint(value ?? null))) {
      throw new AppError("WRITE_CONFIRMATION_FAILED", "目录写入回读不一致，请核实原请求，不重发");
    }
    return publicObject(found, kind, kind === "asset");
  } finally { await store.invalidateCatalogCache(account.id, kind === "book" ? "books" : kind === "asset" ? "assets" : "tags", ""); }
}
