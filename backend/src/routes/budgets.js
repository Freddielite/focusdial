import { Router } from "express";
import { pool } from "../db.js";

export const budgetsRouter = Router();

// Includes the list of tag ids/names currently assigned to each budget,
// so the frontend doesn't need a second round trip to show "this budget
// covers these tags."
budgetsRouter.get("/budgets", async (req, res) => {
  try {
    const { rows: budgets } = await pool.query(`SELECT * FROM budgets WHERE user_id = $1 ORDER BY name ASC`, [
      req.userId,
    ]);
    const { rows: tags } = await pool.query(
      `SELECT id, name, color, budget_id FROM tags WHERE user_id = $1 AND budget_id IS NOT NULL`,
      [req.userId]
    );
    const withTags = budgets.map((b) => ({
      ...b,
      tags: tags.filter((t) => t.budget_id === b.id),
    }));
    res.json(withTags);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list budgets" });
  }
});

budgetsRouter.post("/budgets", async (req, res) => {
  const { name, weekly_target_hours, color } = req.body;
  if (!name || !name.trim() || !weekly_target_hours) {
    return res.status(400).json({ error: "name and weekly_target_hours are required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO budgets (name, weekly_target_seconds, color, user_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), Math.round(weekly_target_hours * 3600), color || "#C9962C", req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "a budget with that name already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "failed to create budget" });
  }
});

budgetsRouter.patch("/budgets/:id", async (req, res) => {
  const { name, weekly_target_hours, color } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE budgets SET
         name = COALESCE($3, name),
         weekly_target_seconds = COALESCE($4, weekly_target_seconds),
         color = COALESCE($5, color)
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        req.params.id,
        req.userId,
        name,
        weekly_target_hours ? Math.round(weekly_target_hours * 3600) : null,
        color,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "budget not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update budget" });
  }
});

budgetsRouter.delete("/budgets/:id", async (req, res) => {
  try {
    // Tags assigned to this budget just lose the assignment (ON DELETE
    // SET NULL) - deleting a budget shouldn't delete the tags or the
    // session history behind them.
    await pool.query(`DELETE FROM budgets WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete budget" });
  }
});
