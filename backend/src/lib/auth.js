import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function isValidPassword(password) {
  return typeof password === "string" && password.length >= 8;
}

// Every data route (sessions, tags, deadlines, everything) goes through
// this. Attaches req.userId from the session cookie set at login - a
// missing/invalid session is a 401, not a redirect, since this is an API
// consumed by the SPA, not server-rendered pages.
export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "not signed in" });
  }
  req.userId = req.session.userId;
  next();
}
