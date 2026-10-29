// Integration-test harness: a real app instance on a random port against
// a real Postgres (TEST_DATABASE_URL), migrated before the suite runs.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.SESSION_SECRET ||= "test-session-secret-test-session-secret";
process.env.CRON_SECRET ||= "test-cron-secret";
process.env.NODE_ENV = "test";
process.env.TOKEN_ENCRYPTION_KEY ||= "a".repeat(64);
process.env.CORS_ORIGIN ||= "*";

const { createApp } = await import("../src/app.js");
const { migrateUp } = await import("../src/migrate.js");
const { pool } = await import("../src/db.js");
const { _resetRateLimitsForTests } = await import("../src/lib/rateLimit.js");

export { pool };

export async function startServer(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  await migrateUp();
  const app = createApp();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

export function resetLimits() {
  _resetRateLimitsForTests();
}

let counter = 0;
export function uniqueEmail(prefix = "user") {
  counter += 1;
  return `${prefix}+${Date.now()}${counter}@example.com`;
}

// Minimal cookie-jar client.
export function client(base, { ip } = {}) {
  let cookie = "";
  async function request(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(ip ? { "X-Forwarded-For": ip } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const pair = c.split(";")[0];
      if (pair.startsWith("focusdial.sid=")) cookie = /Expires=Thu, 01 Jan 1970/.test(c) ? "" : pair;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    get: (p, h) => request("GET", p, undefined, h),
    post: (p, b = {}, h) => request("POST", p, b, h),
    patch: (p, b, h) => request("PATCH", p, b, h),
    put: (p, b, h) => request("PUT", p, b, h),
    del: (p, h) => request("DELETE", p, undefined, h),
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
  };
}

export function randomIp() {
  return `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`;
}

export async function signUp(base, opts = {}) {
  const c = client(base, { ip: opts.ip || randomIp() });
  const email = opts.email || uniqueEmail();
  const res = await c.post("/api/auth/register", { email, password: opts.password || "correct horse battery", displayName: opts.displayName });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  return { c, email, user: res.body };
}
