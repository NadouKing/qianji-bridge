import assert from "node:assert/strict";
import { Store } from "../src/data-store.ts";
import { AppError } from "../src/errors.ts";
import { QianjiClient } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import test from "./context.ts";

const now = Date.UTC(2026, 9, 17);
function fixture() {
  const store = new Store(":memory:");
  const pat = store.createPat("offline", null);
  const account = store.bindPat(pat.id, "fixture-user", "fixture-token", "fixture-device");
  store.setUserCache(account.id, { id: account.uid, viptype: -1, vipstart: 0, vipend: 0, __baseCurrency: "CNY" }, now);
  return { store, account };
}

test("删除分类后同步被删除的账单并使余额快照失效", async t => {
  const { store, account } = fixture();
  t.after(() => store.close());
  store.upsertBill(account.id, { id: "177", bookid: "-1", time: 1770000000, type: 0, money: 10, cateid: "1", assetid: "2", remark: "fixture" });
  store.setCatalogCache(account.id, "assets", "", [{ id: "2", money: 10 }], now);
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/category/deletev2") return Response.json({ ec: 200, data: {} });
    assert.equal(path, "/syncv2/pull");
    return Response.json({ ec: 200, data: { changes: [], deletes: ["177"], bookid: "-1", pageoffset: 0, pagesign: "", hasmore: 0, lasttimes: {} } });
  }}), () => now);
  await service.deleteCategories(account.id, [{ categoryId: "1", deleteBills: true }]);
  assert.equal(store.getBill(account.id, "177"), undefined);
  assert.equal(store.getCatalogCache(account.id, "assets", ""), undefined);
});

test("默认分类无账本缓存时，创建后的查询立即取得新分类并保持账号隔离", async t => {
  const { store, account } = fixture();
  t.after(() => store.close());
  const other = store.bindPat(store.createPat("other", null).id, "other-user", "other-token", "other-device");
  const old = [{ id: "5", name: "Old", type: 0, parentid: "-1" }];
  for (const scope of ["-1", "999"]) store.setCatalogCache(account.id, "categories", scope, old, now);
  store.setCatalogCache(other.id, "categories", "-1", old, now);
  store.setCatalogCache(account.id, "tags", "", [{ id: "tag", name: "Keep" }], now);
  const paths: string[] = [];
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async input => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const category = { id: 177, name: "New", type: 0, parentid: -1 };
    if (path === "/category/submitv2") return Response.json({ ec: 200, data: category });
    if (path === "/category/listv2") return Response.json({ ec: 200, data: { list: [category] } });
    throw new Error(`Unexpected fixture path: ${path}`);
  }}), () => now);
  await service.createCategories(account.id, [{ name: "New", type: 0 }]);
  assert.equal(store.getCatalogCache(account.id, "categories", "-1"), undefined);
  assert.equal(store.getCatalogCache(account.id, "categories", "999"), undefined);
  assert.deepEqual(store.getCatalogCache(other.id, "categories", "-1")?.data, old);
  assert.ok(store.getCatalogCache(account.id, "tags", ""));
  assert.deepEqual((await service.listCategories(account.id, "-1", -1)).map(c => c.name), ["New"]);
  assert.equal(paths.length, 2);
});

