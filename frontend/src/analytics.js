// All the "does the thinking for you" logic lives here, computed from raw
// session history rather than as a server-side aggregate - see the comment
// on GET /sessions/history in the backend for why (timezone correctness).
import { formatDuration } from "./format.js";

// Formats a decimal-hours number the same "Xh Ym" way session durations
// are shown elsewhere (formatDuration works in seconds), instead of a
// raw decimal like "0.3h" -- matters once a deadline's pace can be a
// small fraction of an hour (a short, minutes-scale deadline).
function formatHoursShort(hours) {
  return formatDuration(Math.max(0, hours) * 3600);
}

// Same fix as the Deadlines tab's card: a "per day" rate stops meaning
// anything once less than a day is left before the deadline -- dividing
// a large chunk of remaining work by a sliver of a day produces a
// number like "157h/day", which is technically correct but reads as
// broken. Below a day left, this switches to stating remaining work
// against remaining time directly instead.
function deadlinePaceFragment(d) {
  const hoursLeft = d.daysLeft * 24;
  if (hoursLeft > 0 && hoursLeft < 24) {
    return `${formatHoursShort(d.remainingHours)}, with only ${formatHoursShort(hoursLeft)} left`;
  }
  return `${formatHoursShort(d.hoursPerDayNeeded)}/day`;
}

