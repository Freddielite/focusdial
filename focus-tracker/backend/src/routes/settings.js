import { Router } from "express";
import { pool } from "../db.js";

export const settingsRouter = Router();

// Columns the client is allowed to update, with a validator each. Keeping
// this as an explicit allowlist (rather than trusting req.body keys)
// means a typo or a malicious extra field can't touch anything it
// shouldn't, and adding a new preference is a one-line change here.
const BOOLEAN_FIELDS = [
  "push_enabled",
  "automation_reminders",
  "automation_deadline_pace",
  "automation_streak",
  "automation_runaway_timer",
  "automation_weekly_digest",
  "automation_google_sync",
  "notify_session_completed",
  "notify_deadline_completed",
  "notify_budget_reached",
];

settingsRouter.get("/settings", async (req, res) => {
  try {
    // Get-or-create: a settings row is normally created alongside the
    // user account itself (see routes/auth.js), but this stays
    // defensive regardless — INSERT ... ON CONFLICT DO NOTHING RETURNING
    // * only returns a row if it actually inserted one, so an empty
    // result here means the row already existed and just needs a plain
    // SELECT.
    const inserted = await pool.query(
      `INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING *`,
      [req.userId]
    );
    if (inserted.rows.length > 0) return res.json(inserted.rows[0]);
    const { rows } = await pool.query(`SELECT * FROM settings WHERE user_id = $1`, [req.userId]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load settings" });
  }
});

// Partial update: only the keys actually present in the body are
// changed, so the same endpoint serves both the once-per-load timezone
// sync the app does automatically (see App.jsx) and the individual
// toggles flipped on the Settings tab, without either clobbering the
// other's columns.
//
// timezone_offset_minutes note: the frontend sends
// `-new Date().getTimezoneOffset()` (the sign is flipped — JS's
// getTimezoneOffset() is backwards from the usual "UTC+1" convention)
// so the cron job can approximate the user's local day/hour without a
// full IANA timezone database. See routes/cron.js for why it's an
// approximation and where that matters.
settingsRouter.put("/settings", async (req, res) => {
  const updates = [];
  const values = [req.userId];
  let i = 2;

  if ("timezone_offset_minutes" in req.body) {
    if (typeof req.body.timezone_offset_minutes !== "number") {
      return res.status(400).json({ error: "timezone_offset_minutes must be a number" });
    }
    updates.push(`timezone_offset_minutes = $${i++}`);
    values.push(req.body.timezone_offset_minutes);
  }

  if ("rest_day_of_week" in req.body) {
    const v = req.body.rest_day_of_week;
    if (v !== null && (typeof v !== "number" || v < 0 || v > 6 || !Number.isInteger(v))) {
      return res.status(400).json({ error: "rest_day_of_week must be an integer 0-6, or null" });
    }
    updates.push(`rest_day_of_week = $${i++}`);
    values.push(v);
  }

  for (const field of BOOLEAN_FIELDS) {
    if (field in req.body) {
      if (typeof req.body[field] !== "boolean") {
        return res.status(400).json({ error: `${field} must be a boolean` });
      }
      updates.push(`${field} = $${i++}`);
      values.push(req.body[field]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "no updatable fields provided" });
  }

  try {
    // Row should already exist (created at signup, or by the GET
    // handler's get-or-create above) — ON CONFLICT here is just a safety
    // net so a PUT before any GET still works rather than silently
    // updating zero rows.
    await pool.query(`INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [req.userId]);
    const { rows } = await pool.query(
      `UPDATE settings SET ${updates.join(", ")}, updated_at = now() WHERE user_id = $1 RETURNING *`,
      values
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update settings" });
  }
});
