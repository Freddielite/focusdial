import { Router } from "express";
import { pool } from "../db.js";

export const sessionsRouter = Router();

// Persisting the running session to the database (rather than only
// holding it in frontend memory/localStorage) means a page refresh or
// browser crash mid-session doesn't lose the fact that a timer was
// running — the frontend can recover it via GET /sessions/running.
sessionsRouter.get("/sessions/running", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, tk.title AS task_title
       FROM sessions s LEFT JOIN tasks tk ON tk.id = s.task_id
       WHERE s.user_id = $1 AND s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1`,
      [req.userId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to check running session" });
  }
});

sessionsRouter.post("/sessions/start", async (req, res) => {
  const { tag_id, note, task_id } = req.body;
  try {
    const { rows: existing } = await pool.query(
      `SELECT id FROM sessions WHERE user_id = $1 AND ended_at IS NULL LIMIT 1`,
      [req.userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "a session is already running" });
    }
    const { rows } = await pool.query(
      `INSERT INTO sessions (tag_id, started_at, note, source, task_id, user_id)
       VALUES ($1, now(), $2, 'timer', $3, $4) RETURNING *`,
      [tag_id || null, note || null, task_id || null, req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to start session" });
  }
});

const QUALITY_VALUES = ["focused", "neutral", "distracted"];

sessionsRouter.post("/sessions/:id/stop", async (req, res) => {
  const { note, quality } = req.body || {};
  if (quality && !QUALITY_VALUES.includes(quality)) {
    return res.status(400).json({ error: "quality must be focused, neutral, or distracted" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE sessions SET ended_at = now(), note = COALESCE($3, note), quality = COALESCE($4, quality), updated_at = now()
       WHERE id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING *`,
      [req.params.id, req.userId, note || null, quality || null]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "no running session with that id" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to stop session" });
  }
});

