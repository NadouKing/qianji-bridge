import assert from "node:assert/strict";
import { exportBillPages } from "../src/bill-export.ts";
import test from "./context.ts";

test("exports follow every page, report truncation and preserve formula-like remarks and long IDs", async () => {
  const source = Array.from({length: 203}, (_, i) => ({id: String(1700000000000000000n + BigInt(i)), money: 0.28, remark: i === 0 ? '=HYPERLINK("example")' : "comma,new\nline"}));
  const page = async (cursor: string | undefined, limit: number) => {
    const offset = Number(cursor ?? 0), next = offset + limit;
    return {bills: source.slice(offset, next), nextCursor: next < source.length ? String(next) : null};
  };
  const json = await exportBillPages("json", 1000, page);
  assert.equal(json.complete, true); assert.equal(json.rowCount, 203); assert.deepEqual(JSON.parse(json.content), source);
  const truncated = await exportBillPages("csv", 150, page);
  assert.equal(truncated.complete, false); assert.equal(truncated.rowCount, 100); assert.equal(truncated.nextCursor, "100");
  assert.match(truncated.content, /"'1700000000000000000"/);
  assert.match(truncated.content, /"'=HYPERLINK\(""example""\)"/);
  const rest = await exportBillPages("json", 1000, page, truncated.nextCursor!);
  assert.equal(rest.rowCount, 103); assert.equal(rest.complete, true);
});

test("exports reject repeated IDs or looping cursors instead of claiming completeness", async () => {
  await assert.rejects(exportBillPages("json", 1000, async () => ({bills: [{id: "1"}], nextCursor: "same"})), /重复账单|游标循环/);
  await assert.rejects(exportBillPages("json", 1000, async () => ({bills: [], nextCursor: "same"})), /分页数据/);
});
