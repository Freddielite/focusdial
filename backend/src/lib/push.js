import webpush from "web-push";
import { pool } from "../db.js";
import { log } from "./log.js";

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

export const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushConfigured) {
  webpush.setVapidDetails(
    VAPID_SUBJECT || "mailto:example@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  // Not fatal - the app still works without push configured, it just
  // can't send any. Reminders/automation become in-app-only in that
  // case. See HANDOVER.md for how to generate a VAPID key pair.
  log.warn("VAPID keys not set - push notifications are disabled (npx web-push generate-vapid-keys)");
}

// Sends `payload` (an object with at least title/body) to every device
// belonging to one specific user - replaced the old sendPushToAll now
// that there's more than one person's devices to keep separate.
// Subscriptions that the push service reports as gone (410 Gone, or 404
// Not Found) are removed - those statuses mean the browser has
// permanently unsubscribed, not a transient failure, so retrying or
// keeping them around would just accumulate dead rows.
export async function sendPushToUser(userId, payload) {
  if (!pushConfigured) return { sent: 0, skipped: "not_configured" };

  // Soft master switch (Settings → Notifications). Checked here so a
  // single toggle silences every push path - cron automations and
  // app-driven events alike - without callers each having to remember
  // to check it. Distinct from unsubscribing: the browser subscriptions
  // stay put, so flipping it back on needs no re-permission.
  const { rows: settingsRows } = await pool.query(`SELECT push_enabled FROM settings WHERE user_id = $1`, [userId]);
  if (settingsRows[0] && settingsRows[0].push_enabled === false) {
    return { sent: 0, skipped: "push_disabled" };
  }

  const { rows: subs } = await pool.query(`SELECT * FROM push_subscriptions WHERE user_id = $1`, [userId]);
  let sent = 0;
  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    // Transient failures (429 / 5xx / network) are retried twice with
    // backoff; 404/410 mean the browser unsubscribed for good.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 24 * 60 * 60 });
        sent += 1;
        break;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
          break;
        }
        const transient = !err.statusCode || err.statusCode === 429 || err.statusCode >= 500;
        if (!transient || attempt === 2) {
          log.error("push send failed", { status: err.statusCode, attempt });
          break;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  return { sent, total: subs.length };
}
