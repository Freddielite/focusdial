import webpush from "web-push";
import { pool } from "../db.js";

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

export const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushConfigured) {
  webpush.setVapidDetails(
    VAPID_SUBJECT || "mailto:example@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  // Not fatal — the app still works without push configured, it just
  // can't send any. Reminders/automation become in-app-only in that
  // case. See HANDOVER.md for how to generate a VAPID key pair.
  console.warn(
    "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled. " +
      "Generate a key pair with `npx web-push generate-vapid-keys` and set them as env vars to enable."
  );
}

// Sends `payload` (an object with at least title/body) to every device
// belonging to one specific user — replaced the old sendPushToAll now
// that there's more than one person's devices to keep separate.
// Subscriptions that the push service reports as gone (410 Gone, or 404
// Not Found) are removed — those statuses mean the browser has
// permanently unsubscribed, not a transient failure, so retrying or
// keeping them around would just accumulate dead rows.
export async function sendPushToUser(userId, payload) {
  if (!pushConfigured) return { sent: 0, skipped: "not_configured" };

  // Soft master switch (Settings → Notifications). Checked here so a
  // single toggle silences every push path — cron automations and
  // app-driven events alike — without callers each having to remember
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
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      sent += 1;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
      } else {
        console.error("push send failed:", err.statusCode, err.body);
      }
    }
  }
  return { sent, total: subs.length };
}
