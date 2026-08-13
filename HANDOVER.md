# Handover notes

Running log for whoever picks this up next, same convention as the other
projects in this series. README.md is "what this is and how to run it";
this file is "why it's built this way and what to watch for."

## Session 1 — full build (backend + frontend)

Built end-to-end in one session, applying lessons already learned from
two earlier projects (expense tracker, logistics dashboard) rather than
rediscovering them:

- **Local-vs-remote SSL handling in `db.js`** was written correctly from
  the start this time (conditional on whether `DATABASE_URL` points at
  localhost), instead of needing a follow-up fix like the logistics
  dashboard did.
- **`frontend/.env.example` has `VITE_API_URL` commented out**, not set to
  a live-looking placeholder value. On the logistics dashboard, a
  realistic-looking placeholder (`https://your-backend.onrender.com`) got
  copied verbatim into `.env` and silently broke local dev for a while
  before anyone noticed — commenting it out by default means copying the
  file as-is just leaves it unset, which is the correct default for local
  dev.
- **PORT handling** in `index.js` reads `process.env.PORT` with a
  fallback, matching what Render (and most PaaS hosts) require —
  correct from the start, not a post-deploy fix.

**Design direction:** a warm "instrument/journal" feel — deep walnut
background, brass for the timer/primary actions, muted sage-green for
"productive" signals (streaks, best-hour highlight). Deliberately
different from the other two projects in this series (not the cream
tracker, not the navy ops-dashboard) — see the token list at the top of
`App.css` if extending the palette.

**Files of note:**
- `backend/src/routes/sessions.js` — the running-session-persisted-to-DB
  design (rather than only tracking it in frontend state) is the one
  piece of real engineering care here: it means a browser crash or
  refresh mid-session doesn't silently lose that the timer was running.
  `GET /sessions/running` is how the frontend recovers it on load.
- `frontend/src/analytics.js` — all the actual "insights" logic. See the
  README's "Why analytics are computed in the browser" section for the
  timezone reasoning; don't move this to a server-side aggregate without
  re-solving that problem first.
- `frontend/src/components/HourDial.jsx` — hand-rolled SVG radial dial,
  no charting library. Kept dependency-free deliberately, since this
  project's whole pitch (vs. the logistics dashboard) is "smaller and
  more real," not "more impressive tech stack."

**Not built:**
- No auth — intentional, see README. Revisit if this is ever exposed
  somewhere less private.
- No frontend edit UI for a manual session after creation — only delete
  is wired up in the UI, though the backend's PATCH endpoint already
  supports full edits if a form gets built for it later.
- Not deployed anywhere yet as of this session — local-only, verified via
  `npm run build` (frontend) and `node --check` on every backend file
  (both clean).

## Session 2 — trend chart

Added `frontend/src/components/TrendChart.jsx`: a Week/Month toggle bar
chart, hand-rolled (still no chart library, consistent with the rest of
this project). Backed by two new analytics functions in `analytics.js`:
`computeWeeklyTotals` and `computeMonthlyTotals`, both zero-filling gaps
so the chart shows a continuous timeline rather than only periods with
logged data.

Two deliberate choices worth knowing about if this gets extended:
- **Weeks start Monday** (`mondayOf()` in `analytics.js`) — an arbitrary
  but explicit convention; change it there if Sunday-start is preferred.
- **The current in-progress period is excluded from the average line**
  and drawn with a dashed outline instead of solid fill, since comparing
  a half-finished week against completed ones would understate it
  misleadingly.

## Session 3 — Budgets, Deadlines, full UI overhaul, PWA

Major expansion, turning this from "a tracker" into "a personal daily-use
tool." Three big pieces:

### Time Budgets

`budgets` is a new table, deliberately **separate from tags** (per an
explicit choice, not an oversight) rather than just adding a
weekly-target field onto tags directly. A tag has an optional
`budget_id` (added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, since
earlier deployments of this app already had a `tags` table without it —
this is the first schema change since initial release, and this
if-not-exists pattern is how to handle the next one too, absent a real
migration framework). A budget belongs to no tags, one tag, or several —
`computeBudgetProgress` in `analytics.js` sums real session time across
whichever tags are assigned, for the current Monday-start week.

### Deadline Planner

`deadlines` links optionally to a tag. If linked, `computeDeadlineProgress`
sums real session seconds on that tag **logged since the deadline's
`created_at`** — deliberately not all-time, so a deadline created today
for a tag you've used for months doesn't start "already 80% done" from
unrelated past work. If not linked, `manual_hours_logged` is a plain
running total incremented via `POST /deadlines/:id/log` (atomic SQL
increment, not read-modify-write in JS, to avoid a race if logged twice
quickly).

The feasibility read (Ahead/On Track/Tight/Behind) compares the required
daily pace against `computeAvgDailyFocusSeconds` — averaged over *every*
day in the last 30 (or since your first session), including zero-session
days. That was a deliberate choice: averaging only over days you actually
worked would give an optimistic best-case number, not a realistic
sustainable one, and a deadline plan is exactly the context where you
want the honest number.

### Full UI overhaul

- **Framer Motion** added as a real dependency (unlike the logistics
  dashboard and this project's own earlier sessions, which stayed
  animation-library-free by choice) — the "nothing static" brief needed
  more than hand-rolled CSS transitions could deliver cleanly, especially
  for the tab-switch crossfades and `AnimatePresence` list exit
  animations (budget/deadline cards animate out on delete, not just
  disappear).
- **Tabbed layout** (`TabNav.jsx`) replaced the single long scrolling
  page — Today / Insights / Budgets / Deadlines, with a `layoutId`-based
  sliding indicator. `TodayView.jsx` and `InsightsView.jsx` are thin
  wrappers around components that already existed, just regrouped and
  given the same animation treatment as the two new views for
  consistency.
- **Splash screen** (`Splash.jsx`): typewriter-animates "Focus." on load
  (character-by-character via `setInterval`, not a CSS-only trick, since
  the exact reveal timing needed to be controllable), holds briefly, then
  the component unmounts and Framer Motion's `exit` animation on it
  handles the fade-out — the main app is mounted underneath the whole
  time, so there's no additional loading flash after the splash clears.

### PWA / Chrome install

Three files make this installable: `public/manifest.webmanifest`,
`public/sw.js`, and the icon set in `public/icons/` (generated from a
single source SVG, `public/favicon.svg`, rasterized with `sharp` — the
source SVG itself is just two circles and a wedge, matching the header's
"◐" brand mark). The service worker is intentionally minimal — network
bypass for `/api/*`, cache-first for everything else — see the comment at
the top of `sw.js` for why it doesn't try to be a full offline-first
implementation. Verified Chrome's current installability criteria (valid
manifest + registered service worker with a fetch handler + HTTPS or
localhost) via search before building this, since the requirements have
changed over the years and building against stale assumptions here would
have wasted the effort.

**Not verified this session:** actually installing the app in a real
Chrome browser and confirming the install prompt appears — built to spec
and confirmed the manifest/service worker/icons all land correctly in
the `dist/` build output, but the sandbox this was built in has no
browser to click "Install" in. Worth an explicit check the first time
this runs somewhere with a real Chrome window.

## Session 4 — gradients + light/dark theme

Restructured the color tokens in `App.css` into a dark-default set in
`:root`, overridden entirely inside `@media (prefers-color-scheme:
light)`. Every component still references the same variable *names*
(`--walnut`, `--brass`, `--grad-panel`, etc.) — nothing downstream needed
to change, only the token definitions themselves. Light mode intentionally
keeps the same warm "journal" character, just inverted (light parchment
background, dark ink text), rather than a different palette.

**No manual light/dark toggle was built** — this was an explicit choice
(asked, not assumed): the app always follows the OS/browser's
`prefers-color-scheme`, with no override UI and nothing stored in
`localStorage`. If a manual toggle is wanted later, it's a small addition
(a button that sets a `data-theme` attribute on `<html>` and a matching
CSS override block), but as of this session there isn't one.

Gradients were added fairly thoroughly ("everywhere" was the brief):
page background, header, all panels/cards, inputs, buttons, the running
timer's digits (via `background-clip: text`), the header brand mark, the
tab indicator, and progress bars (via a `--sheen` diagonal highlight
layered on top of each bar's own color, rather than replacing the color —
since progress bar colors are user-chosen per tag/budget, they can't be
hardcoded into a single gradient).

One implementation detail worth knowing if extending this further: the
sheen overlay on `.fd-panel` is applied as a **second background layer on
the element itself** (`background: var(--sheen), var(--grad-panel);`),
not a `::before` pseudo-element. An earlier draft used a `::before` with
`position: absolute; inset: 0`, which is a real bug to avoid — positioned
pseudo-elements with `z-index: auto` paint *after* a parent's normal-flow
in-content children in some stacking scenarios, meaning the sheen would
render on top of the panel's own text instead of behind it. Multiple CSS
background layers on the same element don't have this problem, since an
element's own backgrounds always paint before any of its children/content,
positioned or not.

## Session 5 — manual theme toggle added after all

Session 4 deliberately shipped without a manual light/dark toggle (an
explicit choice at the time — see above). That was reversed this session
based on direct follow-up feedback: a toggle was wanted after all, even
though "always follow system" was the original answer.

Added `hooks/useTheme.js` (three states: `system` / `light` / `dark`,
persisted to `localStorage` under `focusdial-theme`) and
`components/ThemeToggle.jsx` (a segmented control reusing the same
`.fd-trend-toggle` styling as the Weekly/Monthly toggle, for visual
consistency rather than inventing a new control style).

CSS-side: `App.css` now has two `:root[data-theme="..."]` blocks
(duplicating the token values already defined in the `:root` /
`prefers-color-scheme: light` blocks) that win via specificity
(an attribute selector on `:root` outranks the plain `:root` the media
query targets) regardless of the system setting. When `theme === 'system'`,
the hook removes the `data-theme` attribute entirely, so the original
`prefers-color-scheme` media query takes back over with zero JS involved
— "Auto" isn't a third hardcoded palette, it's just "no override present."

## Session 6 — reminders, tasks, real push notifications, automation

The biggest single addition so far. Went with the harder option at every
decision point per explicit confirmation (real push over in-app-only;
both Deadline and Task as conversion targets; all four automations) —
worth knowing that was a deliberate scope choice, not scope creep.

### New tables

`reminders`, `tasks`, `push_subscriptions`, `settings` (singleton config
row), plus `deadlines.last_notified_status` (added via the same `ALTER
TABLE ... ADD COLUMN IF NOT EXISTS` pattern as `tags.budget_id` before
it — this is now a proven, repeatable approach for schema evolution
without a real migration framework, worth continuing to use).

A reminder converts into *either* a Deadline or a Task via two nullable
FKs (`converted_deadline_id`, `converted_task_id`), never both — a
polymorphic reference would be cleaner in principle but Postgres has no
first-class support for "FK against one of two tables," and this is
simple enough to just leave as two nullable columns.

### Real push notifications — the actual hard part

