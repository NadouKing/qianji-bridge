import type { DataStore, QianjiAccount, BillRow } from "./data-store.ts";
import type { QianjiClient } from "./qianji-client.ts";
import { AppError } from "./errors.ts";
import { billFingerprint } from "./reconciliation.ts";
import { createBillId, inspectWriteResult, requireNonnegativeMoney, requirePositiveMoney, normalizeBookId, normalizeRequiredAssetId, publicUserId } from "./bill-rules.ts";
import { decimalAdd, decimalSubtract } from "./decimal.ts";
import { cachedBillObject, publicBill, publicDebtAccount, categoryChildren } from "./qianji-mappers.ts";
import { validDate } from "./repeat-tasks.ts";
import { localDate } from "./time.ts";

type Row = Record<string, unknown>;
export interface FinanceContext { client: QianjiClient; store: DataStore; account: QianjiAccount; sync(): Promise<void>; now: number }
export type DebtCommand =
  | {action: "create"; name: string; direction: "borrowed" | "lent"; money: number; bookId: string; cashAssetId: string; startDate: string; endDate?: string; remark: string}
  | {action: "addPrincipal" | "repay"; debtId: string; expectedVersion: string; cashAssetId: string; bookId: string; money: number; interest?: number; time: number; remark: string}
  | {action: "finish"; debtId: string; expectedVersion: string; endDate: string};
export type InstallmentCommand =
  | {action: "create"; name: string; assetId: string; bookId: string; categoryId: string; money: number; fee: number; periods: number; time: number; feeMethod: "average" | "first" | "last"; remainder: "first" | "last"; remark: string}
  | {action: "configure"; id: string; expectedVersion: string; includeInStatistics: boolean; feeInStatistics: boolean}
  | {action: "deleteUnused"; id: string; expectedVersion: string};

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("FINANCE_SHAPE_UNSUPPORTED", "关联对象结构不完整，停止操作");
  return value as Row;
}
function owned(row: Row | undefined, account: QianjiAccount): asserts row is Row {
  if (!row || publicUserId(row.userid) !== account.uid) throw new AppError("FINANCE_OWNER_MISMATCH", "仅支持当前账号自有对象");
}
function version(row: Row, expected: string) {
  if (billFingerprint(row) !== expected) throw new AppError("FINANCE_VERSION_CONFLICT", "对象已变化，请重新读取后审核");
}
function confirmed(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppError("WRITE_CONFIRMATION_FAILED", message + "，查询原请求及实际状态，不重发");
}
function named(value: string) {
  if (!value.trim() || value !== value.trim() || value.length > 40) throw new AppError("INVALID_FINANCE_NAME", "名称必须为 1 至 40 个字符且不含首尾空白");
}
async function allDebts({client,account}: FinanceContext) {
  const rows: Row[] = [];
  for (const direction of [51,52] as const) for (const status of [0,1] as const) rows.push(...await client.listDebtAccounts(account,direction,status));
  return [...new Map(rows.map(row => [String(row.id),row])).values()];
}
export async function debtDetails(ctx: FinanceContext, id: string) {
  const row = (await allDebts(ctx)).find(row => String(row.id) === id);
  owned(row,ctx.account);
  return {debt: publicDebtAccount(row,"CNY"), version: billFingerprint(row)};
}
async function book(ctx: FinanceContext, id: string) {
  normalizeBookId(id);
  const row = (await ctx.client.listBooks(ctx.account,true)).find(row => String(row.bookid) === id);
  owned(row,ctx.account);
}
async function cash(ctx: FinanceContext, id: string, assets: Row[]) {
  normalizeRequiredAssetId(id);
  const row = assets.find(row => String(row.id) === id); owned(row,ctx.account);
  if (Number(row.type) !== 1 || row.currency !== "CNY" || Number(row.status) !== 0) throw new AppError("DEBT_CASH_UNSUPPORTED", "需要正常自有 CNY 资金账户且明确币种");
  return row;
}
async function bills(ctx: FinanceContext) { return ctx.store.listBills(ctx.account.id,{limit: 1_000_000_000}); }
function preserveHistory(before: BillRow[], after: BillRow[]) {
  const index = new Map(after.map(row=>[row.id,row]));
  for (const row of before) confirmed(index.has(row.id) && billFingerprint(publicBill(cachedBillObject(index.get(row.id)!))) === billFingerprint(publicBill(cachedBillObject(row))), "操作期间历史账单发生变化");
}
function verifyBalances(before: Row[], after: Row[], delta: Map<string,number>) {
  for (const row of before) {
    const id=String(row.id), current=after.find(item=>String(item.id)===id);
    confirmed(current && Number(current.money) === decimalAdd(Number(row.money),delta.get(id)??0), "账户余额变化未核实");
  }
}
function newBill(ctx: FinanceContext, type: number, bookId: string, assetId: string, money: number, time: number, remark: string): Row {
  return {id: createBillId(ctx.now), userid: ctx.account.uid, bookid: bookId, assetid: assetId, cateid: "-1", fromid: "-1", targetid: "-1", type, money, time, remark,
    status: 2, createtime: Math.floor(ctx.now/1000), updatetime: Math.floor(ctx.now/1000), platform: 0, packid: -1, images: [], extra: {}};
}

