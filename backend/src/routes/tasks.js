import { Router } from "express";
import { pool } from "../db.js";
import { nextDueDate, spawnNextOccurrence } from "./deadlines.js";

export const tasksRouter = Router();

// Marking a recurring plain task done spawns the next occurrence as a
// fresh row, same "new row, not the same row advanced in place" shape
// as deadlines.js's spawnNextOccurrence (see that function's comment
// for why) - a completed task should stay in the done list exactly as
// it is, not silently flip back to open with a later date. Only ever
// called for tasks with no deadline_id: a deadline-linked task's
// recurrence is driven by the deadline it belongs to (see
// routes/deadlines.js), not by this column, so this path never
// double-spawns alongside that one.
//
// Carries tag_id and estimate_minutes forward - the new occurrence is
// the "same" recurring task, so its category and effort estimate should
// still apply. last_touched_at is NOT carried forward: it defaults to
// now() on the fresh row, which is exactly right - a brand new
// occurrence hasn't been sitting untouched, its staleness clock should
// start over.
async function spawnNextTaskOccurrence(userId, completed) {
  const nextDue = nextDueDate(completed.due_date, completed.recurrence);
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, due_date, recurrence, tag_id, estimate_minutes, user_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [completed.title, nextDue, completed.recurrence, completed.tag_id, completed.estimate_minutes, userId]
  );
  return rows[0];
}

// Shared SELECT fragment: tag_name/tag_color joined the same way
// sessions.js already joins them, so the frontend gets the tag's
// display info without a second round trip - needed for the priority
// engine's category-balance/energy-fit factors and for showing the tag
// on a task row at all.
const TASK_SELECT = `SELECT t.*, tg.name AS tag_name, tg.color AS tag_color
FROM tasks t LEFT JOIN tags tg ON tg.id = t.tag_id`;

tasksRouter.get("/tasks", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${TASK_SELECT} WHERE t.user_id = $1 AND t.status = 'open' ORDER BY t.due_date ASC NULLS LAST, t.created_at ASC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list tasks" });
  }
});

