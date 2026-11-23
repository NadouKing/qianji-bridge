import assert from "node:assert/strict";
import test from "./context.ts";
import { Store } from "../src/data-store.ts";
import { QianjiClient } from "../src/qianji-client.ts";
import { debtDetails, manageDebt, manageInstallment, installmentAllocation, verifyCreatedDebt, verifyDeletedDebt, type FinanceContext } from "../src/linked-finance.ts";
import { billFingerprint } from "../src/reconciliation.ts";
import { decimalAdd, decimalSubtract } from "../src/decimal.ts";

function fixture() {
  const store=new Store(":memory:"),pat=store.createPat("test",null),account=store.bindPat(pat.id,"1","test","test");
  const client=new QianjiClient({fetch:async()=>{throw new Error("unexpected HTTP");}});
  const assets:Record<string,unknown>[]=[{id:"10",userid:"1",name:"cash",money:100,type:1,currency:"CNY",status:0},
    {id:"11",userid:"1",name:"credit",money:0,type:2,currency:"CNY",status:0,credit:{limit:-1}}];
  let debts:Record<string,unknown>[]=[],tasks:Record<string,unknown>[]=[],rows:Record<string,unknown>[]=[];
  let next=100,writes=0,corrupt=false;
  const deletedIds:string[]=[];
  client.listRepeatTasks=async()=>[];
  client.deleteUnusedWallet=async(_a,id)=>{
    writes++;
    for(const row of rows.filter(row=>String(row.assetid)===id && [4,9].includes(Number(row.type)))) move(row[Number(row.type)===4?"targetid":"fromid"],(Number(row.type)===9?1:-1)*Number(row.money));
    debts=debts.filter(row=>String(row.id)!==id);
    deletedIds.push(...rows.filter(row=>String(row.assetid)===id).map(row=>String(row.id)));
    rows=rows.filter(row=>String(row.assetid)!==id);
  };
  client.listBooks=async()=>[{bookid:"20",userid:"1",name:"test"}];
  client.listCategories=async()=>[{id:"30",bookid:"20",userid:"1",name:"test",type:0}];
  client.listAssets=async()=>structuredClone([...assets,...debts]);
  client.listDebtAccounts=async(_a,d,s)=>structuredClone(debts.filter(row=>row.stype===d && row.status===s));
  const move=(id:unknown,amount:number)=>{const row=[...assets,...debts].find(row=>row.id===String(id))!;row.money=decimalAdd(Number(row.money),amount);};
  client.submitAssetBalance=async(_a,value,money,extra)=>{
    writes++; const id=String(next++),borrow=value.stype===51;
    const {accountId:_accountId,...loan}=value.loan as Record<string,unknown>;
    debts.push({...structuredClone(value),id,money,currency:null,createtime:Math.floor(Date.UTC(2026,0,1)/1000),loan:{...loan,totalpay:0}});
    move(extra!.accountId,-money);
    rows.push({id:String(170000000000000000n+BigInt(next++)),userid:"1",bookid:extra!.bookid,assetid:id,[borrow?"targetid":"fromid"]:extra!.accountId,type:borrow?6:7,money:Math.abs(money),time:1800000000,remark:extra!.remark,status:2,images:[]});
  };
  client.syncBills=async(_a,payload)=>{
    writes++; const changes=(payload.bills as {changelist:Record<string,unknown>[]}).changelist;
    for (const row of changes) {
      const type=Number(row.type),n=Number(row.money),interest=type===10||type===11,borrow=[6,9,10].includes(type),add=type===6||type===7;
      const debt=debts.find(d=>String(d.id)===String(interest?row.fromid:row.assetid))!;
      const cashId=interest?row.assetid:row[[4,6].includes(type)?"targetid":"fromid"];
      move(cashId,(borrow?1:-1)*(add?n:-n));
      if (!interest) {
        const delta=(borrow?-1:1)*(add?1:-1)*n; move(debt.id,delta);
        const loan=debt.loan as Record<string,unknown>;
        if(add) loan.money=decimalAdd(Number(loan.money),delta);else loan.totalpay=decimalAdd(Number(loan.totalpay??0),n);
      }
      rows.push(structuredClone(row));
    }
    if(corrupt) assets[0]!.money=decimalAdd(Number(assets[0]!.money),1);
    return {new_ids:changes.map(row=>String(row.id)),update_ids:[],del_ids:[],conf_ids:[],has_failed:false};
  };
  client.finishDebt=async(_a,id)=>{writes++;debts.find(row=>row.id===id)!.status=1;};
  client.listInstallments=async()=>structuredClone(tasks);
  client.submitInstallment=async(_a,row)=>{writes++;tasks.push({...structuredClone(row),id:String(next++),type:1,packid:next++,money:row.totalmoney,fee:row.totalfee});};
  client.configureInstallment=async(_a,id,v)=>{writes++;const row=tasks.find(row=>row.id===id)!;row.incount=v.incount;(row.data as Record<string,unknown>).feeincount=v.feeincount;};
  client.deleteInstallment=async(_a,id)=>{writes++;tasks=tasks.filter(row=>row.id!==id);};
  const ctx:FinanceContext={client,store,account,baseCurrency:async()=>"CNY",now:Date.UTC(2026,0,1),sync:async()=>store.applySyncBatch(account.id,{changes:rows,deletes:deletedIds,invalidatedCategoryScopes:[],lasttimes:[]})};
  return {ctx,store,assets,get debts(){return debts;},get tasks(){return tasks;},get writes(){return writes;},corrupt(){corrupt=true;},rows};
}

