import { pool } from "../db.js";
import { asyncRouter } from "../lib/asyncRouter.js";
import { hashPassword, verifyPassword, passwordProblem, revokeUserSessions, destroySession } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { encryptSecret, decryptSecret, hashToken, randomToken } from "../lib/crypto.js";
import { generateSecret, verifyTotp, otpauthUri } from "../lib/totp.js";
import { mfaRateLimit } from "../lib/rateLimit.js";
import { deleteItemFromGoogle } from "../lib/google.js";
import { log } from "../lib/log.js";

// Everything about the signed-in person's own account: password, MFA,
// sessions, a full data export, and deletion. Mounted behind requireAuth.
export const accountRouter = asyncRouter();

async function loadUser(userId) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  return rows[0];
}

// Sensitive actions re-check who's at the keyboard: the current password
// if the account has one, otherwise (Google-only accounts) an MFA code if
// MFA is on, otherwise typing the account email as a deliberate confirm.
async function reauthenticate(user, body) {
  if (user.password_hash) {
    return typeof body?.password === "string" && (await verifyPassword(body.password, user.password_hash));
  }
  if (user.totp_enabled) return verifyTotp(decryptSecret(user.totp_secret), String(body?.code || "")) !== null;
  return typeof body?.confirmEmail === "string" && body.confirmEmail.trim().toLowerCase() === user.email;
}

// --- Password -------------------------------------------------------
accountRouter.post("/account/password", async (req, res) => {
  const user = await loadUser(req.userId);
  const { currentPassword, newPassword } = req.body || {};
  if (user.password_hash && !(typeof currentPassword === "string" && (await verifyPassword(currentPassword, user.password_hash)))) {
    await audit(req, user.id, "password_change_failed");
    return res.status(403).json({ error: "current password is incorrect" });
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  await pool.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1`, [
    user.id,
    await hashPassword(newPassword),
  ]);
  // Every other device is signed out; this one stays signed in.
  const revoked = await revokeUserSessions(user.id, req.sessionID);
  await audit(req, user.id, user.password_hash ? "password_changed" : "password_set", { otherSessionsRevoked: revoked });
  res.json({ ok: true, otherSessionsRevoked: revoked });
});

// --- Sessions -------------------------------------------------------
accountRouter.get("/account/sessions", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sid, expire, sess->>'authenticatedAt' AS authenticated_at FROM user_sessions
     WHERE sess->>'userId' = $1 ORDER BY expire DESC`,
    [req.userId]
  );
  res.json(
    rows.map((r) => ({
      current: r.sid === req.sessionID,
      signedInAt: r.authenticated_at ? new Date(Number(r.authenticated_at)).toISOString() : null,
      expiresAt: r.expire,
    }))
  );
});

// "Sign out everywhere": every session for this user, on every device.
// keepCurrent=true signs out only the *other* devices.
accountRouter.post("/account/sessions/revoke", async (req, res) => {
  const keepCurrent = req.body?.keepCurrent === true;
  const revoked = await revokeUserSessions(req.userId, keepCurrent ? req.sessionID : null);
  // Signed-out devices also stop receiving this account's push
  // notifications (reminder titles on a lock screen). The current
  // device's subscription is kept when it stays signed in.
  const keepEndpoint = keepCurrent && typeof req.body?.currentEndpoint === "string" ? req.body.currentEndpoint : null;
  await pool.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND ($2::text IS NULL OR endpoint <> $2)`, [
    req.userId,
    keepEndpoint,
  ]);
  await audit(req, req.userId, "sessions_revoked", { count: revoked, keepCurrent });
  if (!keepCurrent) res.clearCookie("focusdial.sid");
  res.json({ ok: true, revoked });
});

// --- MFA (TOTP + recovery codes) ------------------------------------
function newRecoveryCodes() {
  // 10 single-use codes like "k3f9q-x7m2p"; only hashes are stored.
  return Array.from({ length: 10 }, () => {
    const raw = randomToken(8).replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(10, "x").slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

async function storeRecoveryCodes(client, userId, codes) {
  await client.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
  for (const code of codes) {
    await client.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
      userId,
      hashToken(code.replace(/-/g, "")),
    ]);
  }
}

accountRouter.get("/account/mfa", async (req, res) => {
  const user = await loadUser(req.userId);
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE used_at IS NULL)::int AS remaining FROM mfa_recovery_codes WHERE user_id = $1`,
    [req.userId]
  );
  res.json({ enabled: user.totp_enabled, recoveryCodesRemaining: rows[0].remaining });
});

// Step 1: generate a secret (not active until confirmed with a code).
accountRouter.post("/account/mfa/setup", async (req, res) => {
  const user = await loadUser(req.userId);
  if (user.totp_enabled) return res.status(409).json({ error: "two-step verification is already on" });
  const secret = generateSecret();
  await pool.query(`UPDATE users SET totp_secret = $2, totp_last_counter = NULL WHERE id = $1`, [user.id, encryptSecret(secret)]);
  res.json({ secret, otpauthUrl: otpauthUri(secret, user.email) });
});