`backend/src/lib/push.js` wraps the `web-push` npm library. Requires
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env vars (generate with `npx
web-push generate-vapid-keys`) — **not committed anywhere**, has to be
generated fresh per deployment. Without them set, `pushConfigured` is
`false` and every push call becomes a silent no-op; the frontend checks
`GET /api/push/public-key`'s `configured` field and shows an honest
message rather than a broken "Enable" button.

`frontend/src/push.js` handles the browser side: request Notification
permission (must be from a user gesture — a click handler — or browsers
silently ignore/reject it), subscribe via `PushManager`, POST the
subscription to the backend. `frontend/public/sw.js` got a `push` event
handler (shows the actual system notification) and a `notificationclick`
handler (focuses an existing tab or opens a new one).

### The cron job — and its real limitation

`backend/src/routes/cron.js` is what makes "notifications even when the
app is closed" actually true — nothing else in this stack runs on a
schedule by itself. **This endpoint does nothing unless something
external calls it periodically.** Render's free tier has no built-in
cron; the documented approach (README.md) is pointing a free service like
cron-job.org at `/api/cron/tick?secret=...` every few minutes.
`CRON_SECRET` gates it so it can't be triggered by anyone who finds the
URL.

The cron job needs to reason about "what day/hour is it for the user"
server-side, with zero knowledge of their actual timezone — solved with a
single stored UTC-offset number (`settings.timezone_offset_minutes`,
registered automatically from the browser via `PUT /api/settings` on
every app load) rather than a real IANA timezone database. **This is a
real, documented limitation, not an oversight**: it doesn't shift for
daylight saving time, so streak/deadline timing checks can be off by an
hour part of the year in DST-observing regions. A proper fix would mean
pulling in a timezone library (`luxon` or `date-fns-tz`) and storing an
actual IANA zone name (e.g. `Africa/Lagos`) instead of a raw offset —
worth doing if this ever matters enough to fix, not worth the added
dependency weight for a first cut.

One consequence of this design worth knowing: `checkDeadlinePaceChanges`
in `cron.js` is a **deliberate duplicate** of
`frontend/analytics.js:computeDeadlineProgress`'s core logic, not shared
code — the frontend uses the browser's real timezone (accurate), the
cron job uses the stored offset approximation (slightly less accurate).
Keeping them separate means neither has to compromise its own accuracy
to stay byte-identical to the other. If the pace-status logic ever
changes, **both places need updating** — there's no single source of
truth for this one calculation, unlike almost everything else in this
app (which is a fair trade for two ~40-line functions, not worth
introducing a shared package between two otherwise-independent npm
projects over).

### Automations

- **Smart tag suggestion** (`analytics.js:computeHourlyTagSuggestions`,
  wired into `TimerPanel.jsx`): purely client-side, no cron/push
  involved. Only pre-selects if the person hasn't already touched the
  tag dropdown themselves this session (`userPickedTag` state) — it's a
  suggestion, not something that should fight the user's own choice.
