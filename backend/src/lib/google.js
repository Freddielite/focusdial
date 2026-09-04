import { google } from "googleapis";
import { pool } from "../db.js";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

export const googleConfigured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);

if (!googleConfigured) {
  // Not fatal - same shape as push.js's VAPID check below. The app
  // works without this set, Google Calendar linking is just hidden in
  // Settings. See HANDOVER.md for how to set up an OAuth client.
  console.warn(
    "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI not set - Google Calendar linking is disabled."
  );
}

function newOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function getAuthUrl(state) {
  return newOAuthClient().generateAuthUrl({
    access_type: "offline", // required to get a refresh_token back, not just a short-lived access_token
    prompt: "consent", // forces a refresh_token on every connect, not just the very first - otherwise reconnecting after a disconnect never gets one again
    scope: SCOPES,
    state,
  });
}

export async function exchangeCodeForTokens(code) {
  const { tokens } = await newOAuthClient().getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
}

export function buildClientWithTokens(tokens) {
  const client = newOAuthClient();
  client.setCredentials(tokens);
  return client;
}

export async function fetchConnectedEmail(authClient) {
  const oauth2 = google.oauth2({ version: "v2", auth: authClient });
  const { data } = await oauth2.userinfo.get();
  return data.email || null;
}

// --- "Sign in with Google" (login), separate from the calendar-linking
// flow above --- Deliberately its own redirect URI + scope set: logging
// in shouldn't require granting calendar access, and someone who never
// touches Google Calendar sync shouldn't be prompted for it just to use
// the app. access_type stays "online" (no refresh_token requested) since
// this only needs a one-off identity check - the app's own session
// cookie carries the login afterward, not a stored Google token.
const { GOOGLE_LOGIN_REDIRECT_URI } = process.env;
export const googleLoginConfigured = Boolean(
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_LOGIN_REDIRECT_URI
);

const LOGIN_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export function getLoginAuthUrl() {
  return newOAuthClient().generateAuthUrl({
    redirect_uri: GOOGLE_LOGIN_REDIRECT_URI,
    scope: LOGIN_SCOPES,
  });
}

// Returns { googleSub, email, name } - googleSub is Google's stable
// per-account id (the v2 userinfo endpoint's `id` field, equivalent to
// the id_token's `sub` claim), used to recognize the same person on
// every future login regardless of email changes.
export async function exchangeLoginCode(code) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken({ code, redirect_uri: GOOGLE_LOGIN_REDIRECT_URI });
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data } = await oauth2.userinfo.get();
  if (!data.id || !data.email) throw new Error("google did not return an account id/email");
  return { googleSub: data.id, email: data.email, name: data.name || null };
}

// Loads stored tokens and returns an authenticated client. googleapis'
// OAuth2 client refreshes an expired access_token on demand internally,
// but doesn't persist the new one anywhere by itself - the `tokens`
// event fires whenever that happens, which is the hook used here to
// write it back to the DB so the next call doesn't need to refresh
// again. Returns null if nothing is connected.
export async function getAuthedClient(userId) {
  const { rows } = await pool.query(`SELECT * FROM google_account WHERE user_id = $1`, [userId]);
  const account = rows[0];
  if (!account || !account.refresh_token) return null;

  const client = newOAuthClient();
  client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry ? new Date(account.token_expiry).getTime() : undefined,
  });
  client.on("tokens", (tokens) => {
    // refresh_token is only ever re-included by Google on the very
    // first grant (or when `prompt: consent` forces a fresh one) - a
    // silent refresh only returns a new access_token, so this must not
    // overwrite the stored refresh_token with undefined.
    pool
      .query(
        `UPDATE google_account SET access_token = $1, token_expiry = $2, updated_at = now() WHERE user_id = $3`,
        [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userId]
      )
      .catch((err) => console.error("failed to persist refreshed google token:", err));
  });
  return client;
}

export function getCalendarClient(authClient) {
  return google.calendar({ version: "v3", auth: authClient });
}

// Real, timed events on the person's actual calendar for the rest of
// today - as opposed to everything above, which only ever pushes
// FocusDial's own deadlines/reminders *out* and reads back changes to
// those same pushed events. This is the one place FocusDial reads
// someone's *other* calendar content, and only to compute free time
// with (Open Slots, the morning plan) - titles are returned since
// they're shown in the UI, but nothing here is stored.
//
// google_event_links-linked events (FocusDial's own reminders, pushed
// as 15-minute blocks - see reminderToEvent above) are excluded, or
// every reminder would double as a fake "meeting" eating into the free
// time being measured. All-day events are excluded too (no real
// start/end to treat as a busy block).
export async function fetchTodaysBusyBlocks(userId, authClient, dayEndHour = 21) {
  const calendar = getCalendarClient(authClient);
  const now = new Date();
  const dayEnd = new Date(now);
  dayEnd.setHours(dayEndHour, 0, 0, 0);
  if (dayEnd <= now) return []; // already past the configured end of day - no remaining window to check

  const { data } = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });
  const events = data.items || [];
  if (events.length === 0) return [];

  const { rows: linkRows } = await pool.query(
    `SELECT google_event_id FROM google_event_links
     WHERE google_event_id = ANY($1::text[])`,
    [events.map((e) => e.id)]
  );
  const ownIds = new Set(linkRows.map((r) => r.google_event_id));

  return events
    .filter((e) => e.start?.dateTime && e.end?.dateTime && !ownIds.has(e.id) && e.status !== "cancelled")
    .map((e) => ({ title: e.summary || "Busy", start: e.start.dateTime, end: e.end.dateTime }));
}

