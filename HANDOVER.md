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