- **Streak-at-risk**: exists in *two* places on purpose. An in-app banner
  in `App.jsx` (pure client-side, re-evaluated every 60s via a plain
  `setInterval` tick, no server round-trip) covers "app is open." The
  cron job's `checkStreakAtRisk` covers "app is closed," using the same
  UTC-offset approximation as the deadline check above, with its own
  once-per-local-day guard (`settings.last_streak_nudge_date`, stored as
  **plain TEXT in `YYYY-MM-DD` format**, not a native Postgres `DATE` —
  deliberately, to sidestep `pg`'s default DATE-to-JS-Date parsing
  (which parses at UTC midnight and is a well-known source of
  off-by-one-day bugs when compared against locally-computed date
  strings). Worth remembering if this column is ever queried directly.
- **Deadline pace-change alerts**: cron-only (see above) — only pushes
  for a shift *into* `tight`/`behind`/`overdue`, not every check, and not
  for shifts into `ahead`/`onTrack` (not worth interrupting someone for
  good news).
- **Recurring reminders**: `nextOccurrence()` in `cron.js` just adds a
  day/week/month via plain `Date` arithmetic — no complex recurrence
  rule engine (no "every 2nd Tuesday" support, just daily/weekly/monthly
  from whenever it was created).

### Not done / explicitly deferred

- No timezone-change handling — if someone travels and their offset
  changes, the next page load re-registers it (`PUT /api/settings` runs
  on every load), but there's no mid-session adjustment.
- No notification history/log in the UI — a push either lands or it
  doesn't; there's no in-app record of "what was sent when" to check
  back on.
- Didn't test the actual push delivery end-to-end in a live browser this
  session (no browser available in the build sandbox) — the
  subscribe/send/service-worker-display code paths are all written to
  spec and syntax-verified, but worth an explicit real-world test (click
  "Enable," background the tab, hit `/api/cron/tick` manually, confirm a
  system notification actually appears) the first time this runs
  somewhere with a real browser.

## Anticipated gotchas (same ones hit on earlier projects in this series)

- **Local Postgres on Linux uses peer authentication** for socket
  connections — `createdb` as your own Linux user will fail with "role
  does not exist" unless a matching Postgres role exists. Use `sudo -u
  postgres createdb <name>`, and set a password on the `postgres` role
  (`ALTER USER postgres PASSWORD '...'`) before the app can connect over
  TCP with a password-based `DATABASE_URL`.
- **Supabase direct connections default to IPv6.** Use the session pooler
  connection string (port 5432, `*.pooler.supabase.com`), not the direct
  one, if/when this deploys to Supabase.
- **Render assigns `PORT` dynamically** — already handled correctly in
  `index.js`, just confirm the boot log shows Render's assigned port, not
  a hardcoded one, after deploying.
- **Vite env vars are baked in at build time.** If `VITE_API_URL` gets
  added/changed in Vercel after a deploy already happened, a fresh
  deploy is required — the existing build won't pick it up retroactively.
- **Free Render instances spin down after ~15 min idle** — first request
  after that can take 30-60s. No cold-start banner is wired into this
  frontend yet (unlike the expense tracker's), since it wasn't deployed
  during this session — add `setSlowRequestHandler` wiring in `App.jsx`
  if/when this actually goes on a free host, following the same pattern
  already used in `api.js`.

## Open questions for whoever continues this

- Streak logic currently has no concept of a "planned rest day" — a
  single missed day fully resets it. Fine for a first version; revisit
  if that ever feels too punishing in practice.
- The hour-dial's "attribute whole session to its start hour" 
  simplification could matter more once someone has many long (2h+)
  sessions — worth revisiting with proportional splitting if that starts
  looking wrong in practice, but not worth the complexity up front.

---

## Redesign update (Aug 2026): notifications, Settings tab, mobile nav

A visual + functional pass that adopts the "ledger" design language (gradient hero card, glassy backdrop-blur panels) while keeping FocusDial's brass/green/serif identity.

**New Settings tab** (`components/SettingsView.jsx`) consolidates: push controls, per-event notification toggles, appearance (theme + detected timezone), tag management (moved out of the header), budget management (moved out of the Budgets tab, which is now a read-only progress dashboard), and a per-category data reset.

**Dual notifications.** Every notifiable event shows an in-app toast (`components/Toast.jsx`, `ToastProvider` wraps the app in `main.jsx`). The three cron-driven automations (reminders, deadline pace, streak-at-risk) also push from the server as before. The three app-driven events (session completed, deadline completed, budget goal reached) additionally push, but only when the app is backgrounded — see `maybePushEvent` in `push.js` (guards on `document.visibilityState`). Orchestration lives in `App.jsx` (transition-detection effects gated by the settings toggles).

**New backend surface:**
- `settings` table gained `push_enabled` + six `automation_*`/`notify_*` BOOLEAN columns (auto-migrated via `ADD COLUMN IF NOT EXISTS` in `db.js`).
- `PUT /api/settings` now does partial updates over an allowlist (still serves the on-load timezone sync).
- `POST /api/notify` — app-driven push, gated per-event + master switch.
- `POST /api/data/reset` — `{ categories: [...] }`, one transaction.
- `lib/push.js` `sendPushToAll` checks the `push_enabled` master switch; `cron.js` skips any disabled automation.

**Mobile:** the tab bar becomes a fixed bottom nav (icon-over-label, safe-area aware); the header stays sticky with brand + a single cycling icon theme button (Auto → Light → Dark). No new dependencies — icons are inline SVG.

## Bug-fix pass (Aug 2026)

Found and fixed while investigating a reported bottom-nav indicator misalignment + general mobile jank:

- **Indicator misalignment (the actual reported bug)**: `.fd-tabnav__indicator` used
  `left: 50%; transform: translateX(-50%)` to center itself under the active tab on
  mobile. Framer Motion's `layoutId` shared-element animation takes over that same
  element's `transform` style every frame (that's the mechanism behind the slide
  animation) — it silently overwrote the CSS `translateX(-50%)`, so the bar sat at
  its raw `left` position instead of centered, drifting away from whichever tab was
  active. Fixed by centering with `left: calc(50% - 13px)` (half the 26px width)
  instead of a transform, which doesn't conflict with Framer Motion's ownership of
  that property. **If this indicator (or any other `layoutId`-animated element) ever
  needs repositioning again, don't reach for `transform` in the CSS — use plain
  left/right/top/bottom math instead.**
- **`--rust: var(--rust)`** in the base `:root` block was a self-reference — invalid
  per the CSS spec, so it silently computed to nothing. This is the *fallback* used
  when there's no `data-theme` override and the OS is in dark mode (i.e. the default,
  most common case) — meaning every rust-colored element (overdue-deadline status,
  danger toasts, the Settings "Reset all data" button, error borders using
  `color-mix()` with it) was rendering with an invalid color instead of the intended
  peachy-rust dark-mode tone. The correct value was already duplicated correctly
  under `:root[data-theme="dark"]`; the base block's copy just never got it. Fixed.
- **Mobile smoothness pass**: `viewport-fit=cover` was missing from the viewport
  meta tag, so `env(safe-area-inset-bottom)` — used by the bottom nav's padding —
  was silently resolving to `0` on notched phones. Added. Also: `background-attachment:
  fixed` on `body` is a known scroll-jank cause on mobile Safari (forces a repaint of
  the whole gradient every scroll frame) — now switched to `scroll` below 720px, no
  parallax effect was relying on `fixed` anyway. Added `100dvh` alongside the existing
  `100vh` fallbacks (`100vh` alone freezes to the tallest viewport state and can crop
  content as the address bar shows/hides). Added `-webkit-tap-highlight-color:
  transparent` and `touch-action: manipulation` globally — the former kills the gray
  flash on tap, the latter cuts the ~300ms tap-response delay some mobile browsers
  still apply without it.
- **Tap targets**: the Reminders "Due Now" card's action row (`.fd-reminder-actions`)
  had no `flex-wrap`, so on narrow phones the convert/dismiss/delete links could run
  right up against the card edge with no room to grow; added wrap + minimum
  height/padding on each link so they're not sub-30px hit targets. Same fix for the
  toast's close button, which was ~20×20px.

Not investigated further this session: didn't get to profile actual frame timing on
a real device (no browser in the build sandbox, same limitation as prior sessions) —
worth confirming these fixes actually resolve the "not fluid" feeling on a real phone,
since some of it may also just be inherent to the amount of `backdrop-filter: blur()`
now in use (header/panels/bottom-nav/toasts) on lower-end Android GPUs; if it's still
janky after this pass, dropping blur radius or blur entirely on `prefers-reduced-motion`
would be the next thing to try.
## Chart + animation pass (Aug 2026)

Two more reported issues:

- **Charts too compressed on mobile.** `TrendChart.jsx` rendered a text label under
  every bar (12 for the weekly view) with no thinning — on a narrow panel each label
  is wider than its own column, so they visually merged into unreadable overlapping
  text. Fixed by capping to ~6 evenly-spaced labels (`labelStep =
  Math.ceil(data.length / 6)`), always including the most recent bar; the bars
  themselves are unaffected, only some lose their caption. Separately, `HourDial.jsx`
  had its 12AM/6AM/12PM/6PM labels positioned only 2px from the SVG viewBox edge —
  `text-anchor="middle"` on labels that close to the boundary clips off whichever half
  extends past it (visible in the screenshot as "6A" and "PM" instead of "6AM"/"6PM").
  Fixed by widening the viewBox with a 28px margin on each side without changing any
  of the drawing math (just recomputed `CENTER` from the wider box).
- **Entrance animations feeling web-like, not app-like.** Every view
  (Today/Insights/Budgets/Deadlines/Reminders/Settings) had a 250ms fade+12px-slide-up
  on mount, AND every list item inside Budgets/Deadlines/Reminders/Tasks had its own
  fade+scale/slide-in — all of which replayed in full every time you switched to that
  tab, since switching tabs fully unmounts/remounts the view. If you scrolled down
  right after opening a tab, you'd catch cards still fading/scaling in and progress
  bars still growing from empty — reads as a website's scroll-reveal, not a native
  app where content is just there. Two changes: (1) the per-view mount transition is
  now a fast 120ms opacity-only fade, no slide; (2) added `initial={false}` to every
  list-level `AnimatePresence` (budget cards, deadline cards, both reminder lists,
  tasks) — this is the standard Framer Motion pattern for "don't animate in what was
  already there when this mounted, but still animate genuine adds/removals during the
  session" (creating a new budget while already on that tab still animates in fine;
  reopening the tab later won't replay it). Also added `initial={false}` to the
  top-level tab-switch `AnimatePresence` in `App.jsx` so the very first view shown
  after the splash screen doesn't fade in either.

## Feature ideas (not started — backlog for whoever picks this up)

Suggested Aug 2026, not implemented. Roughly ordered by value-for-effort;
the top three are the recommended starting point.

- **Day-of-week breakdown** — alongside the existing hour-of-day dial.
  Best hour is known (10PM), but not best *day*. Same shape of analytics
  work as `computeSummary`'s hourly bucketing, just bucketed by
  `getDay()` instead of `getHours()`.
- **Session notes** — optional one-line note captured when a session is
  stopped (what actually got done), stored alongside the session row.
  Turns the session log into a work journal, not just durations. Cheap:
  one new nullable column + a text input in the stop flow.
- **CSV/JSON export** — of session history, from Settings, ideally right
  next to the "Reset all data" button as the before-you-nuke-it option.
  No dependency needed, just a `GET /api/sessions/export` that streams
  the existing rows in the target format.
- **Week-over-week comparison** on Insights ("+18% vs last week") instead
  of only the flat trend bars — derivable from `weeklyTotals`, no new
  data needed.
- **Runaway-timer nudge** — if a running session has gone past some
  unreasonable length (forgot to stop it), skews `todaySeconds`/streak.
  Push + in-app nudge after e.g. 4h running.
- **Planned rest day for streaks** — flagged as an open question back in
  Session 1: currently a single missed day fully resets the streak, with
  no concept of a day off. Revisit if that ever feels too punishing.
- **ICS export** for deadlines/reminders, so they show up in a real
  calendar app instead of only inside FocusDial.
- **Weekly digest push** (e.g. Sunday night: "you logged 14h, best day
  was Wednesday") — infrastructure for this already exists (`lib/push.js`,
  `cron.js`), just a new scheduled check alongside the existing three.
- **Session quality tag** — separate from the topic tag, a quick
  1–5 or focused/distracted rating, to eventually see whether the
  longest sessions are actually the best ones or just the longest.
- **Nested tags/projects** — tags are flat today. Only worth it once
  there are enough tags that e.g. "Dev work" vs "Dev work: Client X"
  becomes useful — premature before that.

## Swipe-to-switch-tabs (Aug 2026)

Added `hooks/useSwipeTabs.js`, wired up in `App.jsx` against a ref on
`<main className="fd-main">` (the content area between the fixed header
and bottom nav — swiping there, not at the screen edges, was the ask).

Built on raw `touchstart`/`touchend` rather than framer-motion's
pan/drag gesture on purpose: a live drag recognizer competes with the
browser's own vertical-scroll recognition on a page that's mostly meant
to scroll, which is how you get scrolls that occasionally get eaten by
the gesture recognizer. Instead this just records the start point, then
judges the *finished* gesture against three thresholds (`MIN_DISTANCE`
horizontal, `MAX_VERTICAL` rejects anything that also moved a lot
vertically — i.e. was actually a scroll, `MAX_DURATION` rejects slow
drags) — all via `{ passive: true }` listeners, so scrolling is never
touched. Tab order comes from `TabNav.jsx`'s now-exported `TABS` array,
so adding/reordering tabs there is the only thing that needs to change
for swipe order to follow.

Two deliberate guards: touches starting within 24px of the screen edge
are ignored (that's OS back-gesture territory in a PWA/WebView, not
worth fighting with); touches starting inside an `input`/`textarea`/
`select` are ignored too (dragging to select text shouldn't trigger a
tab change).

Not done: no visual feedback during the drag itself (no
follow-the-finger tracking) — it's binary, swipe past the threshold and
release, or it doesn't count. Worth revisiting if it ever feels
unresponsive in practice, but adds real complexity (would need to
coordinate with the existing opacity-only tab-switch transition rather
than just firing `onChange` at touchend).

## Theme-switch cross-fade

Switching Auto/Light/Dark used to snap colors instantly. Added a
universal transition (`*, *::before, *::after` in `App.css`, wrapped in
`@media (prefers-reduced-motion: no-preference)` so it's skipped
entirely for anyone with that OS preference) covering
`background`/`background-color`/`color`/`border-color`/`box-shadow`/
`fill`/`stroke` at 0.35s.

**The non-obvious part, worth remembering if this ever regresses:** a
universal selector's `transition` is completely overridden — not
merged — by any more-specific selector that declares its own
`transition` property, since `transition` isn't additive across rules.
This codebase had 9 existing component-level `transition:` declarations
(buttons, cards, progress bars, hover rows) that would otherwise have
silently kept switching themes with an instant snap on exactly those
elements, while everything else faded. Fixed by appending the missing
color-related terms into each of those 7 (2 already covered
background+color adequately) rather than relying on the universal rule
alone. **If a new component adds its own `transition:` declaration in
the future, it needs to include `background`/`color`/`border-color`
terms itself (or extend the existing ones) to keep participating in the
theme fade** — the universal rule at the top of the file won't reach it
once it has its own.

View Transitions API (the fancier "circular wipe from the button"
effect) was considered and explicitly not built — asked, and a plain
cross-fade was preferred for broader/simpler browser behavior. Revisit
if a more dramatic transition is ever wanted; current support (Chrome/
Edge 111+, Safari 18+, Firefox 144+ as of the last check) would make it
viable with a safe instant-switch fallback for anything older.

## Day-of-week breakdown, notes-loop closed, session edit, export (Aug 2026)

Picked the top three backlog items plus an explicit ask for a session edit
UI. All four together, one session:

- **Day-of-week breakdown**: `computeSummary` now buckets by `getDay()`
  alongside the existing hourly buckets (`weekdayByGetDay`), then reorders
  to Monday-first for display (`weekday`/`bestWeekday`) — same convention
  as `mondayOf()`. Rendered as a new `WeekdayBreakdown.jsx`, a hand-rolled
  bar chart (still no chart library) placed full-width in Insights rather
  than as an awkward 4th tile in the existing 3-column grid. Best day uses
  the same sage-green (`--grad-green`) as HourDial's best-hour wedge.
- **Session notes, closing the loop**: the `note` column, backend
  accept/store logic, and `ManualEntryForm`'s note field already existed
  from earlier work — what was actually missing was capturing a note when
  *stopping* a running timer session, and displaying notes anywhere.
  Added an inline note field to `TimerPanel` (visible only while running),
  extended `POST /sessions/:id/stop` to accept an optional `note`, and
  `SessionLog` now shows the note under each entry.
- **Session edit modal**: `PATCH /sessions/:id` and `updateSession()` in
  `api.js` already existed with no frontend caller. Added
  `SessionEditModal.jsx` (tag/start/end/note, same field set as
  `ManualEntryForm`) as a centered modal, opened via a new ✎ button next
  to the existing delete ✕ on each `SessionLog` row. Factored the
  `toLocalInputValue` datetime-local formatter out of `ManualEntryForm`
  into `format.js` so both forms share it instead of duplicating it.
- **CSV/JSON export**: `GET /sessions/export?format=csv|json` streams the
  full completed-session history with `Content-Disposition: attachment`.
  CSV cells guard against formula injection (leading `=`/`+`/`-`/`@` gets
  a quote prefix) since `note` is free text the user controls — same
  concern as any user-input CSV export. Settings has a new "Export data"
  card, placed directly above Reset per the backlog's own suggestion,
  with a CSV/JSON toggle reusing `TrendChart`'s pill-toggle style.

Verified: `node --check` clean on every backend file, `npm run build`
clean on the frontend. **Not verified this session:** no browser in this
sandbox, so the note field, edit modal, and export download were checked
by reading the code and the build output, not by clicking through them —
worth a quick manual pass the first time this runs somewhere with a real
browser.

Not done: the remaining backlog items (week-over-week comparison,
runaway-timer nudge, planned rest day, ICS export, weekly digest push,
session quality tag, nested tags) are all still open — see the
"Feature ideas" list above.

## Dropdown and trend-chart rework (Aug 2026, done outside this log)

Freddie reworked `Dropdown.jsx` and `TrendChart.jsx` directly (not
through this assistant), landing in a version that's a genuine
improvement on what was here before — noted here since it wasn't logged
at the time it happened:

- `Dropdown.jsx` is now a true drop-in for `<select>` (`<option>`
  children, `onChange` gives `e.target.value`), portaled to
  `document.body` with real viewport measurement — flips above the
  trigger when there's no room below, recalculates on scroll/resize.
  Also added keyboard nav (arrows/enter/escape/tab). This is what every
  `Dropdown` usage below assumes.
- `TrendChart.jsx`'s label-collision bug (see the previous entry) was
  fixed at the root instead of patched: fixed-width columns with
  horizontal scroll, so every bar gets its own label with guaranteed
  space — the whole "which bars get a label" thinning logic is gone.
- `SettingsView.jsx`: in-app event toggles no longer gray out when push
  is off, with a note explaining they're independent of it.

## Six backlog items in one pass (Aug 2026)

Freddie said to just implement the rest of the backlog. Did six of the
seven — nested tags/projects was deliberately skipped (see below).

- **Week-over-week comparison**: `analytics.js` returns `weekOverWeek`
  — compares "this week so far" (Monday through today) against the
  *same day-span* last week, not full 7-day totals. Comparing a partial
  current week against a complete previous one would always show a
  misleading drop, worse early in the week — so both sides only ever
  cover the same number of days. Shown as a badge (▲/▼ %) in
  `TrendChart`'s header, only on the weekly view, only when there's a
  non-zero prior-week baseline to compare against (a percentage against
  zero is meaningless, not "infinitely up" — `deltaPct` is `null` in
  that case and the badge just doesn't render).
- **Planned rest day for streaks**: new `settings.rest_day_of_week`
  (0-6, nullable, picked via a Dropdown in a new "Streak" settings
  card). `computeSummary`'s streak walk now takes it as a param and
  skips that weekday when nothing was logged — neither breaks nor
  extends the streak, just neutral. Threaded through in three places
  that all needed to agree: the streak calc itself (`analytics.js`), the
  in-app "streak at risk" banner (`App.jsx`), and the backend's
  independent push-based version of the same check (`checkStreakAtRisk`
  in `cron.js`) — all three now skip the rest day the same way.
- **Runaway-timer nudge**: new `sessions.runaway_nudged_at` column.
  `checkRunawayTimer()` in `cron.js` finds any session that's been
  running past 4h with no nudge sent yet, pushes once, and stamps the
  column so it won't nudge again for that same session. Mirrored in-app:
  `TimerPanel` shows an inline warning past the same 4h mark (the two
  thresholds are separate constants, not shared, since one lives in the
  browser bundle and the other in the Node process).
- **Weekly digest push**: `checkWeeklyDigest()` in `cron.js`, fires
  Sunday evening (same local-time-shift pattern as the other cron
  checks), reports total hours + best day over the past 7 days, deduped
  per-calendar-week via `settings.last_weekly_digest_week`.
- **Session quality tag**: new `sessions.quality` column — a closed set
  (`focused`/`neutral`/`distracted`), not a 1-5 scale, so it's a single
  tap rather than something that needs thought. Captured the same way
  notes are: inline while the timer's running, via three pill buttons
  (`TimerPanel`), also available in `ManualEntryForm` and
  `SessionEditModal` for consistency, and shown as a small colored dot
  next to the duration in `SessionLog`. No analytics built on top of it
  yet ("eventually see whether the longest sessions are the best ones"
  per the original backlog note) — that's future work once there's
  enough rated data to make it meaningful.
- **ICS export**: new `GET /api/calendar/export.ics` (`calendar.js`),
  combining active deadlines and pending reminders into one downloadable
  feed — RFC 5545 CRLF line endings, text escaping, `RRULE` for
  recurring reminders. Linked from Settings, next to the CSV/JSON
  session export.
- **Bonus fix, found while touching `PATCH /sessions/:id` for quality**:
  the existing `COALESCE(new_value, old_value)` pattern for `tag_id` and
  `note` couldn't distinguish "field omitted" from "field explicitly
  cleared" — so removing a session's tag or note via the edit modal was
  a silent no-op. Fixed with `hasOwnProperty` presence checks (same
  pattern `routes/deadlines.js` already used for its own `tag_id`).
- **Not done — nested tags/projects**: skipped on purpose. The
  backlog's own note says this is "premature before there are enough
  tags to need it," and there's currently only one tag in the data.
  Building it now would be speculative complexity against the backlog's
  own advice. Worth revisiting once tag count actually grows.

Verified: `node --check` clean on every backend file, `npm run build`
clean on the frontend. **Not verified this session:** no browser in this
sandbox — the quality pills, rest-day dropdown, runaway warning timing,
ICS file (does it actually import cleanly into Google/Apple Calendar),
and week-over-week badge math are all unverified by actually clicking
through them. Worth a manual pass, especially the ICS file against a
real calendar app since that's the part most likely to have a subtle
formatting issue that only shows up on import.

## Google Calendar two-way sync (Aug 2026)

Freddie's planning to deploy to free hosting soon, so this was built
out ahead of that — real OAuth account linking, two-way, via polling
rather than webhooks (a webhook needs a permanently-reachable endpoint
and Google's watch channels expire every ~7 days needing renewal, which
fights a free-tier host that sleeps on idle; polling piggybacks on the
cron tick this app already has running).

**New backend pieces:**
- `google_account` table (singleton, `id = 1`, same pattern as
  `settings`) — stores tokens, connected email, calendar ID, and the
  incremental-sync cursor (`sync_token`).
- `google_event_links` table — maps a FocusDial deadline/reminder to the
  Google Calendar event mirroring it. Used by both directions: push
  uses it to decide create-vs-update, pull uses it to map a
  changed/deleted Google event back to the local row.
- `lib/google.js` — OAuth client setup (`googleConfigured` gates the
  whole feature off gracefully if `GOOGLE_CLIENT_ID`/`_SECRET`/
  `_REDIRECT_URI` aren't set, same shape as `push.js`'s VAPID check),
  token-refresh persistence (googleapis' client refreshes access tokens
  internally but doesn't save the new one anywhere — a `tokens` event
  listener here writes it back to the DB), and the shared
  `pushItemToGoogle`/`deleteItemFromGoogle` helpers.
- `routes/googleAuth.js` — `/api/auth/google/{status,start,callback,disconnect}`.
  The callback backfills every currently-active deadline and pending
  reminder to the newly-connected calendar (so it has immediate parity
  instead of only showing things from now on), *then* establishes the
  sync-token baseline — in that order, so the items just pushed aren't
  immediately misread as remote-side changes on the first poll.
- **Push side** (FocusDial → Google): hooked directly into
  `routes/deadlines.js` and `routes/reminders.js` — create, update,
  delete, dismiss, and both convert-to-deadline/convert-to-task all call
  the shared helpers. Best-effort: every helper swallows its own errors
  (logs, doesn't throw), since the local write has already succeeded by
  the time these run — a Google-side hiccup shouldn't fail the user's
  actual request, just leave that one item's mirror lagging until its
  next edit.
- **Pull side** (Google → FocusDial): `checkGoogleCalendarSync()` in
  `routes/cron.js`, wired into the existing tick alongside the other
  automations, gated by `settings.automation_google_sync`. Uses Google
  Calendar API's `syncToken` mechanism for incremental diffs rather than
  listing everything every tick. An event with no row in
  `google_event_links` is deliberately left alone — this only syncs
  items FocusDial itself created, never imports pre-existing or
  manually-added Google Calendar events as new deadlines/reminders.

**Conflict handling — the one thing worth understanding before relying
on this**: last-edit-wins, nothing fancier. Each event's Google-side
`updated` timestamp is compared against `google_updated` (the value
recorded the last time *this app* touched that event, in either
direction); if they match, it's just an echo of FocusDial's own last
push and is skipped, not a real remote edit. If the same item gets
edited in FocusDial and in Google within the same poll window, whichever
write actually lands on Google's servers last simply wins — no merge,
no per-field diff, no conflict prompt. Fine for a single-user personal
app; would need real operational-transform-style handling for anything
more demanding.

**Other known limitations, on purpose, not by oversight:**
- Recurrence edits made *on the Google side* aren't parsed back into
  FocusDial's daily/weekly/monthly enum — only title/note/time changes
  sync back for reminders. Recurrence only flows FocusDial → Google.
- If Google reports the stored `sync_token` as expired (`410 Gone`),
  the recovery is to drop it and re-baseline — any Google-side changes
  made between the last successful poll and the re-baseline are missed.
  A full historical reconciliation wasn't built; out of scope for a
  periodic personal-app sync.
- Tasks aren't synced (only deadlines + reminders) — consistent with
  the ICS export's scope from the previous session.
- The googleapis Node client (`^174.0.0`) was added as a new backend
  dependency.

**Setup, once deployed:** `backend/.env.example` has the new
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`/
`FRONTEND_URL` vars, all blank with setup instructions in the comments
— left blank rather than a realistic-looking placeholder, same reasoning
as the VITE_API_URL mistake noted earlier in this file. "Testing" mode
on the OAuth consent screen (add your own account as a test user) avoids
Google's full app-verification process, which isn't needed for a
single-user app.

Verified: `node --check` clean on every backend file (caught one real
bug this way — a stray pair of backticks inside a SQL comment in
`db.js` was closing the template literal early and corrupting the whole
schema string), `npm run build` clean on the frontend. **Not verified,
and can't be from this sandbox at all:** none of this has touched a real
Google account or a real Calendar API call — no network access to
Google's endpoints here, and no OAuth credentials exist yet regardless.
Everything above is correct per Google's documented API behavior as I
understand it, but the whole flow (consent screen, token exchange,
backfill, the sync-token baseline timing, and especially the 410-retry
path) needs an actual end-to-end run once this is deployed and a real
OAuth client is configured.

## Dropdown option-list width bug (Aug 2026)

Found via a real-phone screenshot: the rest-day dropdown's option list
("None"/"Mon"/"Tue"/...) was showing every option clipped mid-word
("Tu…", "W…") even though the labels were already the short 3-letter
form — the labels were never the problem. `Dropdown.jsx`'s portaled
list was locked to `width: coords.width` (the trigger's own measured
width), and a trigger showing a short selected value like "None"
shrink-wraps narrow — so the *list* inherited that same narrow width
and clipped every option, including ones that would've fit fine on
their own. Fixed by using `minWidth` instead of a fixed `width` (list
is never narrower than the trigger, but grows to fit its widest
option), with a `maxWidth` cap so it can't run off narrow viewports.

Also worth a permanent note since it came up during testing: **Google
Calendar's Connect flow only works from the same machine running the
backend** (`localhost:5173` in the browser, not the phone's LAN-IP
address) until this is actually deployed. Google's redirect after
consent goes straight to whatever's registered as
`GOOGLE_REDIRECT_URI` — `http://localhost:4000/...` during local
dev — and "localhost" resolves per-device, so a phone hitting that
URL gets `ERR_CONNECTION_REFUSED` since it's not the same machine as
the backend. This isn't a bug to fix; Google explicitly disallows
registering a raw LAN IP (like `192.168.x.x`) as a redirect URI at
all, so there's no code-side fix available pre-deployment — either
test this one feature from the laptop itself, or use a tool like
ngrok for a temporary public HTTPS tunnel if phone testing is needed
before deploying for real.

Verified: `npm run build` clean.






## Multi-user accounts (Aug 2026)

The single biggest change to this app so far — went from "one person, no
login" to real accounts, because Freddie wants to share it with other
people (Ledger already does this; this follows the same instinct).
Touched every table and every route file.

**Auth model:**
- Email/password (bcryptjs, 12 rounds) and "Sign in with Google" both
  work, registration is open (anyone can create an account). An account
  can have either or both auth methods — signing in with Google links
  automatically to an existing password account with the same email,
  rather than creating a duplicate.
- **Two separate Google OAuth flows, deliberately not sharing scopes**:
  `/auth/google/login/*` (signing in — narrow `userinfo.email`/`profile`
  scope, `access_type: online`, no refresh token needed) is completely
  separate from `/auth/google/*` (linking *your own* calendar for sync —
  the existing `calendar.events` scope, `access_type: offline`). Signing
  in with Google shouldn't require granting calendar access. Same OAuth
  client, two different registered redirect URIs — see
  `GOOGLE_LOGIN_REDIRECT_URI` vs `GOOGLE_REDIRECT_URI` in `.env.example`.
- Sessions are cookie-based (`express-session` + `connect-pg-simple`,
  Postgres-backed rather than in-memory so it survives a restart/redeploy),
  not JWT — simpler, well-trodden, and this app has no need for
  stateless/cross-service auth.
- `SESSION_SECRET` is now a **required** env var — the app refuses to
  boot without it (same pattern as the existing `DATABASE_URL` check),
  since a missing/default secret would mean anyone could forge a session.

**Data model:** every table (`sessions`, `tags`, `budgets`, `deadlines`,
`reminders`, `tasks`, `push_subscriptions`) got a `user_id` column.
`settings` and `google_account` — previously singleton tables (`id`
always `1`, one row for the whole app) — became one row per user
instead; the old `CHECK (id = 1)` constraints are dropped, `user_id` is
now what's looked up by. `tags`/`budgets`' name-uniqueness went from
global to per-user (`UNIQUE(user_id, name)`) — two different people are
now allowed to both have a "Deep work" tag. `google_event_links` is the
one table that deliberately has **no** `user_id` column — every lookup
already goes through `item_type`+`item_id`, and that item already
belongs to somebody, so adding it would just be redundant.

**Every route file now filters by `req.userId`** (set by the new
`requireAuth` middleware in `lib/auth.js`, applied to every router in
`index.js` except `authRouter` itself, `cronRouter` — secret-protected,
hit by an external scheduler that can't log in — and `calendarRouter`'s
ICS export, which needed its own fix: it used to have **zero** filtering
at all, meaning every user's deadlines/reminders would have exported
into one shared calendar file. Fixed with a separate per-user
`ics_token` (a bearer secret in the URL's query string, generated lazily
via `GET /calendar/ics-token`) — necessary because calendar apps
"subscribing by URL" poll that endpoint directly with no cookies
attached at all, so session-cookie auth genuinely can't work there.

**`cron.js`** went from "check one global settings row" to "loop over
every user with a settings row, running their own checks against their
own timezone offset and their own dedupe bookkeeping." Every automation
(reminders, deadline pace, streak-at-risk, runaway timer, weekly digest,
Google Calendar poll) is now per-user.

**`lib/google.js` / `lib/push.js`**: `pushItemToGoogle`/
`deleteItemFromGoogle`/`getAuthedClient` all now take a `userId` as
their first argument. `sendPushToAll` was renamed `sendPushToUser` and
takes a `userId` — pushes only ever go to one person's devices now, not
broadcast to everyone's.

**A real bug caught mid-retrofit, worth flagging in case the pattern
recurs**: the Google Calendar OAuth callback's backfill step (mirrors
existing active deadlines/pending reminders to a newly-connected
calendar) originally queried `WHERE status = 'active'` with no user
filter at all — on a single-user app that was harmless, but multi-user
it would have pushed *every* user's deadlines onto whoever just
connected their calendar. Caught by deliberately re-reading every query
in every file being touched rather than just adding `user_id` where it
was "obviously" needed — worth being similarly paranoid on any future
retrofit like this one.

**Migration for pre-existing (single-user era) data**: since `user_id`
was added as a nullable column rather than something auto-migrated
during schema init (safer, but leaves old rows ownerless), there's a
new one-time script: `backend/scripts/migrate-legacy-data.js
you@example.com` — register your account first through the normal
signup flow, then run this once to claim all the previously-ownerless
rows. Idempotent to re-run (only touches rows where `user_id IS NULL`).

**Frontend**: new `AuthGate.jsx` (login/register/Google-sign-in screen)
and `AuthRoot.jsx` (checks `/auth/me` on load, shows `AuthGate` or the
app). `main.jsx` now renders `AuthRoot` instead of `App` directly.
`api.js`'s `apiFetch` sends `credentials: "include"` on every request
now — required for the session cookie to actually be sent, especially
once frontend/backend are split across Vercel/Render (different
origins). A 401 anywhere now calls a registered `unauthorizedHandler`
(wired up in `AuthRoot`) that drops straight back to the login screen,
rather than every affected component separately showing its own
confusing "failed to load" error. Settings has a new "Account" card
(email + sign-out).

Verified: `node --check` clean on every backend file (including the new
`scripts/migrate-legacy-data.js`), `npm run build` clean on the
frontend. **Not verified this session:** no way to actually exercise the
login flow, registration, or Google sign-in end-to-end from this
sandbox (no browser, and the Google OAuth piece specifically needs a
real deployed callback URL to test properly — same limitation as the
calendar-linking OAuth from the previous session). This is a big enough
change that I'd genuinely test the basics by hand before trusting it:
register, log out, log back in, register a second account and confirm
it can't see the first account's data, and — importantly — actually run
`scripts/migrate-legacy-data.js` against existing local data and confirm
nothing that used to be visible disappeared.

## Mobile-first backlog (Aug 2026, not started)

FocusDial's audience is a mix of Android and iPhone users, and this is a
browser-based PWA, not a native app — worth internalizing before picking
up any of these, since two of them are genuinely Android-only due to
WebKit limitations, not an oversight or something fixable here:

- **One-tap resume last tag** — Today screen, skip reopening the tag
  dropdown for back-to-back sessions on the same tag. Plain UI, no
  browser API involved, works identically everywhere.
- **Idle/away detection** — Page Visibility API (`visibilitychange`),
  works on all platforms including iOS Safari/PWA. Record a timestamp on
  hide, compare on show; past some threshold, prompt "you were away Nm —
  keep or trim?" instead of silently counting locked/backgrounded time
  as focused time.
- **Persistent "session running" notification with a Stop action** —
  full support (tappable Stop button via service worker
  `notificationclick`, same pattern already used for push) on Android
  Chrome. On iOS, WebKit doesn't support notification action buttons at
  all — build the notification itself for both, but the Stop button
  only renders/works on Android; iOS gets a plain "session still
  running" notification with no action, tap opens the app instead.
- **Per-tag home-screen shortcuts** — Android/Chrome only, via the
  manifest's `shortcuts` member (already have a manifest from the PWA
  work). **iOS ignores this manifest field entirely** — no equivalent,
  not a bug to chase.
