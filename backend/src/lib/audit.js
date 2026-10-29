import { pool } from "../db.js";
import { log } from "./log.js";

// Records a security event. Never pass secrets in `detail`. Failure to
// write the audit row is logged but never fails the user's request.
export async function audit(req, userId, event, detail = null) {
  try {
    await pool.query(`INSERT INTO audit_log (user_id, event, ip, detail) VALUES ($1, $2, $3, $4)`, [
      userId || null,
      event,
      req?.ip || null,
      detail ? JSON.stringify(detail) : null,
    ]);
  } catch (err) {
    log.error("audit write failed", { event, err });
  }
}
