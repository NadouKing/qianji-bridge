import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWriteScope, main } from "../src/reconcile-cli.ts";
import {
  billFingerprint, executeJournal, OperationFailure, planSchema, privatePath, proposeMatches, rulesSchema,
  type SourceRecord, type LedgerBill,
} from "../src/reconciliation.ts";
import test from "./context.ts";

const source = (id: string, amountMinor: number, patch: Partial<SourceRecord> = {}): SourceRecord => ({
  id, source: "alipay", sourceRow: 1, orderId: id, time: 1700000000,
  merchant: "Fixture收款公司", item: "Fixture商品", direction: "支出", amountMinor, currency: "CNY",
  paymentMethod: "Fixture银行卡", status: "交易成功", kind: "其他", note: "", ...patch,
});
const ledger = (id: string, money: number, patch: Partial<LedgerBill> = {}): LedgerBill => ({
  id, bookId: "1", time: 1700000000, type: 0, money, discount: 0, assetId: "11", remark: "Fixture商店", ...patch,
});
const rules = rulesSchema.parse({ accounts: [{ contains: "Fixture银行卡", assetId: "11" }],
  aliases: [{ source: "Fixture收款公司", target: "Fixture商店" }] });
const plan = planSchema.parse({ version: 1, batchId: "fixture-batch", accountUid: "fixture-uid", bookIds: ["1"],
  operations: [{ id: "one", tool: "create_bills", arguments: { bills: [{ bookId: "1", money: 3 }] } },
    { id: "two", tool: "create_transfer", arguments: { bookId: "1", money: 4 } }] });
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "bridge-reconcile-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("matching keeps same-amount name conflicts as candidates and never assigns writes", () => {
  const report = proposeMatches([source("a", 300)], [ledger("101", 3, { remark: "不同用途" })], rules);
  assert.equal(report.rows[0]!.status, "candidate");
  assert.deepEqual(report.rows[0]!.candidates[0]!.evidence, ["account", "amount", "date-window"]);
  assert.equal("operations" in report, false);
  assert.throws(() => proposeMatches([source("a", 1), source("a", 2)], [], rules), /Duplicate/);
});

test("matching uses net debit, exposes combined candidates and rejects ambiguous accounts and currencies", () => {
  const records = [source("a", 300), source("b", 400, { source: "wechat", time: 1700000100 })];
  const report = proposeMatches(records, [ledger("101", 3.5, { discount: 0.5 }), ledger("102", 7)], rules);
  assert.equal(report.rows[0]!.candidates[0]!.billId, "101");
  assert.deepEqual(report.aggregates[0]!.sourceIds, ["a", "b"]);
  const ambiguous = rulesSchema.parse({ ...rules, accounts: [...rules.accounts, { contains: "银行卡", assetId: "12" }] });
  assert.equal(proposeMatches(records, [ledger("102", 7)], ambiguous).rows[0]!.assetId, null);
  assert.equal(proposeMatches([source("a", 300)], [ledger("101", 3, { currencyConversion: {} })], rules).rows[0]!.candidates.length, 0);
  assert.equal(proposeMatches([source("a", 300, { status: "交易关闭" })], [], rules).rows[0]!.status, "excluded");
  assert.equal(proposeMatches([source("a", 300, { kind: "退款", direction: "不计收支", status: "退款成功" })], [], rules).rows[0]!.status, "needs_review");
});

test("private outputs reject nested paths inside a Git checkout", async t => {
  const dir = await directory(t);
  await mkdir(join(dir, ".git"));
  await assert.rejects(privatePath(join(dir, "new", "report.json")), /outside every Git/);
});

