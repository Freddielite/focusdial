import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. This app requires Postgres — see .env.example."
  );
}

// Managed hosts (Supabase, etc.) require SSL; local Postgres installs
// almost never have it configured. Only require SSL when the connection
// string doesn't point at localhost, so local dev and production both
// work without editing this file.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export async function initSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- Multi-user account. Either auth method can be present alone or
    -- both together (e.g. registered with email/password, later linked
    -- Google too) -- the CHECK below just guarantees there's always at
    -- least one way to actually log in. google_sub is Google's stable
    -- per-account identifier (the JWT 'sub' claim), separate from the
    -- Google Calendar *linking* in google_account below -- this is about
    -- who's allowed into the app at all, that's about which calendar a
    -- logged-in user has connected for sync. Two different concerns that
    -- happen to both go through Google OAuth.
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      google_sub    TEXT UNIQUE,
      display_name  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT users_has_auth_method CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name                  TEXT UNIQUE NOT NULL,
      weekly_target_seconds INTEGER NOT NULL,
      color                 TEXT NOT NULL DEFAULT '#C9962C',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Ownership, added when this app became multi-user. Nullable for now
    -- -- existing rows from before multi-user predate any account to own
    -- them, and stay invisible (every query filters by user_id) until
    -- reassigned by scripts/migrate-legacy-data.js. Every INSERT from
    -- this point forward always sets it.
    ALTER TABLE budgets ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    -- A budget name only needs to be unique per-user, not globally --
    -- two different people are allowed to both have a "Deep work" budget.
    ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_name_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_user_name ON budgets(user_id, name);

    CREATE TABLE IF NOT EXISTS tags (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT UNIQUE NOT NULL,
      color       TEXT NOT NULL DEFAULT '#C9962C',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Added after the initial release -- ADD COLUMN IF NOT EXISTS makes
    -- this safe to run against a database created before budgets existed,
    -- without needing a separate migration framework. A tag belongs to at
    -- most one budget (not many-to-many): simple, and covers the real
    -- use case of "these few tags roll up into this weekly goal."
    ALTER TABLE tags ADD COLUMN IF NOT EXISTS budget_id UUID REFERENCES budgets(id) ON DELETE SET NULL;

    ALTER TABLE tags ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, name);

    CREATE TABLE IF NOT EXISTS sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tag_id      UUID REFERENCES tags(id) ON DELETE SET NULL,
      started_at  TIMESTAMPTZ NOT NULL,
      ended_at    TIMESTAMPTZ,
      note        TEXT,
      source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('timer', 'manual')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Separate from the topic tag: a quick self-rating of how the
    -- session actually went, so it's eventually possible to see whether
    -- the longest sessions are the best ones or just the longest.
    -- Deliberately a small closed set (not 1-5) -- fast enough to tap
    -- without thinking, which matters since this is optional and only
    -- gets filled in if it's genuinely no-friction.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quality TEXT CHECK (quality IN ('focused', 'neutral', 'distracted'));

    -- Sourced when the runaway-timer check (routes/cron.js) first nudges
    -- about a session that's been running too long, so it only nudges
    -- once per session rather than on every cron tick until it's
    -- stopped. Lives on the session row itself (not settings, unlike the
    -- other nudge-dedupe columns) since more than one session could in
    -- theory need tracking across its lifetime, even though only one can
    -- be running at a time in practice.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runaway_nudged_at TIMESTAMPTZ;

    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_tag_id ON sessions(tag_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    -- The one running-session-at-a-time rule (routes/sessions.js's
    -- /running lookup) is now per-user, not global -- two different
    -- people can each have their own timer going simultaneously.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_running_per_user
      ON sessions(user_id) WHERE ended_at IS NULL;

    -- A deadline optionally links to a tag: progress is then computed
    -- from real logged session time on that tag (since the deadline was
    -- created -- see routes/deadlines.js), consistent with this app's
    -- "sessions are the one source of truth" design. Without a linked
    -- tag, manual_hours_logged is used instead as a plain running total.
    CREATE TABLE IF NOT EXISTS deadlines (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title                 TEXT NOT NULL,
      tag_id                UUID REFERENCES tags(id) ON DELETE SET NULL,
      due_date              DATE NOT NULL,
      estimated_hours       NUMERIC NOT NULL,
      manual_hours_logged   NUMERIC NOT NULL DEFAULT 0,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'archived')),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_deadlines_status ON deadlines(status);
    CREATE INDEX IF NOT EXISTS idx_deadlines_user_id ON deadlines(user_id);

    -- Optional time-of-day to go with due_date, so the live countdown can
    -- tick down to an exact moment (e.g. "due 5pm") instead of only ever
    -- resolving to end-of-day. NULL means "just the date" -- callers treat
    -- that as end-of-day for the countdown, same behavior as before this
    -- column existed.
    ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS due_time TIME;

    -- Added for reminders/automation. last_notified_status lets the cron
    -- job (see routes/cron.js) detect when a deadline's pace status
    -- *changes* (e.g. onTrack -> tight) rather than re-notifying on every
    -- check, which would be noisy.
    ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS last_notified_status TEXT;

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint    TEXT UNIQUE NOT NULL,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A device subscribes on behalf of whoever's logged in when it
    -- registers -- nullable for the same legacy-row reason as everywhere
    -- else, but lib/push.js's sendPushToAll is being replaced by
    -- sendPushToUser, which needs this to know who to actually notify.
    ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

    -- Per-user preferences. Used to be a singleton (id always 1, one row
    -- for the whole app) -- became one row per user when the app went
    -- multi-user. timezone_offset_minutes lets the server-side cron job
    -- approximate "what day/hour is it for this particular user" without
    -- a full IANA timezone library -- see routes/cron.js for why this is
    -- an approximation, not exact, and where that matters.
    CREATE TABLE IF NOT EXISTS settings (
      id                      INTEGER PRIMARY KEY DEFAULT 1,
      timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
      last_streak_nudge_date  TEXT,
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- The old "only row id=1 may ever exist" rule doesn't hold once
    -- there's more than one user -- each gets their own settings row,
    -- looked up by user_id instead of the fixed id. The id column itself
    -- is kept as an ordinary surrogate key rather than restructured, to
    -- avoid a riskier primary-key migration on an existing table.
    ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_singleton;
    ALTER TABLE settings ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);
    -- The DROP DEFAULT above left id with no default at all, so every
    -- "INSERT INTO settings (user_id) VALUES (...)" across the app
    -- (auth.js register/google-login, settings.js) hits a
    -- not-null violation on id, since it's still the PRIMARY KEY and
    -- nothing supplies a value. id is still a plain surrogate key per
    -- the comment above (lookups go through user_id), so it just needs
    -- a real auto-incrementing default back.
    CREATE SEQUENCE IF NOT EXISTS settings_id_seq OWNED BY settings.id;
    SELECT setval('settings_id_seq', COALESCE((SELECT MAX(id) FROM settings), 0) + 1, false);
    ALTER TABLE settings ALTER COLUMN id SET DEFAULT nextval('settings_id_seq');

    -- Notification + automation preferences, added after the initial
    -- release (ADD COLUMN IF NOT EXISTS keeps this safe against an
    -- existing settings row). All default to true so behaviour is
    -- unchanged until the user turns something off in the Settings tab.
    --
    -- push_enabled is a soft master switch checked before every push
    -- send (see lib/push.js) -- separate from whether a browser push
    -- subscription actually exists, so the user can silence pushes
    -- without having to unsubscribe every device.
    --
    -- The automation_* flags gate the per-user cron checks (see
    -- routes/cron.js, which now loops over every user with an
    -- automation enabled rather than checking one global settings row);
    -- the notify_* flags gate the three app-driven events that only
    -- push when the app is backgrounded (see routes/notify.js).
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS push_enabled              BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS automation_reminders      BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS automation_deadline_pace  BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS automation_streak         BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_session_completed  BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_deadline_completed BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_budget_reached     BOOLEAN NOT NULL DEFAULT true;

    -- Runaway-timer nudge: warns if a running session has gone past a
    -- sane length (forgotten-running-timer), since it silently skews
    -- todaySeconds/streak until stopped. Weekly digest: Sunday-evening
    -- "here's your week" push, reusing the same cron infrastructure as
    -- the other three automations above.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS automation_runaway_timer BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS automation_weekly_digest BOOLEAN NOT NULL DEFAULT true;
    -- Gates the poll (pull) side of Google Calendar sync specifically --
    -- the push side (mirroring local creates/edits/deletes out to
    -- Google) runs whenever an account is connected, since that's the
    -- point of connecting one. This just lets inbound sync be paused
    -- independently without a full disconnect. See checkGoogleCalendarSync
    -- in routes/cron.js.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS automation_google_sync BOOLEAN NOT NULL DEFAULT true;
    -- Dedupe key for the weekly digest, same idea as last_streak_nudge_date
    -- above but keyed by the Monday of the week it was sent for, so it
    -- fires at most once per calendar week rather than on every Sunday
    -- evening cron tick.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS last_weekly_digest_week TEXT;

    -- A single designated weekly day off (0 = Sunday ... 6 = Saturday,
    -- matching JS's getDay(), null = no rest day configured) that doesn't
    -- break the streak even with zero sessions logged. Addresses the open
    -- question from the original streak design (Session 1): a single
    -- missed day currently resets the streak entirely, with no concept of
    -- a planned day off. See analytics.js's streak walk and cron.js's
    -- checkStreakAtRisk for where this is actually consulted.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS rest_day_of_week INTEGER CHECK (rest_day_of_week BETWEEN 0 AND 6);

    -- Legacy: backed the ICS calendar-subscription feature (deleted —
    -- see HANDOVER.md's "Deleted: ICS export" entry — superseded by
    -- real two-way Google Calendar sync). Left in place rather than
    -- DROP COLUMN, since it's a harmless unused nullable column and
    -- dropping it is a destructive migration for zero functional gain.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS ics_token TEXT UNIQUE;

    -- A simple daily focus-time target, separate from weekly Budgets
    -- (which are tag-scoped and week-long) -- this is a single
    -- unscoped "aim for N hours today" number surfaced on the Today
    -- tab's hero card. NULL (the default) means the feature is off, not
    -- "goal of zero" -- HeroCard.jsx treats those very differently (no
    -- progress bar at all vs. a bar that's already "met" at 0 logged).
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS daily_focus_goal_seconds INTEGER;

    -- When the Sunday-evening weekly digest push actually fires (see
    -- routes/cron.js's checkWeeklyDigest) -- previously hardcoded to
    -- Sunday/7pm-local for everyone. day_of_week matches JS's getDay()
    -- (0 = Sunday ... 6 = Saturday) for consistency with rest_day_of_week
    -- above; hour is 0-23, local to the user via the same
    -- timezone_offset_minutes approximation cron.js already uses for
    -- everything else time-based.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS weekly_digest_day_of_week INTEGER NOT NULL DEFAULT 0 CHECK (weekly_digest_day_of_week BETWEEN 0 AND 6);
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS weekly_digest_hour INTEGER NOT NULL DEFAULT 19 CHECK (weekly_digest_hour BETWEEN 0 AND 23);

    -- Real IANA timezone name (e.g. "Africa/Lagos"), registered from
    -- the browser (Intl.DateTimeFormat().resolvedOptions().timeZone)
    -- alongside the existing timezone_offset_minutes on every app load.
    -- cron.js now prefers this -- Node's built-in Intl API can compute
    -- a fully DST-aware local time from a real zone name with no extra
    -- dependency, which timezone_offset_minutes alone never could (a
    -- fixed offset silently drifts by an hour for ~2 weeks twice a year
    -- in any DST-observing region). timezone_offset_minutes stays as
    -- the fallback for a row that hasn't been touched by a browser
    -- since this shipped.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS timezone TEXT;

    CREATE TABLE IF NOT EXISTS tasks (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title       TEXT NOT NULL,
      due_date    DATE,
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);

    -- Set when a task was created from "Add as task" on a deadline (see
    -- routes/deadlines.js POST /deadlines). ON DELETE CASCADE so deleting
    -- the deadline removes its shadow task too, instead of leaving an
    -- orphaned task with a title that no longer means anything. The two
    -- rows' status fields are kept in sync in both directions (see the
    -- PATCH handlers in routes/deadlines.js and routes/tasks.js) so
    -- completing either one completes the other.
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_id UUID REFERENCES deadlines(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline_id ON tasks(deadline_id);

    -- Lets a timer/manual session optionally point at a specific Task,
    -- not just a Tag -- a Tag says "what kind of work," a Task says
    -- "which specific thing." ON DELETE SET NULL rather than CASCADE:
    -- deleting a task shouldn't delete the time you already logged
    -- against it, just drop the now-meaningless link.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);

    -- A reminder can be converted into either a Deadline or a Task (or
    -- neither, if dismissed) -- both FKs are nullable and at most one is
    -- ever set, rather than a polymorphic reference, since Postgres has
    -- no clean native way to FK against "one of two tables" and this
    -- keeps querying simple.
    CREATE TABLE IF NOT EXISTS reminders (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title                 TEXT NOT NULL,
      note                  TEXT,
      remind_at             TIMESTAMPTZ NOT NULL,
      recurrence            TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly', 'monthly')),
      status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'dismissed')),
      last_fired_at         TIMESTAMPTZ,
      converted_deadline_id UUID REFERENCES deadlines(id) ON DELETE SET NULL,
      converted_task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE reminders ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);

    -- Google Calendar two-way sync -- one row per user who's connected
    -- their calendar (used to be a singleton, same change as settings
    -- above and for the same reason: this became a multi-user app). Kept
    -- as its own table rather than more settings columns since these are
    -- secrets (tokens), not user-facing preferences.
    CREATE TABLE IF NOT EXISTS google_account (
      id             INTEGER PRIMARY KEY DEFAULT 1,
      email          TEXT,
      access_token   TEXT,
      refresh_token  TEXT,
      token_expiry   TIMESTAMPTZ,
      calendar_id    TEXT NOT NULL DEFAULT 'primary',
      -- Google Calendar API's incremental-sync cursor (see
      -- lib/google.js / cron.js's checkGoogleCalendarSync). Cleared and
      -- rebuilt if Google reports it as expired (410 Gone).
      sync_token     TEXT,
      connected_at   TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE google_account DROP CONSTRAINT IF EXISTS google_account_id_check;
    ALTER TABLE google_account ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE google_account ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_google_account_user_id ON google_account(user_id);
    -- Same missing-default bug as settings.id above — routes/googleAuth.js's
    -- INSERT INTO google_account (...) never supplies id, and DROP DEFAULT
    -- left nothing to fill it in.
    CREATE SEQUENCE IF NOT EXISTS google_account_id_seq OWNED BY google_account.id;
    SELECT setval('google_account_id_seq', COALESCE((SELECT MAX(id) FROM google_account), 0) + 1, false);
    ALTER TABLE google_account ALTER COLUMN id SET DEFAULT nextval('google_account_id_seq');

    -- Maps a FocusDial deadline/reminder to the Google Calendar event
    -- that mirrors it. Used in both directions: the push side
    -- (routes/deadlines.js, routes/reminders.js) uses it to know
    -- create-vs-update; the pull side (checkGoogleCalendarSync in
    -- routes/cron.js) uses it to map a changed/deleted Google event back
    -- to the local row it came from. A Google event with no row here is
    -- deliberately left alone by the poll -- FocusDial only syncs events
    -- it created itself, not arbitrary existing calendar content.
    -- No user_id needed here directly: every lookup goes through
    -- item_type+item_id, and that item already belongs to a user.
    CREATE TABLE IF NOT EXISTS google_event_links (
      item_type       TEXT NOT NULL CHECK (item_type IN ('deadline', 'reminder')),
      item_id         UUID NOT NULL,
      google_event_id TEXT NOT NULL,
      -- Google's own 'updated' timestamp as of the last sync in either
      -- direction. Compared against on each poll so an event FocusDial
      -- just pushed isn't mistaken for a remote-side edit and re-pulled
      -- -- see the comment above checkGoogleCalendarSync for why this is
      -- the whole conflict-handling strategy (last-edit-wins, nothing
      -- fancier) and its known limitations.
      google_updated  TIMESTAMPTZ,
      PRIMARY KEY (item_type, item_id),
      UNIQUE (google_event_id)
    );
  `);
}
