import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, signUp, client, uniqueEmail, randomIp, resetLimits, pool } from "./helpers.js";
import { totpAt } from "../src/lib/totp.js";
import { _setTestMailTransport } from "../src/lib/mailer.js";

let srv;
let mail = [];
before(async () => {
  srv = await startServer();
  _setTestMailTransport(async (m) => {
    mail.push(m);
    return { sent: true };
  });
});
after(async () => srv.close());
beforeEach(() => {
  mail = [];
  resetLimits();
});

const PW = "correct horse battery";

test("login rotates the session id (no session fixation)", async () => {
  const email = uniqueEmail();
  await signUp(srv.base, { email });
  const c = client(srv.base, { ip: randomIp() });
  c.cookie = "focusdial.sid=s%3Aplanted.attacker";
  await c.post("/api/auth/login", { email, password: PW });
  const first = c.cookie;
  assert.ok(first && !first.includes("planted"));
  await c.post("/api/auth/login", { email, password: PW });
  assert.notEqual(c.cookie, first);
});

test("logout kills the session server-side", async () => {
  const { c } = await signUp(srv.base);
  const stolen = c.cookie;
  await c.post("/api/auth/logout");
  const replay = client(srv.base);
  replay.cookie = stolen;
  assert.equal((await replay.get("/api/tags")).status, 401);
});

test("login rate limits: per account, and password spraying from one IP", async () => {
  const ip = randomIp();
  const c = client(srv.base, { ip });
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await c.post("/api/auth/login", { email: "victim@example.com", password: "nope" })).status);
  assert.equal(statuses[10], 429);
  resetLimits();
  let sprayBlocked = false;
  for (let i = 0; i < 55; i++) {
    const r = await c.post("/api/auth/login", { email: `spray${i}@example.com`, password: "Password1" });
    if (r.status === 429) sprayBlocked = true;
  }
  assert.ok(sprayBlocked, "many different emails from one IP must hit the per-IP limit");
});

test("password reset: link works once, expires, and signs out other devices", async () => {
  const email = uniqueEmail("reset");
  const { c: otherDevice } = await signUp(srv.base, { email });
  const anon = client(srv.base, { ip: randomIp() });
  const unknown = await anon.post("/api/auth/password-reset/request", { email: "nobody@example.com" });
  const known = await anon.post("/api/auth/password-reset/request", { email: email.toUpperCase() });
  assert.deepEqual(unknown.body, known.body, "same response whether or not the account exists");
  assert.equal(mail.length, 1);
  const token = decodeURIComponent(mail[0].text.match(/resetToken=([^\s]+)/)[1]);

  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token, password: "short" })).status, 400);
  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token, password: "brand new password" })).status, 200);
  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token, password: "another new password" })).status, 400, "single use");
  assert.equal((await otherDevice.get("/api/tags")).status, 401, "old sessions revoked");
  assert.equal((await anon.post("/api/auth/login", { email, password: "brand new password" })).status, 200);

  await anon.post("/api/auth/password-reset/request", { email });
  const token2 = decodeURIComponent(mail[1].text.match(/resetToken=([^\s]+)/)[1]);
  await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
  assert.equal((await anon.post("/api/auth/password-reset/confirm", { token: token2, password: "yet another password" })).status, 400, "expired");
});

