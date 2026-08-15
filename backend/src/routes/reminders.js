import { Router } from "express";
import { pool } from "../db.js";
import { pushItemToGoogle, deleteItemFromGoogle } from "../lib/google.js";

export const remindersRouter = Router();

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
  const { title, note, remind_at, recurrence } = req.body;
  if (!title || !title.trim() || !remind_at) {
    return res.status(400).json({ error: "title and remind_at are required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO reminders (title, note, remind_at, recurrence, user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title.trim(), note || null, remind_at, recurrence || "none", req.userId]
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
  const { title, note, remind_at, recurrence } = req.body;
  const hasNoteField = Object.prototype.hasOwnProperty.call(req.body, "note");
  try {
    const { rows } = await pool.query(
      `UPDATE reminders SET
         title = COALESCE($3, title),
         note = CASE WHEN $4 THEN $5 ELSE note END,
         remind_at = COALESCE($6, remind_at),
         recurrence = COALESCE($7, recurrence),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, title, hasNoteField, hasNoteField ? note : null, remind_at, recurrence]
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
  const { due_date, estimated_hours, tag_id } = req.body;
  if (!due_date || !estimated_hours) {
    return res.status(400).json({ error: "due_date and estimated_hours are required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: reminderRows } = await client.query(
      `SELECT * FROM reminders WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (reminderRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "reminder not found" });
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
  const { due_date } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: reminderRows } = await client.query(
      `SELECT * FROM reminders WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (reminderRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "reminder not found" });
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
