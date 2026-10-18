import assert from "node:assert/strict";
import { Store } from "../src/data-store.ts";
import { QianjiClient } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import test from "./context.ts";

test("batch details isolate accounts, preserve image URLs, report unknown cache age and refresh once", async t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const pat = store.createPat("fixture", null), otherPat = store.createPat("other", null);
  const account = store.bindPat(pat.id, "fixture-uid", "fixture-token", "fixture-device");
  const other = store.bindPat(otherPat.id, "other-uid", "other-token", "other-device");
  store.setUserCache(account.id, { id: account.uid, viptype: -1, __baseCurrency: "CNY" });
  store.setSyncState(account.id, { cursor: 1 });
  const raw = { id: "1700000000000000001", bookid: 1, time: 1700000000,
    type: 0, money: 3, remark: "before", cateid: 2, assetid: 11,
    createtime: 1700000000, updatetime: 1700000000, images: ["fixture-image"] };
  store.upsertBill(account.id, raw);
  store.upsertBill(other.id, { ...raw, id: "1700000000000000002", remark: "other secret" });
  let calls = 0;
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async input => {
    calls++; assert.equal(new URL(String(input)).pathname, "/syncv2/pull");
    return Response.json({ ec: 200, data: {
      changes: [{ ...raw, remark: "after", images: ["replacement-image"] }], deletes: [], categories: [],
      bookid: -1, pageoffset: 0, hasmore: 0, pagesign: "", lasttimes: { cursor: 2 },
    } });
  } }), () => 1700000200000);
  const ids = [raw.id, "1700000000000000002", raw.id];
  const cached = await service.getBills(account.id, ids);
  assert.equal(cached.results.length, 2);
  assert.equal(cached.cache.lastSyncedAt, null);
  assert.equal(cached.cache.refreshed, false);
  assert.equal(cached.results[1]!.bill, null);
  assert.deepEqual(cached.results[0]!.bill!.imageUrls, ["https://billimg.qianjiapp.com/fixture-image!webporigin"]);
  const refreshed = await service.getBills(account.id, ids, true);
  assert.equal(calls, 1);
  assert.equal(refreshed.cache.lastSyncedAt, 1700000200);
  assert.equal(refreshed.cache.refreshed, true);
  assert.equal(refreshed.results[0]!.bill!.remark, "after");
  assert.deepEqual(refreshed.results[0]!.bill!.imageUrls, ["https://billimg.qianjiapp.com/replacement-image!webporigin"]);
  await service.getBills(account.id, ids);
  assert.equal(calls, 1);
  await assert.rejects(service.getBills(account.id, []), /1 至 100/);
});

test("batch refresh propagates synchronization failure instead of returning stale data as fresh", async t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const pat = store.createPat("fixture", null), account = store.bindPat(pat.id, "fixture", "token", "device");
  store.setSyncState(account.id, { cursor: 1 });
  const service = new MoneyTrackService(store, new QianjiClient({ fetch: async () => { throw new Error("offline"); } }));
  await assert.rejects(service.getBills(account.id, ["101"], true), /同步分页失败/);
});
