import assert from "node:assert/strict";
import { Store } from "../src/data-store.ts";
import { QianjiClient } from "../src/qianji-client.ts";
import { getCatalogObject, manageCatalog } from "../src/catalog-management.ts";
import test from "./context.ts";

test("catalog management preserves balances and credit settings, checks versions and never deletes populated books", async t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const pat = store.createPat("fixture", null), account = store.bindPat(pat.id, "uid", "token", "device");
  const client = new QianjiClient({fetch: async () => {throw new Error("unexpected HTTP");}});
  let books: Record<string, unknown>[] = [], assets: Record<string, unknown>[] = [];
  const groups = [{id: "group", userid: "uid", name: "before", tags: [{id: "tag", name: "unchanged"}]}];
  let writes = 0;
  client.listBooks = async () => structuredClone(books);
  client.listAssets = async () => structuredClone(assets);
  client.listTagGroups = async () => structuredClone(groups);
  client.listRepeatTasks = async () => [];
  client.listInstallments = async () => [];
  client.listCategories = async () => [];
  client.listDebtAccounts = async () => [];
  client.checkAssetDeletion = async () => {};
  client.deleteUnusedWallet = async (_account,id) => {writes++; assets=assets.filter(row=>row.id!==id);};
  client.submitBook = async (_account, value) => {
    writes++;
    if (value.bookid) Object.assign(books.find(row => row.bookid === value.bookid)!, value);
    else books.push({...value, userid: "uid", visible: 1, bookid: String(books.length+100)});
  };
  client.toggleBookVisibility = async (_account, id) => {writes++; const row = books.find(row => row.bookid === id)!; row.visible = row.visible === 1 ? 0 : 1;};
  client.submitAssetBalance = async (_account, value, money) => {
    writes++;
    const row = {...value, money};
    if (String(value.id) === "-1") assets.push({...row, id: String(assets.length+200)});
    else assets = assets.map(old => old.id === value.id ? row : old);
  };
  client.renameTagGroup = async (_account, _id, name) => {writes++; groups[0]!.name = name;};
  client.deleteEmptyBook = async (_account, id) => {writes++; books = books.filter(row => row.bookid !== id);};
  const run = (command: Parameters<typeof manageCatalog>[3]) => manageCatalog(client, store, account, command, async () => {});
  for (let round=0; round<3; round++) {
    await run({action: "createBook", name: `fixture${round}`});
    await run({action: "createAsset", name: `cash${round}`, kind: "cash", balance: 0, includeInTotal: false});
  }
  const book = await getCatalogObject(client, account, "book", "100");
  await run({action: "updateBook", id: "100", expectedVersion: book.version, name: "renamed"});
  const beforeStale = writes;
  await assert.rejects(run({action: "updateBook", id: "100", expectedVersion: book.version, name: "stale"}), /已变化/);
  assert.equal(writes, beforeStale);
  const asset = assets[0]!; asset.credit = {statedate: 10, paydate2: "20", limit: 5000}; asset.type = 2; asset.money = -123.45;
  const previous = await getCatalogObject(client, account, "asset", "200", true);
  await run({action: "updateAsset", id: "200", expectedVersion: previous.version, name: "new name", remark: "new remark", includeInTotal: true});
  assert.equal(assets[0]!.money, -123.45);
  assert.deepEqual(assets[0]!.credit, {statedate: 10, paydate2: "20", limit: 5000});
  const group = await getCatalogObject(client, account, "tagGroup", "group");
  await run({action: "renameTagGroup", id: "group", expectedVersion: group.version, name: "after"});
  assert.deepEqual(groups[0]!.tags, [{id: "tag", name: "unchanged"}]);
  store.upsertBill(account.id, {id: "170000000000000001", bookid: "100", userid: "uid", time: 1700000000, type: 0, money: 1, cateid: "2", assetid: "200"});
  const latest = await getCatalogObject(client, account, "book", "100");
  await assert.rejects(run({action: "deleteEmpty", kind: "book", id: "100", expectedVersion: latest.version}), /关联账单/);
  const empty = await getCatalogObject(client, account, "book", "101");
  await run({action: "deleteEmpty", kind: "book", id: "101", expectedVersion: empty.version});
  assert.equal(books.some(row => row.bookid === "101"), false);
  const zero=await getCatalogObject(client,account,"asset","201",true);
  client.listInstallments=async()=>[{id:"999",assetid:"201",data:{cateid:"500"}}];
  const count=writes;
  await assert.rejects(run({action:"deleteEmpty",kind:"asset",id:"201",expectedVersion:zero.version}),/分期引用/);
  assert.equal(writes,count);
  client.listInstallments=async()=>[];
  client.listDebtAccounts=async()=>[{id:"998",loan:{accountId:"201"}}];
  await assert.rejects(run({action:"deleteEmpty",kind:"asset",id:"201",expectedVersion:zero.version}),/借贷或共享/);
  client.listDebtAccounts=async()=>[];
  await run({action:"deleteEmpty",kind:"asset",id:"201",expectedVersion:zero.version});
  assert.equal(assets.some(row=>row.id==="201"),false);
});

test("asset deletion preflight refuses native cascade counts and missing evidence",async()=>{
 const account={id:1,uid:"1",utoken:"test",devid:"test"};
 for(const data of [{installcount:1,repeatcount:0},{installcount:0,repeatcount:2},{},{installcount:0},{installcount:-1,repeatcount:0}]) {
  const client=new QianjiClient({fetch:async(url,init)=>{
   assert.equal(new URL(String(url)).pathname,"/asset/deletecheck");
   assert.equal(new URLSearchParams(String(init?.body)).get("did"),"200");
   return Response.json({ec:200,data});
  }});
  await assert.rejects(client.checkAssetDeletion(account,"200"));
 }
 const client=new QianjiClient({fetch:async()=>Response.json({ec:200,data:{installcount:0,repeatcount:0}})});
 await client.checkAssetDeletion(account,"200");
});
