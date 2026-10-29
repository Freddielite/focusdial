import crypto from "node:crypto";
import { pool } from "../db.js";
import { asyncRouter } from "../lib/asyncRouter.js";
import {
  hashPassword,
  verifyPassword,
  passwordProblem,
  establishSession,
  establishPendingMfa,
  destroySession,
  revokeUserSessions,
} from "../lib/auth.js";
import { googleLoginConfigured, getLoginAuthUrl, exchangeLoginCode } from "../lib/google.js";
import { loginRateLimit, registerRateLimit, resetRateLimit, mfaRateLimit } from "../lib/rateLimit.js";
import { audit } from "../lib/audit.js";
import { hashToken, randomToken, decryptSecret } from "../lib/crypto.js";
import { verifyTotp } from "../lib/totp.js";
import { sendMail, mailConfigured } from "../lib/mailer.js";
import { log } from "../lib/log.js";

export const authRouter = asyncRouter();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TTL_MS = 30 * 60 * 1000;
const PENDING_MFA_TTL_MS = 10 * 60 * 1000;

// Emails are stored and compared lowercased and trimmed. Plus-addressing
// (ann+focus@example.com) is preserved as a distinct address, which is
// what the mail system treats it as.
function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    hasPassword: Boolean(row.password_hash),
    mfaEnabled: Boolean(row.totp_enabled),
    googleLinked: Boolean(row.google_sub),
  };
}

function cleanDisplayName(v) {
  if (v === undefined || v === null || v === "") return { value: null };
  if (typeof v !== "string") return { error: "name must be text" };
  const t = v.trim();
  if (t.length > 80) return { error: "name must be 80 characters or fewer" };
  return { value: t || null };
}

authRouter.get("/auth/config", (req, res) => {
  res.json({ googleLoginEnabled: googleLoginConfigured, passwordResetEnabled: mailConfigured || process.env.NODE_ENV !== "production" });
});

authRouter.post("/auth/register", registerRateLimit, async (req, res) => {
  const { password, displayName } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "a valid email is required" });
  const pwProblem = passwordProblem(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  const name = cleanDisplayName(displayName);
  if (name.error) return res.status(400).json({ error: name.error });

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  let user;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, display_name, password_changed_at) VALUES ($1, $2, $3, now()) RETURNING *`,
      [email, passwordHash, name.value]
    );
    await client.query(`INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [rows[0].id]);
    await client.query("COMMIT");
    user = rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "an account with that email already exists" });
    throw err;
  } finally {
    client.release();
  }
  await establishSession(req, user.id);
  await audit(req, user.id, "register");
  res.status(201).json(publicUser(user));
});

authRouter.post("/auth/login", loginRateLimit, async (req, res) => {
  const { password } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  if (!email || typeof password !== "string") return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  const user = rows[0];
  // Same generic error for unknown email / Google-only account / wrong
  // password, so the response doesn't reveal which emails have accounts.
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    await audit(req, user?.id, "login_failed", { reason: user ? "bad_password" : "unknown_email" });
    return res.status(401).json({ error: "incorrect email or password" });
  }
  if (user.totp_enabled) {
    await establishPendingMfa(req, user.id);
    return res.json({ mfaRequired: true });
  }
  await establishSession(req, user.id);
  await audit(req, user.id, "login", { method: "password" });
  res.json(publicUser(user));
});

// Second step of a login when MFA is on: a 6-digit authenticator code,
// or one of the single-use recovery codes issued at MFA setup (for the
// person who lost their phone).
authRouter.post("/auth/mfa/verify", mfaRateLimit, async (req, res) => {
  const pendingId = req.session?.pendingMfaUserId;
  if (!pendingId || Date.now() - (req.session.pendingMfaAt || 0) > PENDING_MFA_TTL_MS) {
    return res.status(401).json({ error: "your sign-in expired, please start again" });
  }
  const code = typeof req.body?.code === "string" ? req.body.code.replace(/[\s-]/g, "") : "";
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [pendingId]);
  const user = rows[0];
  if (!user || !user.totp_enabled) return res.status(401).json({ error: "your sign-in expired, please start again" });

  let method = null;
  if (/^\d{6}$/.test(code)) {
    const counter = verifyTotp(decryptSecret(user.totp_secret), code);
    if (counter !== null && (user.totp_last_counter == null || counter > Number(user.totp_last_counter))) {
      await pool.query(`UPDATE users SET totp_last_counter = $2 WHERE id = $1`, [user.id, counter]);
      method = "totp";
    }
  } else if (code.length >= 10) {
    const { rowCount } = await pool.query(
      `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [user.id, hashToken(code.toLowerCase())]
    );
    if (rowCount === 1) method = "recovery_code";
  }
  if (!method) {
    await audit(req, user.id, "mfa_failed");
    return res.status(401).json({ error: "that code didn't work" });
  }
  await establishSession(req, user.id);
  await audit(req, user.id, "login", { method: `password+${method}` });
  const { rows: remaining } = await pool.query(
    `SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );
  res.json({ ...publicUser(user), recoveryCodesRemaining: remaining[0].n });
});

authRouter.post("/auth/logout", async (req, res) => {
  const userId = req.session?.userId;
  await destroySession(req);
  res.clearCookie("focusdial.sid");
  if (userId) await audit(req, userId, "logout");
  res.json({ ok: true });
});

