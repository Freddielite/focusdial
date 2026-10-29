import { pool } from "../db.js";

// Every write route that accepts a reference to another row (a session's
// tag/task, a task's or deadline's tag, a tag's budget) used to trust the
// id it was given. Ownership of the row being *edited* was always checked
// (`WHERE id = $1 AND user_id = $2`), but the row being *pointed at* was
// not - so a request could attach your session/task/deadline to someone
// else's tag or task, or your tag to someone else's budget. The joins
// that build every response (`LEFT JOIN tags t ON t.id = s.tag_id`, etc.)
// would then hand back that other account's tag name/color or task title.
//
// One middleware rather than a check in each of ~9 handlers, so a future
// route that accepts one of these fields is covered automatically instead
// of depending on someone remembering to add the check.
const REFERENCE_FIELDS = {
  tag_id: "tags",
  task_id: "tasks",
  budget_id: "budgets",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireOwnedReferences(req, res, next) {
  if (!["POST", "PATCH", "PUT"].includes(req.method)) return next();
  const body = req.body;
  if (!req.userId || !body || typeof body !== "object") return next();

  try {
    for (const [field, table] of Object.entries(REFERENCE_FIELDS)) {
      const value = body[field];
      // null/""/undefined all mean "no reference" (or "clear it") - the
      // route handlers already treat them that way.
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        return res.status(400).json({ error: `invalid ${field}` });
      }
      const { rowCount } = await pool.query(
        `SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`,
        [value, req.userId]
      );
      if (rowCount === 0) {
        return res.status(404).json({ error: `${field.replace("_id", "")} not found` });
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}