// Manual backfill entry — a fully-formed session with both timestamps
// already known, as opposed to the start/stop pair above which only
// knows the end time once you call /stop.
sessionsRouter.post("/sessions", async (req, res) => {
  const { tag_id, started_at, ended_at, note, quality, task_id } = req.body;
  if (!started_at || !ended_at) {
    return res.status(400).json({ error: "started_at and ended_at are required" });
  }
  if (new Date(ended_at) <= new Date(started_at)) {
    return res.status(400).json({ error: "ended_at must be after started_at" });
  }
  if (quality && !QUALITY_VALUES.includes(quality)) {
    return res.status(400).json({ error: "quality must be focused, neutral, or distracted" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO sessions (tag_id, started_at, ended_at, note, quality, source, task_id, user_id)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7) RETURNING *`,
      [tag_id || null, started_at, ended_at, note || null, quality || null, task_id || null, req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create session" });
  }
});

// Returns the full session history (capped generously) for the frontend
// to compute analytics from — streaks, best hour of day, tag breakdowns,
// etc. Deliberately done client-side rather than as a server aggregate:
// "today" and "this week" are timezone-sensitive, and the browser knows
// the user's actual local timezone, while the server would otherwise have
// to guess or assume UTC and get day boundaries subtly wrong.
sessionsRouter.get("/sessions/history", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.tag_id, s.started_at, s.ended_at, s.source, s.quality,
              t.name AS tag_name, t.color AS tag_color
       FROM sessions s LEFT JOIN tags t ON t.id = s.tag_id
       WHERE s.user_id = $1 AND s.ended_at IS NOT NULL
       ORDER BY s.started_at ASC
       LIMIT 5000`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load session history" });
  }
});

// Guards against CSV formula injection: a leading =/+/-/@ in a cell is
// how a spreadsheet app decides to evaluate it as a formula rather than
// display it as text, which matters here since `note` is free text the
// user controls. Prefixing with a single quote is the standard fix —
// Excel/Sheets both render it as literal text, quote stripped.
function csvCell(value) {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (/^[=+\-@]/.test(str)) str = `'${str}`;
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// Streams the full completed-session history for the Settings → Export
// control. Deliberately a separate endpoint from /sessions/history (which
// feeds the frontend's own analytics) since the two have different
// shapes and different consumers — one's JS-internal, this one produces
// a file meant to leave the app. Session-cookie protected like any other
// route here (unlike the ICS calendar export) since this is only ever
// opened by the same logged-in browser clicking a Settings button, never
// polled by an external service.
sessionsRouter.get("/sessions/export", async (req, res) => {
  const format = req.query.format === "json" ? "json" : "csv";
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.started_at, s.ended_at, s.note, s.source, s.quality,
              t.name AS tag_name
       FROM sessions s LEFT JOIN tags t ON t.id = s.tag_id
       WHERE s.user_id = $1 AND s.ended_at IS NOT NULL
       ORDER BY s.started_at ASC`,
      [req.userId]
    );

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", 'attachment; filename="sessions.json"');
      return res.send(
        JSON.stringify(
          rows.map((r) => ({
            id: r.id,
            tag: r.tag_name || null,
            started_at: r.started_at,
            ended_at: r.ended_at,
            duration_seconds: Math.round(
              (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000
            ),
            note: r.note || null,
            quality: r.quality || null,
            source: r.source,
          })),
          null,
          2
        )
      );
    }

    const lines = ["id,tag,started_at,ended_at,duration_seconds,note,quality,source"];
    for (const r of rows) {
      const durationSeconds = Math.round(
        (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000
      );
      lines.push(
        [r.id, r.tag_name || "", r.started_at, r.ended_at, durationSeconds, r.note || "", r.quality || "", r.source]
          .map(csvCell)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="sessions.csv"');
    res.send(lines.join("\n"));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to export sessions" });
  }
});

sessionsRouter.get("/sessions", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  // The COUNT(*) is a full scan of this user's completed sessions --
  // cheap at hobby-app scale, but there's no reason to redo it on every
  // plain Prev/Next click, since paging alone can never change the
  // total. Callers pass count=0 for that case and reuse the total they
  // already have; count=1 (the default) is for the initial load and
  // after anything that could actually change the row count (create,
  // delete).
  const includeTotal = req.query.count !== "0";
  try {
    const rowsPromise = pool.query(
      `SELECT s.*, t.name AS tag_name, t.color AS tag_color, tk.title AS task_title
       FROM sessions s LEFT JOIN tags t ON t.id = s.tag_id LEFT JOIN tasks tk ON tk.id = s.task_id
       WHERE s.user_id = $1 AND s.ended_at IS NOT NULL
       ORDER BY s.started_at DESC LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );
    const countPromise = includeTotal
      ? pool.query(`SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND ended_at IS NOT NULL`, [req.userId])
      : Promise.resolve(null);
    const [{ rows }, countResult] = await Promise.all([rowsPromise, countPromise]);
    // total: null tells the frontend "unchanged, keep what you already
    // have" rather than something it needs to react to.
    res.json({ sessions: rows, total: countResult ? Number(countResult.rows[0].count) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list sessions" });
  }
});

sessionsRouter.patch("/sessions/:id", async (req, res) => {
  const { tag_id, started_at, ended_at, note, quality, task_id } = req.body;
  // COALESCE-against-null looks right for started_at/ended_at (you'd
  // never intentionally PATCH a timestamp to null), but tag_id and note
  // are legitimately clearable — "remove the tag", "clear the note" —
  // and COALESCE can't tell "field omitted" from "field explicitly set
  // to null", so it silently no-ops those clears. hasOwnProperty checks
  // (same pattern as routes/deadlines.js's tag_id handling) fix that.
  const hasTagField = Object.prototype.hasOwnProperty.call(req.body, "tag_id");
  const hasNoteField = Object.prototype.hasOwnProperty.call(req.body, "note");
  const hasQualityField = Object.prototype.hasOwnProperty.call(req.body, "quality");
  const hasTaskField = Object.prototype.hasOwnProperty.call(req.body, "task_id");
  if (started_at && ended_at && new Date(ended_at) <= new Date(started_at)) {
    return res.status(400).json({ error: "ended_at must be after started_at" });
  }
  if (hasQualityField && quality && !QUALITY_VALUES.includes(quality)) {
    return res.status(400).json({ error: "quality must be focused, neutral, distracted, or null" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE sessions SET
         tag_id = CASE WHEN $7 THEN $3 ELSE tag_id END,
         started_at = COALESCE($4, started_at),
         ended_at = COALESCE($5, ended_at),
         note = CASE WHEN $8 THEN $6 ELSE note END,
         quality = CASE WHEN $9 THEN $10 ELSE quality END,
         task_id = CASE WHEN $11 THEN $12 ELSE task_id END,
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        req.userId,
        hasTagField ? tag_id : null,
        started_at,
        ended_at,
        hasNoteField ? note : null,
        hasTagField,
        hasNoteField,
        hasQualityField,
        hasQualityField ? quality : null,
        hasTaskField,
        hasTaskField ? task_id : null,
      ]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "session not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update session" });
  }
});

sessionsRouter.delete("/sessions/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM sessions WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete session" });
  }
});
