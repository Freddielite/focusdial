import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, signUp, pool } from "./helpers.js";

let srv;
before(async () => (srv = await startServer()));
after(async () => srv.close());

const countTitle = async (userId, title, status) =>
  Number(
    (await pool.query(`SELECT count(*) FROM deadlines WHERE user_id = $1 AND title = $2 AND ($3::text IS NULL OR status = $3)`, [userId, title, status || null]))
      .rows[0].count
  );

test("marking a recurring deadline done twice spawns exactly one next occurrence", async () => {
  const { c, user } = await signUp(srv.base);
  const d = (await c.post("/api/deadlines", { title: "Weekly report", due_date: "2026-10-20", estimated_hours: 3, recurrence: "weekly", add_as_task: true })).body;
  await c.patch(`/api/deadlines/${d.id}`, { status: "done" });
  await c.patch(`/api/deadlines/${d.id}`, { status: "done" });
  assert.equal(await countTitle(user.id, "Weekly report", "active"), 1);
  const next = (await c.get("/api/deadlines?status=active")).body[0];
  assert.equal(next.due_date, "2026-10-27");
});

test("two simultaneous 'done' clicks still spawn only one occurrence", async () => {
  const { c, user } = await signUp(srv.base);
  const d = (await c.post("/api/deadlines", { title: "Race", due_date: "2026-10-20", estimated_hours: 1, recurrence: "daily" })).body;
  await Promise.all([c.patch(`/api/deadlines/${d.id}`, { status: "done" }), c.patch(`/api/deadlines/${d.id}`, { status: "done" })]);
  assert.equal(await countTitle(user.id, "Race", "active"), 1);
});

test("completing a recurring task twice (and via its deadline) doesn't duplicate", async () => {
  const { c, user } = await signUp(srv.base);
  const t = (await c.post("/api/tasks", { title: "Water plants", due_date: "2026-10-20", recurrence: "daily" })).body;
  await c.patch(`/api/tasks/${t.id}`, { status: "done" });
  await c.patch(`/api/tasks/${t.id}`, { status: "done" });
  const { rows } = await pool.query(`SELECT count(*) FROM tasks WHERE user_id = $1 AND title = 'Water plants' AND status = 'open'`, [user.id]);
  assert.equal(Number(rows[0].count), 1);

  await c.post("/api/deadlines", { title: "Linked", due_date: "2026-10-20", estimated_hours: 1, recurrence: "weekly", add_as_task: true });
  const linked = (await c.get("/api/tasks")).body.find((x) => x.title === "Linked");
  await c.patch(`/api/tasks/${linked.id}`, { status: "done" });
  await c.patch(`/api/tasks/${linked.id}`, { status: "done" });
  assert.equal(await countTitle(user.id, "Linked", "active"), 1);
});

test("a reminder converts once; bad hours are rejected", async () => {
  const { c, user } = await signUp(srv.base);
  const r = (await c.post("/api/reminders", { title: "Call bank", remind_at: "2026-10-29T08:00:00Z" })).body;
  assert.equal((await c.post(`/api/reminders/${r.id}/convert-to-deadline`, { due_date: "2026-11-01", estimated_hours: "-4" })).status, 400);
  assert.equal((await c.post(`/api/reminders/${r.id}/convert-to-deadline`, { due_date: "2026-11-01", estimated_hours: 2 })).status, 201);
  assert.equal((await c.post(`/api/reminders/${r.id}/convert-to-deadline`, { due_date: "2026-11-01", estimated_hours: 2 })).status, 409);
  assert.equal((await c.post(`/api/reminders/${r.id}/convert-to-task`, {})).status, 409);
  assert.equal(await countTitle(user.id, "Call bank"), 1);
});

test("Idempotency-Key: a retried POST replays instead of creating a second row", async () => {
  const { c, user } = await signUp(srv.base);
  const body = { started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T10:00:00Z", note: "once" };
  const h = { "Idempotency-Key": "retry-test-key-0001" };
  const first = await c.post("/api/sessions", body, h);
  const second = await c.post("/api/sessions", body, h);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers.get("idempotent-replay"), "true");
  assert.equal(second.body.id, first.body.id);
  const { rows } = await pool.query(`SELECT count(*) FROM sessions WHERE user_id = $1 AND note = 'once'`, [user.id]);
  assert.equal(Number(rows[0].count), 1);
  assert.equal((await c.post("/api/tags", { name: "x" }, h)).status, 422, "same key on another endpoint");
});

test("Idempotency-Key: concurrent duplicates create one row", async () => {
  const { c, user } = await signUp(srv.base);
  const h = { "Idempotency-Key": "concurrent-key-0001" };
  const results = await Promise.all(
    Array.from({ length: 4 }, () => c.post("/api/tasks", { title: "Four clicks" }, h))
  );
  assert.ok(results.every((r) => [201, 409].includes(r.status)));
  const { rows } = await pool.query(`SELECT count(*) FROM tasks WHERE user_id = $1 AND title = 'Four clicks'`, [user.id]);
  assert.equal(Number(rows[0].count), 1);
});
