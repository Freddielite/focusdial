// Run once, after registering your own account through the normal
// signup flow: `node scripts/migrate-legacy-data.js you@example.com`
//
// Before this app had real accounts, every row belonged to nobody in
// particular (user_id didn't exist yet). Adding user_id to every table
// (see db.js) was done as a purely additive, nullable column rather than
// trying to auto-detect and reassign ownership during schema init - // safer, but it means old data is invisible (every query filters by
// user_id) until it's explicitly claimed. This script does that claim,
// once, by hand.
import "dotenv/config";
import { pool } from "../src/db.js";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/migrate-legacy-data.js you@example.com");
  process.exit(1);
}

const TABLES = ["tags", "budgets", "sessions", "deadlines", "reminders", "tasks", "push_subscriptions"];

async function main() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
  if (rows.length === 0) {
    console.error(`No account found for ${email} - register through the app first, then run this.`);
    process.exit(1);
  }
  const userId = rows[0].id;

  for (const table of TABLES) {
    const { rowCount } = await pool.query(`UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL`, [userId]);
    console.log(`${table}: claimed ${rowCount} row(s)`);
  }

  // settings and google_account are one-row-per-user (unique on
  // user_id) - if a legacy singleton row exists (from before multi-user)
  // it's claimed the same way, but only if this user doesn't already
  // have their own row from signup, since that would collide with the
  // unique constraint.
  for (const table of ["settings", "google_account"]) {
    const { rows: existing } = await pool.query(`SELECT id FROM ${table} WHERE user_id = $1`, [userId]);
    if (existing.length > 0) {
      console.log(`${table}: you already have a row - skipping, legacy row (if any) left as-is`);
      continue;
    }
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL AND id = (SELECT id FROM ${table} WHERE user_id IS NULL LIMIT 1)`,
      [userId]
    );
    console.log(`${table}: claimed ${rowCount} row(s)`);
  }

  console.log(`Done - all unclaimed legacy data is now owned by ${email}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
