// Versioned migrations: each file in ./migrations runs once, in order,
// and is recorded in schema_migrations. Replaces the old initSchema(),
// which re-ran every ALTER TABLE on every boot.
//
//   npm run migrate            apply pending migrations
//   npm run migrate:down       roll back the most recent one
//   npm run migrate:status     list applied / pending
//
// Safety:
// - pg_advisory_lock: two instances booting at once can't both migrate.
// - lock_timeout 5s: if a table is busy, the migration fails fast and
//   can be retried, instead of queueing behind live traffic while every
//   later query queues behind *it* (the "locks the main table at 2pm"
//   failure mode).
// - transaction=false migrations (CREATE INDEX CONCURRENTLY) run outside
//   a transaction so they don't block writes.
import "dotenv/config";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { pool } from "./db.js";
import { log } from "./lib/log.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_ID = 727274001;

async function loadMigrations() {
  const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.js$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => ({ version: file.split("_")[0], file, mod: await import(pathToFileURL(path.join(DIR, file))) }))
  );
}

async function withLock(fn) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    return await fn(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

async function applied(client) {
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => r.version));
}

export async function pendingMigrations() {
  const all = await loadMigrations();
  const { rows } = await pool
    .query("SELECT version FROM schema_migrations")
    .catch((err) => (err.code === "42P01" ? { rows: [] } : Promise.reject(err)));
  const done = new Set(rows.map((r) => r.version));
  return all.filter((m) => !done.has(m.version));
}

export async function migrateUp() {
  return withLock(async (client) => {
    const done = await applied(client);
    const ran = [];
    for (const m of await loadMigrations()) {
      if (done.has(m.version)) continue;
      const inTx = m.mod.transaction !== false;
      log.info("applying migration", { file: m.file });
      try {
        if (inTx) await client.query("BEGIN");
        await client.query(`SET ${inTx ? "LOCAL " : ""}lock_timeout = '5s'`);
        await m.mod.up(client);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.mod.name || m.file]);
        if (inTx) await client.query("COMMIT");
        else await client.query("RESET lock_timeout");
        ran.push(m.file);
      } catch (err) {
        if (inTx) await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${m.file} failed: ${err.message}`);
      }
    }
    return ran;
  });
}

export async function migrateDown() {
  return withLock(async (client) => {
    const { rows } = await client.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
    if (!rows.length) return null;
    const m = (await loadMigrations()).find((x) => x.version === rows[0].version);
    if (!m) throw new Error(`no migration file for applied version ${rows[0].version}`);
    const inTx = m.mod.transaction !== false;
    try {
      if (inTx) await client.query("BEGIN");
      await client.query(`SET ${inTx ? "LOCAL " : ""}lock_timeout = '5s'`);
      await m.mod.down(client);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [m.version]);
      if (inTx) await client.query("COMMIT");
    } catch (err) {
      if (inTx) await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    return m.file;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || "up";
  try {
    if (cmd === "up") console.log("applied:", (await migrateUp()).join(", ") || "nothing pending");
    else if (cmd === "down") console.log("rolled back:", (await migrateDown()) || "nothing to roll back");
    else if (cmd === "status") {
      const pending = new Set((await pendingMigrations()).map((m) => m.version));
      for (const m of await loadMigrations()) console.log(pending.has(m.version) ? "pending " : "applied ", m.file);
    } else throw new Error(`unknown command ${cmd}`);
    await pool.end();
  } catch (err) {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  }
}
