import { Router } from "express";
import { pool } from "../db.js";
import { sendPushToUser } from "../lib/push.js";

export const notifyRouter = Router();

// The three "app-driven" events — the ones that happen in response to
// something the user just did in the app (finishing a session, hitting a
// budget goal, completing a deadline), as opposed to the cron-driven
// automations that fire while the app is closed.
//
// The client shows an in-app toast for these itself and only calls this
// endpoint when the page is backgrounded/hidden (see push.js on the
// frontend), so the user gets a toast when looking and a push when not,
// never both at once. Each type maps to the settings column that gates
// it, so turning an event off in Settings suppresses its push even if
// the client still asks.
const EVENT_TO_SETTING = {
  session_completed: "notify_session_completed",
  deadline_completed: "notify_deadline_completed",
  budget_reached: "notify_budget_reached",
};

notifyRouter.post("/notify", async (req, res) => {
  const { type, title, body } = req.body || {};

  const settingColumn = EVENT_TO_SETTING[type];
  if (!settingColumn) {
    return res.status(400).json({ error: "unknown notification type" });
  }
  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT ${settingColumn} AS enabled FROM settings WHERE user_id = $1`,
      [req.userId]
    );
    if (rows[0] && rows[0].enabled === false) {
      // The user has this specific event switched off — not an error,
      // just nothing to send.
      return res.json({ ok: true, sent: 0, skipped: "event_disabled" });
    }

    const result = await sendPushToUser(req.userId, {
      title,
      body: body || "",
      tag: `event-${type}`,
      url: "/",
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("notify failed:", err);
    res.status(500).json({ error: "failed to send notification" });
  }
});
