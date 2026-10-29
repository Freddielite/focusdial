// In-memory fixed-window rate limiter for the unauthenticated auth
// endpoints. State is per process: fine for the single instance this app
// runs as; with more than one instance, move the buckets to Postgres or
// Redis (see OPERATIONS.md).
//
// Login uses three independent budgets, and a request must pass all of
// them:
//   ip+email   10 / 15 min   normal typo budget for one person
//   ip         50 / 15 min   stops one machine spraying many accounts
//                            (the old ip+email-only key let a sprayer get
//                            a fresh budget per email)
//   email     100 / 15 min   stops a botnet hammering one account from
//                            many IPs, while staying high enough that a
//                            stranger can't easily lock the real owner out
// Lockouts are always temporary (the window rolls over), never permanent,
// and a successful login doesn't depend on the attacker's traffic: the
// owner can also use password reset, which has its own separate budget.
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now - bucket.windowStart > 60 * 60 * 1000) buckets.delete(key);
}, 5 * 60 * 1000).unref();

function hit(key, windowMs, max) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

const WINDOW = 15 * 60 * 1000;
const clientIp = (req) => req.ip || "unknown";
const emailOf = (req) => (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "");

function tooMany(res) {
  res.set("Retry-After", String(WINDOW / 1000));
  return res.status(429).json({ error: "too many attempts, please wait a few minutes and try again" });
}

export function loginRateLimit(req, res, next) {
  const ip = clientIp(req);
  const email = emailOf(req);
  const ok = [hit(`login:ipemail:${ip}:${email}`, WINDOW, 10), hit(`login:ip:${ip}`, WINDOW, 50), hit(`login:email:${email}`, WINDOW, 100)];
  if (ok.includes(false)) return tooMany(res);
  next();
}

export function registerRateLimit(req, res, next) {
  if (!hit(`register:${clientIp(req)}`, WINDOW, 20)) return tooMany(res);
  next();
}

// Password reset requests: per IP and per email, so the endpoint can't be
// used to mail-bomb someone.
export function resetRateLimit(req, res, next) {
  const ok = [hit(`reset:ip:${clientIp(req)}`, WINDOW, 20), hit(`reset:email:${emailOf(req)}`, 60 * 60 * 1000, 5)];
  if (ok.includes(false)) return tooMany(res);
  next();
}

// MFA code checks: a 6-digit code has 1e6 values; 10 tries per 15 min per
// pending login makes guessing impractical.
export function mfaRateLimit(req, res, next) {
  const who = req.session?.pendingMfaUserId || req.session?.userId || clientIp(req);
  if (!hit(`mfa:${who}`, WINDOW, 10)) return tooMany(res);
  next();
}

export function _resetRateLimitsForTests() {
  buckets.clear();
}
