import { AsyncLocalStorage } from "node:async_hooks";
import { Temporal } from "@js-temporal/polyfill";
import { AppError } from "./errors.ts";

const zones = new AsyncLocalStorage<string>();
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export function timeZone(): string { return zones.getStore() ?? DEFAULT_TIME_ZONE; }
export function validateTimeZone(value: string): string {
  if (!value || /^[+-]/.test(value)) throw new AppError("INVALID_TIME_ZONE", "需要 IANA 时区名称");
  try { return new Intl.DateTimeFormat("en", {timeZone: value}).resolvedOptions().timeZone; }
  catch { throw new AppError("INVALID_TIME_ZONE", "无效的 IANA 时区名称"); }
}
export function inTimeZone<T>(zone: string | undefined, action: () => T): T {
  return zones.run(validateTimeZone(zone ?? DEFAULT_TIME_ZONE), action);
}
export function localTime(epochSeconds: number, zone = timeZone()) {
  return Temporal.Instant.fromEpochMilliseconds(Math.floor(epochSeconds * 1000)).toZonedDateTimeISO(zone);
}
export function offsetSeconds(epochSeconds: number, zone = timeZone()): number {
  return localTime(epochSeconds, zone).offsetNanoseconds / 1e9;
}
export function localDate(epochSeconds: number): string { return localTime(epochSeconds).toPlainDate().toString(); }
export function startOfDay(epochSeconds: number): number { return localTime(epochSeconds).startOfDay().epochMilliseconds / 1000; }
/** Calendar overflow matches existing Date.UTC semantics; startOfDay handles midnight DST. */
export function localSecond(year: number, month: number, day: number): number {
  const date = Temporal.PlainDate.from({year, month: 1, day: 1}).add({months: month - 1, days: day - 1});
  return date.toZonedDateTime(timeZone()).epochMilliseconds / 1000;
}
export function nextDay(epochSeconds: number): number {
  return localTime(epochSeconds).toPlainDate().add({days: 1}).toZonedDateTime(timeZone()).epochMilliseconds / 1000;
}
export function calendarDays(start: number, endExclusive: number): number {
  return localTime(start).toPlainDate().until(localTime(endExclusive).toPlainDate()).days;
}

export function completeLocalDays(start: number, end: number): number {
  return localTime(start).until(localTime(end), {largestUnit: "day"}).days;
}
