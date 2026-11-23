import { AppError } from "./errors.ts";

export interface ExportPage { bills: Record<string, unknown>[]; nextCursor: string | null }
const columns = ["id", "bookId", "time", "type", "money", "fee", "discount", "categoryId", "assetId", "fromId", "targetId", "remark", "tagIds", "currencyConversion"];
function cell(value: unknown) {
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet applications otherwise execute formulas or round long IDs.
  if (typeof value === "string" && (/^[\s\x00-\x1f]*[=+@-]/.test(text) || /^\d{16,}$/.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** Returns bounded content to the authenticated caller, never writes arbitrary server paths. */
export async function exportBillPages(format: "csv" | "json", maxRows: number,
  page: (cursor: string | undefined, limit: number) => Promise<ExportPage>, initialCursor?: string) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new AppError("INVALID_EXPORT_LIMIT", "每次导出 1 至 10000 行");
  const rows: Record<string, unknown>[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor = initialCursor;
  const pageSize = Math.min(100, maxRows);
  while (rows.length + pageSize <= maxRows) {
    if (cursor && cursors.has(cursor)) throw new AppError("EXPORT_PAGINATION_INVALID", "分页游标循环，未生成不完整导出");
    if (cursor) cursors.add(cursor);
    const result = await page(cursor, pageSize);
    if (result.bills.length > Math.min(100, maxRows - rows.length) || (result.bills.length === 0 && result.nextCursor)) throw new AppError("EXPORT_PAGINATION_INVALID", "分页数据与请求范围不符");
    for (const row of result.bills) {
      const id = String(row.id);
      if (ids.has(id)) throw new AppError("EXPORT_PAGINATION_INVALID", "分页出现重复账单，请刷新后重新导出");
      ids.add(id); rows.push(row);
    }
    cursor = result.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return {format, rowCount: rows.length, complete: cursor === undefined, nextCursor: cursor ?? null,
    content: format === "json" ? JSON.stringify(rows) : '\uFEFF' + columns.map(cell).join(",") + "\r\n" + rows.map(row => columns.map(key => cell(row[key])).join(",")).join("\r\n"),
  };
}
