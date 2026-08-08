# FocusDial — Deep Work Journal

A focus-session tracker that logs real time you actually spend working
(via a live timer or manual backfill), then computes real insights from
that history: your peak focus hours, a daily consistency streak, and
which kind of work you sustain focus on longest.

**This is real data, not a simulation.** Unlike a demo/portfolio project,
every session in here is something you actually logged — the analytics
are derived from your own history, not generated.

## Stack

- **Backend:** Node.js + Express, Postgres.
- **Frontend:** React + Vite, Framer Motion for animation (tab transitions,
  card enter/exit, progress bar fills, the opening splash). The hour dial
  and calendar heatmap are still hand-rolled SVG/CSS — no charting
  library dependency.
- **Analytics:** computed **client-side** from raw session history (see
  `frontend/src/analytics.js`), not as a server-side aggregate — see
  "Why analytics are computed in the browser" below.
- **Installable as a Chrome/desktop app** via a web app manifest and a
  minimal service worker — see "Installing it" below.

## Time Budgets

Budgets are weekly hour targets, kept as their **own list, separate from
tags** — each tag can optionally be assigned to one budget (a tag belongs
to at most one budget, not many). A budget's "actual hours this week" is
computed by summing the real logged session time of every tag assigned to
it, for the current Monday-start week. This means budgets can group
several related tags into one goal (e.g. a "Deep Work" budget covering
both "Study" and "Writing" tags) rather than needing a 1:1 tag-to-budget
mapping.

## Deadline Planner

