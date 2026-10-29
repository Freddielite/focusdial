import pg from "pg";
import { log } from "./lib/log.js";

const { Pool, types } = pg;

// Return DATE columns as the plain "YYYY-MM-DD" string Postgres sends,
// instead of node-pg's default of a JS Date at *server-local* midnight.
// That default broke two things: cron.js's String(due_date).slice(0, 10)
// produced "Thu Oct 01" (so the deadline pace check never saw a due date
// and "overdue" could never fire), and on any server not running in UTC
// the JSON-serialized date shifted a day (2026-11-01 -> 2026-10-31T23:00Z
// under Africa/Lagos). A calendar date has no timezone; keep it a string.
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. This app requires Postgres - see .env.example.");
}

const isLocal = /localhost|127\.0\.0\.1|host=\/|\/tmp/.test(process.env.DATABASE_URL);

// Managed Postgres needs TLS. With DATABASE_SSL_CA set (Supabase: Project
// Settings -> Database -> SSL certificate), the server certificate is
// actually verified. Without it the connection is encrypted but not
// authenticated (the previous behaviour), which allows a network-level
// man-in-the-middle - kept only as a fallback so existing deploys don't
// break, and warned about loudly in production.
function sslConfig() {
  if (isLocal) return false;
  const ca = process.env.DATABASE_SSL_CA;
  if (ca) return { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  if (process.env.NODE_ENV === "production") {
    log.warn("DATABASE_SSL_CA not set - database TLS certificate is NOT verified");
  }
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  // Supabase's session pooler caps total connections per project; keep
  // this app's share bounded and fail fast instead of hanging forever
  // when the pool is exhausted during a spike.
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 30_000,
});

// Without a listener, an error on an *idle* pooled client (the database
// restarting, a network blip) is emitted as an unhandled 'error' event
// and kills the process.
pool.on("error", (err) => log.error("idle postgres client error", { err }));
