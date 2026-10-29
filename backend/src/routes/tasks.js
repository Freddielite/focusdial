import { asyncRouter } from "../lib/asyncRouter.js";
import { pool } from "../db.js";
import { nextDueDate, spawnNextOccurrence } from "./deadlines.js";
import { pushItemToGoogle } from "../lib/google.js";

export const tasksRouter = asyncRouter();

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
async function spawnNextTaskOccurrence(userId, completed, db = pool) {
  const nextDue = nextDueDate(completed.due_date, completed.recurrence);
  const { rows } = await db.query(
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
  const { title, due_date, recurrence, tag_id, estimate_minutes } = req.body || {};
  if (typeof title !== "string" || !title.trim()) {
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
      [title.trim(), due_date || null, recurrence || "none", tag_id || null, estimate_minutes ? Math.round(estimate_minutes) : null, req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create task" });
  }
});

tasksRouter.patch("/tasks/:id", async (req, res) => {
  const body = req.body || {};
  const { title, due_date, status, recurrence, tag_id, estimate_minutes } = body;
  if (title !== undefined && (typeof title !== "string" || !title.trim())) {
    return res.status(400).json({ error: "title can't be empty" });
  }
  if (recurrence && recurrence !== "none" && due_date === null) {
    return res.status(400).json({ error: "a due date is required to repeat a task" });
  }
  // tag_id/estimate_minutes/due_date need "was this key sent at all"
  // handling so an explicit null clears the field; clearing due_date also
  // clears recurrence (a recurrence needs a date to advance from).
  const hasTagField = Object.prototype.hasOwnProperty.call(body, "tag_id");
  const hasEstimateField = Object.prototype.hasOwnProperty.call(body, "estimate_minutes");
  const hasDueDateField = Object.prototype.hasOwnProperty.call(body, "due_date");

  const client = await pool.connect();
  let task;
  let spawnedDeadline = null;
  try {
    await client.query("BEGIN");
    // Lock and read the prior status, so recurrence spawning (for this task
    // and for a linked deadline) happens only on the open -> done
    // transition - a repeated "mark done" no longer spawns duplicates.
    const { rows: beforeRows } = await client.query(`SELECT status FROM tasks WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
      req.params.id,
      req.userId,
    ]);
    if (beforeRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "task not found" });
    }
    const wasDone = beforeRows[0].status === "done";
    const { rows } = await client.query(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         due_date = CASE WHEN $11 THEN $4 ELSE due_date END,
         status = COALESCE($5, status),
         recurrence = CASE WHEN $11 AND $4::date IS NULL THEN 'none' ELSE COALESCE($6, recurrence) END,
         tag_id = CASE WHEN $7 THEN $8 ELSE tag_id END,
         estimate_minutes = CASE WHEN $9 THEN $10 ELSE estimate_minutes END,
         last_touched_at = now(),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        req.userId,
        title === undefined ? null : title.trim(),
        due_date || null,
        status || null,
        recurrence || null,
        hasTagField,
        tag_id || null,
        hasEstimateField,
        estimate_minutes ? Math.round(estimate_minutes) : null,
        hasDueDateField,
      ]
    );
    task = rows[0];
    const becameDone = status === "done" && !wasDone;
    const reopened = status === "open" && wasDone;

    if (task.deadline_id && (becameDone || reopened)) {
      const { rows: dRows } = await client.query(`SELECT * FROM deadlines WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
        task.deadline_id,
        req.userId,
      ]);
      const deadlineBefore = dRows[0];
      await client.query(`UPDATE deadlines SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2`, [
        task.deadline_id,
        req.userId,
        becameDone ? "done" : "active",
      ]);
      if (becameDone && deadlineBefore && deadlineBefore.status !== "done" && deadlineBefore.recurrence !== "none") {
        spawnedDeadline = await spawnNextOccurrence(req.userId, deadlineBefore, client);
      }
    }
    if (becameDone && !task.deadline_id && task.recurrence !== "none" && task.due_date) {
      await spawnNextTaskOccurrence(req.userId, task, client);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (spawnedDeadline) await pushItemToGoogle(req.userId, "deadline", spawnedDeadline);
  const { rows: joined } = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND t.user_id = $2`, [task.id, req.userId]);
  res.json(joined[0] || task);
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
