import { asyncRouter } from "../lib/asyncRouter.js";
import { pool } from "../db.js";

export const dataRouter = asyncRouter();

// Per-category wipe for the Settings → Reset data control. The user
// picks exactly which categories to clear, so this takes an explicit
// list rather than being all-or-nothing.
//
// Foreign keys are all declared ON DELETE SET NULL (see db.js), so the
// categories don't have to be deleted in dependency order - clearing
// tags, for instance, just nulls out sessions.tag_id and
// deadlines.tag_id rather than failing or cascading. Everything still
// runs in one transaction so a mid-way error can't leave a half-wiped
// database. Every statement is scoped to the requesting user's own rows
// only - $1 is always req.userId.
const CATEGORY_SQL = {
  sessions: `DELETE FROM sessions WHERE user_id = $1`,
  tags: `DELETE FROM tags WHERE user_id = $1`,
  budgets: `DELETE FROM budgets WHERE user_id = $1`,
  deadlines: `DELETE FROM deadlines WHERE user_id = $1`,
  reminders: `DELETE FROM reminders WHERE user_id = $1`,
  tasks: `DELETE FROM tasks WHERE user_id = $1`,
  // "preferences" doesn't drop the settings row - it resets the
  // notification/automation toggles back to their defaults (all on) and
  // clears the streak-nudge bookkeeping. timezone_offset_minutes is left
  // alone since the app re-syncs it on the next load anyway.
  preferences: `
    UPDATE settings SET
      push_enabled = true,
      automation_reminders = true,
      automation_deadline_pace = true,
      automation_streak = true,
      automation_runaway_timer = true,
      automation_weekly_digest = true,
      automation_google_sync = true,
      automation_category_nudge = true,
      automation_risk_reminders = true,
      notify_session_completed = true,
      notify_deadline_completed = true,
      notify_budget_reached = true,
      streak_recovery_grace_enabled = false,
      rest_day_of_week = NULL,
      daily_focus_goal_seconds = NULL,
      weekly_digest_day_of_week = 0,
      weekly_digest_hour = 19,
      due_toast_interval_minutes = 60,
      last_streak_nudge_date = NULL,
      last_weekly_digest_week = NULL,
      updated_at = now()
    WHERE user_id = $1`,
};

dataRouter.post("/data/reset", async (req, res) => {
  const { categories } = req.body || {};
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: "categories must be a non-empty array" });
  }

  const invalid = categories.filter((c) => typeof c !== "string" || !Object.prototype.hasOwnProperty.call(CATEGORY_SQL, c));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `unknown categories: ${invalid.join(", ")}` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cleared = [];
    // De-duplicate so passing the same category twice can't double-run.
    for (const category of [...new Set(categories)]) {
      await client.query(CATEGORY_SQL[category], [req.userId]);
      cleared.push(category);
    }
    await client.query("COMMIT");
    res.json({ ok: true, cleared });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("data reset failed:", err);
    res.status(500).json({ error: "failed to reset data" });
  } finally {
    client.release();
  }
});