test("journal resumes confirmed operations but stops on partial or uncertain results without replay", async t => {
  const dir = await directory(t), path = join(dir, "journal.json");
  let calls = 0;
  await assert.rejects(executeJournal(plan, path, async () => {
    if (++calls === 2) throw new OperationFailure({ code: "WRITE_PARTIAL", completed: [1], unconfirmed: [2] });
    return { bills: [{ id: "101" }] };
  }), /uncertain/);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.operations.map((x: { status: string }) => x.status), ["confirmed", "uncertain"]);
  assert.deepEqual(saved.operations[1].failure.completed, [1]);
  await assert.rejects(executeJournal(plan, path, async () => { calls++; return {}; }), /uncertain/);
  assert.equal(calls, 2);
});

test("journal rejects changed plans and overlapping runners; successful reruns perform zero calls", async t => {
  const dir = await directory(t), path = join(dir, "journal.json");
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const first = executeJournal(plan, path, async () => { calls++; entered(); await blocked; return {}; });
  await started;
  await assert.rejects(executeJournal(plan, path, async () => ({})), /EEXIST/);
  release(); await first;
  await executeJournal(plan, path, async () => { calls++; return {}; });
  assert.equal(calls, 2);
  await assert.rejects(executeJournal({ ...plan, batchId: "changed" }, path, async () => ({})), /does not match/);
});

test("apply defaults to validation without connecting or writing; preflight rejects wrong account/book", async t => {
  const dir = await directory(t), path = join(dir, "plan.json");
  await writeFile(path, JSON.stringify(plan));
  await main(["apply", "--plan", path]);
  await assert.rejects(checkWriteScope(plan, async () => ({ user: { id: "other" } })), /another account/);
  const other = { ...plan, operations: [{ ...plan.operations[0]!, arguments: { bills: [{ bookId: "2", money: 3 }] } }] };
  await assert.rejects(checkWriteScope(other, async () => ({ user: { id: "fixture-uid" } })), /another book/);
  const missingBook = { ...plan, operations: [{ ...plan.operations[0]!, arguments: { bills: [{ money: 3 }] } }] };
  await assert.rejects(checkWriteScope(missingBook, async () => ({ user: { id: "fixture-uid" } })), /explicit allowed/);
});

test("write preflight rejects source changes after review and accepts unchanged fingerprints", async () => {
  const before = ledger("101", 3);
  const update = planSchema.parse({ ...plan,
    expectedBills: [{ billId: "101", hash: billFingerprint(before) }],
    operations: [{ id: "edit", tool: "update_bills", arguments: { updates: [{ billId: "101", patch: { remark: "reviewed" } }] } }],
  });
  const call = async (name: string) => name === "get_user_info" ? { user: { id: plan.accountUid } } :
    name === "get_bills" ? { results: [{ billId: "101", bill: before }] } : {};
  await checkWriteScope(update, call);
  await assert.rejects(checkWriteScope(update, async name => name === "get_bills" ?
    { results: [{ billId: "101", bill: { ...before, remark: "changed elsewhere" } }] } : call(name)), /changed/);
  await assert.rejects(checkWriteScope({ ...update, expectedBills: [] }, call), /fingerprint/);
});

test("CLI match follows snapshot range and writes private candidates without changing sources", async t => {
  const dir = await directory(t);
  const imports = { version: 1, source: "alipay", records: [source("within", 300), source("outside", 400, { time: 1600000000 })] };
  await writeFile(join(dir, "import.json"), JSON.stringify(imports));
  await writeFile(join(dir, "rules.json"), JSON.stringify(rules));
  await writeFile(join(dir, "snapshot.json"), JSON.stringify({
    version: 1, accountUid: "fixture-uid", bookId: "1", fetchedAt: "2024-01-01T00:00:00Z",
    range: { startTime: 1700000000, endTime: 1700000200 }, bills: [ledger("101", 3)],
  }));
  await main(["match", "--input", join(dir, "import.json"), "--snapshot", join(dir, "snapshot.json"),
    "--rules", join(dir, "rules.json"), "--output", join(dir, "report.json")]);
  const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  assert.equal(report.rows.length, 1);
  assert.equal(report.outsideScope, 1);
  assert.equal(report.rows[0].status, "candidate");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "import.json"), "utf8")), imports);
});
