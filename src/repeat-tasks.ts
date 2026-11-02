import { inputBillMoney } from "./bill-rules.ts";

/** 固定金额转账周期任务；不是投资申购指令，也不支持预测变额投入。 */
export interface CreateRepeatTransferInput {
  bookId?: string;
  fromAssetId: string;
  targetAssetId: string;
  money: number;
  fee?: number;
  remark: string;
  tagIds?: string[];
  startDate: string;
  timeOfDay: string;
  weekdays?: number[];
  repeatType?: "week" | "workday";
}

/** 公开周期设置，主金额与普通转账保持同一口径，不返回上游账号资料。 */
export function publicRepeatTask(raw: Record<string, unknown>): Record<string, unknown> {
  const data = raw.data as Record<string, unknown>;
  const fee = Number(data.fee ?? 0);
  return {
    id: String(raw.id),
    type: Number(raw.type),
    status: Number(raw.status),
    count: Number(raw.count),
    bookId: String(data.bookid),
    fromAssetId: data.fromid === undefined ? null : String(data.fromid),
    targetAssetId: data.targetid === undefined ? null : String(data.targetid),
    categoryId: data.cateid === undefined || [2, 3].includes(Number(raw.type)) ? null : String(data.cateid),
    money: inputBillMoney(data.money, fee),
    fee: Math.max(0, fee),
    discount: Math.max(0, -fee),
    remark: String(data.remark ?? ""),
    startDate: String(data.start),
    timeOfDay: String(data.time).split(":").map((part) => part.padStart(2, "0")).join(":"),
    repeat: data.repeat,
    end: data.end ?? null,
    tagIds: data.tags ?? [],
    imageCount: Array.isArray(data.images) ? data.images.length : 0,
  };
}