- **Haptic feedback** (`navigator.vibrate()` on start/stop/streak
  milestones) — Android/Chrome only. **Apple has never implemented the
  Vibration API in WebKit, on any iOS browser** — this one has no iOS
  path at all, ever, short of wrapping the PWA in a native shell later.

Building all five despite the Android-only gaps on two of them — a
mixed user base still gets real value from the other three, and the
Android-only ones degrade to "does nothing" on iOS rather than breaking
anything.

## Mobile-first backlog, implemented (Aug 2026)

All five items from the backlog above, with one scoped down from what
was written there — flagged clearly rather than silently built
different from what was asked.

- **One-tap resume last tag**: `TimerPanel` now remembers the tag from
  whatever session was last stopped (`localStorage`, survives reloads)
  and shows a "↻ Resume: {tag}" button right under Start once idle —
  skips the dropdown entirely for back-to-back sessions on the same
  thing.
- **Idle/away detection**: `visibilitychange` listener records when the
  tab goes hidden while a session is running; if it's been away more
  than 5 minutes by the time it's visible again, a prompt offers "Keep
  it" or "Trim {duration}" — trimming pushes the session's `started_at`
  forward by the away time via the existing `PATCH /sessions/:id`, no
  new backend endpoint needed. The same visibility listener also
  re-checks `GET /sessions/running` on every return to foreground, which
  turned out to double as the fix for a gap the notification feature
  below would've otherwise had (see next item).