/** Principal and interest use their native types, and both loan history and cash movement are verified. */
export async function manageDebt(ctx: FinanceContext, command: DebtCommand) {
  const {client,store,account}=ctx;
  await ctx.sync();
  const beforeBills=await bills(ctx), assets=await client.listAssets(account,true), debts=await allDebts(ctx);
  const old="debtId" in command ? debts.find(row=>String(row.id)===command.debtId) : undefined;
  if ("debtId" in command) {
    owned(old,account); version(old,command.expectedVersion);
    if (Number(old.type)!==5 || ![51,52].includes(Number(old.stype)) || old.currency!=="CNY" || Number(old.status)!==0) throw new AppError("DEBT_TYPE_UNSUPPORTED","需要正常自有 CNY 借贷记录");
  }
  if (command.action==="finish") {
    if (Number(old!.money)!==0 || !validDate(command.endDate) || command.endDate < String(object(old!.loan).startdate)) throw new AppError("DEBT_NOT_SETTLED","本金未归零或结清日期无效");
    await client.finishDebt(account,command.debtId,command.endDate);
    const after=(await allDebts(ctx)).find(row=>String(row.id)===command.debtId);
    confirmed(after && Number(after.status)===1 && Number(after.money)===0 && billFingerprint(after.loan)===billFingerprint(old!.loan),"借贷结清字段未确认");
    await ctx.sync(); preserveHistory(beforeBills,await bills(ctx));
    verifyBalances(assets.filter(row=>String(row.id)!==command.debtId),await client.listAssets(account,true),new Map());
    await store.invalidateCatalogCache(account.id,"assets","");
    return {debt: publicDebtAccount(after,"CNY"),version:billFingerprint(after),billIds:[]};
  }
  await book(ctx,command.bookId); await cash(ctx,command.cashAssetId,assets);
  const borrow=command.action==="create" ? command.direction==="borrowed" : Number(old!.stype)===51;
  requireNonnegativeMoney(command.money,"本金");
  const interest=command.action==="repay" ? command.interest??0 : 0;
  requireNonnegativeMoney(interest,"利息");
  if (command.money===0 && interest===0) throw new AppError("EMPTY_DEBT_OPERATION","本金与利息不能同时为零");
  if (command.action==="addPrincipal" && command.interest) throw new AppError("INVALID_DEBT_INTEREST","追加本金不能附加还款利息");
  if (command.action==="repay" && command.money>Math.abs(Number(old!.money))) throw new AppError("PRINCIPAL_EXCEEDS_REMAINING","偿还本金超过未还余额");
  const add=command.action!=="repay", debtDelta=(borrow ? -1:1)*(add?1:-1)*command.money;
  const cashDelta=(borrow?1:-1)*(add?command.money:-decimalAdd(command.money,interest));
  let rows: Row[]=[], debtId=old ? String(old.id):"";
  if (command.action==="create") {
    named(command.name); requirePositiveMoney(command.money,"本金");
    if (!validDate(command.startDate) || (command.endDate && (!validDate(command.endDate) || command.endDate<command.startDate))) throw new AppError("INVALID_DEBT_DATES","借贷起止日期无效");
    if ([...assets,...debts].some(row=>row.name===command.name)) throw new AppError("FINANCE_NAME_EXISTS","同名资产已存在");
    await client.submitAssetBalance(account,{id:-1,userid:account.uid,name:command.name,type:5,stype:borrow?51:52,money:debtDelta,incount:0,currency:"CNY",status:0,
      loan:{accountId:null,startdate:command.startDate,enddate:command.endDate??null,remark:command.remark,money:debtDelta,totalpay:null},credit:null,extra:null,remark:command.remark,createtime:0,sort:0,lastpaytime:null,icon:null,color:null},debtDelta,
      {bookid:command.bookId,accountId:command.cashAssetId,remark:command.remark,images:[]});
    const created=(await allDebts(ctx)).filter(row=>!debts.some(old=>String(old.id)===String(row.id)));
    confirmed(created.length===1 && created[0]!.name===command.name && Number(created[0]!.stype)===(borrow?51:52),"新增借贷对象未唯一匹配");
    debtId=String(created[0]!.id);
  } else {
    if (!Number.isInteger(command.time) || command.time<0) throw new AppError("INVALID_TIME","需要 Unix 秒");
    if (command.money>0) {
      const type=add ? (borrow?6:7):(borrow?9:4);
      const row=newBill(ctx,type,command.bookId,debtId,command.money,command.time,command.remark);
      row[[4,6].includes(type)?"targetid":"fromid"]=command.cashAssetId; rows.push(row);
    }
    if (interest>0) { const row=newBill(ctx,borrow?10:11,command.bookId,command.cashAssetId,interest,command.time,command.remark); row.fromid=debtId; rows.push(row); }
    if (new Set(rows.map(row=>String(row.id))).size!==rows.length || rows.some(row=>beforeBills.some(old=>old.id===String(row.id)))) throw new AppError("BILL_ID_COLLISION","账单编号冲突，未发送");
    const response=await client.syncBills(account,{bills:{changelist:rows}});
    const inspected=inspectWriteResult(response,rows.map(row=>String(row.id))); if (inspected.error) throw inspected.error;
  }
  await ctx.sync(); const afterBills=await bills(ctx); preserveHistory(beforeBills,afterBills);
  const additions=afterBills.filter(row=>!beforeBills.some(old=>old.id===row.id)).map(cachedBillObject);
  if (command.action==="create") {
    const matches=additions.filter(row=>Number(row.type)===(borrow?6:7) && String(row.assetid)===debtId && String(row[borrow?"targetid":"fromid"])===command.cashAssetId && String(row.bookid)===command.bookId && Number(row.money)===command.money && row.remark===command.remark);
    confirmed(matches.length===1,"借贷起始本金账单未确认"); rows=matches;
  } else for (const row of rows) {
    const found=additions.find(item=>String(item.id)===String(row.id));
    confirmed(found && ["type","money","time","bookid","assetid","fromid","targetid","remark"].every(key=>String(found[key])===String(row[key])),"本金或利息账单字段未确认");
  }
  confirmed(additions.length===rows.length,"操作期间出现未归属的新账单");
  const debt=(await allDebts(ctx)).find(row=>String(row.id)===debtId);
  const loan=debt && object(debt.loan), beforeLoan=old && object(old.loan);
  confirmed(debt && loan && Number(debt.money)===decimalAdd(Number(old?.money??0),debtDelta),"未还本金未确认");
  confirmed(Number(loan.money)===decimalAdd(Number(beforeLoan?.money??0),add?debtDelta:0) && Number(loan.totalpay??0)===decimalAdd(Number(beforeLoan?.totalpay??0),add?0:command.money),"借贷本金与累计还款未确认");
  if (command.action==="create") confirmed(String(loan.accountId)===command.cashAssetId && loan.startdate===command.startDate,"借贷资金账户或日期未确认");
  verifyBalances(assets,await client.listAssets(account,true),new Map([[command.cashAssetId,cashDelta],[debtId,debtDelta]]));
  await store.invalidateCatalogCache(account.id,"assets","");
  return {debt:publicDebtAccount(debt,"CNY"),version:billFingerprint(debt),billIds:rows.map(row=>String(row.id))};
}

