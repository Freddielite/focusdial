import { asyncRouter } from "../lib/asyncRouter.js";
import { pool } from "../db.js";
import { pushItemToGoogle, deleteItemFromGoogle } from "../lib/google.js";

export const remindersRouter = asyncRouter();

remindersRouter.get("/reminders", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM reminders WHERE user_id = $1 AND status = 'pending' ORDER BY remind_at ASC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list reminders" });
  }
});

remindersRouter.post("/reminders", async (req, res) => {
  const { title, note, remind_at, recurrence, auto_source_type, auto_source_id } = req.body || {};
  if (typeof title !== "string" || !title.trim() || !remind_at) {
    return res.status(400).json({ error: "title and remind_at are required" });
  }
  // Both or neither -- see the auto_source_type column's CHECK
  // constraint in db.js for the valid type values; a source_id with no
  // type (or vice versa) can't be used for the dedup lookup
  // computeAutomationTriggers relies on, so it's rejected here rather
  // than silently stored as a half-tagged row.
  if ((auto_source_type == null) !== (auto_source_id == null)) {
    return res.status(400).json({ error: "auto_source_type and auto_source_id must be provided together" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO reminders (title, note, remind_at, recurrence, user_id, auto_source_type, auto_source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title.trim(), note || null, remind_at, recurrence || "none", req.userId, auto_source_type || null, auto_source_id || null]
    );
    await pushItemToGoogle(req.userId, "reminder", rows[0]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create reminder" });
  }
});

// Edits a pending reminder's own fields (title/note/remind_at/
// recurrence) -- distinct from dismiss/convert above, which change its
// status/lifecycle instead of its content. due_time has no equivalent
// here since remind_at already carries both date and time in one
// timestamp column.
remindersRouter.patch("/reminders/:id", async (req, res) => {
  const { title, note, remind_at, recurrence } = req.body || {};
  const hasNoteField = Object.prototype.hasOwnProperty.call(req.body || {}, "note");
  if (title !== undefined && (typeof title !== "string" || !title.trim())) {
    return res.status(400).json({ error: "title can't be empty" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE reminders SET
         title = COALESCE($3, title),
         note = CASE WHEN $4 THEN $5 ELSE note END,
         remind_at = COALESCE($6, remind_at),
         recurrence = COALESCE($7, recurrence),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, title === undefined ? null : title.trim(), hasNoteField, hasNoteField ? note || null : null, remind_at || null, recurrence || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: "reminder not found" });
    if (rows[0].status === "pending") {
      await pushItemToGoogle(req.userId, "reminder", rows[0]);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update reminder" });
  }
});

// Converts a fired reminder into a Deadline. The reminder's own note (if
// any) isn't carried over automatically - estimated_hours has to come
// from the person converting it, since a reminder has no sense of how
// long the resulting work will take.
remindersRouter.post("/reminders/:id/convert-to-deadline", async (req, res) => {
  const { due_date, estimated_hours, tag_id } = req.body || {};
  if (!due_date) return res.status(400).json({ error: "due_date is required" });
  if (typeof estimated_hours !== "number" || !(estimated_hours > 0)) {
    return res.status(400).json({ error: "estimated_hours must be a positive number" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE + the status check: converting is a one-time action. A
    // double click used to create two deadlines/tasks from one reminder.
    const { rows: reminderRows } = await client.query(
      `SELECT * FROM reminders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [req.params.id, req.userId]
    );
    if (reminderRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "reminder not found" });
    }
    if (reminderRows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `this reminder was already ${reminderRows[0].status}` });
    }
    const reminder = reminderRows[0];
    const { rows: deadlineRows } = await client.query(
      `INSERT INTO deadlines (title, tag_id, due_date, estimated_hours, user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [reminder.title, tag_id || null, due_date, estimated_hours, req.userId]
    );
    await client.query(
      `UPDATE reminders SET status = 'converted', converted_deadline_id = $2, updated_at = now() WHERE id = $1`,
      [req.params.id, deadlineRows[0].id]
    );
    await client.query("COMMIT");
    await deleteItemFromGoogle(req.userId, "reminder", req.params.id);
    await pushItemToGoogle(req.userId, "deadline", deadlineRows[0]);
    res.status(201).json(deadlineRows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "failed to convert reminder to deadline" });
  } finally {
    client.release();
  }
});

remindersRouter.post("/reminders/:id/convert-to-task", async (req, res) => {
  const { due_date } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE + the status check: converting is a one-time action. A
    // double click used to create two deadlines/tasks from one reminder.
    const { rows: reminderRows } = await client.query(
      `SELECT * FROM reminders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [req.params.id, req.userId]
    );
    if (reminderRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "reminder not found" });
    }
    if (reminderRows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `this reminder was already ${reminderRows[0].status}` });
    }
    const reminder = reminderRows[0];
    const { rows: taskRows } = await client.query(
      `INSERT INTO tasks (title, due_date, user_id) VALUES ($1, $2, $3) RETURNING *`,
      [reminder.title, due_date || null, req.userId]
    );
    await client.query(
      `UPDATE reminders SET status = 'converted', converted_task_id = $2, updated_at = now() WHERE id = $1`,
      [req.params.id, taskRows[0].id]
    );
    await client.query("COMMIT");
    await deleteItemFromGoogle(req.userId, "reminder", req.params.id);
    res.status(201).json(taskRows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "failed to convert reminder to task" });
  } finally {
    client.release();
  }
});

remindersRouter.post("/reminders/:id/dismiss", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE reminders SET status = 'dismissed', updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "reminder not found" });
    await deleteItemFromGoogle(req.userId, "reminder", req.params.id);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to dismiss reminder" });
  }
});

remindersRouter.delete("/reminders/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM reminders WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    await deleteItemFromGoogle(req.userId, "reminder", req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete reminder" });
  }
});
