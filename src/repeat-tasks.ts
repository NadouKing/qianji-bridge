import { inputBillMoney } from "./bill-rules.ts";
import { AppError } from "./errors.ts";

export interface RepeatSchedule { type: "day" | "week" | "month" | "year" | "workday" | "bystep"; values?: Array<number | string> }
export interface RepeatTaskInput {
  type: 0 | 1 | 2 | 3 | 5; bookId: string; fromAssetId: string; targetAssetId?: string; categoryId?: string;
  money: number; fee?: number; remark: string; startDate: string; timeOfDay: string; schedule: RepeatSchedule;
}
export interface RepeatTaskPatch {
  money?: number; fee?: number; remark?: string; timeOfDay?: string; schedule?: RepeatSchedule;
}
export function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
export function repeatSchedule(schedule: RepeatSchedule) {
  const values = schedule.values ?? [];
  let valid = new Set(values).size === values.length;
  if (schedule.type === "day" || schedule.type === "workday") valid &&= values.length === 0;
  else if (schedule.type === "week" || schedule.type === "month") valid &&= values.length > 0 && values.every(v => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= (schedule.type === "week" ? 7 : 31));
  else if (schedule.type === "year") valid &&= values.length > 0 && values.every(v => typeof v === "string" && validDate("2000-" + v));
  else if (schedule.type === "bystep") valid &&= values.length === 1 && typeof values[0] === "number" && Number.isInteger(values[0]) && values[0] >= 1 && values[0] <= 3650;
  else valid = false;
  if (!valid) throw new AppError("INVALID_REPEAT_SCHEDULE", "周期参数不匹配，周为 1 至 7，月为 1 至 31，年为 MM-DD，间隔天数为 1 至 3650");
  return { type: schedule.type, value: values.length ? [...values].sort((a,b) => String(a).localeCompare(String(b), "en", {numeric: true})) : null };
}

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