test("native borrowing and lending preserve principal, interest and both balances across three rounds",async t=>{
  const f=fixture();t.after(()=>f.store.close());
  for(let round=0;round<3;round++) for (const direction of ["borrowed","lent"] as const) {
    const created=await manageDebt(f.ctx,{action:"create",name:`fixture${round}${direction}`,direction,money:10,bookId:"20",cashAssetId:"10",startDate:"2026-01-01",remark:"fixture"});
    const id=String(created.debt.id), expectedVersion=created.version;
    const add=await manageDebt(f.ctx,{action:"addPrincipal",debtId:id,expectedVersion,cashAssetId:"10",bookId:"20",money:2,time:1800000001,remark:"principal"});
    const count=f.writes;
    await assert.rejects(manageDebt(f.ctx,{action:"repay",debtId:id,expectedVersion,cashAssetId:"10",bookId:"20",money:2,interest:0,time:1800000002,remark:"stale"}),/已变化/);
    assert.equal(f.writes,count);
    const repaid=await manageDebt(f.ctx,{action:"repay",debtId:id,expectedVersion:add.version,cashAssetId:"10",bookId:"20",money:12,interest:0.03,time:1800000002,remark:"repayment"});
    assert.equal(repaid.billIds.length,2);assert.equal(repaid.debt.balance,0);assert.equal(repaid.debt.totalPaid,12);
    await manageDebt(f.ctx,{action:"finish",debtId:id,expectedVersion:repaid.version,endDate:"2026-02-01"});
  }
  assert.equal(f.assets[0]!.money,100);
  assert.equal(f.rows.filter(row=>[10,11].includes(Number(row.type))).length,6);
});

test("debt rejects overpayment before dispatch and reports post-dispatch balance drift",async t=>{
  const f=fixture();t.after(()=>f.store.close());
  const created=await manageDebt(f.ctx,{action:"create",name:"fixture",direction:"borrowed",money:10,bookId:"20",cashAssetId:"10",startDate:"2026-01-01",remark:"fixture"});
  const debtId=String(created.debt.id),count=f.writes;
  await assert.rejects(manageDebt(f.ctx,{action:"repay",debtId,expectedVersion:created.version,cashAssetId:"10",bookId:"20",money:11,time:1800000000,remark:"excess"}),/超过/);
  assert.equal(f.writes,count);f.corrupt();
  await assert.rejects(manageDebt(f.ctx,{action:"repay",debtId,expectedVersion:created.version,cashAssetId:"10",bookId:"20",money:1,time:1800000000,remark:"drift"}),/余额变化未核实/);
  assert.equal((await debtDetails(f.ctx,debtId)).debt.balance,9);
});

test("installment allocations conserve cents and future settings can be configured and removed without history changes",async t=>{
  const f=fixture();t.after(()=>f.store.close());
  for(const feeMethod of ["average","first","last"] as const) for(const remainder of ["first","last"] as const) {
    const allocation=installmentAllocation(10.01,0.05,3,feeMethod,remainder);
    assert.equal(allocation.principal.reduce(decimalAdd,0),10.01);assert.equal(allocation.fees.reduce(decimalAdd,0),0.05);
    const created=await manageInstallment(f.ctx,{action:"create",name:`${feeMethod}${remainder}`,assetId:"11",bookId:"20",categoryId:"30",money:10.01,fee:0.05,periods:3,time:1800000000,feeMethod,remainder,remark:"fixture"});
    assert.ok("installment" in created && created.installment);
    const id=created.installment.id;
    const configured=await manageInstallment(f.ctx,{action:"configure",id,expectedVersion:created.installment.version,includeInStatistics:true,feeInStatistics:true});
    assert.ok("installment" in configured && configured.installment);
    await manageInstallment(f.ctx,{action:"deleteUnused",id,expectedVersion:configured.installment.version});
  }
  assert.equal(f.tasks.length,0);assert.equal(f.rows.length,0);assert.equal(f.assets[1]!.money,0);
  assert.throws(()=>installmentAllocation(0.01,0,3,"average","first"));
});