// Feature 2 (estimate learning) needs completed tasks that carry both a
// tag and an estimate to compare against actual logged time - open
// tasks obviously can't tell you anything about actual-vs-estimated yet,
// and a completed task missing either field has nothing to learn from.
// Filtered here rather than client-side so a account with years of
// history isn't shipping every ever-completed task down the wire just
// to throw most of them away. Actual time isn't computed here - the
// frontend already has the full session history in hand (`history`,
// with task_id on each row) and cross-references it there, one less
// place this could disagree with the numbers already on screen.
// Ordered newest-first and capped at 200: estimate accuracy is a rolling
// recent-behavior signal (see computeTagEstimateStats), not an
// all-time archive - old estimating habits from years ago shouldn't
// outweigh how someone estimates today.
tasksRouter.get("/tasks/completed", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${TASK_SELECT}
       WHERE t.user_id = $1 AND t.status = 'done' AND t.tag_id IS NOT NULL AND t.estimate_minutes IS NOT NULL
       ORDER BY t.updated_at DESC LIMIT 200`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list completed tasks" });
  }
});

tasksRouter.post("/tasks", async (req, res) => {
  const { title, due_date, recurrence, tag_id, estimate_minutes } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  // A recurrence needs a date to advance from - without one there's
  // nothing for nextDueDate to step forward when this eventually gets
  // marked done, so reject rather than silently storing a recurrence
  // that could never actually fire.
  if (recurrence && recurrence !== "none" && !due_date) {
    return res.status(400).json({ error: "a due date is required to repeat a task" });
  }
  if (estimate_minutes != null && (typeof estimate_minutes !== "number" || estimate_minutes <= 0)) {
    return res.status(400).json({ error: "estimate_minutes must be a positive number" });
  }
  try {
    const { rows } = await pool.query(
      `WITH inserted AS (
         INSERT INTO tasks (title, due_date, recurrence, tag_id, estimate_minutes, user_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
       )
       SELECT inserted.*, tg.name AS tag_name, tg.color AS tag_color
       FROM inserted LEFT JOIN tags tg ON tg.id = inserted.tag_id`,
      [title.trim(), due_date || null, recurrence || "none", tag_id || null, estimate_minutes || null, req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create task" });
  }
});

tasksRouter.patch("/tasks/:id", async (req, res) => {
  const { title, due_date, status, recurrence, tag_id, estimate_minutes } = req.body;
  if (recurrence && recurrence !== "none" && due_date === null) {
    return res.status(400).json({ error: "a due date is required to repeat a task" });
  }
  if (estimate_minutes != null && (typeof estimate_minutes !== "number" || estimate_minutes <= 0)) {
    return res.status(400).json({ error: "estimate_minutes must be a positive number" });
  }
  // tag_id/estimate_minutes need the same "was this key sent at all"
  // distinction sessions.js's PATCH already uses for task_id - COALESCE
  // against undefined would silently ignore a deliberate "clear the tag"
  // (tag_id: null) the same way it'd ignore a field that was never sent,
  // so both go through explicit CASE WHEN <field present> instead.
  const hasTagField = Object.prototype.hasOwnProperty.call(req.body, "tag_id");
  const hasEstimateField = Object.prototype.hasOwnProperty.call(req.body, "estimate_minutes");
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         due_date = COALESCE($4, due_date),
         status = COALESCE($5, status),
         recurrence = COALESCE($6, recurrence),
         tag_id = CASE WHEN $7 THEN $8 ELSE tag_id END,
         estimate_minutes = CASE WHEN $9 THEN $10 ELSE estimate_minutes END,
         last_touched_at = now(),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        req.userId,
        title,
        due_date,
        status,
        recurrence,
        hasTagField,
        tag_id || null,
        hasEstimateField,
        estimate_minutes || null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "task not found" });
    // Mirror completion back onto the deadline this task was created
    // from (see POST /deadlines' add_as_task), same reasoning as the
    // deadline -> task direction in routes/deadlines.js.
    if (rows[0].deadline_id && (status === "done" || status === "open")) {
      // Fetched before the mirror UPDATE below so the transition can be
      // detected (was it already done?) rather than just the end state -
      // guarding on the transition, not just "status is done", is what
      // stops a deadline that's already done from spawning a duplicate
      // occurrence every time this task gets touched again (e.g. a
      // second, redundant "mark done" click). Same guard shape as
      // deadlines.js's own PATCH handler uses for the same reason.
      const { rows: beforeRows } = await pool.query(
        `SELECT * FROM deadlines WHERE id = $1 AND user_id = $2`,
        [rows[0].deadline_id, req.userId]
      );
      const deadlineBefore = beforeRows[0];
      await pool.query(
        `UPDATE deadlines SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [rows[0].deadline_id, req.userId, status === "done" ? "done" : "active"]
      );
      // Completing a recurring deadline from its linked task (checking
      // the box here in the Tasks widget) used to skip this entirely -
      // only completing it from the Deadlines tab itself actually spawned
      // the next occurrence, since that spawn call lived solely in
      // routes/deadlines.js's own PATCH handler, which this mirror never
      // went through. Fixed here rather than left as a gap while adding
      // task-level recurrence right next to it in the same file.
      if (
        status === "done" &&
        deadlineBefore &&
        deadlineBefore.status !== "done" &&
        deadlineBefore.recurrence !== "none"
      ) {
        await spawnNextOccurrence(req.userId, deadlineBefore);
      }
    }
    // Own recurrence only applies to plain tasks (no deadline_id) - a
    // deadline-linked task's due date/recurrence is meaningless on its
    // own, it just mirrors whatever the deadline itself is doing.
    if (status === "done" && !rows[0].deadline_id && rows[0].recurrence !== "none" && rows[0].due_date) {
      await spawnNextTaskOccurrence(req.userId, rows[0]);
    }
    const { rows: joined } = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND t.user_id = $2`, [
      rows[0].id,
      req.userId,
    ]);
    res.json(joined[0] || rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update task" });
  }
});

// Feature 3's "bump"/defer action: resets the staleness clock without
// completing the task or changing anything else about it, for the
// "genuinely not time-sensitive yet" case the feature spec calls out. A
// dedicated endpoint rather than overloading PATCH with an empty body,
// since an empty PATCH body already means "no-op, change nothing" today
// (every field COALESCEs to its own current value) - reusing that same
// shape to mean "but do touch last_touched_at" would be a surprising
// special case buried in a handler that otherwise treats "nothing sent"
// as "nothing to do."
tasksRouter.post("/tasks/:id/bump", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH updated AS (
         UPDATE tasks SET last_touched_at = now() WHERE id = $1 AND user_id = $2 RETURNING *
       )
       SELECT updated.*, tg.name AS tag_name, tg.color AS tag_color
       FROM updated LEFT JOIN tags tg ON tg.id = updated.tag_id`,
      [req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "task not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to bump task" });
  }
});

tasksRouter.delete("/tasks/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete task" });
  }
});
