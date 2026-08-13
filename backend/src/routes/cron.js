import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { sendPushToUser } from "../lib/push.js";
import { googleConfigured, getAuthedClient, getCalendarClient, fetchSyncTokenBaseline } from "../lib/google.js";

export const cronRouter = Router();

// --- Local-time approximation helpers -------------------------------
// The backend has no idea what timezone a user is actually in — only the
// fixed UTC offset they reported once via PUT /api/settings (see
// routes/settings.js). Shifting a UTC timestamp by that offset and then
// reading its UTC-calendar fields back off is the standard trick for
// approximating local wall-clock time without pulling in a full IANA
// timezone database. This is an approximation with a real limitation:
// it doesn't account for daylight saving time shifts, so it can be an
// hour off for users in DST-observing regions part of the year. Fine for
// "is it evening" / "which day is this" checks used here; would need a
// real timezone library (e.g. `date-fns-tz` or `luxon`) if more precision
// is ever needed.
function shiftToLocal(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * 60000);
}
// Zero-padded ISO date (YYYY-MM-DD) from an already-shifted "local" Date,
// reading its UTC-calendar fields (since shiftToLocal baked the offset
// into the timestamp itself — see the module comment above). Used both
// for same-day comparisons between sessions and for the plain-text
// last_streak_nudge_date column, so it needs to be exactly this format
// everywhere it's used, not just internally consistent.
function localDateISO(localDate) {
  const y = localDate.getUTCFullYear();
  const m = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(localDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function localHour(localDate) {
  return localDate.getUTCHours();
}

function nextOccurrence(date, recurrence) {
  const d = new Date(date);
  if (recurrence === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

async function checkDueReminders(userId) {
  const { rows: due } = await pool.query(
    `SELECT * FROM reminders
     WHERE user_id = $1 AND status = 'pending' AND remind_at <= now()
       AND (last_fired_at IS NULL OR last_fired_at < remind_at)`,
    [userId]
  );
  for (const r of due) {
    await sendPushToUser(userId, {
      title: "Reminder",
      body: r.title,
      tag: `reminder-${r.id}`,
      url: "/",
    });
    if (r.recurrence === "none") {
      await pool.query(`UPDATE reminders SET last_fired_at = remind_at WHERE id = $1`, [r.id]);
    } else {
      const next = nextOccurrence(new Date(r.remind_at), r.recurrence);
      await pool.query(
        `UPDATE reminders SET last_fired_at = remind_at, remind_at = $2, updated_at = now() WHERE id = $1`,
        [r.id, next.toISOString()]
      );
    }
  }
  return due.length;
}

// Duplicates a slimmed-down version of the frontend's deadline pace
// calculation (see frontend/src/analytics.js:computeDeadlineProgress) —
// intentionally, not accidentally. The frontend uses the browser's real
// local timezone; this uses the fixed offset from settings instead (see
// the module comment above). Keeping them as separate implementations
// means the frontend's calculation doesn't need to compromise its
// accuracy to stay identical to this approximation, and vice versa.
async function checkDeadlinePaceChanges(userId, offsetMinutes) {
  const { rows: deadlines } = await pool.query(`SELECT * FROM deadlines WHERE user_id = $1 AND status = 'active'`, [
    userId,
  ]);
  if (deadlines.length === 0) return 0;

  const { rows: sessions } = await pool.query(
    `SELECT tag_id, started_at, ended_at FROM sessions WHERE user_id = $1 AND ended_at IS NOT NULL`,
    [userId]
  );

  const nowLocal = shiftToLocal(new Date(), offsetMinutes);
  const todayStart = new Date(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()));

  // Average daily focus over the last 30 local days, same "include
  // zero-session days" reasoning as the frontend version.
  const thirtyDaysAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentSeconds = sessions
    .filter((s) => shiftToLocal(new Date(s.started_at), offsetMinutes) >= thirtyDaysAgo)
    .reduce((sum, s) => sum + (new Date(s.ended_at) - new Date(s.started_at)) / 1000, 0);
  const avgDailyFocusHours = recentSeconds / 30 / 3600;

  let changed = 0;
  for (const d of deadlines) {
    let completedHours;
    if (d.tag_id) {
      const createdAt = new Date(d.created_at);
      const seconds = sessions
        .filter((s) => s.tag_id === d.tag_id && new Date(s.started_at) >= createdAt)
        .reduce((sum, s) => sum + (new Date(s.ended_at) - new Date(s.started_at)) / 1000, 0);
      completedHours = seconds / 3600;
    } else {
      completedHours = Number(d.manual_hours_logged) || 0;
    }
    const remainingHours = Math.max(0, Number(d.estimated_hours) - completedHours);

    // Same fix as computeDeadlineProgress on the frontend: derive
    // days/hours left from the exact due moment (date + optional
    // time-of-day), not a whole-calendar-day count -- the old version
    // ignored due_time entirely, so it could mark a deadline "overdue"
    // (and push a notification saying so) first thing in the morning on
    // its due date, many hours before it was actually due.
    const [dY, dM, dD] = String(d.due_date).slice(0, 10).split("-").map(Number);
    const dueAtLocal = d.due_time
      ? new Date(Date.UTC(dY, dM - 1, dD, ...String(d.due_time).split(":").map(Number)))
      : new Date(Date.UTC(dY, dM - 1, dD, 23, 59, 59, 999));
    const hoursLeft = (dueAtLocal.getTime() - nowLocal.getTime()) / 3_600_000;
    const daysLeft = hoursLeft / 24;
    const hoursPerDayNeeded = daysLeft > 0 ? remainingHours / daysLeft : remainingHours;

    let status;
    if (remainingHours <= 0) status = "done";
    else if (hoursLeft <= 0) status = "overdue";
    else if (avgDailyFocusHours <= 0) status = "unknown";
    else {
      const ratio = hoursPerDayNeeded / avgDailyFocusHours;
      if (ratio <= 0.7) status = "ahead";
      else if (ratio <= 1.05) status = "onTrack";
      else if (ratio <= 1.5) status = "tight";
      else status = "behind";
    }

    // Only push for the statuses someone would actually want to act on —
    // a shift into "ahead" or "onTrack" isn't worth interrupting someone
    // for, but "tight"/"behind"/"overdue" are.
    const worthNotifying = ["tight", "behind", "overdue"].includes(status);
    if (status !== d.last_notified_status && worthNotifying) {
      await sendPushToUser(userId, {
        title: `Deadline update: ${d.title}`,
        body:
          status === "overdue"
            ? "This deadline is now overdue."
            : `You need ${hoursPerDayNeeded.toFixed(1)}h/day to finish in time, that's ${status === "tight" ? "tight" : "behind"} your usual pace.`,
        tag: `deadline-${d.id}`,
        url: "/",
      });
      changed += 1;
    }
    if (status !== d.last_notified_status) {
      await pool.query(`UPDATE deadlines SET last_notified_status = $2 WHERE id = $1`, [d.id, status]);
    }
  }
  return changed;
}

async function checkStreakAtRisk(userId, offsetMinutes, settings) {
  const nowLocal = shiftToLocal(new Date(), offsetMinutes);
  if (localHour(nowLocal) < 19) return false; // not evening yet, locally

  // A configured rest day never breaks the streak, so there's nothing at
  // risk to warn about — same rule the frontend's streak walk applies
  // (see analytics.js's computeSummary), just checked here too since
  // this runs independently while the app is closed.
  if (settings.rest_day_of_week !== null && nowLocal.getUTCDay() === settings.rest_day_of_week) return false;

  const todayKey = localDateISO(nowLocal);
  if (settings.last_streak_nudge_date === todayKey) return false; // already nudged today

  const { rows: sessions } = await pool.query(
    `SELECT started_at FROM sessions WHERE user_id = $1 AND ended_at IS NOT NULL AND started_at >= now() - interval '2 days'`,
    [userId]
  );
  const yesterdayLocal = new Date(nowLocal.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = localDateISO(yesterdayLocal);

  const hasToday = sessions.some((s) => localDateISO(shiftToLocal(new Date(s.started_at), offsetMinutes)) === todayKey);
  const hasYesterday = sessions.some(
    (s) => localDateISO(shiftToLocal(new Date(s.started_at), offsetMinutes)) === yesterdayKey
  );

  if (hasToday || !hasYesterday) return false; // no risk, or no streak to protect

  await sendPushToUser(userId, {
    title: "Your streak is at risk",
    body: "You haven't logged a session today. Log one before midnight to keep your streak alive.",
    tag: "streak-risk",
    url: "/",
  });
  await pool.query(`UPDATE settings SET last_streak_nudge_date = $1, updated_at = now() WHERE user_id = $2`, [
    todayKey,
    userId,
  ]);
  return true;
}

// Catches a session that's still running well past any reasonable
// length — almost always means it was forgotten, not that someone's
// genuinely been heads-down for 4+ hours straight. Left running, it
// silently skews todaySeconds and the streak calculation for as long as
// it stays open. runaway_nudged_at (on the session row itself) makes
// this fire once per session rather than every cron tick until it's
// finally stopped.
async function checkRunawayTimer(userId) {
  const { rows } = await pool.query(
    `SELECT id, started_at FROM sessions
     WHERE user_id = $1 AND ended_at IS NULL AND runaway_nudged_at IS NULL
       AND started_at < now() - interval '4 hours'
     LIMIT 1`,
    [userId]
  );
  if (rows.length === 0) return false;
  const session = rows[0];
  const hours = ((Date.now() - new Date(session.started_at).getTime()) / 3600000).toFixed(1);
  await sendPushToUser(userId, {
    title: "Still running?",
    body: `A session has been running for ${hours}h. Stop it if you're done, or it'll keep counting.`,
    tag: `runaway-${session.id}`,
    url: "/",
  });
  await pool.query(`UPDATE sessions SET runaway_nudged_at = now() WHERE id = $1`, [session.id]);
  return true;
}

// Monday-of-the-week key (YYYY-MM-DD, UTC-calendar fields on an
// already-shifted "local" date — same convention as localDateISO above)
// used only to dedupe the weekly digest to once per calendar week,
// mirroring last_streak_nudge_date's per-day dedupe.
function localMondayKey(localDate) {
  const day = localDate.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(localDate);
  monday.setUTCDate(monday.getUTCDate() + diff);
  return localDateISO(monday);
}

// Configurable "here's your week" push (day/hour come from Settings —
// see the db.js column comments on weekly_digest_day_of_week/hour —
// defaulting to Sunday evening for anyone who hasn't touched the
// setting) — reuses the same push infrastructure as the other
// automations, just on a weekly cadence instead of reacting to an event.
async function checkWeeklyDigest(userId, offsetMinutes, settings) {
  const nowLocal = shiftToLocal(new Date(), offsetMinutes);
  if (nowLocal.getUTCDay() !== settings.weekly_digest_day_of_week) return false;
  if (localHour(nowLocal) < settings.weekly_digest_hour) return false;

  const weekKey = localMondayKey(nowLocal);
  if (settings.last_weekly_digest_week === weekKey) return false; // already sent this week

  const { rows: sessions } = await pool.query(
    `SELECT started_at, ended_at FROM sessions
     WHERE user_id = $1 AND ended_at IS NOT NULL AND started_at >= now() - interval '7 days'`,
    [userId]
  );

  const dayTotals = new Map();
  let totalSeconds = 0;
  for (const s of sessions) {
    const key = localDateISO(shiftToLocal(new Date(s.started_at), offsetMinutes));
    const secs = (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
    dayTotals.set(key, (dayTotals.get(key) || 0) + secs);
    totalSeconds += secs;
  }

  let bestDayKey = null;
  let bestSeconds = 0;
  for (const [key, secs] of dayTotals) {
    if (secs > bestSeconds) {
      bestSeconds = secs;
      bestDayKey = key;
    }
  }
  const bestDayLabel = bestDayKey
    ? new Date(`${bestDayKey}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
    : null;
  const hours = (totalSeconds / 3600).toFixed(1);

  await sendPushToUser(userId, {
    title: "Your week in focus",
    body:
      totalSeconds > 0
        ? `You logged ${hours}h this week, best day was ${bestDayLabel}.`
        : "No focus sessions logged this week.",
    tag: "weekly-digest",
    url: "/",
  });
  await pool.query(`UPDATE settings SET last_weekly_digest_week = $1, updated_at = now() WHERE user_id = $2`, [
    weekKey,
    userId,
  ]);
  return true;
}

// Pull side of the two-way sync — the push side (mirroring FocusDial's
// own creates/edits/deletes out) lives in lib/google.js and is called
// directly from routes/deadlines.js and routes/reminders.js, not from
// here. This only looks for changes made *on Google's side*, for one
// specific user's connected calendar.
//
// Conflict handling is intentionally simple: last-edit-wins, decided by
// comparing each event's `updated` timestamp against google_updated (the
// timestamp recorded the last time *this app* synced that event in
// either direction). If they don't differ, this is just an echo of
// FocusDial's own last push, not a real remote edit, and is skipped. A
// genuine known limitation: if the same item is edited in FocusDial and
// in Google within the same poll window, whichever write actually
// reaches Google's servers last wins — there's no merge, no per-field
// diff, no user-facing conflict prompt. Acceptable for personal use per
// account; would need real operational-transform-style handling for
// anything more.
//
// Also deliberate: an event Google returns that has no row in
// google_event_links is left alone. This only syncs items FocusDial
// itself created — it never imports pre-existing or manually-added
// Google Calendar events as new deadlines/reminders.
async function checkGoogleCalendarSync(userId) {
  if (!googleConfigured) return { skipped: "not_configured" };

  const { rows: accountRows } = await pool.query(`SELECT * FROM google_account WHERE user_id = $1`, [userId]);
  const account = accountRows[0];
  if (!account || !account.refresh_token) return { skipped: "not_connected" };

  const authClient = await getAuthedClient(userId);
  if (!authClient) return { skipped: "not_connected" };
  const calendar = getCalendarClient(authClient);
  const calendarId = account.calendar_id || "primary";

  // Normally set right after connecting (see routes/googleAuth.js's
  // callback) — re-established here too in case it's ever missing, so
  // this can self-heal rather than staying stuck.
  if (!account.sync_token) {
    try {
      const syncToken = await fetchSyncTokenBaseline(calendar, calendarId);
      await pool.query(`UPDATE google_account SET sync_token = $1, updated_at = now() WHERE user_id = $2`, [
        syncToken,
        userId,
      ]);
    } catch (err) {
      console.error("failed to establish google sync token baseline:", err.message);
      return { skipped: "baseline_failed" };
    }
    return { skipped: "baseline_established" }; // nothing to diff yet — next tick does real work
  }

  let events = [];
  let pageToken;
  let nextSyncToken = account.sync_token;
  try {
    do {
      const { data } = await calendar.events.list({ calendarId, syncToken: account.sync_token, pageToken });
      events = events.concat(data.items || []);
      pageToken = data.nextPageToken;
      if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err.code === 410) {
      // Google's documented recovery for an expired/invalid sync token:
      // drop it and re-baseline. Changes made on Google's side between
      // now and the next successful poll are missed — a full historical
      // diff isn't attempted, out of scope for a periodic personal sync.
      console.warn("google sync token expired (410) — re-establishing baseline");
      try {
        const freshToken = await fetchSyncTokenBaseline(calendar, calendarId);
        await pool.query(`UPDATE google_account SET sync_token = $1, updated_at = now() WHERE user_id = $2`, [
          freshToken,
          userId,
        ]);
      } catch (err2) {
        console.error("failed to re-establish google sync token after 410:", err2.message);
      }
      return { skipped: "resynced_after_410" };
    }
    console.error("google calendar poll failed:", err.message);
    return { skipped: "poll_failed" };
  }

  let applied = 0;
  for (const event of events) {
    // No user_id filter needed here: google_event_id is already globally
    // unique, and the item_id it maps to already belongs to this user
    // (it could only have been pushed by this user's own
    // pushItemToGoogle call in the first place).
    const { rows: linkRows } = await pool.query(`SELECT * FROM google_event_links WHERE google_event_id = $1`, [
      event.id,
    ]);
    if (linkRows.length === 0) continue; // not something FocusDial created — leave it alone
    const link = linkRows[0];

    if (event.status === "cancelled") {
      if (link.item_type === "deadline") {
        await pool.query(`DELETE FROM deadlines WHERE id = $1`, [link.item_id]);
      } else {
        await pool.query(`UPDATE reminders SET status = 'dismissed', updated_at = now() WHERE id = $1`, [
          link.item_id,
        ]);
      }
      await pool.query(`DELETE FROM google_event_links WHERE item_type = $1 AND item_id = $2`, [
        link.item_type,
        link.item_id,
      ]);
      applied += 1;
      continue;
    }

    const remoteUpdated = event.updated ? new Date(event.updated) : null;
    if (link.google_updated && remoteUpdated && remoteUpdated <= new Date(link.google_updated)) {
      continue; // echo of FocusDial's own last push, not a real remote edit
    }

    if (link.item_type === "deadline") {
      const dueDate = event.start?.date; // all-day event
      if (dueDate) {
        await pool.query(`UPDATE deadlines SET title = $2, due_date = $3, updated_at = now() WHERE id = $1`, [
          link.item_id,
          event.summary || "Untitled",
          dueDate,
        ]);
      }
    } else {
      // Recurrence edits made on the Google side aren't parsed back into
      // FocusDial's daily/weekly/monthly enum — only title/note/time.
      const remindAt = event.start?.dateTime;
      if (remindAt) {
        await pool.query(
          `UPDATE reminders SET title = $2, note = $3, remind_at = $4, updated_at = now() WHERE id = $1`,
          [link.item_id, event.summary || "Untitled", event.description || null, remindAt]
        );
      }
    }
    await pool.query(`UPDATE google_event_links SET google_updated = $3 WHERE item_type = $1 AND item_id = $2`, [
      link.item_type,
      link.item_id,
      remoteUpdated,
    ]);
    applied += 1;
  }

  await pool.query(`UPDATE google_account SET sync_token = $1, updated_at = now() WHERE user_id = $2`, [
    nextSyncToken,
    userId,
  ]);
  return { synced: applied, total: events.length };
}

// Plain `!==` on a secret leaks timing information proportional to how
// many leading bytes match, which is (in principle) usable to recover
// the secret byte-by-byte. crypto.timingSafeEqual compares in constant
// time — but it throws on mismatched buffer lengths, so the length is
// checked separately (comparing against a fixed-length hash of both
// sides, rather than the raw values, sidesteps that without leaking the
// real secret's length through a thrown/caught exception timing gap).
function secretsMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handleTick(req, res) {
  const secret = req.header("x-cron-secret") || req.query.secret;
  if (!process.env.CRON_SECRET || !secretsMatch(secret, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    // One tick now runs every user's checks in a single pass — this used
    // to read one global settings row; now it loops over every user who
    // has one (every user gets a settings row at signup, see
    // routes/auth.js), each with their own independent
    // automation flags, timezone offset, and dedupe bookkeeping.
    const { rows: allSettings } = await pool.query(`SELECT * FROM settings WHERE user_id IS NOT NULL`);

    const perUser = [];
    for (const settings of allSettings) {
      const userId = settings.user_id;
      const offsetMinutes = settings.timezone_offset_minutes;

      // Each automation can be turned off independently from the
      // Settings tab. A disabled check is skipped entirely here rather
      // than relying on the push master switch downstream, so no work
      // (or state mutation like last_notified_status) happens for
      // something the user has opted out of. `push_enabled` is still
      // enforced separately in lib/push.js as the catch-all master mute.
      const remindersFired = settings.automation_reminders ? await checkDueReminders(userId) : 0;
      const paceChanges = settings.automation_deadline_pace
        ? await checkDeadlinePaceChanges(userId, offsetMinutes)
        : 0;
      const streakNudged = settings.automation_streak
        ? await checkStreakAtRisk(userId, offsetMinutes, settings)
        : false;
      const runawayNudged = settings.automation_runaway_timer ? await checkRunawayTimer(userId) : false;
      const digestSent = settings.automation_weekly_digest
        ? await checkWeeklyDigest(userId, offsetMinutes, settings)
        : false;
      const googleSync = settings.automation_google_sync
        ? await checkGoogleCalendarSync(userId)
        : { skipped: "disabled" };

      perUser.push({ userId, remindersFired, paceChanges, streakNudged, runawayNudged, digestSent, googleSync });
    }

    res.json({ ok: true, usersChecked: perUser.length, results: perUser });
  } catch (err) {
    console.error("cron tick failed:", err);
    res.status(500).json({ error: "cron tick failed" });
  }
}

cronRouter.get("/cron/tick", handleTick);
cronRouter.post("/cron/tick", handleTick);
