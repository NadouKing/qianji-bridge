import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { OperationJournal } from "../src/operation-journal.ts";
import { AppError } from "../src/errors.ts";
import test from "./context.ts";
import { noteRemoteWrite } from "../src/write-context.ts";

const result: CallToolResult = { content: [{ type: "text", text: '{"id":"fixture"}' }], structuredContent: { id: "fixture" } };
const noop = async () => {};

test("durable operation replay survives reopen, isolates UIDs and rejects changed content", async t => {
  const root = mkdtempSync(join(tmpdir(), "qianji-journal-")); t.after(() => rmSync(root, { recursive: true }));
  let writes = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const journal = new OperationJournal(root);
    assert.deepEqual(await journal.execute("uid-a", "stable", "create_bills", { value: 1 }, noop, async () => { writes++; return result; }), result);
    assert.equal((await journal.status("uid-a", "stable")).state, "confirmed");
  }
  assert.equal(writes, 1);
  const journal = new OperationJournal(root);
  await assert.rejects(journal.execute("uid-a", "stable", "create_bills", { value: 2 }, noop, async () => result), /不同内容/);
  assert.equal((await journal.status("uid-b", "stable")).state, "notFound");
  await journal.execute("uid-b", "stable", "create_bills", { value: 1 }, noop, async () => { writes++; return result; });
  assert.equal(writes, 2);
});

test("uncertain and partial results stop all new writes, and status never retries", async t => {
  const root = mkdtempSync(join(tmpdir(), "qianji-journal-")); t.after(() => rmSync(root, { recursive: true }));
  const journal = new OperationJournal(root);
  let writes = 0;
  await journal.execute("uid", "partial", "create_bills", {}, noop, async () => {
    noteRemoteWrite();
    writes++;
    return { isError: true, content: [{ type: "text", text: "WRITE_PARTIAL" }] };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await new OperationJournal(root).status("uid", "partial")).state, "uncertain");
    await assert.rejects(journal.execute("uid", "partial", "create_bills", {}, noop, async () => { writes++; return result; }), /待核实/);
    await assert.rejects(journal.execute("uid", "new", "create_bills", {}, noop, async () => { writes++; return result; }), /待核实/);
  }
  assert.equal(writes, 1);
});

test("preflight failure is not executed, while competing journal instances cannot enter a pending write", async t => {
  const root = mkdtempSync(join(tmpdir(), "qianji-journal-")); t.after(() => rmSync(root, { recursive: true }));
  const journal = new OperationJournal(root);
  let writes = 0;
  await journal.execute("uid", "stale", "update_bills", {}, async () => { throw new AppError("BILL_VERSION_CONFLICT", "changed"); }, async () => { writes++; return result; });
  assert.equal((await journal.status("uid", "stale")).state, "notExecuted");
  assert.equal(writes, 0);
  let release!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = journal.execute("uid", "first", "create_bills", {}, noop, async () => {
    writes++; entered(); await wait; return result;
  });
  await entry;
  await assert.rejects(new OperationJournal(root).execute("uid", "second", "create_bills", {}, noop, async () => { writes++; return result; }), /待核实/);
  release(); await first;
  assert.equal(writes, 1);
});

test("process termination after remote entry leaves durable pending evidence, never auto-expires", async t => {
  const root = mkdtempSync(join(tmpdir(), "qianji-journal-")); t.after(() => rmSync(root, { recursive: true }));
  const moduleUrl = new URL("../src/operation-journal.ts", import.meta.url).href;
  const script = `import { OperationJournal } from ${JSON.stringify(moduleUrl)};
    await new OperationJournal(process.argv[1]).execute('uid', 'crash', 'create_bills', {}, async () => {}, async () => { process.exit(42); });`;
  const child = spawnSync(process.execPath, ["-e", script, root], { encoding: "utf8" });
  assert.equal(child.status, 42, child.stderr);
  const journal = new OperationJournal(root);
  assert.equal((await journal.status("uid", "crash")).state, "pending");
  await assert.rejects(journal.execute("uid", "crash", "create_bills", {}, noop, async () => result), /待核实/);
});
