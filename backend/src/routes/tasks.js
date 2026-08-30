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
async function spawnNextTaskOccurrence(userId, completed) {
  const nextDue = nextDueDate(completed.due_date, completed.recurrence);
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, due_date, recurrence, user_id) VALUES ($1, $2, $3, $4) RETURNING *`,
    [completed.title, nextDue, completed.recurrence, userId]
  );
  return rows[0];
}

tasksRouter.get("/tasks", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tasks WHERE user_id = $1 AND status = 'open' ORDER BY due_date ASC NULLS LAST, created_at ASC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list tasks" });
  }
});

tasksRouter.post("/tasks", async (req, res) => {
  const { title, due_date, recurrence } = req.body;
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
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, due_date, recurrence, user_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), due_date || null, recurrence || "none", req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create task" });
  }
});

tasksRouter.patch("/tasks/:id", async (req, res) => {
  const { title, due_date, status, recurrence } = req.body;
  if (recurrence && recurrence !== "none" && due_date === null) {
    return res.status(400).json({ error: "a due date is required to repeat a task" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         due_date = COALESCE($4, due_date),
         status = COALESCE($5, status),
         recurrence = COALESCE($6, recurrence),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, title, due_date, status, recurrence]
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
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update task" });
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

