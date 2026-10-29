import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, signUp, client, pool } from "./helpers.js";

let srv;
before(async () => (srv = await startServer()));
after(async () => {
  await srv.close();
});

test("non-string input gets a 400 and the server stays up (was: process crash)", async () => {
  const { c } = await signUp(srv.base);
  const cases = [
    ["/api/tags", { name: 5 }],
    ["/api/budgets", { name: {}, weekly_target_hours: 5 }],
    ["/api/deadlines", { title: 5, due_date: "2026-12-01", estimated_hours: 2 }],
    ["/api/tasks", { title: ["x"] }],
    ["/api/reminders", { title: 1, remind_at: "2026-12-01T09:00:00Z" }],
    ["/api/sessions", { started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T10:00:00Z", note: { a: 1 } }],
    ["/api/notify", { type: "session_completed", title: "x", body: 5 }],
  ];
  for (const [path, body] of cases) {
    const res = await c.post(path, body);
    assert.equal(res.status, 400, `${path} -> ${res.status} ${res.text}`);
  }
  const anon = client(srv.base);
  assert.equal((await anon.post("/api/auth/register", { email: 5, password: "x" })).status, 400);
  assert.equal((await anon.post("/api/auth/login", { email: [], password: {} })).status, 400);
  assert.equal((await c.post("/api/tags", "{not json")).status, 400);
  assert.equal((await fetch(srv.base + "/health")).status, 200);
});

test("plus-sign emails, mixed case, apostrophes, emoji and RTL text round-trip", async () => {
  const email = `Ann.O'Brien+focus${Date.now()}@Example.COM`;
  const { c } = await signUp(srv.base, { email, displayName: "Ann O'Brien 😀 مرحبا" });
  const login = client(srv.base);
  const res = await login.post("/api/auth/login", { email: email.toLowerCase(), password: "correct horse battery" });
  assert.equal(res.status, 200);
  assert.equal(res.body.displayName, "Ann O'Brien 😀 مرحبا");
  const tag = await c.post("/api/tags", { name: "Écriture 📚 O'Neil שלום", color: "#123456" });
  assert.equal(tag.status, 201);
  const list = await c.get("/api/tags");
  assert.ok(list.body.some((t) => t.name === "Écriture 📚 O'Neil שלום"));
});

test("user B cannot read, edit, delete or reference user A's rows", async () => {
  const a = await signUp(srv.base);
  const b = await signUp(srv.base);
  const tag = (await a.c.post("/api/tags", { name: "A tag" })).body;
  const session = (await a.c.post("/api/sessions", { tag_id: tag.id, started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T10:00:00Z" })).body;
  assert.equal((await b.c.patch(`/api/sessions/${session.id}`, { note: "pwned" })).status, 404);
  assert.equal((await b.c.patch(`/api/tags/${tag.id}`, { name: "pwned" })).status, 404);
  assert.equal((await b.c.post("/api/sessions", { tag_id: tag.id, started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T10:00:00Z" })).status, 404);
  await b.c.del(`/api/sessions/${session.id}`);
  const mine = await a.c.get("/api/sessions?limit=10");
  assert.equal(mine.body.sessions.length, 1);
  assert.equal(mine.body.sessions[0].note, null);
  assert.equal((await b.c.get("/api/sessions?limit=10")).body.sessions.length, 0);
});

test("a session can't end before it starts, whichever field is patched", async () => {
  const { c } = await signUp(srv.base);
  const s = (await c.post("/api/sessions", { started_at: "2026-10-28T09:00:00Z", ended_at: "2026-10-28T10:00:00Z" })).body;
  assert.equal((await c.patch(`/api/sessions/${s.id}`, { ended_at: "2026-10-27T00:00:00Z" })).status, 400);
  assert.equal((await c.patch(`/api/sessions/${s.id}`, { started_at: "2026-10-28T11:00:00Z" })).status, 400);
  assert.equal((await c.patch(`/api/sessions/${s.id}`, { ended_at: "2026-10-28T10:30:00Z" })).status, 200);
  await assert.rejects(
    pool.query(`UPDATE sessions SET ended_at = started_at - interval '1 hour' WHERE id = $1`, [s.id]),
    /sessions_end_after_start/
  );
});

test("analytics history returns the newest sessions when over the cap", async () => {
  const { c, user } = await signUp(srv.base);
  await pool.query(
    `INSERT INTO sessions (user_id, started_at, ended_at, source)
     SELECT $1, now() - (g || ' hours')::interval - interval '30 minutes', now() - (g || ' hours')::interval, 'manual'
     FROM generate_series(1, 20010) g`,
    [user.id]
  );
  const res = await c.get("/api/sessions/history");
  assert.equal(res.body.length, 20000);
  assert.equal(res.headers.get("x-history-truncated"), "true");
  const newest = new Date(res.body[res.body.length - 1].ended_at);
  assert.ok(Date.now() - newest.getTime() < 2 * 60 * 60 * 1000, "most recent session must be included");
  assert.ok(new Date(res.body[0].started_at) < newest, "still ordered oldest-first");
});

test("CSV export: ISO timestamps, UTF-8 BOM, formula guard, numbers untouched", async () => {
  const { c } = await signUp(srv.base);
  const tag = (await c.post("/api/tags", { name: "Wörk 📚" })).body;
  await c.post("/api/sessions", { tag_id: tag.id, started_at: "2026-10-28T09:00:00Z", ended_at: "2026-10-28T10:00:00Z", note: "=HYPERLINK(1), quoted \"x\"" });
  const res = await c.get("/api/sessions/export");
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith("id,tag,started_at")); // fetch's decoder strips the BOM...
  const raw = new Uint8Array(await (await fetch(srv.base + "/api/sessions/export", { headers: { Cookie: c.cookie } })).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf]); // ...so check the bytes: UTF-8 BOM for Excel
  const line = res.text.trim().split("\n")[1];
  assert.match(line, /,Wörk 📚,2026-10-28T09:00:00\.000Z,2026-10-28T10:00:00\.000Z,3600,"'=HYPERLINK\(1\), quoted ""x""",,manual$/);
  const json = await c.get("/api/sessions/export?format=json");
  assert.equal(json.body.length, 1);
  assert.equal(json.body[0].duration_seconds, 3600);
});

test("DATE columns come back as plain YYYY-MM-DD", async () => {
  const { c } = await signUp(srv.base);
  const d = await c.post("/api/deadlines", { title: "Report", due_date: "2026-11-01", estimated_hours: 3 });
  assert.equal(d.body.due_date, "2026-11-01");
  const t = await c.post("/api/tasks", { title: "Task", due_date: "2026-11-02" });
  assert.equal(t.body.due_date, "2026-11-02");
});

test("a malformed query value is a 400, and the server keeps serving", async () => {
  const { c } = await signUp(srv.base);
  const res = await c.get("/api/sessions?limit=10&from=2026-01-01T00:00:00Z&to=not-a-date");
  assert.equal(res.status, 400);
  assert.equal((await fetch(srv.base + "/health")).status, 200);
});