function durationSeconds(session) {
  return (new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 1000;
}

function localDayKey(date) {
  // getFullYear/getMonth/getDate (no UTC prefix) read the browser's local
  // timezone, which is exactly what we want for "what day did this happen
  // on, from the user's own perspective."
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Splits a session's duration across local-midnight boundaries it
// crosses, so a session running 11:45pm-12:15am counts 15m toward the
// day it started and 15m toward the day it ended, instead of the whole
// 30m landing on just one of those days. Every place below that
// attributes time *to a specific calendar day* (streaks, the calendar
// heatmap, "today"/"this week" totals, best-day, weekly/monthly trend
// charts, budget progress) walks these segments rather than assuming a
// session belongs entirely to the day it started.
function splitSessionByLocalDay(session) {
  const end = new Date(session.ended_at);
  let cursor = new Date(session.started_at);
  const segments = [];
  while (cursor < end) {
    const dayStart = startOfLocalDay(cursor);
    const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const segmentEnd = end < nextDayStart ? end : nextDayStart;
    segments.push({ date: dayStart, seconds: (segmentEnd.getTime() - cursor.getTime()) / 1000 });
    cursor = segmentEnd;
  }
  return segments;
}

function mondayOf(date) {
  const d = startOfLocalDay(date);
  const day = d.getDay(); // 0 = Sunday ... 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

// Last `weeksBack` calendar weeks (Monday-start), ending with the current
// week, filled in even for weeks with zero sessions so the chart shows a
// continuous timeline rather than only the weeks that happen to have data.
function computeWeeklyTotals(sessions, weeksBack = 12) {
  const totals = new Map();
  for (const s of sessions) {
    for (const seg of splitSessionByLocalDay(s)) {
      const key = localDayKey(mondayOf(seg.date));
      totals.set(key, (totals.get(key) || 0) + seg.seconds);
    }
  }
  const thisMonday = mondayOf(new Date());
  const result = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const weekStart = new Date(thisMonday.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    result.push({
      periodStart: weekStart,
      seconds: totals.get(localDayKey(weekStart)) || 0,
      isCurrent: i === 0,
    });
  }
  return result;
}

// Last `monthsBack` calendar months, ending with the current month, same
// zero-filling approach as weekly totals above.
function computeMonthlyTotals(sessions, monthsBack = 6) {
  const totals = new Map();
  for (const s of sessions) {
    for (const seg of splitSessionByLocalDay(s)) {
      const key = `${seg.date.getFullYear()}-${seg.date.getMonth()}`;
      totals.set(key, (totals.get(key) || 0) + seg.seconds);
    }
  }
  const now = new Date();
  const result = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    result.push({ periodStart: d, seconds: totals.get(key) || 0, isCurrent: i === 0 });
  }
  return result;
}

// Average seconds of focus per calendar day, over the last 30 completed
// days (or since your first-ever session, if you've been using this
// less than 30 days). Deliberately averaged over every completed day in
// the window - including zero-session days - not just the days you
// happened to work, since a deadline plan needs a realistic "what can I
// actually sustain every day," not a best-case "when I do sit down, how
// long" number.
//
// Day-granular window, stopping at yesterday - same "today's still in
// progress, don't compare it against finished days" convention as
// computeConsistencyScore and the Trend chart's average line (see
// HANDOVER Session 2/20/21). This used to use the *exact timestamp* of
// your earliest session through the current moment instead, which both
// pulled today's still-accumulating total into the sum and rounded the
// day-count with Math.round on a continuously moving elapsed time -
// meaning it could report a different "per day" figure than
// computeConsistencyScore for the same underlying data depending on
// what time of day you happened to check, exactly the kind of
// disagreement Session 17 already fixed once for weekSeconds. Matching
// the same completed-days convention here fixes that class of bug for
// this figure too.
export function computeAvgDailyFocusSeconds(sessions, now = new Date()) {
  if (sessions.length === 0) return 0;
  const earliest = sessions.reduce(
    (min, s) => (new Date(s.started_at) < min ? new Date(s.started_at) : min),
    new Date(sessions[0].started_at)
  );
  const earliestDayStart = startOfLocalDay(earliest);
  const yesterday = new Date(startOfLocalDay(now).getTime() - 24 * 60 * 60 * 1000);
  const daysSinceEarliest =
    Math.floor((yesterday.getTime() - earliestDayStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  // No completed days yet (account created today, nothing logged before
  // today) - nothing to average, same "not enough history" read as a
  // brand-new consistency score returning null.
  if (daysSinceEarliest <= 0) return 0;
  const daysInWindow = Math.min(30, daysSinceEarliest);
  const windowStart = new Date(yesterday.getTime() - (daysInWindow - 1) * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(yesterday.getTime() + 24 * 60 * 60 * 1000); // start of today, exclusive
  const secondsInWindow = sessions
    .filter((s) => {
      const started = new Date(s.started_at);
      return started >= windowStart && started < windowEnd;
    })
    .reduce((sum, s) => sum + durationSeconds(s), 0);
  return secondsInWindow / daysInWindow;
}

// How many completed days actually feed the average above - exposed
// separately so the UI can say "over the last N days" truthfully for a
// newer account, instead of a hardcoded "30 days" that's wrong until an
// account is actually a month old. Deliberately duplicates the window
// math above rather than changing computeAvgDailyFocusSeconds's return
// shape - keeps every existing caller of that function (which just wants
// the number) untouched.
export function computeAvgDailyFocusWindowDays(sessions, now = new Date()) {
  if (sessions.length === 0) return 0;
  const earliest = sessions.reduce(
    (min, s) => (new Date(s.started_at) < min ? new Date(s.started_at) : min),
    new Date(sessions[0].started_at)
  );
  const earliestDayStart = startOfLocalDay(earliest);
  const yesterday = new Date(startOfLocalDay(now).getTime() - 24 * 60 * 60 * 1000);
  const daysSinceEarliest =
    Math.floor((yesterday.getTime() - earliestDayStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  return Math.min(30, Math.max(0, daysSinceEarliest));
}

// How steady your daily focus time actually is, not just how much of
// it there is -- two people can average the same 2h/day with totally
// different feels: one logging ~2h every day, the other alternating
// 5h binges with multi-day gaps. Total/average alone can't tell those
// apart; this looks at the *spread* of daily totals instead.
//
// Population stddev (not sample) over up to the 14 most recent
// *completed* calendar days -- today is deliberately excluded, same
// convention as the Trend chart's average line (see HANDOVER Session
// 2): comparing a still-in-progress day against finished ones
// understates it, since an early-in-the-day zero isn't a real skipped
// day yet.
//
// The window is also clamped to never reach earlier than your first-
// ever session -- same trap computeAvgDailyFocusSeconds's windowStart
// and the Trend chart's average-line fix both already avoid. Without
// this, a brand-new account (or the first fortnight after signup)
// would have days *before it existed* zero-filled into the variance,
// making "just started, only 6 days old" indistinguishable from "6
// active days out of a real, lived-in 14."
//
// Needs at least 5 active days within whatever window is actually
// available (never more than 14, but fewer for a newer account)
// before trusting a score -- same "don't manufacture a pattern from
// too little evidence" bar as computeHourlyTagSuggestions/
// mostSustainedTag (those use >=3 sessions; this uses >=5 days since
// it's a short rolling window, not an all-time one). A window that
// hasn't even reached 5 days yet (account younger than 5 days) can't
// clear that bar regardless of how many of those days were active.
const CONSISTENCY_WINDOW_DAYS = 14;
const CONSISTENCY_MIN_ACTIVE_DAYS = 5;
export function computeConsistencyScore(sessions, now = new Date()) {
  if (sessions.length === 0) return null;

  const dayTotals = new Map();
  let earliest = new Date(sessions[0].started_at);
  for (const s of sessions) {
    const started = new Date(s.started_at);
    if (started < earliest) earliest = started;
    for (const seg of splitSessionByLocalDay(s)) {
      const key = localDayKey(seg.date);
      dayTotals.set(key, (dayTotals.get(key) || 0) + seg.seconds);
    }
  }

  const earliestDayStart = startOfLocalDay(earliest);
  const yesterday = new Date(startOfLocalDay(now).getTime() - 24 * 60 * 60 * 1000);
  const daysSinceEarliest =
    Math.floor((yesterday.getTime() - earliestDayStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const windowDays = Math.min(CONSISTENCY_WINDOW_DAYS, Math.max(0, daysSinceEarliest));
  if (windowDays < CONSISTENCY_MIN_ACTIVE_DAYS) return null; // account too new for even a partial read

  const values = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(yesterday.getTime() - i * 24 * 60 * 60 * 1000);
    values.push(dayTotals.get(localDayKey(d)) || 0);
  }
  const activeDays = values.filter((v) => v > 0).length;
  if (activeDays < CONSISTENCY_MIN_ACTIVE_DAYS) return null;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const score = Math.round(100 / (1 + stddev / mean));

  return { score, avgSeconds: mean, stddevSeconds: stddev, activeDays, windowDays };
}

// Whether jumping between tags a lot in a day comes with a real cost to
// how long individual sessions run -- a different question from the
// existing "which hour/tag am I best in," this looks at same-day
// churn instead of time-of-day or subject matter.
//
// Groups sessions by the local day they *started* on (not split across
// midnight -- a session belongs to one day for switch-counting, unlike
// the duration-attribution elsewhere in this file), sorts each day's
// sessions by start time, and counts how many times the tag actually
// changes between consecutive sessions. Days are bucketed
// high-switch (>=5 tag changes) vs low-switch (0-4), then average
// session length is compared between the two buckets -- only surfaced
// once both buckets have >=3 days behind them (same sample-size bar as
// qualityByDuration) and the gap is at least 15% relative, so a couple
// of noisy days can't manufacture a false "switching costs you" story.
const HIGH_SWITCH_THRESHOLD = 5;
const CONTEXT_SWITCH_MIN_DAYS = 3;
const CONTEXT_SWITCH_MIN_GAP_PCT = 0.15;
// Same "today's still in progress, don't judge it yet" rule as
// computeConsistencyScore and computeComparativeInsights - a day with
// only one session logged so far would otherwise look like a
// zero-switch day and get bucketed as "low switch" with a short average
// duration, even though the day isn't over and more tag-hopping (or a
// longer session) could still happen. Confirmed this actually flipped a
// day's bucket in practice before the fix: a single 20-minute session
// logged so far today landed in the "low switch" bucket next to three
// real 3-hour low-switch days, dragging that bucket's average down.
export function computeContextSwitchCost(sessions, now = new Date()) {
  const todayKey = localDayKey(now);
  const byDay = new Map(); // localDayKey -> sessions[]
  for (const s of sessions) {
    const key = localDayKey(new Date(s.started_at));
    if (key === todayKey) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }

  const highSwitchDurations = [];
  const lowSwitchDurations = [];
  byDay.forEach((daySessions) => {
    if (daySessions.length === 0) return;
    const sorted = [...daySessions].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
    let switches = 0;
    for (let i = 1; i < sorted.length; i++) {
      if ((sorted[i].tag_id ?? null) !== (sorted[i - 1].tag_id ?? null)) switches += 1;
    }
    const avgDuration = sorted.reduce((sum, s) => sum + durationSeconds(s), 0) / sorted.length;
    (switches >= HIGH_SWITCH_THRESHOLD ? highSwitchDurations : lowSwitchDurations).push(avgDuration);
  });

  if (highSwitchDurations.length < CONTEXT_SWITCH_MIN_DAYS || lowSwitchDurations.length < CONTEXT_SWITCH_MIN_DAYS) {
    return null;
  }

  const highAvg = highSwitchDurations.reduce((a, b) => a + b, 0) / highSwitchDurations.length;
  const lowAvg = lowSwitchDurations.reduce((a, b) => a + b, 0) / lowSwitchDurations.length;
  if (lowAvg <= 0) return null;
  const pctShorter = (lowAvg - highAvg) / lowAvg;
  if (pctShorter < CONTEXT_SWITCH_MIN_GAP_PCT) return null;

  return {
    highSwitchAvgSeconds: highAvg,
    lowSwitchAvgSeconds: lowAvg,
    highSwitchDayCount: highSwitchDurations.length,
    lowSwitchDayCount: lowSwitchDurations.length,
    pctShorter,
  };
}

// "You focus 23% more on Tuesdays than your daily average" -- turns the
// weekday chart (WeekdayBreakdown) that's already on Insights into
// plain-language callouts instead of leaving the "how much is that,
// really" read to whoever's eyeballing the bars. Comparative against
// your *own* baseline, not anyone else's numbers.
//
// Same zero-fill + account-age-clamped-window convention as
// computeConsistencyScore: a weekday's average is total seconds logged
// on that weekday divided by how many times that weekday has actually
// *occurred* in the window (including zero-session occurrences), not
// just the sessions that happened to land on it -- otherwise a weekday
// you skip a lot would look artificially high from having fewer,
// larger data points pulling its average up.
//
// Window is 8 calendar weeks (56 completed days), clamped to never
// reach earlier than the account's first-ever session -- same trap
// computeConsistencyScore's windowDays clamp and
// computeAvgDailyFocusSeconds's windowStart both already guard against.
// Today is excluded (in-progress days understate, same as everywhere
// else in this file that deals with "today" vs. completed days).
//
// Each weekday needs >=3 occurrences within whatever window is actually
// available before it's trusted -- same "don't manufacture a pattern"
// bar as mostSustainedTag/computeHourlyTagSuggestions -- and the
// deviation from the overall window average needs to be >=15% relative
// to be worth a sentence, same gap threshold computeContextSwitchCost
// uses for the same reason: a 4% difference is real but not a useful
// thing to tell someone. Returns up to 3 candidates, largest deviation
// first, so a very lopsided week doesn't drown a shorter list in noise.
//
// Concretely: no weekday can clear the >=3-occurrences bar before day
// 15 of an account's history at the very earliest (occurrences of any
// single weekday land 7 days apart, so the 3rd one is day 15) - a
// brand-new account, even a perfect daily streak, will see this stay
// empty until then. ComparativeInsightsCard's empty state says so
// explicitly rather than a vague "check back later," since "why is
// this empty despite a real streak" is the obvious question to ask
// before that point.
const COMPARATIVE_WINDOW_DAYS = 56;
const COMPARATIVE_MIN_OCCURRENCES = 3;
const COMPARATIVE_MIN_DEVIATION_PCT = 0.15;
const COMPARATIVE_MAX_INSIGHTS = 3;
const WEEKDAY_LABELS_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export function computeComparativeInsights(sessions, now = new Date()) {
  if (sessions.length === 0) return [];

  const dayTotals = new Map();
  let earliest = new Date(sessions[0].started_at);
  for (const s of sessions) {
    const started = new Date(s.started_at);
    if (started < earliest) earliest = started;
    for (const seg of splitSessionByLocalDay(s)) {
      const key = localDayKey(seg.date);
      dayTotals.set(key, (dayTotals.get(key) || 0) + seg.seconds);
    }
  }

  const earliestDayStart = startOfLocalDay(earliest);
  const yesterday = new Date(startOfLocalDay(now).getTime() - 24 * 60 * 60 * 1000);
  const daysSinceEarliest =
    Math.floor((yesterday.getTime() - earliestDayStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const windowDays = Math.min(COMPARATIVE_WINDOW_DAYS, Math.max(0, daysSinceEarliest));
  if (windowDays === 0) return [];

  const perWeekday = Array.from({ length: 7 }, () => []); // getDay() -> [seconds,...]
  let windowTotal = 0;
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(yesterday.getTime() - i * 24 * 60 * 60 * 1000);
    const seconds = dayTotals.get(localDayKey(d)) || 0;
    perWeekday[d.getDay()].push(seconds);
    windowTotal += seconds;
  }
  const overallAvg = windowTotal / windowDays;
  if (overallAvg <= 0) return [];

  const candidates = [];
  perWeekday.forEach((values, day) => {
    if (values.length < COMPARATIVE_MIN_OCCURRENCES) return;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const pctDiff = (avg - overallAvg) / overallAvg;
    if (Math.abs(pctDiff) < COMPARATIVE_MIN_DEVIATION_PCT) return;
    const direction = pctDiff > 0 ? "more" : "less";
    candidates.push({
      id: `weekday-${day}`,
      weekdayAvgSeconds: avg,
      overallAvgSeconds: overallAvg,
      occurrences: values.length,
      pctDiff,
      direction,
      text: `You focus ${Math.round(Math.abs(pctDiff) * 100)}% ${direction} on ${WEEKDAY_LABELS_PLURAL[day]} than your daily average.`,
    });
  });

  return candidates
    .sort((a, b) => Math.abs(b.pctDiff) - Math.abs(a.pctDiff))
    .slice(0, COMPARATIVE_MAX_INSIGHTS);
}

// Linear same-pace projection of today's total, for the one question
// the existing goal bar (HeroCard) can't answer on its own: "at this
// rate, will I actually get there." Deliberately naive (today's total
// divided by how much of the day has elapsed, extrapolated to
// midnight) rather than anything session-pattern-aware -- a simple,
// legible number a person can sanity-check in their head beats a
// cleverer model they'd have to trust blindly.
//
// Returns null once the goal's already met (nothing to project) or
// before there's enough of the day elapsed to extrapolate from
// (before 6am, or on a goal-free day) -- an 8am projection off of one
// early session would swing wildly and just be noise.
const GOAL_PROJECTION_MIN_DAY_FRACTION = 0.25; // 6am
export function computeGoalProjection({ todaySeconds, dailyGoalSeconds, now = new Date() }) {
  if (!dailyGoalSeconds || dailyGoalSeconds <= 0) return null;
  if (todaySeconds >= dailyGoalSeconds) return null;

  const dayStart = startOfLocalDay(now);
  const dayMs = 24 * 60 * 60 * 1000;
  const elapsedFraction = (now.getTime() - dayStart.getTime()) / dayMs;
  if (elapsedFraction < GOAL_PROJECTION_MIN_DAY_FRACTION) return null;

  const projectedSeconds = todaySeconds / elapsedFraction;
  const onPace = projectedSeconds >= dailyGoalSeconds;
  const remainingSeconds = Math.max(0, dailyGoalSeconds - todaySeconds);
  const remainingDayMs = Math.max(0, dayMs - (now.getTime() - dayStart.getTime()));

  return { projectedSeconds, onPace, remainingSeconds, remainingDayMs };
}

// Flags when today's first session started meaningfully later than
// usual, purely from mean/stddev of past start times -- no ML, same
// spirit as the rest of this file's "cheap, explainable stats beat a
// black box" approach. A late start is often the earliest visible
// sign of a day slipping, before it shows up in any totals.
//
// Baseline is each of the last 30 days' *first* session's start time
// (minutes since local midnight), excluding today. Needs at least 7
// of those days present -- a full week's worth -- before trusting a
// mean/stddev enough to call anything "unusual" against it; fewer than
// that and one early riser or one late night skews the baseline too
// much to mean anything. Requires stddev > 0 too, since a baseline
// with zero spread would flag any deviation at all as an "anomaly."
const START_TIME_LOOKBACK_DAYS = 30;
const START_TIME_MIN_BASELINE_DAYS = 7;
const START_TIME_ANOMALY_STDDEVS = 2;
export function computeStartTimeAnomaly(sessions, now = new Date()) {
  const todayKey = localDayKey(now);
  const windowStart = new Date(now.getTime() - START_TIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const firstStartByDay = new Map(); // dayKey -> earliest started_at
  for (const s of sessions) {
    const started = new Date(s.started_at);
    if (started < windowStart) continue;
    const key = localDayKey(started);
    const existing = firstStartByDay.get(key);
    if (!existing || started < existing) firstStartByDay.set(key, started);
  }

  const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();
  const todayFirst = firstStartByDay.get(todayKey);
  if (!todayFirst) return null; // nothing logged yet today, nothing to compare

  const baselineMinutes = [];
  firstStartByDay.forEach((d, key) => {
    if (key === todayKey) return;
    baselineMinutes.push(minuteOfDay(d));
  });
  if (baselineMinutes.length < START_TIME_MIN_BASELINE_DAYS) return null;

  const mean = baselineMinutes.reduce((a, b) => a + b, 0) / baselineMinutes.length;
  const variance = baselineMinutes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / baselineMinutes.length;
  const stddev = Math.sqrt(variance);
  if (stddev <= 0) return null;

  const todayMinute = minuteOfDay(todayFirst);
  const deltaMinutes = todayMinute - mean;
  if (deltaMinutes <= stddev * START_TIME_ANOMALY_STDDEVS) return null;

  return { todayStartMinute: todayMinute, avgStartMinute: mean, deltaMinutes, baselineDays: baselineMinutes.length };
}

// Rolls each budget's assigned tags up into "how much of this week's
// target have I actually logged," using the same Monday-start week
// convention as the weekly trend chart.
export function computeBudgetProgress(budgets, sessions) {
  const now = new Date();
  const weekStart = mondayOf(now);
  // End of the current Monday-start week (i.e. end of Sunday), same
  // "end of the last day" convention computeDueAt uses for a deadline
  // with no time-of-day set.
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  const hoursLeftInWeek = (weekEnd.getTime() - now.getTime()) / 3_600_000;

  return budgets.map((b) => {
    const tagIds = new Set((b.tags || []).map((t) => t.id));
    // Split by local day rather than filtering whole sessions on
    // started_at >= weekStart -- a session starting Sunday night and
    // ending Monday morning has a real Monday portion that belongs to
    // this week's budget, which a whole-session filter would drop
    // entirely.
    let actualSeconds = 0;
    for (const s of sessions) {
      if (!s.tag_id || !tagIds.has(s.tag_id)) continue;
      for (const seg of splitSessionByLocalDay(s)) {
        if (seg.date >= weekStart) actualSeconds += seg.seconds;
      }
    }
    const targetSeconds = b.weekly_target_seconds;
    const remainingSeconds = Math.max(0, targetSeconds - actualSeconds);

    // Same fractional-day math as Deadlines (see computeDeadlineProgress
    // below) rather than rounding "days left in the week" to a whole
    // number, for the same reason: that rounding is what let a
    // deadline's countdown and pace figure disagree with each other.
    const daysLeftInWeek = hoursLeftInWeek / 24;
    const secondsPerDayNeeded =
      remainingSeconds <= 0 ? 0 : daysLeftInWeek > 0 ? remainingSeconds / daysLeftInWeek : remainingSeconds;

    return {
      ...b,
      actualSeconds,
      targetSeconds,
      pct: targetSeconds ? actualSeconds / targetSeconds : 0,
      remainingSeconds,
      hoursLeftInWeek,
      secondsPerDayNeeded,
    };
  });
}

// Exact moment a deadline is due. With no due_time, that's end-of-day
// on due_date. due_date comes back from the database as a full
// timestamp string (e.g. "2026-08-13T00:00:00.000Z"), not a plain
// "2026-08-13" -- gluing due_time directly onto it produces a malformed
// string, so the date portion is extracted first.
function computeDueAt(d) {
  const dueDatePart = String(d.due_date).slice(0, 10);
  const dueDate = startOfLocalDay(new Date(dueDatePart));
  return d.due_time ? new Date(`${dueDatePart}T${d.due_time}`) : new Date(dueDate.getTime() + 24 * 60 * 60 * 1000 - 1);
}

// Computes real progress + a feasibility read for each deadline, comparing
// the pace it actually requires against your real historical average - // this is the "does the thinking for you" part: it's not just a countdown,
// it's telling you whether the plan is realistic given how you actually work.
export function computeDeadlineProgress(deadlines, sessions, avgDailyFocusSeconds) {
  const avgDailyFocusHours = avgDailyFocusSeconds / 3600;

  return deadlines.map((d) => {
    let completedHours;
    if (d.tag_id) {
      // Only counts sessions logged since the deadline was created, so
      // pre-existing history on that tag doesn't count as progress you
      // hadn't actually made toward this specific goal yet.
      const createdAt = new Date(d.created_at);
      const seconds = sessions
        .filter((s) => s.tag_id === d.tag_id && new Date(s.started_at) >= createdAt)
        .reduce((sum, s) => sum + durationSeconds(s), 0);
      completedHours = seconds / 3600;
    } else {
      completedHours = Number(d.manual_hours_logged) || 0;
    }

    const estimatedHours = Number(d.estimated_hours);
    const remainingHours = Math.max(0, estimatedHours - completedHours);

    // Same fix as before: derived from the exact due moment (date +
    // optional time-of-day), not a whole-calendar-day count, so this
    // can never disagree with the live countdown.
    const dueAt = computeDueAt(d);

    const hoursLeft = (dueAt.getTime() - Date.now()) / 3_600_000;
    const daysLeft = hoursLeft / 24; // fractional now, not rounded to whole days
    const hoursPerDayNeeded = daysLeft > 0 ? remainingHours / daysLeft : remainingHours;

    let status;
    if (d.status === "done" || d.status === "archived") {
      // Manually set (e.g. the checkmark in DeadlinesView) - this is a
      // deliberate user action, so it must win over the derived pace
      // status instead of being silently recalculated away.
      status = d.status;
    } else if (remainingHours <= 0) {
      status = "done";
    } else if (hoursLeft <= 0) {
      status = "overdue";
    } else if (avgDailyFocusHours <= 0) {
      status = "unknown"; // not enough history yet to judge feasibility
    } else {
      const ratio = hoursPerDayNeeded / avgDailyFocusHours;
      if (ratio <= 0.7) status = "ahead";
      else if (ratio <= 1.05) status = "onTrack";
      else if (ratio <= 1.5) status = "tight";
      else status = "behind";
    }

    return {
      ...d,
      completedHours,
      remainingHours,
      daysLeft,
      hoursPerDayNeeded,
      dueAt,
      status,
    };
  });
}

// Looks back across every deadline that has actually been resolved one
// way or another (marked done, or its due date has already passed) and
// asks a question none of the real-time pace/status logic above
// answers: over time, do you actually hit your deadlines? Takes
// computeDeadlineProgress's own output (deadlinesProgress), not raw
// deadlines, so it reuses the exact same dueAt every card already
// computed instead of re-deriving it a third time.
//
// "Completed at" is approximated as the deadline's updated_at at the
// moment its status last became "done" -- there's no separate
// completed_at column, but updated_at is stamped on every write
// (routes/deadlines.js) and the checkmark in DeadlinesView is the only
// thing that sets status to "done", so in practice this is accurate
// unless a done deadline gets edited again afterward (rare, and only
// off by however long between completing it and touching it again).
//
// Archived deadlines are excluded entirely -- that status means
// "cancelled," not "missed," so counting it against the rate would
// punish clearing out a deadline that no longer applies the same as
// actually blowing through one.
export function computeDeadlineTrackRecord(deadlinesProgress) {
  const now = Date.now();
  let onTime = 0;
  let late = 0;
  let missed = 0;

  for (const d of deadlinesProgress) {
    if (d.status === "archived") continue;
    if (d.status === "done") {
      const completedAt = new Date(d.updated_at).getTime();
      if (completedAt <= d.dueAt.getTime()) onTime += 1;
      else late += 1;
    } else if (d.dueAt.getTime() < now) {
      // Still active (or already flagged overdue) and the due moment
      // has passed without ever being marked done -- a real miss, not
      // just "not resolved yet."
      missed += 1;
    }
    // Anything else (active, not yet due) hasn't been resolved either
    // way and is excluded, the same way an in-progress deadline
    // shouldn't count against or for the rate.
  }

  const resolved = onTime + late + missed;
  return {
    onTime,
    late,
    missed,
    resolved,
    onTimeRatePct: resolved > 0 ? (onTime / resolved) * 100 : null,
  };
}

// For each hour of day (0-23), which tag has the most historical seconds
// logged starting in that hour - used both to pre-select a tag when
// starting a new timer around that time, and (see TimerPanel's
// proactive nudge) to actively suggest starting one. Returns a plain
// object keyed by hour (0-23) to { tagId, name, color, seconds, count }
// or null for hours with no clear tag history. `count` (how many past
// sessions contributed) is what lets a consumer distinguish "this is a
// real pattern" from "one session happened to land in this hour once."
export function computeHourlyTagSuggestions(sessions) {
  // hour -> tagId -> { seconds, count }
  const perHourTagStats = Array.from({ length: 24 }, () => new Map());
  const tagInfo = new Map(); // tagId -> { name, color }

  for (const s of sessions) {
    if (!s.tag_id) continue;
    const hour = new Date(s.started_at).getHours();
    const seconds = durationSeconds(s);
    const bucket = perHourTagStats[hour];
    const existing = bucket.get(s.tag_id) || { seconds: 0, count: 0 };
    existing.seconds += seconds;
    existing.count += 1;
    bucket.set(s.tag_id, existing);
    if (!tagInfo.has(s.tag_id)) {
      tagInfo.set(s.tag_id, { name: s.tag_name, color: s.tag_color });
    }
  }

  const suggestions = {};
  perHourTagStats.forEach((bucket, hour) => {
    if (bucket.size === 0) {
      suggestions[hour] = null;
      return;
    }
    let bestTagId = null;
    let bestStats = { seconds: 0, count: 0 };
    bucket.forEach((stats, tagId) => {
      if (stats.seconds > bestStats.seconds) {
        bestStats = stats;
        bestTagId = tagId;
      }
    });
    suggestions[hour] = bestTagId
      ? { tagId: bestTagId, ...tagInfo.get(bestTagId), seconds: bestStats.seconds, count: bestStats.count }
      : null;
  });
  return suggestions;
}

// Focused-count / rated-count over a subset of sessions, ignoring
// sessions with no quality rating at all (there's no "neutral default"
// to fall back on - an unrated session simply doesn't count toward the
// rate either way). ratePct is null (not 0) when there's no rated
// session in the subset, so callers can tell "0% focused" apart from
// "no data yet."
function qualityRate(sessions) {
  let focused = 0;
  let rated = 0;
  for (const s of sessions) {
    if (!s.quality) continue;
    rated += 1;
    if (s.quality === "focused") focused += 1;
  }
  return { focused, rated, ratePct: rated > 0 ? (focused / rated) * 100 : null };
}

// Answers a different question than the hourly quality breakdown above
// ("when do I focus best") -- "are my longest sessions actually my best
// ones, or just the longest." Every session already carries an
// optional Focused/Neutral/Distracted rating; this is the first thing
// in the app that buckets it by how long the session ran instead of
// when it happened. Only surfaces once there's a real contrast between
// at least two buckets with enough rated sessions to trust (same "at
// least 3" bar used elsewhere -- mostSustainedTag, bestFocusHour), so a
// single outlier long session can't manufacture a false pattern.
const QUALITY_DURATION_BUCKETS = [
  { key: "under30", label: "under 30m", maxSeconds: 30 * 60 },
  { key: "30to60", label: "30m-1h", maxSeconds: 60 * 60 },
  { key: "1to2h", label: "1-2h", maxSeconds: 2 * 60 * 60 },
  { key: "over2h", label: "over 2h", maxSeconds: Infinity },
];

function qualityByDuration(sessions) {
  const buckets = QUALITY_DURATION_BUCKETS.map((b) => ({ ...b, sessions: [] }));
  for (const s of sessions) {
    if (!s.quality) continue;
    const seconds = durationSeconds(s);
    const bucket = buckets.find((b) => seconds <= b.maxSeconds) || buckets[buckets.length - 1];
    bucket.sessions.push(s);
  }
  const eligible = buckets
    .map((b) => ({ key: b.key, label: b.label, ...qualityRate(b.sessions) }))
    .filter((b) => b.rated >= 3);
  if (eligible.length < 2) return null; // nothing to contrast yet

  const best = eligible.reduce((a, b) => (b.ratePct > a.ratePct ? b : a));
  const worst = eligible.reduce((a, b) => (b.ratePct < a.ratePct ? b : a));
  return { buckets: eligible, best, worst };
}

export function computeSummary(sessions, restDayOfWeek = null, graceEnabled = false) {
  const now = new Date();
  const todayKey = localDayKey(now);
  // Monday-start calendar week, matching the convention used everywhere
  // else in this file (mondayOf(), weekOverWeek, computeBudgetProgress,
  // computeWeeklyTotals, computeWeeklyReview) - this used to be a
  // trailing 7-day rolling window instead (today back through 6 days
  // ago), which quietly disagreed with all of those any day that isn't
  // a Monday, worst by Sunday (up to 6 extra days of the *previous*
  // calendar week counted as "this week"). That's what made the Today
  // tab's "This week" stat and the Insights tab's Weekly Review total
  // show two different numbers for what's supposed to be the same
  // question.
  const thisWeekStart = mondayOf(now);

  let todaySeconds = 0;
  let weekSeconds = 0;
  let allTimeSeconds = 0;

  const dayTotals = new Map(); // localDayKey -> seconds, for streak + heatmap
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, seconds: 0 }));
  // Parallel to `hourly` above but tallying quality ratings instead of
  // duration - "which hour do I log the most time in" and "which hour
  // do I actually focus best in" are different questions, and only the
  // first one was answerable before this existed.
  const hourlyQuality = Array.from({ length: 24 }, () => ({ focused: 0, rated: 0 }));
  // Indexed by JS's native getDay() (0 = Sunday ... 6 = Saturday) so the
  // accumulation loop below can write straight into it, same shape as
  // `hourly` above. Reordered to Monday-first only for display, right
  // before it's returned - see `weekday` below.
  const weekdayByGetDay = Array.from({ length: 7 }, (_, day) => ({ day, seconds: 0 }));
  const tagTotals = new Map(); // tag_id ('untagged' if none) -> {name,color,seconds,count}

  for (const s of sessions) {
    const started = new Date(s.started_at);
    const seconds = durationSeconds(s);
    allTimeSeconds += seconds;

    // Calendar-day attribution (streak, heatmap, today/week totals, the
    // weekday pattern) splits at local midnight -- see
    // splitSessionByLocalDay -- so a session crossing midnight counts
    // toward both days it actually touched, not just the one it started
    // on.
    for (const seg of splitSessionByLocalDay(s)) {
      const dayKey = localDayKey(seg.date);
      dayTotals.set(dayKey, (dayTotals.get(dayKey) || 0) + seg.seconds);
      if (dayKey === todayKey) todaySeconds += seg.seconds;
      if (seg.date >= thisWeekStart) weekSeconds += seg.seconds;
      weekdayByGetDay[seg.date.getDay()].seconds += seg.seconds;
    }

    // Attributes the whole session to the hour it started in, rather than
    // splitting a session that crosses an hour boundary proportionally - // a reasonable simplification for a "which hour am I usually
    // focused in" insight, not a billing system.
    hourly[started.getHours()].seconds += seconds;

    if (s.quality) {
      const bucket = hourlyQuality[started.getHours()];
      bucket.rated += 1;
      if (s.quality === "focused") bucket.focused += 1;
    }

    const tagKey = s.tag_id || "untagged";
    const existing = tagTotals.get(tagKey) || {
      tagId: s.tag_id,
      name: s.tag_name || "Untagged",
      color: s.tag_color || "#8C8074",
      seconds: 0,
      count: 0,
    };
    existing.seconds += seconds;
    existing.count += 1;
    tagTotals.set(tagKey, existing);
  }

  // Streak: walk backwards day by day from today. If today has no logged
  // session yet, that's not a broken streak - the day isn't over - so
  // start counting from yesterday instead in that case. A configured
  // rest day (see Settings) doesn't break the streak even with zero
  // sessions logged - it's skipped over rather than counted, so it
  // neither extends nor resets the streak on its own. Addresses the
  // open question from the original streak design: previously a single
  // missed day fully reset it, with no concept of a planned day off.
  //
  // Recovery grace (opt-in, separate from the rest day): one protected
  // miss per Monday-start calendar week. Unlike the rest day, this isn't
  // tied to a specific weekday - it's a one-time-per-week allowance that
  // covers whichever day actually gets missed. `graceUsedWeeks` tracks
  // which weeks (by Monday key) have already spent their one protected
  // miss during this walk, so a second miss in the same week still
  // breaks the streak as normal - only the first one per week is
  // forgiven. `streakGraceAvailable` specifically answers "is *this*
  // week's grace still unspent as of right now" - flipped false the
  // moment the walk consumes it while still inside the current week -
  // so the UI can tell "a miss tonight would still be safe" apart from
  // "the safety net for this week is already used."
  let streakDays = 0;
  let cursor = startOfLocalDay(now);
  if (!dayTotals.has(todayKey)) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  const graceUsedWeeks = new Set();
  const nowWeekKey = localDayKey(mondayOf(now));
  let streakGraceAvailable = graceEnabled;
  while (true) {
    const key = localDayKey(cursor);
    if (dayTotals.has(key)) {
      streakDays += 1;
    } else if (restDayOfWeek !== null && cursor.getDay() === restDayOfWeek) {
      // Rest day, nothing logged - skip without breaking or counting.
    } else if (graceEnabled && !graceUsedWeeks.has(localDayKey(mondayOf(cursor)))) {
      // Protected miss - consumes this week's one grace, streak
      // continues without counting the day itself.
      const weekKey = localDayKey(mondayOf(cursor));
      graceUsedWeeks.add(weekKey);
      if (weekKey === nowWeekKey) streakGraceAvailable = false;
    } else {
      break;
    }
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }

  // Week-over-week: "this week so far" (Monday through today) against
  // the equivalent Monday-through-same-weekday slice of last week - not
  // full 7-day totals, since comparing a partial current week against a
  // complete previous one would always show a misleading drop, worse the
  // earlier in the week it is. Both slices cover the same day count, so
  // the comparison is fair at any point in the week. Reuses
  // `thisWeekStart` from the top of this function rather than a second
  // `mondayOf(now)` call - that's also what `weekSeconds` above is now
  // scoped to, so this and the hero card's "This week" stat agree.
  const daysElapsedThisWeek = Math.floor((startOfLocalDay(now) - thisWeekStart) / 86400000) + 1;
  let thisWeekSoFarSeconds = 0;
  let lastWeekSameSpanSeconds = 0;
  for (let i = 0; i < daysElapsedThisWeek; i++) {
    const day = new Date(thisWeekStart.getTime() + i * 24 * 60 * 60 * 1000);
    thisWeekSoFarSeconds += dayTotals.get(localDayKey(day)) || 0;
    const lastWeekDay = new Date(day.getTime() - 7 * 24 * 60 * 60 * 1000);
    lastWeekSameSpanSeconds += dayTotals.get(localDayKey(lastWeekDay)) || 0;
  }
  const weekOverWeek = {
    thisWeekSoFarSeconds,
    lastWeekSameSpanSeconds,
    deltaSeconds: thisWeekSoFarSeconds - lastWeekSameSpanSeconds,
    // null (not 0 or Infinity) when there's no prior-week baseline to
    // compare against - a percentage against zero is meaningless, not
    // "infinitely up."
    deltaPct: lastWeekSameSpanSeconds > 0 ? (thisWeekSoFarSeconds - lastWeekSameSpanSeconds) / lastWeekSameSpanSeconds : null,
  };

  const bestHour = hourly.reduce((best, h) => (h.seconds > best.seconds ? h : best), hourly[0]);

  // Same "at least 3 rated sessions" bar as mostSustainedTag below, for
  // the same reason - one lucky/unlucky rating in an otherwise-empty
  // hour shouldn't crown it "best" or "worst." Null (not hour 0) when
  // nothing clears that bar, so callers can tell "no confident answer
  // yet" apart from a real result at midnight.
  const MIN_RATED_FOR_HOUR = 3;
  let bestFocusHour = null;
  hourlyQuality.forEach((bucket, hour) => {
    if (bucket.rated < MIN_RATED_FOR_HOUR) return;
    const ratePct = (bucket.focused / bucket.rated) * 100;
    if (!bestFocusHour || ratePct > bestFocusHour.ratePct) {
      bestFocusHour = { hour, ratePct, rated: bucket.rated };
    }
  });

  // Quality (focus-rate) trend, same "this week so far vs. the same
  // number of days last week" fairness rule as weekOverWeek above - // reusing thisWeekStart/daysElapsedThisWeek rather than a second
  // definition of "this week."
  const thisWeekQuality = qualityRate(sessions.filter((s) => new Date(s.started_at) >= thisWeekStart));
  const lastWeekQualityStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekQualityEnd = new Date(lastWeekQualityStart.getTime() + daysElapsedThisWeek * 24 * 60 * 60 * 1000);
  const lastWeekQuality = qualityRate(
    sessions.filter((s) => {
      const started = new Date(s.started_at);
      return started >= lastWeekQualityStart && started < lastWeekQualityEnd;
    })
  );
  const overallQuality = qualityRate(sessions);
  const quality = {
    ratedCount: overallQuality.rated,
    totalCount: sessions.length,
    focusRatePct: overallQuality.ratePct,
    thisWeekFocusRatePct: thisWeekQuality.ratePct,
    byDuration: qualityByDuration(sessions),
    lastWeekFocusRatePct: lastWeekQuality.ratePct,
    // Percentage-point change (not a ratio) - null unless both weeks
    // have at least one rated session to compare, same reasoning as
    // weekOverWeek's deltaPct null-vs-zero distinction above.
    deltaPct:
      thisWeekQuality.ratePct != null && lastWeekQuality.ratePct != null
        ? thisWeekQuality.ratePct - lastWeekQuality.ratePct
        : null,
    bestHour: bestFocusHour,
  };

  const bestWeekday = weekdayByGetDay.reduce(
    (best, d) => (d.seconds > best.seconds ? d : best),
    weekdayByGetDay[0]
  );
  // Monday-first for display, consistent with this app's Monday-start
  // week convention (see mondayOf() above) - the accumulation above still
  // uses getDay()'s native Sunday-first indexing, this just reorders the
  // same 7 entries for the chart.
  const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
  const weekday = MONDAY_FIRST.map((day) => weekdayByGetDay[day]);

  const byTag = [...tagTotals.values()]
    .map((t) => ({ ...t, avgSeconds: t.count ? t.seconds / t.count : 0 }))
    .sort((a, b) => b.seconds - a.seconds);

  // "Most productive" tag: longest average session length among tags with
  // at least 3 sessions (enough to not be a fluke from one long outlier),
  // not just whichever tag has the most total time - total time mostly
  // just reflects what you do most, not what you're best at sustaining
  // focus on.
  const eligibleForAvg = byTag.filter((t) => t.count >= 3);
  const mostSustainedTag =
    eligibleForAvg.length > 0
      ? eligibleForAvg.reduce((best, t) => (t.avgSeconds > best.avgSeconds ? t : best))
      : null;

  // Last 12 weeks (84 days) of daily totals, oldest first, for the
  // calendar heatmap.
  const daily = [];
  for (let i = 83; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    daily.push({ dateKey: localDayKey(d), date: d, seconds: dayTotals.get(localDayKey(d)) || 0 });
  }

  return {
    todaySeconds,
    weekSeconds,
    allTimeSeconds,
    streakDays,
    streakGraceAvailable,
    hourly,
    bestHour,
    weekday,
    bestWeekday,
    weekOverWeek,
    byTag,
    mostSustainedTag,
    quality,
    daily,
    weeklyTotals: computeWeeklyTotals(sessions),
    monthlyTotals: computeMonthlyTotals(sessions),
    avgDailyFocusSeconds: computeAvgDailyFocusSeconds(sessions),
    avgDailyFocusWindowDays: computeAvgDailyFocusWindowDays(sessions),
    hourlyTagSuggestions: computeHourlyTagSuggestions(sessions),
    consistency: computeConsistencyScore(sessions, now),
    startTimeAnomaly: computeStartTimeAnomaly(sessions, now),
    contextSwitchCost: computeContextSwitchCost(sessions, now),
    comparativeInsights: computeComparativeInsights(sessions, now),
  };
}

const HOUR_LABEL_OPTS = { hour: "numeric" };
function hourLabel(hour) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, HOUR_LABEL_OPTS);
}

// Picks the single most notable, actionable thing to surface right now
// out of everything the app already knows - a prioritized list of
// candidate observations, evaluated top-down, first one whose
// condition actually holds wins. Order matters: it's roughly "most
// urgent to act on" first (an overdue deadline) down to "just a nice
// thing to know" last (your best-sustained tag), so the one thing shown
// is the one most worth seeing today, not whichever happens to compute
// first.
export function computeInsightOfTheDay({ summary, budgetsProgress = [], deadlinesProgress = [] }) {
  const candidates = [];

  const overdue = deadlinesProgress.filter((d) => d.status === "overdue");
  if (overdue.length > 0) {
    candidates.push({
      tone: "danger",
      message:
        overdue.length === 1
          ? `"${overdue[0].title}" is now overdue.`
          : `${overdue.length} deadlines are now overdue, including "${overdue[0].title}."`,
    });
  }

  // Compounding risk: a tag that's behind on both its weekly budget and
  // a deadline riding on that same tag - worth calling out together
  // since either alone might look manageable.
  const behindBudgets = budgetsProgress.filter((b) => b.pct < 0.7);
  for (const d of deadlinesProgress) {
    if (!d.tag_id || !["tight", "behind"].includes(d.status)) continue;
    const matchedBudget = behindBudgets.find((b) => (b.tags || []).some((t) => t.id === d.tag_id));
    if (matchedBudget) {
      candidates.push({
        tone: "warning",
        message: `"${d.title}" is behind pace, and its "${matchedBudget.name}" budget is behind too. This tag needs more time this week.`,
      });
      break; // one compounding example is enough to make the point
    }
  }

  const behind = deadlinesProgress.filter((d) => d.status === "behind");
  if (behind.length > 0) {
    candidates.push({
      tone: "warning",
      message: `"${behind[0].title}" is behind pace. You need ${deadlinePaceFragment(behind[0])} to catch up.`,
    });
  }

  const q = summary.quality;
  if (q.deltaPct != null && q.deltaPct <= -10) {
    candidates.push({
      tone: "warning",
      message: `Your focus rate dropped ${Math.abs(Math.round(q.deltaPct))} points this week (${Math.round(q.thisWeekFocusRatePct)}% vs ${Math.round(q.lastWeekFocusRatePct)}% last week).`,
    });
  }
  if (q.deltaPct != null && q.deltaPct >= 10) {
    candidates.push({
      tone: "positive",
      message: `Your focus rate is up ${Math.round(q.deltaPct)} points this week (${Math.round(q.thisWeekFocusRatePct)}% vs ${Math.round(q.lastWeekFocusRatePct)}% last week). Whatever changed, keep it up.`,
    });
  }

  if (q.bestHour && q.bestHour.ratePct >= 70) {
    // Names the actual tag you tend to work on at this hour when
    // there's a real pattern behind it (same >=3 "not a fluke" bar
    // used elsewhere), rather than a generic "deep work" -- that read
    // like a named category/slot you were supposed to already have,
    // which isn't what it meant.
    const tagAtBestHour = summary.hourlyTagSuggestions?.[q.bestHour.hour];
    const activityText = tagAtBestHour && tagAtBestHour.count >= 3 ? tagAtBestHour.name : "your most demanding work";
    candidates.push({
      tone: "neutral",
      message: `You're focused most often around ${hourLabel(q.bestHour.hour)} (${Math.round(q.bestHour.ratePct)}% of rated sessions). Worth protecting that slot for ${activityText}.`,
    });
  }

  if (summary.streakDays >= 3) {
    candidates.push({
      tone: "positive",
      message: `You're on a ${summary.streakDays}-day streak. Keep it going.`,
    });
  }

  if (summary.weekOverWeek.deltaPct != null && summary.weekOverWeek.deltaPct >= 0.15) {
    candidates.push({
      tone: "positive",
      message: `You've logged ${Math.round(summary.weekOverWeek.deltaPct * 100)}% more focus time this week than the same point last week.`,
    });
  }

  if (summary.mostSustainedTag) {
    candidates.push({
      tone: "neutral",
      message: `Your longest average sessions are on "${summary.mostSustainedTag.name}" (${Math.round(summary.mostSustainedTag.avgSeconds / 60)}m each). That's where your focus holds up best.`,
    });
  }

  if (summary.contextSwitchCost) {
    const c = summary.contextSwitchCost;
    candidates.push({
      tone: "neutral",
      message: `Days with ${HIGH_SWITCH_THRESHOLD}+ tag switches average ${Math.round(c.pctShorter * 100)}% shorter sessions (${Math.round(c.highSwitchAvgSeconds / 60)}m vs ${Math.round(c.lowSwitchAvgSeconds / 60)}m). Fewer switches, longer stretches.`,
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      tone: "neutral",
      message:
        summary.allTimeSeconds === 0
          ? "Log a few sessions to start seeing personalized insights here."
          : "Keep logging sessions (and rating them) to unlock more personalized insights.",
    });
  }

  return candidates[0];
}

// Everything currently worth a "heads up" across Budgets and Deadlines,
// in one list - cross-referencing by shared tag so a tag that's behind
// on both fronts shows up as one combined line instead of two
// disconnected ones. Severity order: overdue > behind > tight budget
// alone, so the most urgent item leads.
export function computeRiskDigest({ budgetsProgress = [], deadlinesProgress = [] }) {
  const behindBudgets = budgetsProgress.filter((b) => b.pct < 0.7);
  const riskyDeadlines = deadlinesProgress.filter((d) => ["tight", "behind", "overdue"].includes(d.status));
  const crossMatchedBudgetIds = new Set();
  const items = [];

  const severityRank = { overdue: 0, behind: 1, tight: 2 };

  for (const d of riskyDeadlines) {
    const matchedBudget = d.tag_id ? behindBudgets.find((b) => (b.tags || []).some((t) => t.id === d.tag_id)) : null;
    if (matchedBudget) {
      crossMatchedBudgetIds.add(matchedBudget.id);
      items.push({
        key: `deadline-${d.id}-budget-${matchedBudget.id}`,
        tone: d.status === "overdue" ? "danger" : "warning",
        rank: severityRank[d.status],
        message:
          d.status === "overdue"
            ? `"${d.title}" is overdue, and its "${matchedBudget.name}" budget is behind too.`
            : `"${d.title}" is ${d.status} on pace, and its "${matchedBudget.name}" budget is behind (${Math.round(matchedBudget.pct * 100)}% of this week's goal).`,
      });
    } else {
      items.push({
        key: `deadline-${d.id}`,
        tone: d.status === "overdue" ? "danger" : "warning",
        rank: severityRank[d.status],
        message:
          d.status === "overdue"
            ? `"${d.title}" is overdue.`
            : `"${d.title}" is ${d.status} on pace, needs ${deadlinePaceFragment(d)} to finish in time.`,
      });
    }
  }

  for (const b of behindBudgets) {
    if (crossMatchedBudgetIds.has(b.id)) continue; // already surfaced above, combined with a deadline
    items.push({
      key: `budget-${b.id}`,
      tone: "warning",
      rank: 3,
      message: `"${b.name}" is behind this week, ${Math.round(b.pct * 100)}% of its ${formatDuration(b.targetSeconds)} goal so far.`,
    });
  }

  items.sort((a, b) => a.rank - b.rank);
  return { items, allClear: items.length === 0 };
}

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The in-app counterpart to the Sunday-evening push digest
// (routes/cron.js's checkWeeklyDigest) -- richer than that push (which
// only has room for "X hours, best day was Y"), since this reuses
// everything already computed for Insights instead of being limited to
// what fits in a notification. Deliberately a separate, self-contained
// function (own Monday-start week walk, own quality tally) rather than
// bolted onto computeSummary -- it answers "how was this week"
// specifically, not "give me every angle on all-time history," and
// keeping it separate means it can take deadlines/reminders as input
// without computeSummary's signature (sessions + restDayOfWeek only)
// having to grow to accommodate it.
export function computeWeeklyReview({ sessions, deadlinesProgress = [], reminders = [] }) {
  const now = new Date();
  const thisMonday = mondayOf(now);
  const daysElapsed = Math.floor((startOfLocalDay(now) - thisMonday) / 86400000) + 1;
  const lastWeekStart = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekEnd = new Date(lastWeekStart.getTime() + daysElapsed * 24 * 60 * 60 * 1000);

  // Overlap-based (not just started_at >= thisMonday) so a session that
  // started Sunday night and ran past midnight is still counted as
  // touching this week -- its tag/quality apply to the whole session
  // (see tagTotals/weekQuality below), while its actual *time* is split
  // per calendar day just below.
  const thisWeekSessions = sessions.filter((s) => new Date(s.ended_at) > thisMonday);
  const lastWeekSessions = sessions.filter((s) => {
    const started = new Date(s.started_at);
    const ended = new Date(s.ended_at);
    return ended > lastWeekStart && started < lastWeekEnd;
  });

  // Splits each session by local day and only counts the portion that
  // actually falls within [rangeStart, rangeEnd) -- so a session
  // crossing midnight into this week contributes just its this-week
  // minutes, not the whole thing (and not zero, either).
  function secondsByDayInRange(sessionsList, rangeStart, rangeEnd) {
    let total = 0;
    const perDay = new Map();
    for (const s of sessionsList) {
      for (const seg of splitSessionByLocalDay(s)) {
        if (seg.date >= rangeStart && seg.date < rangeEnd) {
          total += seg.seconds;
          const key = localDayKey(seg.date);
          perDay.set(key, (perDay.get(key) || 0) + seg.seconds);
        }
      }
    }
    return { total, perDay };
  }

  const thisWeekFull = new Date(thisMonday.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { total: totalSeconds, perDay: dayTotals } = secondsByDayInRange(
    thisWeekSessions,
    thisMonday,
    thisWeekFull
  );
  const { total: lastWeekSeconds } = secondsByDayInRange(lastWeekSessions, lastWeekStart, lastWeekEnd);
  const deltaPct = lastWeekSeconds > 0 ? (totalSeconds - lastWeekSeconds) / lastWeekSeconds : null;

  let bestDay = null;
  for (let i = 0; i < daysElapsed; i++) {
    const day = new Date(thisMonday.getTime() + i * 24 * 60 * 60 * 1000);
    const seconds = dayTotals.get(localDayKey(day)) || 0;
    if (!bestDay || seconds > bestDay.seconds) {
      bestDay = { label: WEEKDAY_LONG[day.getDay()], seconds };
    }
  }
  if (bestDay && bestDay.seconds === 0) bestDay = null; // no sessions at all yet this week

  const tagTotals = new Map();
  for (const s of thisWeekSessions) {
    if (!s.tag_id) continue;
    const existing = tagTotals.get(s.tag_id) || { name: s.tag_name, color: s.tag_color, seconds: 0 };
    existing.seconds += durationSeconds(s);
    tagTotals.set(s.tag_id, existing);
  }
  const topTag = [...tagTotals.values()].sort((a, b) => b.seconds - a.seconds)[0] || null;

  const weekQuality = qualityRate(thisWeekSessions);

  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const upcomingDeadlines = deadlinesProgress
    .filter((d) => d.status !== "done" && d.status !== "archived" && d.dueAt >= now && d.dueAt <= weekFromNow)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 5);
  const upcomingReminders = reminders
    .filter((r) => {
      const remindAt = new Date(r.remind_at);
      return remindAt >= now && remindAt <= weekFromNow;
    })
    .sort((a, b) => new Date(a.remind_at) - new Date(b.remind_at))
    .slice(0, 5);

  return {
    totalSeconds,
    lastWeekSeconds,
    deltaPct,
    bestDay,
    topTag,
    qualityRatePct: weekQuality.ratePct,
    qualityRatedCount: weekQuality.rated,
    qualityTotalCount: thisWeekSessions.length,
    upcomingDeadlines,
    upcomingReminders,
  };
}

