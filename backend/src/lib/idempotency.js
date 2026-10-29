import { pool } from "../db.js";

// Idempotency-Key support for authenticated POSTs. The frontend sends a
// fresh key per user action and re-sends the *same* key when it retries
// that action (network blip, Render cold start), so the retry replays the
// first response instead of creating a second session/deadline/task.
//
// Flow: claim (user_id, key) with INSERT ... ON CONFLICT DO NOTHING.
//   - claimed: run the handler, store its status + JSON body.
//   - already completed: replay the stored response.
//   - claimed but not completed (the first request is still running):
//     409, the client can retry shortly.
// A key reused for a different endpoint is a client bug -> 422.
// Keys are pruned after 24 hours by the cron tick.
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

export async function idempotency(req, res, next) {
  const key = req.get("Idempotency-Key");
  if (req.method !== "POST" || !key || !req.userId) return next();
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "invalid Idempotency-Key" });
  const path = req.originalUrl.split("?")[0];

  try {
    const claimed = await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, method, path) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [req.userId, key, req.method, path]
    );
    if (claimed.rowCount === 0) {
      const { rows } = await pool.query(`SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [req.userId, key]);
      const prior = rows[0];
      if (!prior) return next();
      if (prior.method !== req.method || prior.path !== path) {
        return res.status(422).json({ error: "Idempotency-Key was already used for a different request" });
      }
      if (prior.status_code == null) return res.status(409).json({ error: "this request is already being processed" });
      res.set("Idempotent-Replay", "true");
      if (prior.response == null) return res.status(prior.status_code).end();
      return res.status(prior.status_code).json(prior.response);
    }
  } catch (err) {
    return next(err);
  }

  // Record the outcome. Server errors (5xx) release the key so the client
  // can genuinely retry; everything else is stored for replay.
  const record = (status, body) => {
    const done =
      status >= 500
        ? pool.query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [req.userId, key])
        : pool.query(`UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2`, [
            req.userId,
            key,
            status,
            body === undefined ? null : JSON.stringify(body),
          ]);
    done.catch(() => {});
  };
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    record(res.statusCode, body);
    return originalJson(body);
  };
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    if (!res.headersSent || res.statusCode === 204) {
      if (res.statusCode === 204) record(204, undefined);
    }
    return originalEnd(...args);
  };
  next();
}
