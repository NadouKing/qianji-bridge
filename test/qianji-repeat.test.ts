import assert from "node:assert/strict";
import { Store } from "../src/data-store.ts";
import { QianjiClient, parseQianjiJson } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import test from "./context.ts";

test("周期任务读取完整目录，创建含费用的转账模板，暂停后回读且不创建历史账单", async () => {
  const now = Date.parse("2026-01-04T12:00:00+08:00");
  const store = new Store(":memory:");
  const pat = store.createPat("周期任务测试", null);
  const account = store.bindPat(pat.id, "user", "token", "device");
  store.setUserCache(account.id, { id: account.uid, viptype: -1, __baseCurrency: "CNY" }, now);
  store.setCatalogCache(account.id, "books", "", [{ bookid: "-1", name: "账本", visible: 1, type: -1 }], now);
  store.setCatalogCache(account.id, "assets", "", [
    { id: "101", name: "资金", type: 1, currency: "CNY" },
    { id: "102", name: "投资", type: 4, currency: "CNY" },
  ], now);
  store.setCatalogCache(account.id, "tags", "", [{ id: "tag" }], now);
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  let task: Record<string, unknown> | undefined;
  const tasks: Record<string, unknown>[] = [];
  const client = new QianjiClient({ fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    const form = new URLSearchParams(String(init?.body));
    requests.push({ path, form });
    let data: unknown;
    if (path === "/repeat_task/list") data = { list: tasks };
    else if (path === "/repeat_task/submit") {
      task = { ...(parseQianjiJson(form.get("v")!) as Record<string, unknown>), id: tasks.length === 0 ? "18000000000000001" : "18000000000000002", status: 1 };
      const dataFields = task.data as Record<string, unknown>;
      delete dataFields.cateid; // 真实接口的转账任务不返回此字段。
      dataFields.time = "9:0"; // 手机客户端使用未补零的时刻。
      tasks.push(task);
      data = { task };
    } else if (path === "/repeat_task/toggle") {
      assert.equal(form.get("did"), "18000000000000001");
      tasks[0]!.status = 0;
      data = {};
    } else throw Error(`Unexpected route ${path}`);
    return Response.json({ ec: 200, data });
  } });
  const service = new MoneyTrackService(store, client, () => now);
  try {
    assert.deepEqual(await service.listRepeatTasks(account.id), []);
    const input = { fromAssetId: "101", targetAssetId: "102", money: 25, fee: 0.03,
      remark: "基金", startDate: "2026-01-05", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] };
    const result = await service.createRepeatTransfer(account.id, input);
    assert.equal(result.money, 25);
    assert.equal(result.fee, 0.03);
    assert.equal(result.id, "18000000000000001");
    const submit = requests.find((r) => r.path === "/repeat_task/submit")!.form.get("v")!;
    assert.match(submit, /"fromid":101/);
    assert.match(submit, /"money":24\.97/);
    assert.equal((await service.listRepeatTasks(account.id)).length, 1);
    assert.ok(requests.filter((r) => r.path === "/repeat_task/list").every((r) => r.form.get("page") === "0"));
    const paused = await service.setRepeatTaskEnabled(account.id, "18000000000000001", false);
    assert.equal(paused.status, 0);
    assert.equal(paused.money, 25);
    await service.setRepeatTaskEnabled(account.id, "18000000000000001", false);
    assert.equal(requests.filter((r) => r.path === "/repeat_task/toggle").length, 1);
    const workday = await service.createRepeatTransfer(account.id, {
      ...input, remark: "工作日基金", repeatType: "workday", weekdays: [],
    });
    assert.deepEqual(workday.repeat, { type: "workday", value: [] });
    assert.equal(workday.timeOfDay, "09:00");
    assert.equal(workday.categoryId, null);
    assert.equal((await service.listRepeatTasks(account.id)).length, 2);
    assert.ok(requests.every((r) => r.path.startsWith("/repeat_task/")));
  } finally {
    store.close();
  }
});
