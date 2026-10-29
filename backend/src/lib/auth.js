import bcrypt from "bcryptjs";
import { pool } from "../db.js";

const BCRYPT_ROUNDS = 12;

// Session lifetime: a session idles out after IDLE_DAYS without use
// (the cookie is rolling - see app.js) and is hard-capped at
// ABSOLUTE_DAYS from sign-in regardless of activity.
export const IDLE_MS = (Number(process.env.SESSION_IDLE_DAYS) || 14) * 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = (Number(process.env.SESSION_ABSOLUTE_DAYS) || 30) * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// bcrypt only uses the first 72 bytes of input, so longer passwords are
// rejected rather than silently truncated.
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 8) return "password must be at least 8 characters";
  if (Buffer.byteLength(password, "utf8") > 72) return "password must be 72 bytes or fewer";
  return null;
}

// Starts an authenticated session. regenerate() issues a brand-new
// session id, so an id planted in the browser before login (session
// fixation) is worthless afterwards.
export function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.authenticatedAt = Date.now();
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

// Holds a half-finished login (password OK, MFA code still needed). The
// session id is also rotated here; userId stays unset so requireAuth
// keeps rejecting every data route until the second factor is supplied.
export function establishPendingMfa(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.pendingMfaUserId = userId;
      req.session.pendingMfaAt = Date.now();
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

export function destroySession(req) {
  return new Promise((resolve) => req.session.destroy(() => resolve()));
}

// Deletes every stored session for a user (optionally keeping the
// current one). connect-pg-simple stores the session as JSON in
// user_sessions.sess.
export async function revokeUserSessions(userId, exceptSid = null) {
  const { rowCount } = await pool.query(
    `DELETE FROM user_sessions WHERE sess->>'userId' = $1 AND ($2::text IS NULL OR sid <> $2)`,
    [userId, exceptSid]
  );
  return rowCount;
}

export function requireAuth(req, res, next) {
  const s = req.session;
  if (!s?.userId) return res.status(401).json({ error: "not signed in" });
  // Sessions created before authenticatedAt existed get it stamped now,
  // so they age out normally from here on rather than being cut off.
  if (!s.authenticatedAt) s.authenticatedAt = Date.now();
  if (Date.now() - s.authenticatedAt > ABSOLUTE_MS) {
    return s.destroy(() => res.status(401).json({ error: "session expired, please sign in again" }));
  }
  req.userId = s.userId;
  next();
}