/** Integer cents keep every allocation exact, including the explicitly chosen remainder. */
export function installmentAllocation(money: number, fee: number, periods: number, feeMethod: "average"|"first"|"last", remainder: "first"|"last") {
  requirePositiveMoney(money,"分期本金"); requireNonnegativeMoney(fee,"总手续费");
  if (!Number.isInteger(periods) || periods<2 || periods>120 || !["average","first","last"].includes(feeMethod) || !["first","last"].includes(remainder)) throw new AppError("INVALID_INSTALLMENT","分期参数无效");
  const total=Math.round(money*100), totalFee=Math.round(fee*100), per=Math.floor(total/periods), perFee=Math.floor(totalFee/periods);
  if (per<1) throw new AppError("INVALID_INSTALLMENT","每期本金至少 0.01");
  const principal=Array<number>(periods).fill(per), fees=Array<number>(periods).fill(feeMethod==="average"?perFee:0), index=remainder==="first"?0:periods-1;
  principal[index]!+=total-per*periods;
  fees[feeMethod==="average"?index:feeMethod==="first"?0:periods-1]!+=feeMethod==="average"?totalFee-perFee*periods:totalFee;
  return {principal:principal.map(n=>n/100),fees:fees.map(n=>n/100),per:per/100,perFee:perFee/100};
}
export function publicInstallment(row: Row) {
  const data=object(row.data);
  return {id:String(row.id),name:String(row.name),assetId:String(row.assetid),status:Number(row.status),type:Number(row.type),startTime:Number(row.starttime),periods:Number(row.totalcount),completedPeriods:Number(row.count),
    totalPrincipal:Number(row.totalmoney),totalFee:Number(row.totalfee),remainingPrincipal:Number(row.money),remainingFee:Number(row.fee),categoryId:String(data.cateid),remark:String(data.remark??""),
    feeMethod:String(data.feetype??"ave"),remainder:String(data.lefttype),includeInStatistics:row.incount===1,feeInStatistics:data.feeincount===1,version:billFingerprint(row)};
}
export async function manageInstallment(ctx: FinanceContext, command: InstallmentCommand) {
  const {client,account,store}=ctx;
  await ctx.sync(); const beforeBills=await bills(ctx), assets=await client.listAssets(account,true), tasks=await client.listInstallments(account);
  const old="id" in command ? tasks.find(row=>String(row.id)===command.id):undefined;
  if ("id" in command) {owned(old,account);version(old,command.expectedVersion);}
  let id=old?String(old.id):"";
  if (command.action==="create") {
    named(command.name); await book(ctx,command.bookId);
    if (!Number.isInteger(command.time) || command.time<0 || localDate(command.time)<=localDate(ctx.now/1000)) throw new AppError("INSTALLMENT_START_UNSUPPORTED","新分期从未来自然日开始，避免隐式回补历史");
    const asset=assets.find(row=>String(row.id)===command.assetId); owned(asset,account);
    const shared = object(asset.credit).shareid;
    if (assets.some(row => String((row.credit as Row | null)?.shareid) === command.assetId)) throw new AppError("INSTALLMENT_ASSET_UNSUPPORTED", "信用账户有关联共享成员");
    if (Number(asset.type)!==2 || asset.currency!=="CNY" || Number(asset.status)!==0 || (shared != null && !["", "0", "-1"].includes(String(shared)))) throw new AppError("INSTALLMENT_ASSET_UNSUPPORTED","需要正常 CNY 独立信用账户");
    const categories=(await client.listCategories(account,command.bookId,0)).flatMap(row=>[row,...categoryChildren(row)]);
    const category=categories.find(row=>String(row.id)===command.categoryId);
    if (!category || Number(category.type)!==0) throw new AppError("INVALID_CATEGORY","分期需要该账本的支出分类");
    if (tasks.some(row=>row.name===command.name)) throw new AppError("FINANCE_NAME_EXISTS","同名分期已存在");
    const allocation=installmentAllocation(command.money,command.fee,command.periods,command.feeMethod,command.remainder);
    await client.submitInstallment(account,{id:null,userid:account.uid,name:command.name,assetid:command.assetId,type:0,starttime:command.time,createtime:Math.floor(ctx.now/1000),updatetime:0,
      totalcount:command.periods,count:0,totalmoney:command.money,totalfee:command.fee,money:allocation.per,fee:allocation.perFee,status:1,packid:null,incount:0,
      data:{cateid:command.categoryId,remark:command.remark,images:null,feetype:command.feeMethod==="average"?"ave":command.feeMethod,lefttype:command.remainder,category:JSON.stringify(category),asset:JSON.stringify(asset),billflag:null,feeincount:null,prepay:null,tags:null}});
    const created=(await client.listInstallments(account)).filter(row=>!tasks.some(old=>String(old.id)===String(row.id)));
    confirmed(created.length===1,"新增分期未唯一匹配"); const task=created[0]!,data=object(task.data);id=String(task.id);
    confirmed(publicUserId(task.userid)===account.uid && task.name===command.name && Number(task.type)===1 && Number(task.status)===1 && String(task.assetid)===command.assetId && Number(task.starttime)===command.time && Number(task.totalcount)===command.periods && Number(task.count)===0 && Number(task.totalmoney)===command.money && Number(task.totalfee)===command.fee && Number(task.money)===command.money && Number(task.fee)===command.fee && Number(task.incount)===0 && String(data.cateid)===command.categoryId && data.remark===command.remark && data.lefttype===command.remainder && (data.feetype===(command.feeMethod==="average"?"ave":command.feeMethod) || (command.fee===0 && data.feetype==null)),"分期本金、费用、分配或关联字段未确认");
  } else if (command.action==="configure") {
    if (Number(old!.type)!==1) throw new AppError("INSTALLMENT_TYPE_UNSUPPORTED","当前分期类型不支持配置");
    await client.configureInstallment(account,id,{incount:Number(command.includeInStatistics),feeincount:Number(command.feeInStatistics)});
    const current=(await client.listInstallments(account)).find(row=>String(row.id)===id);
    confirmed(current && Number(current.incount)===Number(command.includeInStatistics) && Number(object(current.data).feeincount??0)===Number(command.feeInStatistics),"分期统计开关未确认");
    const stable=(row:Row)=>{const {incount:_i,updatetime:_u,...rest}=row;const {feeincount:_f,...data}=object(rest.data);return {...rest,data};};
    confirmed(billFingerprint(stable(current))===billFingerprint(stable(old!)),"配置分期时其他字段发生变化");
  } else {
    if (Number(old!.count)!==0 || object(old!.data).prepay || beforeBills.some(row=>[cachedBillObject(row).packid,cachedBillObject(row).importpackid].some(value=>Number(old!.packid)>0 && String(value)===String(old!.packid)))) throw new AppError("INSTALLMENT_IN_USE","仅删除尚未生成账单或提前还款的分期设置");
    await client.deleteInstallment(account,id);
    confirmed(!(await client.listInstallments(account)).some(row=>String(row.id)===id),"分期删除未确认");
  }
  await ctx.sync(); const afterBills=await bills(ctx);preserveHistory(beforeBills,afterBills);
  confirmed(afterBills.length===beforeBills.length,"操作期间生成了新账单，需要核实");
  verifyBalances(assets,await client.listAssets(account,true),new Map());
  await store.invalidateCatalogCache(account.id,"assets","");
  if (command.action==="deleteUnused") return {deleted:true,id};
  const task=(await client.listInstallments(account)).find(row=>String(row.id)===id);confirmed(task,"分期回读缺失");
  return {installment:publicInstallment(task)};
}
