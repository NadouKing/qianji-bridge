import assert from "node:assert/strict";
import { Store } from "../src/data-store.ts";
import { QianjiClient, parseQianjiJson } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import test from "./context.ts";
import { repeatSchedule } from "../src/repeat-tasks.ts";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal } from "../src/operation-journal.ts";
import { noteRemoteWrite } from "../src/write-context.ts";

test("six repeat schedules validate boundaries and reject invalid calendar dates", () => {
  assert.deepEqual(repeatSchedule({type: "month", values: [31, 1]}), {type: "month", value: [1, 31]});
  assert.deepEqual(repeatSchedule({type: "year", values: ["02-29"]}), {type: "year", value: ["02-29"]});
  for (const type of ["day", "workday"] as const) assert.deepEqual(repeatSchedule({type}), {type, value: []});
  assert.deepEqual(repeatSchedule({type: "bystep", values: [3]}), {type: "bystep", value: [3]});
  for (const schedule of [{type: "week", values: [0]}, {type: "month", values: [32]}, {type: "year", values: ["02-30"]}, {type: "workday", values: [1]}, {type: "week", values: [1, 1]}] as const) {
    assert.throws(() => repeatSchedule({type: schedule.type, values: [...schedule.values]}), /周期参数/);
  }
});

test("future creation review requires unique unexecuted settings and never redispatches the original",async t=>{
  const root=mkdtempSync(join(tmpdir(),"repeat-review-"));t.after(()=>rmSync(root,{recursive:true}));
  const store=new Store(":memory:");t.after(()=>store.close());
  const pat=store.createPat("test",null),account=store.bindPat(pat.id,"uid","test","test"),now=Date.now();
  store.applySyncBatch(account.id,{changes:[],deletes:[],invalidatedCategoryScopes:[],lasttimes:[]});
  const startDate=new Date(now+7*86400000).toISOString().slice(0,10);
  const args={type:2,bookId:"1",fromAssetId:"101",targetAssetId:"102",money:0.03,fee:0.01,remark:"fixture",startDate,timeOfDay:"09:00",schedule:{type:"week",values:[1,3]}};
  const task={id:"999",userid:"uid",type:2,status:1,count:0,createtime:Math.floor(now/1000),packid:1700000000,data:{bookid:"1",fromid:"101",targetid:"102",money:0.02,fee:0.01,remark:"fixture",start:startDate,time:"9:0",repeat:{type:"week",value:[1,3]},end:null}};
  let tasks=[task];
  const client=new QianjiClient({fetch:async(url)=>{
    if(new URL(String(url)).pathname==="/repeat_task/list") return Response.json({ec:200,data:{list:tasks}});
    return Response.json({ec:200,data:{changes:[],deletes:[],categories:[],bookid:-1,pageoffset:0,hasmore:0,pagesign:"",lasttimes:[]}});
  }});
  const service=new MoneyTrackService(store,client,()=>now,{operationsRoot:root}),journal=new OperationJournal(root),payload={args,expected:[]};
  const rejected={isError:true,content:[{type:"text" as const,text:JSON.stringify({error:{code:"WRITE_CONFIRMATION_FAILED"}})}]};
  await journal.execute("uid","create","create_repeat_task",payload,async()=>{},async()=>{noteRemoteWrite();return rejected;});
  task.count=1;await assert.rejects(service.verifyFutureRepeatCreation(account.id,"create",args,[],"999"),/未唯一匹配/);
  task.count=0;tasks=[task,{...task,id:"998"}];await assert.rejects(service.verifyFutureRepeatCreation(account.id,"create",args,[],"999"),/未唯一匹配/);
  tasks=[task];const verified=await service.verifyFutureRepeatCreation(account.id,"create",args,[],"999");
  assert.equal(verified.operation.state,"reviewed");
  assert.deepEqual(await journal.execute("uid","create","create_repeat_task",payload,async()=>{},async()=>{throw new Error("must not redispatch");}),rejected);
});