test("MFA: setup, login challenge, replay protection, recovery code for a lost phone", async () => {
  const email = uniqueEmail("mfa");
  const { c } = await signUp(srv.base, { email });
  const setup = await c.post("/api/account/mfa/setup");
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const secret = setup.body.secret;
  const now = () => Math.floor(Date.now() / 30000);
  assert.equal((await c.post("/api/account/mfa/enable", { code: "000000" })).status, 400);
  const enabled = await c.post("/api/account/mfa/enable", { code: totpAt(secret, now()) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.recoveryCodes.length, 10);

  const login = client(srv.base, { ip: randomIp() });
  const step1 = await login.post("/api/auth/login", { email, password: PW });
  assert.deepEqual(step1.body, { mfaRequired: true });
  assert.equal((await login.get("/api/tags")).status, 401, "no data access until the second factor");
  assert.equal((await login.post("/api/auth/mfa/verify", { code: "123456" })).status, 401);
  const nextCode = totpAt(secret, now() + 1); // a fresh step the enable call didn't consume
  assert.equal((await login.post("/api/auth/mfa/verify", { code: nextCode })).status, 200);
  assert.equal((await login.get("/api/tags")).status, 200);

  const replay = client(srv.base, { ip: randomIp() });
  await replay.post("/api/auth/login", { email, password: PW });
  assert.equal((await replay.post("/api/auth/mfa/verify", { code: nextCode })).status, 401, "a used code can't be replayed");

  const lostPhone = client(srv.base, { ip: randomIp() });
  await lostPhone.post("/api/auth/login", { email, password: PW });
  const rc = enabled.body.recoveryCodes[0];
  const ok = await lostPhone.post("/api/auth/mfa/verify", { code: rc.toUpperCase() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.recoveryCodesRemaining, 9);
  const again = client(srv.base, { ip: randomIp() });
  await again.post("/api/auth/login", { email, password: PW });
  assert.equal((await again.post("/api/auth/mfa/verify", { code: rc })).status, 401, "recovery codes are single-use");

  const { rows } = await pool.query(`SELECT totp_secret FROM users WHERE email = $1`, [email]);
  assert.ok(rows[0].totp_secret.startsWith("enc:v1:"), "MFA secret encrypted at rest");
});

test("sign out everywhere, and password change signs out other devices", async () => {
  const email = uniqueEmail();
  const { c: laptop } = await signUp(srv.base, { email });
  const phone = client(srv.base, { ip: randomIp() });
  await phone.post("/api/auth/login", { email, password: PW });
  assert.equal((await laptop.post("/api/account/password", { currentPassword: "wrong", newPassword: "new password 123" })).status, 403);
  const changed = await laptop.post("/api/account/password", { currentPassword: PW, newPassword: "new password 123" });
  assert.equal(changed.body.otherSessionsRevoked, 1);
  assert.equal((await phone.get("/api/tags")).status, 401);
  assert.equal((await laptop.get("/api/tags")).status, 200);

  const tablet = client(srv.base, { ip: randomIp() });
  await tablet.post("/api/auth/login", { email, password: "new password 123" });
  await laptop.post("/api/account/sessions/revoke", { keepCurrent: false });
  assert.equal((await laptop.get("/api/tags")).status, 401);
  assert.equal((await tablet.get("/api/tags")).status, 401);
});

test("account deletion removes the user's data everywhere", async () => {
  const email = uniqueEmail("delete");
  const { c, user } = await signUp(srv.base, { email });
  await c.post("/api/tags", { name: "gone" });
  await c.post("/api/sessions", { started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T10:00:00Z" });
  const exported = await c.get("/api/account/export");
  assert.equal(exported.body.sessions.length, 1);
  assert.equal((await c.post("/api/account/delete", { password: "wrong" })).status, 403);
  assert.equal((await c.post("/api/account/delete", { password: PW })).status, 200);
  for (const table of ["users", "sessions", "tags", "settings"]) {
    const col = table === "users" ? "id" : "user_id";
    const { rows } = await pool.query(`SELECT count(*) FROM ${table} WHERE ${col} = $1`, [user.id]);
    assert.equal(Number(rows[0].count), 0, table);
  }
  const { rows } = await pool.query(`SELECT count(*) FROM user_sessions WHERE sess->>'userId' = $1`, [user.id]);
  assert.equal(Number(rows[0].count), 0);
  assert.equal((await client(srv.base, { ip: randomIp() }).post("/api/auth/login", { email, password: PW })).status, 401);
});

test("cross-site requests are rejected when an origin allow-list is set", async () => {
  const strict = await startServer({ CORS_ORIGIN: "https://app.example" });
  try {
    const { c } = await signUp(strict.base);
    assert.equal((await c.post("/api/tags", { name: "csrf" }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await c.post("/api/tags", { name: "ok" }, { Origin: "https://app.example" })).status, 201);
  } finally {
    await strict.close();
  }
});

test("security headers are on every API response", async () => {
  const res = await fetch(srv.base + "/api/auth/config");
  for (const h of ["strict-transport-security", "x-content-type-options", "content-security-policy", "x-frame-options"]) {
    assert.ok(res.headers.get(h), h);
  }
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
});