// Establishes (or re-establishes) the incremental-sync cursor. Google
// Calendar API's syncToken mechanism requires the *first* request in a
// sync sequence to carry whatever filters should apply throughout - // timeMin (only future events matter here) and showDeleted (so
// cancellations show up in later incremental polls) - and forbids
// combining those same filters with syncToken on later calls. So this
// paginates once with the filters, keeps only the final page's
// nextSyncToken, and every later poll (routes/cron.js) uses only that
// token with no other filters.
export async function fetchSyncTokenBaseline(calendar, calendarId) {
  let pageToken;
  let syncToken;
  do {
    const { data } = await calendar.events.list({
      calendarId,
      timeMin: new Date().toISOString(),
      singleEvents: true,
      showDeleted: true,
      pageToken,
    });
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) syncToken = data.nextSyncToken;
  } while (pageToken);
  return syncToken;
}

function deadlineToEvent(deadline) {
  const start = deadline.due_date; // "YYYY-MM-DD"
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1); // Google's all-day events use an exclusive end date
  return {
    summary: deadline.title,
    start: { date: start },
    end: { date: end.toISOString().slice(0, 10) },
  };
}

function reminderToEvent(reminder) {
  const start = new Date(reminder.remind_at);
  const end = new Date(start.getTime() + 15 * 60 * 1000);
  const event = {
    summary: reminder.title,
    description: reminder.note || undefined,
    start: { dateTime: start.toISOString(), timeZone: "UTC" },
    end: { dateTime: end.toISOString(), timeZone: "UTC" },
  };
  if (reminder.recurrence === "daily") event.recurrence = ["RRULE:FREQ=DAILY"];
  else if (reminder.recurrence === "weekly") event.recurrence = ["RRULE:FREQ=WEEKLY"];
  else if (reminder.recurrence === "monthly") event.recurrence = ["RRULE:FREQ=MONTHLY"];
  return event;
}

// Creates or updates the Google Calendar event mirroring a deadline or
// reminder, and keeps google_event_links in sync. Best-effort by design
// - every call site treats a local write as already succeeded before
// this runs, so a Google-side failure here (not connected, transient API
// error, etc.) is logged and swallowed rather than surfaced as a request
// failure. Worst case, that one item's mirror lags until its next edit.
export async function pushItemToGoogle(userId, itemType, item) {
  try {
    const authClient = await getAuthedClient(userId);
    if (!authClient) return; // not connected - nothing to push

    const { rows: accountRows } = await pool.query(`SELECT calendar_id FROM google_account WHERE user_id = $1`, [userId]);
    const calendarId = accountRows[0]?.calendar_id || "primary";
    const calendar = getCalendarClient(authClient);
    const eventBody = itemType === "deadline" ? deadlineToEvent(item) : reminderToEvent(item);

    const { rows: linkRows } = await pool.query(
      `SELECT google_event_id FROM google_event_links WHERE item_type = $1 AND item_id = $2`,
      [itemType, item.id]
    );

    let response;
    if (linkRows.length > 0) {
      response = await calendar.events.update({
        calendarId,
        eventId: linkRows[0].google_event_id,
        requestBody: eventBody,
      });
    } else {
      response = await calendar.events.insert({ calendarId, requestBody: eventBody });
    }

    await pool.query(
      `INSERT INTO google_event_links (item_type, item_id, google_event_id, google_updated)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_type, item_id) DO UPDATE SET google_event_id = $3, google_updated = $4`,
      [itemType, item.id, response.data.id, response.data.updated ? new Date(response.data.updated) : null]
    );
  } catch (err) {
    console.error(`failed to push ${itemType} ${item.id} to google calendar:`, err.message);
  }
}

// Deletes the Google Calendar event mirroring a deadline/reminder (used
// when the item itself is deleted, or leaves the active/pending state - // completed, archived, dismissed, converted), and removes the link row
// regardless of whether the Google-side delete actually succeeded, since
// a 404/410 there means it's already gone either way.
export async function deleteItemFromGoogle(userId, itemType, itemId) {
  try {
    const { rows: linkRows } = await pool.query(
      `SELECT google_event_id FROM google_event_links WHERE item_type = $1 AND item_id = $2`,
      [itemType, itemId]
    );
    if (linkRows.length === 0) return; // never synced, nothing to clean up

    const authClient = await getAuthedClient(userId);
    if (authClient) {
      const { rows: accountRows } = await pool.query(`SELECT calendar_id FROM google_account WHERE user_id = $1`, [userId]);
      const calendarId = accountRows[0]?.calendar_id || "primary";
      const calendar = getCalendarClient(authClient);
      try {
        await calendar.events.delete({ calendarId, eventId: linkRows[0].google_event_id });
      } catch (err) {
        if (err.code !== 404 && err.code !== 410) throw err;
      }
    }
    await pool.query(`DELETE FROM google_event_links WHERE item_type = $1 AND item_id = $2`, [itemType, itemId]);
  } catch (err) {
    console.error(`failed to delete ${itemType} ${itemId} from google calendar:`, err.message);
  }
}
