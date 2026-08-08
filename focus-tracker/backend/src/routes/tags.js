import { Router } from "express";
import { pool } from "../db.js";

export const tagsRouter = Router();

tagsRouter.get("/tags", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM tags WHERE user_id = $1 ORDER BY name ASC`, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list tags" });
  }
});

tagsRouter.post("/tags", async (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO tags (name, color, user_id) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), color || "#C9962C", req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "a tag with that name already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "failed to create tag" });
  }
});

tagsRouter.patch("/tags/:id", async (req, res) => {
  const { name, color } = req.body;
  // budget_id needs three states: "not mentioned, leave alone", "set to a
  // budget", and "explicitly clear it" (null). A plain COALESCE can't tell
  // "not mentioned" apart from "explicitly null," so it's handled with its
  // own CASE branch, gated on whether the key was present in the body at
  // all — otherwise a request that only updates a tag's name/color would
  // silently wipe out its existing budget assignment.
  const hasBudgetField = Object.prototype.hasOwnProperty.call(req.body, "budget_id");
  try {
    const { rows } = await pool.query(
      `UPDATE tags SET
         name = COALESCE($3, name),
         color = COALESCE($4, color),
         budget_id = CASE WHEN $5 THEN $6 ELSE budget_id END
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, name, color, hasBudgetField, hasBudgetField ? req.body.budget_id : null]
    );
    if (rows.length === 0) return res.status(404).json({ error: "tag not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update tag" });
  }
});

tagsRouter.delete("/tags/:id", async (req, res) => {
  try {
    // Sessions referencing this tag keep their history — tag_id just goes
    // null on them (ON DELETE SET NULL in the schema) rather than the
    // sessions themselves being deleted. Losing a session because you
    // renamed/removed a category would be a surprising, destructive side
    // effect for someone just tidying up their tag list.
    await pool.query(`DELETE FROM tags WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete tag" });
  }
});