test("installment edits refuse stale versions and deletion of executed plans",async t=>{
  const f=fixture();t.after(()=>f.store.close());
  await manageInstallment(f.ctx,{action:"create",name:"fixture",assetId:"11",bookId:"20",categoryId:"30",money:10,fee:0,periods:2,time:1800000000,feeMethod:"average",remainder:"first",remark:"fixture"});
  const row=f.tasks[0]!,oldVersion=billFingerprint(row);row.count=1;
  const count=f.writes;
  await assert.rejects(manageInstallment(f.ctx,{action:"deleteUnused",id:String(row.id),expectedVersion:oldVersion}),/已变化/);
  await assert.rejects(manageInstallment(f.ctx,{action:"deleteUnused",id:String(row.id),expectedVersion:billFingerprint(row)}),/仅删除/);
  assert.equal(f.writes,count);
});

test("settled debt deletion requires complete reviewed principal scope and preserves unrelated history and cash",async t=>{
  for(const direction of ["borrowed","lent"] as const) {
    const f=fixture();t.after(()=>f.store.close());
    const created=await manageDebt(f.ctx,{action:"create",name:"cleanup",direction,money:10,bookId:"20",cashAssetId:"10",startDate:"2026-01-01",remark:"fixture"});
    const debtId=String(created.debt.id);
    const repaid=await manageDebt(f.ctx,{action:"repay",debtId,expectedVersion:created.version,cashAssetId:"10",bookId:"20",money:10,time:1800000000,remark:"fixture"});
    const finished=await manageDebt(f.ctx,{action:"finish",debtId,expectedVersion:repaid.version,endDate:"2026-02-01"});
    const billIds=[...created.billIds,...repaid.billIds],count=f.writes;
    const command={action:"deleteSettled" as const,debtId,expectedVersion:finished.version,billIds};
    await assert.rejects(manageDebt(f.ctx,{...command,billIds:created.billIds}),/精确清单/);
    f.rows[0]!.images=["existing-image"];
    await assert.rejects(manageDebt(f.ctx,command),/无附件/);
    f.rows[0]!.images=[];
    f.ctx.client.listRepeatTasks=async()=>[{data:{fromid:debtId}}];
    await assert.rejects(manageDebt(f.ctx,command),/其他对象引用/);
    assert.equal(f.writes,count);
    f.ctx.client.listRepeatTasks=async()=>[];
    f.rows.push({id:"170000000099999999",userid:"1",bookid:"20",type:0,money:1,time:1800000000,assetid:"10",remark:"unrelated"});
    const result=await manageDebt(f.ctx,command);
    assert.equal(result.deleted,true);assert.deepEqual(result.deletedBillIds,billIds);
    assert.equal(f.debts.length,0);assert.equal(f.assets[0]!.money,direction==="borrowed"?110:90);
    await assert.rejects(verifyDeletedDebt(f.ctx,command,[{assetId:"10",balance:100}]),/资金余额/);
    const reviewed=await verifyDeletedDebt(f.ctx,command,[{assetId:"10",balance:direction==="borrowed"?110:90}]);assert.equal(reviewed.deleted,true);
    assert.equal((await f.store.listBills(f.ctx.account.id,{limit:100})).length,1);
  }
});

test("debt creation review matches native base-currency data, opening relationship and independently expected cash balance",async t=>{
 const f=fixture();t.after(()=>f.store.close());
 const command={action:"create" as const,name:"review",direction:"borrowed" as const,money:10,bookId:"20",cashAssetId:"10",startDate:"2026-01-01",remark:"fixture"};
 const created=await manageDebt(f.ctx,command),id=String(created.debt.id),finished=f.ctx.now/1000;
 await assert.rejects(verifyCreatedDebt(f.ctx,command,id,100,finished),/资金余额/);
 await assert.rejects(verifyCreatedDebt(f.ctx,command,id,110,finished+120),/时间窗/);
 const verified=await verifyCreatedDebt(f.ctx,command,id,110,finished);
 assert.deepEqual(verified.billIds,created.billIds);assert.equal(verified.debt.currency,"CNY");
 f.rows.push({...f.rows[0],id:"170000000099999998"});
 await assert.rejects(verifyCreatedDebt(f.ctx,command,id,110,finished),/起始本金/);
});
