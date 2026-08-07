import { Router } from "express";
import { pool } from "../db.js";

export const tasksRouter = Router();

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
  const { title, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, due_date, user_id) VALUES ($1, $2, $3) RETURNING *`,
      [title.trim(), due_date || null, req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create task" });
  }
});

tasksRouter.patch("/tasks/:id", async (req, res) => {
  const { title, due_date, status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         due_date = COALESCE($4, due_date),
         status = COALESCE($5, status),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, title, due_date, status]
    );
    if (rows.length === 0) return res.status(404).json({ error: "task not found" });
    // Mirror completion back onto the deadline this task was created
    // from (see POST /deadlines' add_as_task), same reasoning as the
    // deadline -> task direction in routes/deadlines.js.
    if (rows[0].deadline_id && (status === "done" || status === "open")) {
      await pool.query(
        `UPDATE deadlines SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [rows[0].deadline_id, req.userId, status === "done" ? "done" : "active"]
      );
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
