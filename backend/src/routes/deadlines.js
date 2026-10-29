import { asyncRouter } from "../lib/asyncRouter.js";
import { pool } from "../db.js";
import { pushItemToGoogle, deleteItemFromGoogle } from "../lib/google.js";

export const deadlinesRouter = asyncRouter();

// Same recurrence step reminders' cron-side nextOccurrence() (routes/cron.js)
// uses, but operating on a plain DATE rather than a TIMESTAMPTZ - a
// deadline's due_date has no time-of-day component of its own (due_time
// is separate and just carried over unchanged to the next occurrence).
// Exported: routes/tasks.js reuses this unchanged for plain recurring
// tasks (which also only ever carry a DATE, never a time), rather than
// duplicating the same date-stepping logic in a second file.
export function nextDueDate(dueDate, recurrence) {
  const d = new Date(`${String(dueDate).slice(0, 10)}T00:00:00Z`);
  if (recurrence === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// Marking a recurring deadline done spawns the next occurrence as a
// fresh row (see db.js's schema comment on deadlines.recurrence for why
// this doesn't just advance the same row the way a reminder does).
// Carries forward title/tag/due_time/estimated_hours/recurrence as-is,
// and recreates a linked task too if the just-completed deadline had
// one (from "Add as task" at creation, or from a later edit) - the
// point of a recurring deadline is that each occurrence behaves like a
// fresh one, task included, not just the deadline card by itself.
// Exported: routes/tasks.js calls this directly when a deadline-linked
// task is what actually completes the deadline (see that file's PATCH
// handler for why the mirror path needs its own call into this, not
// just this route's).
export async function spawnNextOccurrence(userId, completed, db = pool) {
  const nextDue = nextDueDate(completed.due_date, completed.recurrence);
  const { rows } = await db.query(
    `INSERT INTO deadlines (title, tag_id, due_date, due_time, estimated_hours, recurrence, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [completed.title, completed.tag_id, nextDue, completed.due_time, completed.estimated_hours, completed.recurrence, userId]
  );
  const spawned = rows[0];
  const { rows: linkedTasks } = await db.query(`SELECT id FROM tasks WHERE deadline_id = $1 AND user_id = $2`, [
    completed.id,
    userId,
  ]);
  if (linkedTasks.length > 0) {
    await db.query(`INSERT INTO tasks (title, due_date, deadline_id, user_id) VALUES ($1, $2, $3, $4)`, [
      completed.title,
      nextDue,
      spawned.id,
      userId,
    ]);
  }
  // Google sync is done by the caller *after* its transaction commits, so
  // a slow or failing Google API never holds a row lock or rolls back the
  // local write.
  return spawned;
}

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
  const { title, tag_id, due_date, due_time, estimated_hours, add_as_task, recurrence } = req.body || {};
  if (typeof title !== "string" || !title.trim() || !due_date) {
    return res.status(400).json({ error: "title and due_date are required" });
  }
  if (typeof estimated_hours !== "number" || estimated_hours <= 0) {
    return res.status(400).json({ error: "estimated_hours must be a positive number" });
  }
  // Deadline + its optional shadow task are one unit: both or neither.
  const client = await pool.connect();
  let created;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO deadlines (title, tag_id, due_date, due_time, estimated_hours, recurrence, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title.trim(), tag_id || null, due_date, due_time || null, estimated_hours, recurrence || "none", req.userId]
    );
    created = rows[0];
    if (add_as_task) {
      await client.query(`INSERT INTO tasks (title, due_date, deadline_id, user_id) VALUES ($1, $2, $3, $4)`, [
        title.trim(),
        due_date,
        created.id,
        req.userId,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await pushItemToGoogle(req.userId, "deadline", created); // no-op if Google isn't connected
  res.status(201).json(created);
});

deadlinesRouter.patch("/deadlines/:id", async (req, res) => {
  const { title, tag_id, due_date, due_time, estimated_hours, status, recurrence } = req.body || {};
  const hasTagField = Object.prototype.hasOwnProperty.call(req.body || {}, "tag_id");
  // due_time needs the "was this field sent" treatment too, so due_time:
  // null clears it back to "just a date" instead of COALESCE keeping it.
  const hasDueTimeField = Object.prototype.hasOwnProperty.call(req.body || {}, "due_time");
  if (title !== undefined && (typeof title !== "string" || !title.trim())) {
    return res.status(400).json({ error: "title can't be empty" });
  }

  const client = await pool.connect();
  let updated;
  let spawned = null;
  try {
    await client.query("BEGIN");
    // Lock the row and read its status *before* the update. Spawning the
    // next occurrence of a recurring deadline must happen only on the
    // transition into "done". The old code checked the request body
    // instead, so a double-click or retried "mark done" spawned a
    // duplicate next occurrence each time. FOR UPDATE also serializes two
    // simultaneous requests, so exactly one of them sees the transition.
    const { rows: beforeRows } = await client.query(`SELECT status FROM deadlines WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
      req.params.id,
      req.userId,
    ]);
    if (beforeRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "deadline not found" });
    }
    const before = beforeRows[0];
    const { rows } = await client.query(
      `UPDATE deadlines SET
         title = COALESCE($3, title),
         tag_id = CASE WHEN $4 THEN $5 ELSE tag_id END,
         due_date = COALESCE($6, due_date),
         due_time = CASE WHEN $7 THEN $8 ELSE due_time END,
         estimated_hours = COALESCE($9, estimated_hours),
         status = COALESCE($10, status),
         recurrence = COALESCE($11, recurrence),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        req.userId,
        title === undefined ? null : title.trim(),
        hasTagField,
        hasTagField ? tag_id || null : null,
        due_date || null,
        hasDueTimeField,
        hasDueTimeField ? due_time || null : null,
        estimated_hours ?? null,
        status || null,
        recurrence || null,
      ]
    );
    updated = rows[0];
    // Mirror completion onto a linked task so the two never disagree.
    if (status && status !== before.status && (status === "done" || status === "active")) {
      await client.query(`UPDATE tasks SET status = $3, updated_at = now() WHERE deadline_id = $1 AND user_id = $2`, [
        updated.id,
        req.userId,
        status === "done" ? "done" : "open",
      ]);
    }
    if (status === "done" && before.status !== "done" && updated.recurrence !== "none") {
      spawned = await spawnNextOccurrence(req.userId, updated, client);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Google mirror after commit (best-effort; see lib/google.js).
  if (updated.status === "active") await pushItemToGoogle(req.userId, "deadline", updated);
  else await deleteItemFromGoogle(req.userId, "deadline", updated.id);
  if (spawned) await pushItemToGoogle(req.userId, "deadline", spawned);
  res.json(updated);
});

// Adds to manual_hours_logged atomically (read-modify-write in SQL rather
// than in JS) - only meaningful for deadlines with no linked tag, since
// tag-linked ones compute progress from real session history instead
// (see the frontend's analytics for that calculation).
deadlinesRouter.post("/deadlines/:id/log", async (req, res) => {
  const { hours } = req.body || {};
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
