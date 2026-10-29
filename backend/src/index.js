import "dotenv/config";
import { createApp } from "./app.js";
import { pool } from "./db.js";
import { migrateUp, pendingMigrations } from "./migrate.js";
import { log } from "./lib/log.js";

process.on("unhandledRejection", (err) => log.error("unhandled rejection", { err }));

async function main() {
  // Schema changes run only when there's a migration that hasn't been
  // applied - an ordinary restart or cold start does no DDL at all.
  // Set MIGRATE_ON_BOOT=false to require `npm run migrate` as a separate
  // deploy step instead (recommended once on a paid Render plan, as a
  // pre-deploy command).
  const pending = await pendingMigrations();
  if (pending.length) {
    if (process.env.MIGRATE_ON_BOOT === "false") {
      throw new Error(`pending migrations: ${pending.map((m) => m.file).join(", ")} - run \`npm run migrate\``);
    }
    log.info("applying pending migrations on boot", { files: pending.map((m) => m.file) });
    await migrateUp();
  }

  const app = createApp();
  const port = process.env.PORT || 4000;
  const server = app.listen(port, () => log.info("focus tracker API listening", { port }));

  // Zero-downtime-friendly shutdown: Render sends SIGTERM before replacing
  // an instance. Stop accepting connections, let in-flight requests
  // finish, then close the pool.
  const shutdown = (signal) => {
    log.info("shutting down", { signal });
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error("fatal startup error", { err });
  process.exit(1);
});
