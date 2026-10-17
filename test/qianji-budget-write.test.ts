import assert from "node:assert/strict";
import { Store } from "../src/data-store.ts";
import { QianjiClient, parseQianjiJson } from "../src/qianji-client.ts";
import { MoneyTrackService, type SetBudgetInput } from "../src/qianji-service.ts";
import test from "./context.ts";

function fixture() {
  const store = new Store(":memory:");
  const pat = store.createPat("budget-test", null);
  const account = store.bindPat(pat.id, "user-a", "token-a", "device-a");
  const now = Date.UTC(2026, 9, 18);
  store.setUserCache(account.id, { id: account.uid, viptype: -1, __baseCurrency: "CNY" }, now);
  let rows: Record<string, unknown>[] = [
    { bookid: "1", flag: 1, cateid: "-1", money: 1000, budgetid: "9223372036854775806" },
    { bookid: "1", flag: 2, cateid: "3", money: 80 },
  ];
  const forms: URLSearchParams[] = [];
  let behavior: "normal" | "ignore" | "collateral" | "lost" | "read-failure" = "normal";
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("uid"), account.uid);
    const ok = (data: unknown) => Response.json({ ec: 200, data });
    if (path === "/book/list") return ok({ list: [{ bookid: 1, name: "test", config: { range: "m15" } }] });
    if (path === "/category/listv2") return ok({ list: [
      { id: 2, type: 0, parentid: -1, sublist: [{ id: 4, type: 0, parentid: 2 }] },
      { id: 3, type: 0, parentid: -1 }, { id: 5, type: 1, parentid: -1 },
    ] });
    if (path === "/budget/list") {
      if (behavior === "read-failure" && forms.length) throw new Error("read unavailable");
      return ok({ list: rows });
    }
    if (path === "/budget/submitv2") {
      forms.push(form);
      if (behavior === "lost") throw new Error("response lost");
      const entries = parseQianjiJson(form.get("changelist")!) as Record<string, unknown>[];
      assert.ok(entries.every((entry) => entry.flag !== 2 || Number(entry.money) > 0));
      if (behavior !== "ignore") {
        // Real submitv2 replaces the entire period, rather than applying a patch.
        rows = entries.filter((entry) => entry.money !== 0).map((entry) => ({
          ...entry, bookid: String(entry.bookid), cateid: String(entry.cateid),
        }));
      }
      if (behavior === "collateral") rows = rows.filter((x) => x.flag !== 1);
      return ok({ list: rows });
    }
    throw new Error(`unexpected ${path}`);
  } }), () => now);
  const input: SetBudgetInput = { bookId: "1", period: { kind: "month", year: 2026, month: 10 }, target: { kind: "category", categoryId: "2" }, amount: 20 };
  return { store, account, service, forms, input, rows: () => rows, behavior: (value: typeof behavior) => { behavior = value; } };
}

test("预算全量替换协议下单项修改仍保留总额与兄弟分类，支持子分类和清零", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  for (const [categoryId, amount] of [["2", 20], ["4", 5], ["2", 25], ["2", 0]] as const) {
    const input = { ...f.input, target: { kind: "category" as const, categoryId }, amount };
    assert.deepEqual(await f.service.setBudget(f.account.id, input), input);
    const form = f.forms.at(-1)!;
    assert.equal(form.get("flts"), '{"month":"2026,10"}');
    assert.equal(form.get("range"), "m15");
    assert.ok(JSON.parse(form.get("changelist")!).length >= 3);
    assert.equal(f.rows().find((x) => x.flag === 1)?.money, 1000);
    assert.equal(f.rows().find((x) => x.cateid === "3")?.money, 80);
  }
});

test("总预算保留大整数预算 ID，年度筛选和默认账本 ID 按协议序列化", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  await f.service.setBudget(f.account.id, { ...f.input, period: { kind: "year", year: 2027 }, target: { kind: "total" }, amount: 900 });
  assert.equal(f.forms[0]!.get("flts"), '{"year":"2027"}');
  assert.match(f.forms[0]!.get("changelist")!, /"budgetid":9223372036854775806/);
  assert.equal(f.rows().find((x) => x.cateid === "3")?.money, 80);
  const forms: URLSearchParams[] = [];
  const client = new QianjiClient({ fetch: async (_input, init) => {
    forms.push(new URLSearchParams(String(init?.body))); return Response.json({ ec: 200, data: {} });
  } });
  await client.submitBudget(f.account, "-1", { kind: "month", year: 2026, month: 1 }, [{ categoryId: "9223372036854775807", amount: 1 }]);
  assert.match(forms[0]!.get("changelist")!, /"bookid":-1/);
  assert.match(forms[0]!.get("changelist")!, /"cateid":9223372036854775807/);
  assert.equal(forms[0]!.has("range"), false);
});

test("未知账本、其他账号分类、收入分类及无效金额/期间在写入前拒绝", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  // Stale local entries must not allow writes to resources absent from fresh account data.
  f.store.setCatalogCache(f.account.id, "books", "", [{ bookid: "999" }], Date.UTC(2026, 9, 18));
  f.store.setCatalogCache(f.account.id, "categories", "1", [{ id: "999", type: 0 }], Date.UTC(2026, 9, 18));
  const invalid = [
    { ...f.input, bookId: "999" },
    ...["999", "5"].map((categoryId) => ({ ...f.input, target: { kind: "category" as const, categoryId } })),
    ...[-1, NaN, Infinity, 0.001].map((amount) => ({ ...f.input, amount })),
    { ...f.input, period: { kind: "month" as const, year: 2026, month: 13 } },
  ];
  for (const input of invalid) await assert.rejects(() => f.service.setBudget(f.account.id, input));
  assert.equal(f.forms.length, 0);
});

test("预算静默未生效、其他额度变化或确认失败均不报告成功且不自动重试", async (t) => {
  for (const mode of ["ignore", "collateral", "read-failure", "lost"] as const) {
    const f = fixture(); t.after(() => f.store.close()); f.behavior(mode);
    await assert.rejects(() => f.service.setBudget(f.account.id, f.input), (error: unknown) => {
      const e = error as { code: string; message: string };
      assert.equal(e.code, mode === "lost" ? "QIANJI_HTTP_ERROR" : "WRITE_CONFIRMATION_FAILED");
      assert.match(e.message, /未确认|确认失败/); return true;
    });
    assert.equal(f.forms.length, 1);
  }
});