authRouter.get("/auth/me", async (req, res) => {
  if (!req.session?.userId) return res.json({ user: null, mfaPending: Boolean(req.session?.pendingMfaUserId) });
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [req.session.userId]);
  if (rows.length === 0) return res.json({ user: null });
  res.json({ user: publicUser(rows[0]) });
});

authRouter.patch("/auth/me", async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "not signed in" });
  const name = cleanDisplayName(req.body?.displayName);
  if (name.error) return res.status(400).json({ error: name.error });
  if (!name.value) return res.status(400).json({ error: "a name is required" });
  const { rows } = await pool.query(`UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2 RETURNING *`, [
    name.value,
    req.session.userId,
  ]);
  if (rows.length === 0) return res.status(401).json({ error: "not signed in" });
  res.json(publicUser(rows[0]));
});

// --- Password reset -------------------------------------------------
// Always answers the same way whether or not the email has an account,
// so it can't be used to discover who's registered.
authRouter.post("/auth/password-reset/request", resetRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const generic = { ok: true, message: "If that email has an account, a reset link is on its way." };
  if (!EMAIL_RE.test(email)) return res.json(generic);
  const { rows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [email]);
  const user = rows[0];
  if (!user) return res.json(generic);

  const token = randomToken(32);
  // A new request invalidates any earlier unused link.
  await pool.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
  await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    user.id,
    hashToken(token),
    new Date(Date.now() + RESET_TTL_MS),
  ]);
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const link = `${frontendUrl}/?resetToken=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Reset your FocusDial password",
    text: `Someone (hopefully you) asked to reset the password for this FocusDial account.\n\nReset it here (the link works once and expires in 30 minutes):\n${link}\n\nIf this wasn't you, ignore this email - your password hasn't changed.`,
  });
  await audit(req, user.id, "password_reset_requested");
  res.json(generic);
});

authRouter.post("/auth/password-reset/confirm", resetRateLimit, async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== "string" || token.length < 20 || token.length > 200) {
    return res.status(400).json({ error: "this reset link is invalid or has expired" });
  }
  const pwProblem = passwordProblem(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  let userId;
  try {
    await client.query("BEGIN");
    // Consume atomically: the UPDATE only succeeds once per token, even
    // if the link is clicked twice at the same moment.
    const { rows } = await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [hashToken(token)]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "this reset link is invalid or has expired" });
    }
    userId = rows[0].user_id;
    await client.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1`, [
      userId,
      passwordHash,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  // Whoever might have had the old password is signed out everywhere, and
  // their devices stop receiving this account's notifications.
  await revokeUserSessions(userId);
  await pool.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [userId]);
  await audit(req, userId, "password_reset_completed");
  res.json({ ok: true });
});

// --- Sign in with Google --------------------------------------------
authRouter.get("/auth/google/login/start", (req, res) => {
  if (!googleLoginConfigured) return res.status(503).json({ error: "Google sign-in is not configured on this server" });
  // Anti-CSRF state bound to this browser's session. Without it, an
  // attacker could complete the OAuth flow with *their* Google account
  // and get the victim's browser signed into it (login CSRF).
  const nonce = crypto.randomBytes(24).toString("base64url");
  req.session.googleLoginState = nonce;
  req.session.save(() => res.redirect(getLoginAuthUrl(nonce)));
});

authRouter.get("/auth/google/login/callback", async (req, res) => {
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const redirectTo = (status) => res.redirect(`${frontendUrl}/?authResult=${status}`);

  if (!googleLoginConfigured) return res.status(503).send("Google sign-in is not configured");
  const { code, error, state } = req.query;
  const expected = req.session?.googleLoginState;
  if (req.session) delete req.session.googleLoginState;
  if (error) return redirectTo("error");
  if (typeof code !== "string" || !code) return res.status(400).send("missing code");
  if (!expected || typeof state !== "string" || state !== expected) return redirectTo("error");

  try {
    const { googleSub, email, emailVerified, name } = await exchangeLoginCode(code);
    let { rows } = await pool.query(`SELECT * FROM users WHERE google_sub = $1`, [googleSub]);
    if (rows.length === 0) {
      const byEmail = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
      if (byEmail.rows.length > 0) {
        // Only link to an existing account when Google vouches that the
        // person controls that address; otherwise someone could create a
        // Google account claiming the victim's email and take theirs over.
        if (!emailVerified) {
          await audit(req, byEmail.rows[0].id, "google_link_refused_unverified_email");
          return redirectTo("unverified");
        }
        const linked = await pool.query(`UPDATE users SET google_sub = $1, updated_at = now() WHERE id = $2 RETURNING *`, [
          googleSub,
          byEmail.rows[0].id,
        ]);
        rows = linked.rows;
        await audit(req, rows[0].id, "google_linked");
      } else {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const created = await client.query(
            `INSERT INTO users (email, google_sub, display_name) VALUES ($1, $2, $3) RETURNING *`,
            [email.toLowerCase(), googleSub, (name || "").slice(0, 80) || null]
          );
          await client.query(`INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [created.rows[0].id]);
          await client.query("COMMIT");
          rows = created.rows;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        await audit(req, rows[0].id, "register", { method: "google" });
      }
    }
    if (rows[0].totp_enabled) {
      await establishPendingMfa(req, rows[0].id);
      return redirectTo("mfa");
    }
    await establishSession(req, rows[0].id);
    await audit(req, rows[0].id, "login", { method: "google" });
    redirectTo("success");
  } catch (err) {
    log.error("google login callback failed", { err });
    redirectTo("error");
  }
});
