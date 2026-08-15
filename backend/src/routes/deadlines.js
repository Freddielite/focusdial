import { Router } from "express";
import { pool } from "../db.js";
import { pushItemToGoogle, deleteItemFromGoogle } from "../lib/google.js";

export const deadlinesRouter = Router();

deadlinesRouter.get("/deadlines", async (req, res) => {
  const status = req.query.status; // optional filter, e.g. ?status=active
  try {
    const { rows } = status
      ? await pool.query(
          `SELECT d.*, t.name AS tag_name, t.color AS tag_color
           FROM deadlines d LEFT JOIN tags t ON t.id = d.tag_id
           WHERE d.user_id = $1 AND d.status = $2 ORDER BY d.due_date ASC`,
          [req.userId, status]
        )
      : await pool.query(
          `SELECT d.*, t.name AS tag_name, t.color AS tag_color
           FROM deadlines d LEFT JOIN tags t ON t.id = d.tag_id
           WHERE d.user_id = $1
           ORDER BY d.due_date ASC`,
          [req.userId]
        );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list deadlines" });
  }
});

deadlinesRouter.post("/deadlines", async (req, res) => {
  const { title, tag_id, due_date, due_time, estimated_hours, add_as_task } = req.body;
  if (!title || !title.trim() || !due_date || !estimated_hours) {
    return res.status(400).json({ error: "title, due_date, and estimated_hours are required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO deadlines (title, tag_id, due_date, due_time, estimated_hours, user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title.trim(), tag_id || null, due_date, due_time || null, estimated_hours, req.userId]
    );
    if (add_as_task) {
      await pool.query(
        `INSERT INTO tasks (title, due_date, deadline_id, user_id) VALUES ($1, $2, $3, $4)`,
        [title.trim(), due_date, rows[0].id, req.userId]
      );
    }
    await pushItemToGoogle(req.userId, "deadline", rows[0]); // no-op if Google isn't connected
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create deadline" });
  }
});

deadlinesRouter.patch("/deadlines/:id", async (req, res) => {
  const { title, tag_id, due_date, due_time, estimated_hours, status } = req.body;
  const hasTagField = Object.prototype.hasOwnProperty.call(req.body, "tag_id");
  // due_time needs the same "was this field even sent" treatment as
  // tag_id (rather than plain COALESCE) so a request that wants to clear
  // the time back to "just a date" can send due_time: null and have it
  // stick, instead of COALESCE silently keeping the old value.
  const hasDueTimeField = Object.prototype.hasOwnProperty.call(req.body, "due_time");
  try {
    const { rows } = await pool.query(
      `UPDATE deadlines SET
         title = COALESCE($3, title),
         tag_id = CASE WHEN $4 THEN $5 ELSE tag_id END,
         due_date = COALESCE($6, due_date),
         due_time = CASE WHEN $7 THEN $8 ELSE due_time END,
         estimated_hours = COALESCE($9, estimated_hours),
         status = COALESCE($10, status),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        req.userId,
        title,
        hasTagField,
        hasTagField ? tag_id : null,
        due_date,
        hasDueTimeField,
        hasDueTimeField ? due_time : null,
        estimated_hours,
        status,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "deadline not found" });
    // Mirror completion onto a linked task (from "Add as task" at
    // creation, see POST above) so the two never disagree about
    // whether the work is done.
    if (status === "done" || status === "active") {
      await pool.query(
        `UPDATE tasks SET status = $3, updated_at = now() WHERE deadline_id = $1 AND user_id = $2`,
        [rows[0].id, req.userId, status === "done" ? "done" : "open"]
      );
    }
    // 'active' stays mirrored; anything else (done/archived) means it's
    // no longer relevant on the calendar, so remove the event instead of
    // leaving a stale entry sitting there.
    if (rows[0].status === "active") {
      await pushItemToGoogle(req.userId, "deadline", rows[0]);
    } else {
      await deleteItemFromGoogle(req.userId, "deadline", rows[0].id);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update deadline" });
  }
});

// Adds to manual_hours_logged atomically (read-modify-write in SQL rather
// than in JS) - only meaningful for deadlines with no linked tag, since
// tag-linked ones compute progress from real session history instead
// (see the frontend's analytics for that calculation).
deadlinesRouter.post("/deadlines/:id/log", async (req, res) => {
  const { hours } = req.body;
  if (typeof hours !== "number" || hours <= 0) {
    return res.status(400).json({ error: "hours must be a positive number" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE deadlines SET manual_hours_logged = manual_hours_logged + $3, updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, hours]
    );
    if (rows.length === 0) return res.status(404).json({ error: "deadline not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to log progress" });
  }
});

deadlinesRouter.delete("/deadlines/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM deadlines WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    await deleteItemFromGoogle(req.userId, "deadline", req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete deadline" });
  }
});
