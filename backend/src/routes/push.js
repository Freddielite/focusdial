import { Router } from "express";
import { pool } from "../db.js";
import { pushConfigured } from "../lib/push.js";

export const pushRouter = Router();

pushRouter.get("/push/public-key", (req, res) => {
  res.json({ publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : null, configured: pushConfigured });
});

pushRouter.post("/push/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "a valid PushSubscription object is required" });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3, user_id = $4`,
      [endpoint, keys.p256dh, keys.auth, req.userId]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save subscription" });
  }
});

pushRouter.post("/push/unsubscribe", async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  try {
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, req.userId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to remove subscription" });
  }
});
