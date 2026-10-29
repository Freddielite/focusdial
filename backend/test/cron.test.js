import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, signUp, pool } from "./helpers.js";
import { nextOccurrenceLocal, shiftToLocal } from "../src/lib/time.js";

let srv;
before(async () => (srv = await startServer()));
after(async () => srv.close());

const tick = () => fetch(`${srv.base}/api/cron/tick`, { headers: { "x-cron-secret": process.env.CRON_SECRET } }).then((r) => r.json());

test("cron rejects a wrong secret", async () => {
  const res = await fetch(`${srv.base}/api/cron/tick`, { headers: { "x-cron-secret": "nope" } });
  assert.equal(res.status, 401);
});

test("an overdue deadline is classified overdue (was: 'unknown' forever)", async () => {
  const { c } = await signUp(srv.base);
  const d = (await c.post("/api/deadlines", { title: "Long overdue", due_date: "2026-01-01", estimated_hours: 10 })).body;
  await tick();
  const { rows } = await pool.query(`SELECT last_notified_status FROM deadlines WHERE id = $1`, [d.id]);
  assert.equal(rows[0].last_notified_status, "overdue");
});

test("overlapping ticks fire a due reminder once", async () => {
  const { c, user } = await signUp(srv.base);
  await c.post("/api/reminders", { title: "Once only", remind_at: new Date(Date.now() - 60_000).toISOString() });
  const results = await Promise.all([tick(), tick(), tick()]);
  const fired = results
    .flatMap((r) => r.results || [])
    .filter((r) => r.userId === user.id)
    .reduce((n, r) => n + (r.remindersFired || 0), 0);
  assert.equal(fired, 1);
});

test("a recurring reminder catches up past now() instead of bursting", async () => {
  const { c } = await signUp(srv.base);
  const r = (await c.post("/api/reminders", { title: "Daily", remind_at: new Date(Date.now() - 5 * 86400_000).toISOString(), recurrence: "daily" })).body;
  await tick();
  const { rows } = await pool.query(`SELECT remind_at FROM reminders WHERE id = $1`, [r.id]);
  assert.ok(new Date(rows[0].remind_at) > new Date());
  const second = await tick();
  assert.ok(second.ok);
});

test("a daily 9am reminder stays at 9am local across a DST change", () => {
  const tz = { timezone: "America/New_York" };
  let d = new Date("2026-10-30T13:00:00Z"); // 9:00 EDT
  for (let i = 0; i < 4; i++) {
    d = nextOccurrenceLocal(d, "daily", tz);
    assert.equal(shiftToLocal(d, tz).getUTCHours(), 9, d.toISOString());
  }
  const lagos = { timezone: "Africa/Lagos" };
  const m = nextOccurrenceLocal(new Date("2026-01-31T08:00:00Z"), "monthly", lagos);
  assert.equal(shiftToLocal(m, lagos).getUTCHours(), 9);
});
