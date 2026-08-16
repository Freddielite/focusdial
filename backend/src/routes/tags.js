import { Router } from "express";
import { pool } from "../db.js";

export const tagsRouter = Router();

// Active tags only by default - the picker list for starting a new
// session, quick-start, manual entry, or assigning a budget/deadline
// should never surface something the person archived on purpose.
// ?include_archived=1 returns everything, for the two places that
// specifically need to know about a tag that's no longer active: the
// Session Log's edit modal (a past session may already reference an
// archived tag and needs to keep showing it correctly) and TagManager's
// own "show archived" section (so there's something to unarchive from).
tagsRouter.get("/tags", async (req, res) => {
  try {
    const includeArchived = req.query.include_archived === "1" || req.query.include_archived === "true";
    const { rows } = await pool.query(
      includeArchived
        ? `SELECT * FROM tags WHERE user_id = $1 ORDER BY archived ASC, name ASC`
        : `SELECT * FROM tags WHERE user_id = $1 AND archived = false ORDER BY name ASC`,
      [req.userId]
    );
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
  const { name, color, archived } = req.body;
  // budget_id needs three states: "not mentioned, leave alone", "set to a
  // budget", and "explicitly clear it" (null). A plain COALESCE can't tell
  // "not mentioned" apart from "explicitly null," so it's handled with its
  // own CASE branch, gated on whether the key was present in the body at
  // all - otherwise a request that only updates a tag's name/color would
  // silently wipe out its existing budget assignment. `archived` doesn't
  // need this treatment - it's a plain boolean with no meaningful "null"
  // state, so COALESCE($5, archived) already does the right thing whether
  // the client sends true, false, or omits it entirely.
  const hasBudgetField = Object.prototype.hasOwnProperty.call(req.body, "budget_id");
  try {
    const { rows } = await pool.query(
      `UPDATE tags SET
         name = COALESCE($3, name),
         color = COALESCE($4, color),
         archived = COALESCE($5, archived),
         budget_id = CASE WHEN $6 THEN $7 ELSE budget_id END
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId, name, color, archived, hasBudgetField, hasBudgetField ? req.body.budget_id : null]
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
    // Sessions referencing this tag keep their history - tag_id just goes
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