const batchCases: Array<[string, "categories" | "tags", (service: MoneyTrackService, id: number) => Promise<unknown>]> = [
  ["create categories", "categories", (s, id) => s.createCategories(id, ["A", "B", "C"].map(name => ({ name, type: 0 })))],
  ["rename categories", "categories", (s, id) => s.updateCategories(id, ["1", "2", "3"].map(categoryId => ({ categoryId, name: "New" })))],
  ["delete categories", "categories", (s, id) => s.deleteCategories(id, ["1", "2", "3"].map(categoryId => ({ categoryId })))],
  ["create tag groups", "tags", (s, id) => s.createTagGroups(id, ["A", "B", "C"].map(name => ({ name })))],
  ["delete tag groups", "tags", (s, id) => s.deleteTagGroups(id, ["a", "b", "c"])],
  ["create tags", "tags", (s, id) => s.createTags(id, ["A", "B", "C"].map(name => ({ name })))],
  ["update tags", "tags", (s, id) => s.updateTags(id, ["a", "b", "c"].map(tagId => ({ tagId, name: "New" })))],
  ["delete tags", "tags", (s, id) => s.deleteTags(id, ["a", "b", "c"])],
  ["archive tags", "tags", (s, id) => s.archiveTags(id, ["a", "b", "c"])],
];
for (const [name, kind, run] of batchCases) {
  test(`目录部分成功后清缓存、准确报告序号并停止后续写入：${name}`, async t => {
    const { store, account } = fixture();
    t.after(() => store.close());
    store.setCatalogCache(account.id, kind, kind === "categories" ? "-1" : "", [{ id: "5", name: "Old" }], now);
    let calls = 0;
    const service = new MoneyTrackService(store, new QianjiClient({ fetch: async input => {
      if (new URL(String(input)).pathname === "/syncv2/pull") return Response.json({ ec: 200, data: { changes: [], deletes: [], bookid: "-1", pageoffset: 0, pagesign: "", hasmore: 0, lasttimes: {} } });
      if (new URL(String(input)).pathname === "/tag/list") return Response.json({ ec: 200, data: { list: [{ id: "", name: "", tags: ["a", "b", "c"].map(id => ({ id, name: id })) }] } });
      if (new URL(String(input)).pathname === "/book/list") return Response.json({ ec: 200, data: { list: [] } });
      if (new URL(String(input)).pathname === "/category/listv2") return Response.json({ ec: 200, data: { list: ["1", "2", "3"].map(id => ({ id, name: id, type: 0, parentid: "-1" })) } });
      calls++;
      if (calls === 2) throw new Error("fixture secret must not leak");
      return Response.json({ ec: 200, data: {} });
    }}), () => now);
    await assert.rejects(() => run(service, account.id), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "WRITE_PARTIAL");
      assert.match(error.message, /"completed":\[1\],"unconfirmed":\[2\],"notAttempted":\[3\]/);
      assert.ok(!error.message.includes("fixture secret"));
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(store.getCatalogCache(account.id, kind, kind === "categories" ? "-1" : ""), undefined);
  });
}

test("分类输入全量预检，后续项非法时不发送第一项", async t => {
  const { store, account } = fixture();
  t.after(() => store.close());
  let calls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async () => {
    calls++;
    return Response.json({ ec: 200, data: {} });
  }}), () => now);
  await assert.rejects(() => service.createCategories(account.id, [{ name: "A", type: 0 }, { name: " ", type: 0 }]));
  await assert.rejects(() => service.updateCategories(account.id, [{ categoryId: "1", name: "A" }, { categoryId: "2", name: " " }]));
  await assert.rejects(() => service.deleteCategories(account.id, [{ categoryId: "1" }, { categoryId: "2", transferTo: "2" }]));
  await assert.rejects(() => service.deleteCategories(account.id, [{ categoryId: "1", transferTo: "2" }, { categoryId: "2" }]));
  await assert.rejects(() => service.deleteCategories(account.id, [{ categoryId: "1", transferTo: "2", deleteBills: true }]));
  assert.equal(calls, 0);
});

test("远端全部成功但缓存失败时仍报告成功序号，避免重试创建", async t => {
  const { store, account } = fixture();
  t.after(() => store.close());
  store.invalidateCatalogCache = () => { throw new Error("private db path"); };
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async () => Response.json({ ec: 200, data: {} }) }), () => now);
  await assert.rejects(() => service.createTags(account.id, [{ name: "New" }]), error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "WRITE_CONFIRMATION_FAILED");
    assert.match(error.message, /"completed":\[1\],"unconfirmed":\[\],"notAttempted":\[\]/);
    assert.match(error.message, /refresh_cache/);
    assert.ok(!error.message.includes("private db path"));
    return true;
  });
});
