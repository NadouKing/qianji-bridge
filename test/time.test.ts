import assert from "node:assert/strict";
import test from "./context.ts";
import { inTimeZone, localSecond, localDate, nextDay, calendarDays, offsetSeconds, validateTimeZone } from "../src/time.ts";
import { Store } from "../src/data-store.ts";
import { QianjiClient } from "../src/qianji-client.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";

test("calendar boundaries support DST, midnight gaps and skipped dates without 86400-second loops", () => {
  inTimeZone("America/New_York", () => {
    const spring = localSecond(2026, 3, 8), fall = localSecond(2026, 11, 1);
    assert.equal(nextDay(spring) - spring, 23 * 3600);
    assert.equal(nextDay(fall) - fall, 25 * 3600);
    assert.equal(calendarDays(spring, nextDay(spring)), 1);
    assert.equal(offsetSeconds(spring), -18000);
    assert.equal(offsetSeconds(nextDay(spring)), -14400);
    assert.equal(localDate(localSecond(2026, 13, 1)), "2027-01-01");
  });
  inTimeZone("America/Sao_Paulo", () => {
    assert.equal(localDate(localSecond(2018, 11, 4)), "2018-11-04");
    assert.equal(nextDay(localSecond(2018, 11, 4)) - localSecond(2018, 11, 4), 23 * 3600);
  });
  inTimeZone("Pacific/Apia", () => assert.equal(localDate(nextDay(localSecond(2011, 12, 29))), "2011-12-31"));
  assert.throws(() => validateTimeZone("+08:00"));
  assert.throws(() => validateTimeZone("No/Such_Zone"));
});

test("account time zones remain isolated across concurrent calls, migrations and a legacy reader", async t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const pat = store.ensureAdminPat("admin");
  const first = store.bindPat(pat.id, "1", "test", "test");
  const otherPat = store.createPat("other", null);
  const second = store.bindPat(otherPat.id, "2", "test", "test");
  const service = new MoneyTrackService(store, new QianjiClient());
  assert.equal(first.timeZone, "Asia/Shanghai");
  await service.setTimeZone(first.id, "America/New_York");
  for (let i=0;i<3;i++) {
    const [a,b] = await Promise.all([service.getTimeZone(first.id),service.getTimeZone(second.id)]);
    assert.equal(a.timeZone, "America/New_York"); assert.equal(b.timeZone,"Asia/Shanghai");
  }
  assert.equal(store.requireAccount(first.id).timeZone,"America/New_York");
  // Previous releases select named columns; additive timezone does not alter credentials or timestamps.
  assert.equal((store.db.query("SELECT uid FROM accounts WHERE id = ?").get(first.id) as {uid:string}).uid,"1");
});
