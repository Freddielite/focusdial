// Minimal in-memory fixed-window rate limiter for auth endpoints.
//
// Deliberately not a full library (e.g. express-rate-limit) to avoid
// adding a dependency for something this small - but the same caveat
// applies as to any in-memory limiter: state is per-process, so it
// resets on restart and isn't shared across horizontally-scaled
// instances. Fine for a single-instance deploy (this app's current
// target); if this ever runs as multiple instances behind a load
// balancer, back this with something shared (e.g. Postgres, which is
// already a dependency here, or Redis) instead.
//
// Keys combine IP + a second identifier (typically the submitted email)
// so a single attacker can't reset their own budget just by cycling
// emails from one IP, while a shared/proxied IP (many real users) still
// gets separate budgets per email.

const buckets = new Map();

// Sweep old entries periodically so this doesn't grow unbounded - sized
// off the largest windowMs any caller uses (see loginLimiter/registerLimiter
// below); doubled for headroom.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 30 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function makeLimiter({ windowMs, max }) {
  return function rateLimit(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { windowStart: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= max;
  };
}

// 10 attempts per 15 minutes per IP+email - generous enough for a real
// user who mistypes a password a few times, tight enough to make
// credential stuffing / password spraying against a single account slow
// and noisy rather than free.
const checkLoginAttempt = makeLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
// Looser budget for registration - the goal here is just to make
// mass account-enumeration slow, not to block normal signup traffic.
const checkRegisterAttempt = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

function clientIp(req) {
  // express's req.ip already honors "trust proxy" (set in index.js), so
  // this reflects the real client IP behind Render's reverse proxy
  // rather than the proxy's own address.
  return req.ip || "unknown";
}

export function loginRateLimit(req, res, next) {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const key = `login:${clientIp(req)}:${email}`;
  if (!checkLoginAttempt(key)) {
    return res.status(429).json({ error: "too many attempts, please wait a few minutes and try again" });
  }
  next();
}

export function registerRateLimit(req, res, next) {
  const key = `register:${clientIp(req)}`;
  if (!checkRegisterAttempt(key)) {
    return res.status(429).json({ error: "too many attempts, please wait a few minutes and try again" });
  }
  next();
}