- **Persistent "session running" notification with Stop**: shown via
  `registration.showNotification` on session start (and on recovering an
  already-running session on load), `tag: "running-session"` so it
  replaces itself rather than stacking. The Stop action calls the stop
  endpoint **directly from the service worker** (`sw.js`'s
  `notificationclick` handler) — works even if the app isn't open at
  all, which is the actual point of a persistent notification. Since the
  SW runs outside the Vite bundle and has no access to `api.js`'s
  `BASE_URL` resolution, the full stop URL is baked into the
  notification's `data` when it's created (`API_BASE_URL`, newly
  exported from `api.js`, specifically for this). After the SW stops a
  session, it `postMessage`s any open tabs so they refresh their timer
  state instead of showing a "running" timer that's actually already
  stopped — this is what the visibility-listener's re-check above
  covers for the backgrounded-tab case; a `message` listener covers the
  rarer case where a tab is open and foregrounded when the notification
  is tapped from elsewhere. **Android/Chrome only for the Stop button
  itself** — WebKit has never implemented the Notification actions API,
  so iOS still gets the notification, just without a working button;
  tapping it opens the app instead, same as any other notification.
  Best-effort throughout: only shows at all if push permission was
  already granted through Settings, never prompts for it on its own.
- **Per-tag home-screen shortcuts — scoped down, worth reading before
  extending this**: the backlog asked for shortcuts specific to each
  user's actual tags. That's not practical as written: `manifest.webmanifest`
  is a single static file, this is a shared multi-tenant app (not
  everyone has the same tags, or any), and the frontend is a static
  Vercel deploy with no per-request manifest generation. A genuinely
  dynamic per-user manifest would need either a backend-served manifest
  route (complicated by frontend/backend being different origins) or a
  client-side Blob-URL swap of the manifest link (real, but unreliable
  for shortcuts specifically, which most browsers only read at install
  time, not on every launch) — both meaningfully bigger and shakier than
  what got built instead: three **static** shortcuts (Start a session,
  Deadlines, Reminders), deep-linking via a new `?tab=` query param
  `App.jsx` now reads on load. Genuinely useful, just not what
  "per-tag" implied. iOS ignores the whole `shortcuts` manifest field
  regardless, same as noted in the original backlog entry.
- **Haptic feedback**: `haptics.js` (new, shared — `TimerPanel` and
  `App.jsx` both needed it) wraps `navigator.vibrate()`, silently a
  no-op where it doesn't exist (iOS, always). Wired to start (short
  pulse), stop (a small pattern), and — genuinely new, this app had no
  streak-milestone concept at all before now — crossing a streak
  milestone (3/7/14/30/60/100/200/365 days, a fixed round-number list
  rather than "every N days") now fires both a toast and a longer
  celebratory vibration pattern.