Enter a task, a due date, and how many hours it'll take. Optionally link
it to a tag — if you do, progress is computed automatically from real
logged sessions on that tag (only counting sessions logged *after* the
deadline was created, so pre-existing history doesn't inflate progress
you hadn't actually made toward this specific goal). Without a linked
tag, you log progress manually with a simple "add N hours" action.

The planner then does the actual "thinking": it calculates hours/day
needed to finish on time (`remaining hours ÷ days left`), and compares
that against your **real historical average daily focus time** (last 30
days, or since your first session if you're newer than that) to give a
feasibility read — Ahead, On Track, Tight, or Behind — rather than just a
countdown number with no sense of whether it's realistic.

## Installing it (Chrome/desktop app)

Once deployed (or even on `localhost`, which Chrome treats as a secure
context for this purpose), open the site in Chrome and look for an
install icon in the address bar (or Menu → "Install FocusDial…"). This
works because the app ships a web app manifest (`public/manifest.webmanifest`)
and a minimal service worker (`public/sw.js`) — both required by Chrome's
installability criteria. The service worker is deliberately simple: it
never caches API responses (your session/budget/deadline data always
needs to be fresh), only the static app shell, so there's no risk of
seeing stale data after installing.

## Why analytics are computed in the browser

"Today," "this week," and "your peak hour" are all timezone-sensitive
questions. The backend stores every timestamp in UTC (standard practice),
but if the *server* tried to compute "what happened today," it would have
to guess or assume UTC, which can misclassify a session that happened
late at night in the user's actual timezone. The browser already knows
the user's real local timezone via `Date`, so `GET /api/sessions/history`
just returns the raw session list, and `analytics.js` does all the
bucketing (by local day, local hour) client-side. This is the correct
call for a single-user personal tool; it would need rethinking if this
ever became multi-timezone/multi-user.

## Data model

**`tags`** — user-defined categories (Deep Work, Study, Admin, etc.),
each with a name and a color.

**`sessions`** — one row per logged block of time. `source` is either
`'timer'` (started live, `ended_at` is null until stopped) or `'manual'`
(backfilled with both timestamps already known). A session with
`ended_at IS NULL` is the currently-running one — persisted to the
database (not just frontend memory) specifically so a page refresh or
browser crash mid-session doesn't lose track of it; `GET
/api/sessions/running` lets the frontend recover it on load.

## What the analytics actually compute

- **Today / this week / all-time totals** — straightforward sums,
  bucketed by local calendar day.
- **Streak** — consecutive days with at least one logged session, walking
  backwards from today. If today has nothing logged yet, that's not
  treated as a broken streak (the day isn't over) — it starts counting
  from yesterday instead in that case.
- **Peak hour** — every session's *start* hour (local time) accumulates
  its duration into one of 24 buckets; the hour with the most total time
  historically is "your best hour." A session that spans an hour boundary
  is simplified to count entirely toward its start hour, not split
  proportionally — a reasonable approximation for this kind of insight,
  not a billing system.
- **Most-sustained tag** — the tag with the highest *average* session
  length (not highest total time), and only among tags with at least 3
  logged sessions, so one long outlier session doesn't misleadingly crown
  a tag you barely use. Total time mostly just reflects what you do most;
  average length is a better proxy for what you actually sustain deep
  focus on.

## Reminders, Tasks, and Automation

**Reminders** are scheduled (optionally recurring) prompts. When one's
due, you get a real push notification — even if the app/browser is fully
closed (see "Push notifications" below) — and in the app itself, a due
reminder shows two conversion buttons: **→ Deadline** (add hours needed
and a due date; optionally link a tag for auto-tracked progress) or **→
Task** (a plain due-date checklist item, no hour tracking). You can also
just dismiss it.

**Tasks** are the lightweight option — a title, an optional due date, a
checkbox. They live in a "Quick Tasks" widget on the Today tab, for stuff
that doesn't need the full Deadline machinery.

**Automations**, all opt-in via enabling push notifications (Reminders
tab):
- **Smart tag suggestion** — starting a new timer pre-selects whatever
  tag you've most often logged at this hour of day historically (you can
  always override it).
- **Streak-at-risk nudge** — if it's evening, you haven't logged
  anything today, and you have an active streak, you get warned (both an
  in-app banner while the app is open, and a push if it's closed).
- **Deadline pace-change alerts** — a push fires the moment a deadline's
  feasibility status shifts into Tight, Behind, or Overdue.
- **Recurring reminders** — set once, keeps firing on schedule.

## Push notifications

Real Web Push (VAPID + the `web-push` npm library), not just in-app
toasts — reminders and automation alerts reach you even with the
app/browser fully closed, the whole reason this was worth building
instead of the simpler in-app-only version. Three things make this work:

1. **VAPID keys** (`backend/.env` — generate with `npx web-push
   generate-vapid-keys`). Without these set, the app still runs fine,
   push is just silently disabled (`GET /api/push/public-key` reports
   `configured: false`, and the Reminders tab explains this rather than
   pretending push is available).
2. **A service worker push handler** (`frontend/public/sw.js`) — displays
   the actual system notification when a push arrives, and focuses/opens
   the app on click.
3. **A cron trigger hitting `/api/cron/tick`.** This is the piece that
   makes "even when closed" actually true — the backend has no way to
   check anything on its own while idle (especially on a free host that
   spins down). You need an external scheduler (e.g. the free tier at
   **cron-job.org**) hitting `https://your-backend/api/cron/tick?secret=YOUR_CRON_SECRET`
   every few minutes. `CRON_SECRET` (set in `backend/.env`) prevents
   randoms from triggering it. **Without this external cron configured,
   reminders/automation will never fire** — the in-app streak banner
   still works (that's pure client-side), but nothing else will.

**A known limitation, not a bug:** the cron job approximates your local
day/hour using a fixed UTC-offset number (registered automatically from
your browser on load, via `PUT /api/settings`), not a real timezone
database — so it doesn't adjust for daylight saving time shifts. Can be
off by an hour part of the year in DST-observing regions. See
HANDOVER.md if this ever needs upgrading to a real timezone library.

## Running locally

**Backend:**

```bash
cd backend
cp .env.example .env
# edit DATABASE_URL — see HANDOVER.md for local Postgres setup notes
npm install
npm run dev
```

**Frontend:**

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET/POST | `/api/tags` | List / create tags |
| PATCH | `/api/tags/:id` | Update a tag's name/color, or assign/unassign its budget |
| DELETE | `/api/tags/:id` | Delete a tag (sessions keep their history, tag_id goes null) |
| GET | `/api/sessions/running` | The currently in-progress session, if any |
| POST | `/api/sessions/start` | Start a live timer session |
| POST | `/api/sessions/:id/stop` | Stop a running session |
| POST | `/api/sessions` | Create a manual (backfilled) session |
| GET | `/api/sessions?limit=` | Recent completed sessions, for the log UI |
| GET | `/api/sessions/history` | Full completed-session history, for analytics |
| PATCH/DELETE | `/api/sessions/:id` | Edit or delete a session |
| GET/POST | `/api/budgets` | List (with assigned tags) / create a budget |
| PATCH/DELETE | `/api/budgets/:id` | Update or delete a budget |
| GET/POST | `/api/deadlines` | List / create a deadline |
| PATCH | `/api/deadlines/:id` | Update a deadline (title, tag, due date, hours, status) |
| POST | `/api/deadlines/:id/log` | Add hours to a deadline's manual progress (untagged ones only) |
| DELETE | `/api/deadlines/:id` | Delete a deadline |
| GET | `/api/push/public-key` | The VAPID public key (and whether push is configured at all) |
| POST | `/api/push/subscribe` | Register a browser's push subscription |
| POST | `/api/push/unsubscribe` | Remove a push subscription |
| GET/POST | `/api/reminders` | List pending reminders / create one |
| POST | `/api/reminders/:id/convert-to-deadline` | Convert a reminder into a Deadline |
| POST | `/api/reminders/:id/convert-to-task` | Convert a reminder into a Task |
| POST | `/api/reminders/:id/dismiss` | Dismiss a reminder without converting it |
| DELETE | `/api/reminders/:id` | Delete a reminder |
| GET/POST | `/api/tasks` | List open tasks / create one |
| PATCH/DELETE | `/api/tasks/:id` | Update (e.g. mark done) or delete a task |
| GET/PUT | `/api/settings` | Read/update the stored timezone offset used by the cron job |
| GET/POST | `/api/cron/tick?secret=` | Checks due reminders, deadline pace changes, and streak risk — meant for an external scheduler, not manual use |

## Deploying

Same free-tier pattern as this series' other projects: backend on Render
(free tier), frontend on Vercel, Postgres on Supabase. See HANDOVER.md for
the specific gotchas already hit on those earlier deploys (Supabase IPv6,
Render's dynamic `PORT`, Vite env vars needing a rebuild to take effect,
and the `.env.example` placeholder mistake that broke local dev once
before) — same lessons apply here.

## Not built (by design, for now)

- No auth/PIN — single-user personal tool. Add one later if this ever
  needs to be shared or made more private.
- No editing UI for manual sessions beyond delete (the PATCH endpoint
  exists on the backend, just no frontend form wired to it yet).
- No offline support beyond the static app shell — the service worker
  never caches API responses, so the app still needs a network
  connection to actually load or log data. It's installable, not
  offline-first.
- Deadlines have no notion of "planned rest days" in the pace
  calculation — see HANDOVER.md.
