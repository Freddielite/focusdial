import crypto from "node:crypto";
import { log } from "./log.js";

// Application-level encryption for secrets stored in Postgres (Google
// refresh/access tokens, TOTP secrets). The database provider already
// encrypts its disks; this protects against the more common leak - a
// database dump, a backup, or a read-only SQL session - exposing live
// credentials to someone's Google Calendar.
//
// TOKEN_ENCRYPTION_KEY: 32 random bytes, hex or base64. Values written
// without a key (or before this existed) are stored/read as plaintext so
// existing deployments keep working; they are re-encrypted the next time
// they are written once a key is set.
const PREFIX = "enc:v1:";
let key = null;
const raw = process.env.TOKEN_ENCRYPTION_KEY;
if (raw) {
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
  key = buf;
} else if (process.env.NODE_ENV === "production") {
  log.warn("TOKEN_ENCRYPTION_KEY not set - OAuth tokens and MFA secrets are stored unencrypted");
}

export function encryptSecret(plain) {
  if (plain == null || !key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(stored) {
  if (stored == null || !String(stored).startsWith(PREFIX)) return stored;
  if (!key) throw new Error("encrypted value found but TOKEN_ENCRYPTION_KEY is not set");
  const data = Buffer.from(String(stored).slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

// One-way hash for single-use tokens (password reset links, recovery
// codes): only the hash is stored, so a database leak doesn't hand out
// working reset links.
export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