Verified: `node --check` clean on every backend file and `sw.js`,
`npm run build` clean on the frontend, `manifest.webmanifest` is valid
JSON. **Not verified, and mostly can't be from this sandbox at all**:
none of the five have been exercised on an actual phone. The
notification Stop action specifically needs a real Android/Chrome device
with push permission already granted to test meaningfully — the
happy-path logic is straightforward, but service-worker notification
handling has enough real-device-only edge cases (backgrounding
behavior, notification grouping, OS-level battery/doze restrictions)
that "it should work" is a genuinely different claim from "it works."
Worth a deliberate phone pass through all five before trusting them,
same as every other client-facing feature built in this sandbox so far.

## authResult URL param — cleanup + a real silent-failure fix (Aug 2026)

Spotted from a screenshot: `?authResult=success` was sitting unstripped
in the URL bar after a Google sign-in. While fixing that, found the more
important half of the same gap — `authResult=error` (a *failed* Google
sign-in) was never read anywhere at all. Since `App.jsx` only renders
once `AuthRoot` has a real authenticated user, a failed sign-in never
reaches it — the failure was only ever visible back on `AuthGate.jsx`,
which didn't check for it. Net effect: a failed Google sign-in
previously gave literally no feedback, just silently dumped back on the
same login screen with nothing explaining why. Fixed in `AuthGate.jsx`
(shows the error, strips the param) and `App.jsx` now also strips/toasts
the success case, matching how `googleAuth=`/`tab=` were already handled.

Verified: `npm run build` clean.

## Removed: resume-last-tag and haptic feedback (Aug 2026)

Freddie's call — didn't need them. Pulled cleanly, not just hidden:

- `TimerPanel.jsx`: removed the `lastTag` state, its `localStorage`
  persistence, the resume button, and `handleStart`/`handleStop`'s
  `vibrate()` calls. Idle/away detection and the notification stuff
  stay — those weren't part of this ask.
- `App.jsx`: removed the whole streak-milestone block (detection +
  toast + vibration) — this was built specifically to give the haptic
  feature something to fire on, wasn't a pre-existing or separately
  requested feature, so it went with it rather than leaving a
  toast-only remnant of a feature that's otherwise gone.
- Deleted `haptics.js` entirely (nothing else used it) and the now-dead
  `.fd-timer-resume` CSS.

Verified: `npm run build` clean, grepped for stray `vibrate`/`haptics`
references afterward — none left.

## Deleted: ICS export (Aug 2026)

Redundant now that real two-way Google Calendar sync exists — the ICS
export was the lighter-weight, one-way, poll-interval-limited version of
the same idea, built before the OAuth sync existed. First pass removed
just the Settings buttons; Freddie asked for the rest gone too, so this
is now a full deletion:

- `backend/src/routes/calendar.js` — deleted entirely (`GET
  /api/calendar/export.ics`, `GET /api/calendar/ics-token`).
- `index.js` — router import and mounting removed.
- `api.js` — `calendarExportUrl`/`getIcsToken` removed.
- `SettingsView.jsx` — `ExportSection` back down to just CSV/JSON.

Left in place, deliberately, rather than a destructive migration for
zero functional gain: `settings.ics_token` (the column that backed the
per-user secret token) stays in the schema as a harmless unused nullable
column — `DROP COLUMN` wasn't worth the risk for cleaning up something
that was never going to be queried again anyway. Comment on that column
in `db.js` updated to say so, so it doesn't look orphaned/mysterious to
whoever reads it next.

Verified: `node --check` clean on every backend file, `npm run build`
clean on the frontend, grepped for any remaining reference to
`calendar.js`/`ics-token`/`export.ics` across both — none left except
this note and the explanatory comment on the unused column.

## Undo for every delete/reset (Aug 2026)