// Step 2: prove the authenticator works, then turn MFA on and hand back
// recovery codes - shown exactly once.
accountRouter.post("/account/mfa/enable", mfaRateLimit, async (req, res) => {
  const user = await loadUser(req.userId);
  if (user.totp_enabled) return res.status(409).json({ error: "two-step verification is already on" });
  if (!user.totp_secret) return res.status(400).json({ error: "start setup first" });
  const counter = verifyTotp(decryptSecret(user.totp_secret), String(req.body?.code || "").replace(/\s/g, ""));
  if (counter === null) return res.status(400).json({ error: "that code didn't match - check your phone's clock and try again" });
  const codes = newRecoveryCodes();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE users SET totp_enabled = true, totp_last_counter = $2, updated_at = now() WHERE id = $1`, [user.id, counter]);
    await storeRecoveryCodes(client, user.id, codes);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await revokeUserSessions(user.id, req.sessionID);
  await audit(req, user.id, "mfa_enabled");
  res.json({ ok: true, recoveryCodes: codes });
});

accountRouter.post("/account/mfa/recovery-codes", mfaRateLimit, async (req, res) => {
  const user = await loadUser(req.userId);
  if (!user.totp_enabled) return res.status(400).json({ error: "two-step verification is off" });
  if (verifyTotp(decryptSecret(user.totp_secret), String(req.body?.code || "")) === null) {
    return res.status(403).json({ error: "that code didn't work" });
  }
  const codes = newRecoveryCodes();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await storeRecoveryCodes(client, user.id, codes);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await audit(req, user.id, "mfa_recovery_codes_regenerated");
  res.json({ ok: true, recoveryCodes: codes });
});

accountRouter.post("/account/mfa/disable", mfaRateLimit, async (req, res) => {
  const user = await loadUser(req.userId);
  if (!user.totp_enabled) return res.json({ ok: true });
  const code = String(req.body?.code || "").replace(/[\s-]/g, "");
  const codeOk =
    verifyTotp(decryptSecret(user.totp_secret), code) !== null ||
    (
      await pool.query(`SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`, [
        user.id,
        hashToken(code.toLowerCase()),
      ])
    ).rowCount === 1;
  const passwordOk = !user.password_hash || (typeof req.body?.password === "string" && (await verifyPassword(req.body.password, user.password_hash)));
  if (!codeOk || !passwordOk) return res.status(403).json({ error: "password or code is incorrect" });
  await pool.query(`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_counter = NULL WHERE id = $1`, [user.id]);
  await pool.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [user.id]);
  await audit(req, user.id, "mfa_disabled");
  res.json({ ok: true });
});

// --- Security activity (the person's own audit trail) ---------------
accountRouter.get("/account/activity", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT event, ip, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.userId]
  );
  res.json(rows);
});

// --- Export everything (GDPR access / portability) -----------------
accountRouter.get("/account/export", async (req, res) => {
  const uid = req.userId;
  const q = (sql) => pool.query(sql, [uid]).then((r) => r.rows);
  const [user] = await q(`SELECT id, email, display_name, created_at, google_sub IS NOT NULL AS google_linked, totp_enabled FROM users WHERE id = $1`);
  const data = {
    exported_at: new Date().toISOString(),
    account: user,
    settings: (await q(`SELECT * FROM settings WHERE user_id = $1`))[0] || null,
    tags: await q(`SELECT * FROM tags WHERE user_id = $1 ORDER BY created_at`),
    budgets: await q(`SELECT * FROM budgets WHERE user_id = $1 ORDER BY created_at`),
    sessions: await q(`SELECT * FROM sessions WHERE user_id = $1 ORDER BY started_at`),
    deadlines: await q(`SELECT * FROM deadlines WHERE user_id = $1 ORDER BY created_at`),
    tasks: await q(`SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at`),
    reminders: await q(`SELECT * FROM reminders WHERE user_id = $1 ORDER BY created_at`),
    google_calendar: (await q(`SELECT email, calendar_id, connected_at FROM google_account WHERE user_id = $1`))[0] || null,
    push_devices: (await q(`SELECT created_at FROM push_subscriptions WHERE user_id = $1`)).length,
    security_activity: await q(`SELECT event, ip, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at`),
  };
  res.setHeader("Content-Disposition", `attachment; filename="focusdial-account-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

// --- Delete account -------------------------------------------------
// Removes the user row; every table's user_id FK is ON DELETE CASCADE, so
// all their data goes with it in one statement. Things outside those FKs
// are cleaned up explicitly: Google calendar events FocusDial created
// (and the stored grant), google_event_links rows, and their sessions.
// The audit trail keeps an anonymous "account_deleted" row (user_id SET
// NULL). Backups age out on the provider's retention schedule - see
// OPERATIONS.md for the GDPR note.
accountRouter.post("/account/delete", async (req, res) => {
  const user = await loadUser(req.userId);
  if (!(await reauthenticate(user, req.body))) {
    return res.status(403).json({ error: "please confirm with your password (or your account email)" });
  }

  const { rows: items } = await pool.query(
    `SELECT 'deadline' AS type, id FROM deadlines WHERE user_id = $1
     UNION ALL SELECT 'reminder', id FROM reminders WHERE user_id = $1`,
    [user.id]
  );
  for (const item of items) await deleteItemFromGoogle(user.id, item.type, item.id).catch(() => {});
  const { rows: g } = await pool.query(`SELECT refresh_token, access_token FROM google_account WHERE user_id = $1`, [user.id]);
  if (g[0]) {
    try {
      const token = decryptSecret(g[0].refresh_token) || decryptSecret(g[0].access_token);
      if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
    } catch (err) {
      log.warn("google revoke during account deletion failed", { message: err.message });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM google_event_links
       WHERE (item_type = 'deadline' AND item_id IN (SELECT id FROM deadlines WHERE user_id = $1))
          OR (item_type = 'reminder' AND item_id IN (SELECT id FROM reminders WHERE user_id = $1))`,
      [user.id]
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await revokeUserSessions(user.id);
  await audit(req, null, "account_deleted");
  await destroySession(req);
  res.clearCookie("focusdial.sid");
  res.json({ ok: true });
});
