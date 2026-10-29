// Composite indexes for the per-user session queries (Session Log
// pagination orders by ended_at; history/analytics by started_at).
// Built CONCURRENTLY so the sessions table stays writable while they
// build - that can't run inside a transaction, hence transaction=false.
export const name = "session_indexes";
export const transaction = false;

export async function up(client) {
  await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_user_ended ON sessions(user_id, ended_at DESC)`);
  await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_user_started ON sessions(user_id, started_at)`);
  await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reminders_user_status ON reminders(user_id, status, remind_at)`);
}

export async function down(client) {
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_reminders_user_status`);
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_user_started`);
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_user_ended`);
}