test("repeat create and edit preserve task identity, reject stale versions and verify historical bills and balances", async t => {
  const now = Date.parse("2026-01-01T12:00:00+08:00");
  const store = new Store(":memory:"); t.after(() => store.close());
  const pat = store.createPat("fixture", null), account = store.bindPat(pat.id, "uid", "token", "device");
  const assets = [{id: "101", userid: "uid", type: 1, money: 100, currency: "CNY"}, {id: "102", userid: "uid", type: 4, money: 0, currency: "CNY"}];
  store.setUserCache(account.id, {id: "uid", viptype: -1, __baseCurrency: "CNY"}, now);
  store.setCatalogCache(account.id, "books", "", [{bookid: "1", name: "fixture", visible: 1}], now);
  store.setCatalogCache(account.id, "assets", "", assets, now);
  store.setCatalogCache(account.id, "categories", "1", [{id: "2", type: 0, bookid: "1", name: "fixture"}], now);
  store.setCatalogCache(account.id, "tags", "", [], now);
  const tasks: Record<string, unknown>[] = [];
  const history = {id: "170000000000000001", bookid: "1", userid: "uid", type: 0, time: 1700000000, createtime: 1700000000, updatetime: 1700000000, money: 1, cateid: "2", assetid: "101", remark: "history", images: ["old"]};
  let writes = 0;
  const client = new QianjiClient({fetch: async (url, init) => {
    const path = new URL(String(url)).pathname, form = new URLSearchParams(String(init?.body));
    let data: unknown;
    if (path === "/repeat_task/list") data = {list: tasks};
    else if (path === "/tag/list") data = {list: []};
    else if (path === "/asset/list") data = {list: assets};
    else if (path === "/syncv2/pull") data = {changes: [history], deletes: [], categories: [], bookid: -1, pageoffset: 0, hasmore: 0, pagesign: "", lasttimes: {cursor: writes}};
    else if (path === "/repeat_task/submit") {
      writes++;
      const row = parseQianjiJson(form.get("v")!) as Record<string, unknown>;
      if ((row.data as Record<string, unknown>).time === "21:00") history.remark = "unexpected historical modification";
      const id = row.id === undefined ? String(18000000 + tasks.length) : String(row.id);
      const old = tasks.find(task => String(task.id) === id);
      const next = {...row, userid:"uid", data:{...row.data as Record<string,unknown>,end:null}, id, status: old?.status ?? 1, count: old?.count ?? 0, packid: old?.packid ?? 1700000001};
      if (old) Object.assign(old, next); else tasks.push(next);
      data = {task: next};
    } else throw new Error(path);
    return Response.json({ec: 200, data});
  }});
  const service = new MoneyTrackService(store, client, () => now);
  const created = await service.createRepeatTask(account.id, {type: 2, bookId: "1", fromAssetId: "101", targetAssetId: "102", money: 10, fee: 0.03, remark: "fixture", startDate: "2026-01-02", timeOfDay: "09:00", schedule: {type: "week", values: [1,2,3,4,5]}});
  assert.equal(created.money, 10); assert.equal(created.fee, 0.03);
  let version = created.version;
  for (const timeOfDay of ["23:59", "09:00", "22:00"]) {
    const changed = await service.updateRepeatTask(account.id, String(created.id), version, {timeOfDay, money: 20, fee: 0.04});
    assert.equal(changed.id, created.id); assert.equal(changed.money, 20); assert.equal(changed.fee, 0.04);
    assert.equal(changed.timeOfDay, timeOfDay); assert.deepEqual(changed.generatedBillIds, []);
    version = changed.version;
  }
  const before = writes;
  await assert.rejects(service.updateRepeatTask(account.id, String(created.id), created.version, {remark: "stale"}), /已变化/);
  assert.equal(writes, before);
  assert.deepEqual(assets.map(row => row.money), [100, 0]);
  await assert.rejects(service.updateRepeatTask(account.id, String(created.id), version, {timeOfDay: "21:00"}), /历史账单发生变化/);
});

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