Confirm first (custom-styled, not the browser's native `confirm()`),
then delete happens immediately with a 3-second undo window surfaced as
an action button in the toast — not a soft-delete/restore-on-the-server
system, something simpler: the confirmed delete doesn't actually reach
the backend until the window closes with no Undo tap. Tapping Undo just
cancels the pending request; there's nothing to reverse because nothing
was sent yet. Real consequence worth knowing: closing the tab or
reloading during those 3 seconds cancels the pending delete rather than
letting it complete in the background — under-deleting felt like the
safer default than a delete silently finishing after the page that
triggered it is gone.

**New shared pieces:**
- `components/ConfirmDialog.jsx` — `ConfirmProvider` + `useConfirm()`,
  an imperative `await confirm({ title, body })` returning a boolean.
  Reuses the same `.fd-modal-overlay`/`.fd-modal-panel` chrome
  `SessionEditModal` already established, so it's visually consistent
  with the rest of the app rather than another one-off dialog style.
  Wired into `main.jsx` alongside `ToastProvider`.
- `hooks/useUndoableDelete.js` — the actual delay/undo mechanics
  (`requestDelete({ id, label, onHide, onRestore, deleteFn,
  afterCommit })`). Deliberately owns no list state of its own — every
  component holds its items differently (some local state, some props
  re-fetched from `App.jsx`), so the caller supplies its own
  hide/restore, and the hook only owns the timing + toast + undo
  wiring, which is identical everywhere.
- `Toast.jsx` — toasts can now carry an `actionLabel`/`onAction` (the
  Undo button itself), and `useToast()`'s returned function gained a
  `.dismiss(id)` — attached to the existing function rather than
  changing what `useToast()` returns, so none of the ~10 existing
  `const toast = useToast(); toast({...})` call sites needed touching.

**Retrofitted:** `SessionLog`, `TagManager`, `BudgetManager` (budget
delete only — removing a tag *from* a budget stays instant, it's an
unassignment, not a delete), `DeadlinesView`, `RemindersView` (both the
"due now" and "upcoming" delete paths, which previously had separately
duplicated delete logic — now share one handler in the parent),
`TasksWidget`, and Settings' Reset Data section. Status-change actions
(mark deadline done, dismiss a reminder, toggle a task complete) were
deliberately left alone — those aren't deletes.

Reset Data specifically doesn't reuse `useUndoableDelete` directly — that
hook's shape (`onHide`/`onRestore` for one item by id) doesn't fit a
bulk category wipe with nothing to visually hide (Settings doesn't
render the sessions/tags/etc. it's about to clear). Same delay+toast+undo
mechanics, hand-written inline in `ResetSection` instead.

Verified: `npm run build` clean, grepped for any remaining
un-retrofitted direct delete call across every component — none found.
**Not verified this session:** no browser here — the actual undo
interaction (tap delete, see the toast, tap Undo before it closes, item
reappears) needs a real click-through, same as everything else built in
this sandbox.

## Date/time input mobile overflow fix

Every paired date/time field in the app (Start+End in
`ManualEntryForm.jsx`/`SessionEditModal.jsx`, Due-date+Hours in
`DeadlinesView.jsx`/`RemindersView.jsx`, Remind-at+Repeat in
`RemindersView.jsx`) was overflowing/clipping on narrow phones. Root
cause: native `date`/`datetime-local` inputs render several fixed-width
internal segments (month/day/year, hour/minute, AM/PM, the calendar-icon
button) that don't compress — two of them side-by-side in a flex row
simply don't have room on a ~360-390px phone. `color-scheme` was already
set correctly (so the native picker *popup* itself was already themed
right), the bug was purely the closed-state field's layout.

Fix: `width: 100%` on `.fd-manual-form__row input`/`select` (they had no
explicit width before, relying on browser intrinsic sizing), plus a new
`.fd-manual-form__row--dates` modifier class (added to the JSX of each
of those specific rows, not applied blanket to
`.fd-manual-form__row`) that stacks the pair vertically on screens
≤480px instead of forcing them side-by-side. Scoped to a modifier rather
than the base row class so short-field rows elsewhere (Tag, Note, etc.)
keep their normal wrapping behavior.

**Worth knowing for anyone extending date/time UI further:** this
codebase already solved the equivalent problem for `<select>` properly —
`Dropdown.jsx` is a fully custom-built replacement (portaled option
list, positioned/flipped to avoid clipping, styled to match the rest of
the app) rather than a CSS patch on the native element. Native
`date`/`datetime-local` inputs don't have an equivalent custom
replacement here yet — this fix keeps the native browser picker (now
just correctly *sized*), it doesn't rebuild it. If pixel-perfect
cross-device consistency for the picker *popup* itself (not just the
closed field) is ever wanted, a custom calendar/time-select component
following the same pattern as `Dropdown.jsx` would be the natural next
step — flagged, not built, this session.

## Real bug: cron endpoint was unreachable — Express middleware ordering

Live symptom: the external cron trigger (`/api/cron/tick`) returned
`401 {"error":"not signed in"}` on every request, even with the correct
`CRON_SECRET`. Root cause had nothing to do with the secret, or with a
stale deploy (there's only ever been one backend-affecting commit — this
was live from day one and never noticed until the cron trigger was
actually wired up).

**The actual bug:** `app.use("/api", requireAuth, someRouter)` mounts
`requireAuth` at the `/api` *prefix*, not scoped to `someRouter`'s own
paths. Express runs middleware in registration order and doesn't peek
ahead to check whether a later-mounted router would've matched — it just
runs each `app.use()` chain in sequence for anything matching the
prefix. `cronRouter` was registered *after* eight `requireAuth`-gated
routers (`app.use("/api", requireAuth, tagsRouter)` etc.), so the very
first one of those unconditionally intercepted **every** unauthenticated
`/api/*` request — including `/api/cron/tick` — and returned 401 before
`cronRouter` ever got a turn. The code's own comment ("Not
session-protected...") shows the *intent* was always right; only the
registration order was backwards.

**Fix:** moved `app.use("/api", cronRouter)` to immediately after
`authRouter` (the only other unauthenticated router), before any of the
`requireAuth`-gated ones. Order in `index.js` now is: health check →
`authRouter` (unauthenticated) → `cronRouter` (unauthenticated, its own
secret check) → everything else (`requireAuth`-gated).

**General lesson for this codebase going forward:** any future route
meant to be reachable without a session (a webhook, another external
trigger, a public status page, etc.) needs the same treatment — register
it *before* the `requireAuth` block, not after, regardless of how far
down the list feels logical by topic. Grouping by "requires auth or
not," not by feature area, is what actually matters for correctness
here.


## Session 7 — deadline countdown + live tag-linked hours

Two additions to the Deadline Planner, both requested together since
they're related: a real countdown, and having the hours-worked number
actually move while you're mid-session, not just after you stop the
timer.

**Optional due time.** `deadlines.due_time` (nullable `TIME`) added via
the same idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS` pattern
already used for `last_notified_status` — no separate migration file,
consistent with how this project has always evolved the schema in
`db.js`. `routes/deadlines.js`'s PATCH handler treats it like `tag_id`
(a `hasOwnProperty` check + `CASE WHEN`, not `COALESCE`), since a request
needs to be able to explicitly clear a due time back to "just a date" by
sending `due_time: null` — `COALESCE` would silently ignore that and
keep the old value. `computeDeadlineProgress` (`analytics.js`) derives a
new `dueAt` (exact `Date`) per deadline: `due_time` present → that exact
moment on `due_date`; absent → end-of-day, so a deadline with no time set
behaves exactly like it did before this feature existed (not "overdue"
until the day has actually fully passed). The pre-existing `daysLeft`
(whole-day granularity, used for the Ahead/On Track/Tight/Behind pace
read) is deliberately untouched — `dueAt` is only for the new countdown
display, not for feasibility math, so this doesn't change how any
existing deadline was already being judged.

**Live countdown.** `DeadlinesView.jsx` has its own 1-second ticker
(`useLiveNow`) feeding a small `Countdown` component that formats
`dueAt - now` into `Nd hh:mm:ss` (`formatCountdown` in `format.js`). One
shared interval for the whole list, not one per card.

**Live hours while a timer runs.** This is the part worth understanding
before touching it again: `DeadlinesView` polls `GET /sessions/running`
itself (`useRunningSession`, every 15s + on `visibilitychange`) rather
than trying to read `TimerPanel`'s local `running` state. That's a
deliberate choice, not an oversight — `TimerPanel` only exists while the
Today tab is mounted (the tab switcher in `App.jsx` conditionally renders
exactly one tab at a time), so a session could easily be running while
someone's sitting on the Deadlines tab with `TimerPanel` nowhere in the
tree. Polling from `DeadlinesView` directly means the live number works
regardless of which tab started the timer or which tab is open now.

For a deadline with a linked tag, if the currently-running session's
`tag_id` matches, the elapsed time since `started_at` is added on top of
`d.completedHours` (which only reflects sessions already stopped and
saved — see the original `analytics.js` comment on why running sessions
aren't in `history` at all) purely for that render — `completedHours`,
`remainingHours`, and the progress bar's `pct` are all recomputed
locally in the card from that live total. **Nothing is written back
anywhere from this** — it's a display-only projection that self-corrects
the moment the real session is stopped and `onDataChanged`/`loadAll`
refetches actual history. A small pulsing dot (`.fd-countdown__live-dot`)
next to the countdown is the only UI cue that a number is currently
"live" vs. a stable saved value — worth keeping if this is touched again,
since without it there's no way to tell the two apart at a glance.

**Known rough edge, not fixed this session:** the progress bar's
`motion.div` re-runs its `0.6s` width transition on every 1-second tick
while a matching session is running (since `pct` changes slightly each
second). It reads as smooth continuous motion in practice, not as
visibly restarting, but if a future pass wants it perfectly smooth, the
real fix is a CSS-driven fill (`transition: width 1s linear` with no
framer-motion `animate` re-trigger) rather than tuning the current
approach further.

## Session 8 — pagination on Recent Sessions

`GET /api/sessions` was "give me up to `limit` sessions, newest first,"
with no way to reach anything past that. Added `offset` and changed the
response shape from a bare array to `{ sessions, total }` — `total` is a
`COUNT(*)` over the same `WHERE user_id = $1 AND ended_at IS NOT NULL`
run alongside the page query (`Promise.all`, one round trip), so the
frontend can render "Page X of Y" and disable Next without a second
request. This is the only response-shape change in the app's REST API
so far; the only caller was `listRecentSessions` in `api.js`, updated in
the same commit, so nothing else broke.

**Why SessionLog now fetches its own data instead of getting a prop.**
Before this, `App.jsx`'s `loadAll()` fetched 50 sessions up front as part
of its one big `Promise.all`, stored in `recentSessions` state, and
`SessionLog` just rendered whatever slice of that it was handed — fine
for a flat list, not workable for real pagination (you can't "go to page
6" of a list that was only ever fetched 50-deep). `SessionLog` now calls
`listRecentSessions(10, offset)` itself, owns its own `page`/`total`
state, and re-fetches on page change. `loadAll()` no longer touches the
raw session list at all — it still fetches `/sessions/history` (5000-cap,
used for analytics: streaks, tag breakdowns, deadline pace, etc.), which
is a genuinely different endpoint/purpose and was correctly left alone.

**The one thing SessionLog can't know by itself: a new session showing
up.** Starting/stopping the timer and the manual-entry form both live as
separate components on the same tab, not inside `SessionLog` — so
`App.jsx` still needs to tell it "something new landed." That's the
`sessionsVersion` counter: bumped in `handleSessionCompleted` and
`handleSessionCreated`, passed down as a prop, and `SessionLog` resets to
page 1 and re-fetches whenever it changes (same "land on page 1 to see
the new thing" behavior most apps default to). Edits and deletes don't
need this — both are triggered from *inside* `SessionLog` itself (the
edit modal, the delete button), so they just call `load(page)` directly
after committing, no cross-component signal required.

**Why `history` (the analytics copy) still gets patched locally on
delete, in `App.jsx`.** `handleSessionDeleted` used to strip the deleted
session out of both `recentSessions` and `history`. `recentSessions` is
gone now (see above), but `history` still needs that same optimistic
local removal — it's a separate fetch from a separate endpoint
(`/sessions/history`), and without patching it directly, today's total /
streak / deadline progress would all show stale numbers for anything
derived from the deleted session until the next unrelated `loadAll()`
happened to run.

**Page-boundary edge case handled:** deleting the only item on a page
past page 1 (or the last remaining item overall) recomputes the new last
page from `total - 1` and lands there instead of leaving the view on a
now-empty page with nothing but a Prev button to escape with.

**Not extended to Reminders/Tasks this session.** Both are naturally
bounded lists (open tasks, active/upcoming reminders) that don't grow
into the hundreds the way session history does, so they were left as
plain unpaginated lists — flagged here in case that assumption stops
holding and one of them needs the same treatment later.

### Follow-up: skip the recount on plain page turns

Caught right after the pagination above shipped: `GET /api/sessions` ran
a `COUNT(*)` on *every* request, including a plain Prev/Next click where
the total can't possibly have changed — pure wasted work, worse the more
sessions someone has.

Fixed with a `count=0|1` query param (default `1`, so nothing calling
the old shape breaks): `count=0` skips the COUNT query server-side and
returns `total: null`, which the frontend reads as "unchanged, keep what
you already have" rather than something to act on. `SessionLog`'s
`load(pageNum, { withTotal })` defaults to `true`, and only plain
Prev/Next (`goToPage`) and post-edit refetches pass `withTotal: false` —
initial load and post-delete refetches still pass `true`, since those
are exactly the two moments the total can genuinely change (a session
was added or removed).

## Session 9 — inline editing everywhere + custom date/time pickers

Budgets, Deadlines, and Reminders could be created and deleted but not
edited from the UI, even though Budgets' and Deadlines' PATCH endpoints
already existed server-side (Reminders' didn't — added
`PATCH /reminders/:id` in `routes/reminders.js` this session, matching
the same `hasOwnProperty` + `CASE WHEN` pattern already used for
`tag_id`/`due_time` elsewhere, so a field can be explicitly cleared to
`null` and not just left alone by `COALESCE`).

**Inline, not modal.** Each row/card gets a pencil (✎) that expands an
edit form directly inside the row (`editingId` state + `AnimatePresence`
height animation) — the same pattern the create ("+ New") forms already
used, rather than introducing a second interaction pattern. `BudgetEditForm`,
`DeadlineEditForm`, and `ReminderEditForm` live alongside their manager
components. Sessions followed the same path a session later (see below).

**`DateTimeField.jsx` — custom Date/Time/DateTime pickers.** Native
`<input type="date/time/datetime-local">` renders whatever the OS/browser
provides, which looked inconsistent with the rest of the app's custom
`Dropdown` (itself already a from-scratch `<select>` replacement, for the
same reason). `DatePicker`, `TimePicker`, and `DateTimePicker` are portal-
positioned popovers built the same way `Dropdown` positions its option
list — and deliberately keep the **exact same value/onChange contract**
as the native inputs they replace (`"YYYY-MM-DD"`, `"HH:MM"` 24h,
`"YYYY-MM-DDTHH:MM"`), so every call site just swapped the tag with no
change to submit logic. `TimeColumns` (hour/minute/AM-PM scroll lists) is
shared between `TimePicker` and `DateTimePicker`'s combined popover.
Swapped in everywhere a date/time input existed: `ManualEntryForm`,
`SessionEditModal`, `DeadlinesView`, `RemindersView`.

## Session 10 — Session edit moved from modal to inline

Follow-up to Session 9: Sessions were still edited via a popup modal
(`SessionEditModal`'s `fd-modal-overlay`) while everything else had just
moved to inline expand. `SessionEditModal` was rewritten to render as a
plain `motion.form` (no overlay wrapper) with `onCancel`/`onSaved` props
instead of `onClose`; `SessionLog` wraps each row in `.fd-log-row-wrap`
and toggles the form via the same `editingId` pattern as the other three.
**Watch this if touching the row divider styling again:** the
`border-bottom`/`:last-child` rule had to move from `.fd-log-row` to
`.fd-log-row-wrap` — with the edit form as a sibling inside the wrap, the
row itself is no longer reliably the actual last child when a form is
open, which silently ate every row's divider before it was caught.

## Session 11 — three real bugs (not just polish)

All three reported by actual use, not found by re-reading code:

**Service worker served a stale app shell.** `public/sw.js` was
cache-first for *every* same-origin GET, including the page shell itself
— fine for hashed `/assets/*.js` (a new deploy = a new filename, so
cache-first there is always safe), actively wrong for `/` and any
navigation, since it meant a stale cached shell (pointing at an old JS
bundle) could keep getting served indefinitely, including right after
landing back from a Google OAuth redirect — the exact moment freshness
matters most. Fixed: navigation requests (`request.mode === "navigate"`)
now go network-first, falling back to cache only on an actual network
failure. Cache name bumped to `v2` so any already-installed worker drops
its stale shell entries on next activation rather than serving them
forever under the old key.

**Google Calendar connect silently dropped you on the wrong tab.**
`routes/googleAuth.js`'s OAuth callback redirected back to `/?googleAuth=
connected` with no tab info, so `App.jsx`'s initial-tab logic (reads
`?tab=` once at mount) always defaulted to "Today" — a successful connect
looked like nothing happened, since the confirmation lives in Settings
and that's not where you landed. Fixed by hardcoding `&tab=settings` onto
that one redirect (safe to hardcode, not round-trip: Connect/Disconnect
only ever appears in Settings, there's no other page this flow can start
from).

**Requests looked slow "most of the time."** This is Render's free tier
cold-start (spins down when idle, first request can take 20-50s to wake
it), colliding with `api.js`'s old 20s client timeout — the first attempt
routinely aborted right before the server would've actually answered,
and only a manual retry a moment later (server now warm) succeeded.
Raised the timeout to 45s and added one automatic retry in `apiFetch`:
always for a bare network failure (`TypeError`, the request never
reached the server), but for our own timeout (`AbortError`) **only on
GET/HEAD** — a POST/PATCH/DELETE that times out is left alone rather than
silently retried, since the server may have already received and acted
on it the first time, and retrying could double a write.

## Session 12 — focus-quality analytics, a combined risk card, Timer→Task linking

Three features aimed at the same brief: use data the app already has
more, and let its own features inform each other more.

**Focus-quality analytics.** Every session already carried an optional
Focused/Neutral/Distracted `quality` rating that nothing had ever
aggregated. `computeSummary` (`analytics.js`) now tracks it per-hour
(parallel to the existing per-hour *duration* tally — "when do I log the
most time" and "when do I actually focus best" are different questions)
and week-over-week (reusing the same `thisMonday`/`daysElapsedThisWeek`
fairness window as the existing `weekOverWeek` duration comparison, not
a second definition of "this week"). Surfaced as a new `FocusQualityCard`
on the Insights tab. `computeInsightOfTheDay()` picks the single most
notable thing across *all* of summary/budgets/deadlines (a prioritized
candidate list, evaluated top-down — overdue deadline first, generic
encouragement last) and renders as `InsightCard` on Today, so noticing a
trend doesn't require reading every chart yourself.

**Combined risk card.** `computeRiskDigest()` cross-matches budgets
behind pace (`pct < 0.7`) against deadlines at risk (tight/behind/
overdue) by shared tag — a tag behind on both fronts becomes one combined
line ("X is behind pace, and its Y budget is behind too") instead of two
separate, easy-to-miss-the-connection warnings. Renders as `RiskDigestCard`
on Today, and renders nothing at all when there's nothing to flag (no
hollow "all clear" card taking up space every day).

**Timer→Task linking.** New nullable `sessions.task_id` (`ALTER TABLE
... ADD COLUMN IF NOT EXISTS`, same idempotent pattern as every other
schema change in this project, `ON DELETE SET NULL` — deleting a task
shouldn't delete time already logged against it, just drop the
now-meaningless link). A session can now point at a specific open Task,
not just a Tag: Tag answers "what kind of work," Task answers "which
specific thing." Wired into `TimerPanel` (dropdown when idle, a "Mark
'{title}' done when I stop" checkbox — defaulted **on** — while running),
`ManualEntryForm`, and `SessionEditModal`. This closes the loop the other
direction from a Deadline's existing "add as task": that flow lets
finishing a Deadline complete a Task; this lets finishing a *session*
complete one too, instead of that being a second, easy-to-forget trip to
the Tasks widget. `GET /sessions` and `GET /sessions/running` both
`LEFT JOIN tasks` for `task_title` so the log/timer can show the link
without needing the full tasks array passed down everywhere.

## Session 13 — em dash cleanup

Removed the "—" character from every place a user actually sees it:
`FocusQualityCard.jsx`'s trend glyph/placeholder (swapped for "•" and
"n/a"), five auto-generated message strings in `computeInsightOfTheDay`/
`computeRiskDigest` (`analytics.js`, rewritten as separate sentences or
with a comma instead of a dash-joined clause), and the two rate-limit
error strings in `lib/rateLimit.js` ("too many attempts, please wait...").

**Deliberately left alone:** the character is still all over code
comments, `console.*` logs, and the handful of `throw new Error(...)`
startup-config messages in `db.js`/`index.js`/`lib/google.js`/`lib/push.js`
— none of those render inside the running app; they're either developer
documentation or a one-time message printed to the server's own console
before it even finishes booting. If a future pass wants those gone too,
they're easy to find: `grep -rn "—" backend frontend/src` (excluding
`node_modules`) turns up every remaining instance, comment or not.

## Session 14 — proactive "start session?" nudge

Follow-up to Session 12's hourly tag suggestion, which only ever
quietly pre-selected the Timer's tag dropdown — easy to miss, and not
actually "proactive" the way it was originally pitched.

**`computeHourlyTagSuggestions` now tracks `count`** (how many past
sessions contributed to that hour's best tag), not just `seconds`. This
is what lets a consumer tell "this is a real pattern" apart from "one
session happened to land in this hour once" — same `>= 3` bar already
used elsewhere (`mostSustainedTag`, `bestFocusHour`), reused rather than
inventing a new threshold.

**`TimerPanel` now shows an actual card, not just a pre-filled dropdown**,
once that count clears `MIN_NUDGE_SESSIONS` (3): "You usually work on X
around this time," with a **Start now** button that starts the timer
with that tag in one tap (`handleStart` takes an optional tag-id
override for this — the main Start button still calls it with no
override, using whatever's in the dropdown). Below that bar, the old
quiet pre-fill-plus-caption behavior is untouched, so a thin/early
history doesn't get an assertive card with too little evidence behind it.

**Dismiss is scoped to "this hour, today," not forever.** `localStorage`
stores a single `"YYYY-M-D-H"` key on dismiss; the card re-checks that
key against the *current* hour-bucket on every mount, so dismissing it
at 2pm today doesn't suppress it at 2pm tomorrow — same hour, different
day, fresh chance. No backend involved; this is deliberately a
device-local, low-stakes preference, same reasoning as `useNotifications`'
localStorage log.

## Session 15 — in-app Weekly Review

The Sunday-evening digest (`checkWeeklyDigest`, `routes/cron.js`) only
ever existed as a push notification — "X hours this week, best day was
Y" — and only if push was configured and permission granted. This adds
the same "how was this week" answer as a real panel on the Insights tab,
always there rather than a one-shot notification you either saw or
missed.

**`computeWeeklyReview({ sessions, deadlinesProgress, reminders })`**
(new export in `analytics.js`) is deliberately its own self-contained
function, not folded into `computeSummary`. It reuses the same
Monday-start week walk and `qualityRate` helper already in the module,
but takes deadlines/reminders as input for the "coming up" section —
`computeSummary`'s signature (sessions + `restDayOfWeek` only) didn't
need to grow just to answer a question only this one card asks. Wired
in `App.jsx` as its own `useMemo`, alongside (not merged into) the
existing `insightOfTheDay`/`riskDigest` memos.

**Content:** total hours logged this week so far vs. the same point
last week (percentage delta, same fairness convention as the existing
`weekOverWeek` — equal day-count spans, not a partial week against a
full one), best day, top tag, this week's focus-rate, and up to 5 each
of upcoming deadlines/reminders due in the next 7 days. Renders a plain
"no sessions yet" / "nothing due" empty state rather than an intimidating
wall of zeros when either half has nothing to show.

## Session 16 — daily focus goal + configurable digest timing

Two independent Settings additions, both new nullable/defaulted columns
on the per-user `settings` row (same `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` pattern as every other schema change in this project).

**`daily_focus_goal_seconds`** (nullable INTEGER, NULL = off). A single
unscoped "aim for N hours today" number, deliberately separate from
weekly Budgets (which are tag-scoped and week-long, a different
question). Surfaced on `HeroCard.jsx` as a thin progress bar under
today's total, switching to green + a "Goal met" status pill once
`todaySeconds` clears it — same tone system already used for streak/
budget status elsewhere, not a new color vocabulary. NULL vs. 0 matters
here: NULL means the feature's off (no bar rendered at all), 0 would be
a real, already-met goal — `routes/settings.js`'s validator only
rejects genuinely invalid input, not falsy values, to keep that
distinction intact. `SettingsView.jsx`'s `DailyGoalRow` buffers the
hours input in local state and commits on blur (not every keystroke),
the same reasoning any free-typed numeric field needs — everything else
in Settings is a toggle/dropdown that can commit immediately without
that concern.

**`weekly_digest_day_of_week`/`weekly_digest_hour`** (defaults: Sunday,
19 — the old hardcoded behavior, so nobody's existing digest silently
moved). `routes/cron.js`'s `checkWeeklyDigest` now reads both from
`settings` instead of literal `0`/`19`. The per-week dedupe
(`last_weekly_digest_week`) is untouched — it still fires at most once
per calendar week regardless of which day/hour is configured. UI lives
right under the existing "Weekly digest" toggle in Settings (only shown
while that automation's actually on), two `Dropdown`s (day, hour) rather
than a new picker — a weekday + hour-of-day is exactly what `Dropdown`
already handles well, no need for `DateTimeField`'s calendar/time-wheel
machinery here.

## Session 17 — "This week" disagreed with itself across tabs

Real bug, caught by comparing two screenshots side by side: the Today
tab's "This week" stat (`StatsStrip`/`HeroCard`, both reading
`summary.weekSeconds`) and the Insights tab's Weekly Review total
disagreed by several hours at the same moment, for the same account.

**Root cause:** `computeSummary`'s `weekSeconds` was a trailing 7-day
*rolling* window (today back through 6 days ago) — a leftover from
before this app had a "weeks start Monday" convention at all. Every
other weekly figure added since (`weekOverWeek`, `computeBudgetProgress`,
`computeWeeklyTotals`, and Session 15's `computeWeeklyReview`) uses a
Monday-start calendar week instead. The two only agree on Mondays; by
Sunday, the rolling window could include up to 6 days from the
*previous* calendar week that none of the Monday-start figures would
ever count — which is exactly the gap in the screenshots (a Thursday,
partway through a Monday-start week that had barely gotten going, vs. a
rolling window still carrying most of last week).

**Fix:** `weekSeconds` now uses the same `mondayOf(now)` cutoff as
everything else, computed once at the top of `computeSummary` as
`thisWeekStart` and reused for `weekOverWeek`'s calculation too (which
previously had its own separate `mondayOf(now)` call a few dozen lines
later in the same function — consolidated into one, both to fix this
and so there's only one definition of "this week" to keep in sync
going forward). Nothing downstream of `weekSeconds` needed to change —
`HeroCard` and `StatsStrip` just read whatever `summary.weekSeconds` is,
same as before.

## Session 18 — running-session notification: "Untitled session" + no timer

Two real bugs in the persistent "Session running" notification, both
present since it first shipped.

**"Untitled session" even with a tag set.** `showRunningSessionNotification`
(`push.js`) decides the body text from `session.tag_name` — but
`POST /sessions/start`, `POST /sessions/:id/stop`, `POST /sessions`
(manual), and `PATCH /sessions/:id` all used a plain
`INSERT/UPDATE ... RETURNING *`, which can only return columns from
`sessions` itself. `tag_name` was never actually on the object handed
back from any of them — only the list endpoints (`GET /sessions`,
`GET /sessions/history`) ever joined against `tags` at all, and none of
those are what feeds the notification. It showed "Untitled session"
unconditionally, regardless of what tag was picked.

**Fix:** wrapped each of those four queries' INSERT/UPDATE in a
data-modifying CTE, then SELECT + LEFT JOIN tags (and tasks, for
`task_title`) off of it — one round trip, same as a bare `RETURNING *`,
now with the joined columns actually present. `GET /sessions/running`
got the same tags join added directly (it's a plain SELECT, no CTE
needed there).

**No live timer on the notification.** The "1 min" shown next to the
notification's title is the browser's own "posted X ago" indicator —
anchored to whenever `showNotification` was actually called, not to the
session's real `started_at`. Every time it got re-shown (tab refocus,
page reload while a session was already running) that indicator
effectively reset instead of reflecting true elapsed time. Fixed by
passing `timestamp: new Date(session.started_at).getTime()` — the
Notification API's own field for exactly this ("the time this
notification is *about*, not when it was posted"), so the OS renders and
keeps ticking up an accurate relative time on its own. No polling/
interval needed on our side to keep it live.

