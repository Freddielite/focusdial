// All the "does the thinking for you" logic lives here, computed from raw
// session history rather than as a server-side aggregate — see the comment
// on GET /sessions/history in the backend for why (timezone correctness).
import { formatDuration } from "./format.js";

// Formats a decimal-hours number the same "Xh Ym" way session durations
// are shown elsewhere (formatDuration works in seconds), instead of a
// raw decimal like "0.3h" -- matters once a deadline's pace can be a
// small fraction of an hour (a short, minutes-scale deadline).
function formatHoursShort(hours) {
  return formatDuration(Math.max(0, hours) * 3600);
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
    const key = localDayKey(mondayOf(new Date(s.started_at)));
    totals.set(key, (totals.get(key) || 0) + durationSeconds(s));
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
    const started = new Date(s.started_at);
    const key = `${started.getFullYear()}-${started.getMonth()}`;
    totals.set(key, (totals.get(key) || 0) + durationSeconds(s));
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

// Average seconds of focus per calendar day, over the last 30 days (or
// since your first-ever session, if you've been using this less than 30
// days). Deliberately averaged over every day in the window — including
// zero-session days — not just the days you happened to work, since a
// deadline plan needs a realistic "what can I actually sustain every
// day," not a best-case "when I do sit down, how long" number.
export function computeAvgDailyFocusSeconds(sessions) {
  if (sessions.length === 0) return 0;
  const now = new Date();
  const earliest = sessions.reduce(
    (min, s) => (new Date(s.started_at) < min ? new Date(s.started_at) : min),
    new Date(sessions[0].started_at)
  );
  const windowStart = new Date(Math.max(earliest.getTime(), now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const daysInWindow = Math.max(1, Math.round((now.getTime() - windowStart.getTime()) / (24 * 60 * 60 * 1000)));
  const secondsInWindow = sessions
    .filter((s) => new Date(s.started_at) >= windowStart)
    .reduce((sum, s) => sum + durationSeconds(s), 0);
  return secondsInWindow / daysInWindow;
}

// Rolls each budget's assigned tags up into "how much of this week's
// target have I actually logged," using the same Monday-start week
// convention as the weekly trend chart.
export function computeBudgetProgress(budgets, sessions) {
  const weekStart = mondayOf(new Date());
  return budgets.map((b) => {
    const tagIds = new Set((b.tags || []).map((t) => t.id));
    const actualSeconds = sessions
      .filter((s) => s.tag_id && tagIds.has(s.tag_id) && new Date(s.started_at) >= weekStart)
      .reduce((sum, s) => sum + durationSeconds(s), 0);
    const targetSeconds = b.weekly_target_seconds;
    return {
      ...b,
      actualSeconds,
      targetSeconds,
      pct: targetSeconds ? actualSeconds / targetSeconds : 0,
    };
  });
}

// Computes real progress + a feasibility read for each deadline, comparing
// the pace it actually requires against your real historical average —
// this is the "does the thinking for you" part: it's not just a countdown,
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
    const dueDate = startOfLocalDay(new Date(d.due_date));

    // Exact moment the deadline is due. With no due_time, that's
    // end-of-day on due_date. This is now the single number everything
    // below (daysLeft, hoursPerDayNeeded, and the overdue check) is
    // derived from, instead of pace/status being computed from a
    // separate whole-calendar-day count. That used to be able to
    // disagree with the live countdown by up to 24 hours -- e.g. showing
    // "Overdue" first thing in the morning on the due date, while the
    // countdown (which does use dueAt) still had hours left to go.
    // due_date comes back from the database as a full timestamp string
    // (e.g. "2026-08-13T00:00:00.000Z"), not a plain "2026-08-13" -- so
    // gluing due_time directly onto it (the old code) produced a
    // malformed string like "2026-08-13T00:00:00.000ZT14:30:00", which
    // is an invalid date (NaN). That NaN then propagated two different,
    // contradictory ways into the countdown and the status calculation
    // below, which is why they could disagree with each other. Extract
    // just the date part first, same as DeadlineEditForm already does
    // when pre-filling its own date field.
    const dueDatePart = String(d.due_date).slice(0, 10);
    const dueAt = d.due_time
      ? new Date(`${dueDatePart}T${d.due_time}`)
      : new Date(dueDate.getTime() + 24 * 60 * 60 * 1000 - 1);

    const hoursLeft = (dueAt.getTime() - Date.now()) / 3_600_000;
    const daysLeft = hoursLeft / 24; // fractional now, not rounded to whole days
    const hoursPerDayNeeded = daysLeft > 0 ? remainingHours / daysLeft : remainingHours;

    let status;
    if (d.status === "done" || d.status === "archived") {
      // Manually set (e.g. the checkmark in DeadlinesView) — this is a
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

// For each hour of day (0-23), which tag has the most historical seconds
// logged starting in that hour — used both to pre-select a tag when
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
// to fall back on — an unrated session simply doesn't count toward the
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

export function computeSummary(sessions, restDayOfWeek = null) {
  const now = new Date();
  const todayKey = localDayKey(now);
  // Monday-start calendar week, matching the convention used everywhere
  // else in this file (mondayOf(), weekOverWeek, computeBudgetProgress,
  // computeWeeklyTotals, computeWeeklyReview) — this used to be a
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
  // duration — "which hour do I log the most time in" and "which hour
  // do I actually focus best in" are different questions, and only the
  // first one was answerable before this existed.
  const hourlyQuality = Array.from({ length: 24 }, () => ({ focused: 0, rated: 0 }));
  // Indexed by JS's native getDay() (0 = Sunday ... 6 = Saturday) so the
  // accumulation loop below can write straight into it, same shape as
  // `hourly` above. Reordered to Monday-first only for display, right
  // before it's returned — see `weekday` below.
  const weekdayByGetDay = Array.from({ length: 7 }, (_, day) => ({ day, seconds: 0 }));
  const tagTotals = new Map(); // tag_id ('untagged' if none) -> {name,color,seconds,count}

  for (const s of sessions) {
    const started = new Date(s.started_at);
    const seconds = durationSeconds(s);
    allTimeSeconds += seconds;

    const dayKey = localDayKey(started);
    dayTotals.set(dayKey, (dayTotals.get(dayKey) || 0) + seconds);

    if (dayKey === todayKey) todaySeconds += seconds;
    if (started >= thisWeekStart) weekSeconds += seconds;

    // Attributes the whole session to the hour it started in, rather than
    // splitting a session that crosses an hour boundary proportionally —
    // a reasonable simplification for a "which hour am I usually
    // focused in" insight, not a billing system.
    hourly[started.getHours()].seconds += seconds;
    weekdayByGetDay[started.getDay()].seconds += seconds;

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
  // session yet, that's not a broken streak — the day isn't over — so
  // start counting from yesterday instead in that case. A configured
  // rest day (see Settings) doesn't break the streak even with zero
  // sessions logged — it's skipped over rather than counted, so it
  // neither extends nor resets the streak on its own. Addresses the
  // open question from the original streak design: previously a single
  // missed day fully reset it, with no concept of a planned day off.
  let streakDays = 0;
  let cursor = startOfLocalDay(now);
  if (!dayTotals.has(todayKey)) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  while (true) {
    const key = localDayKey(cursor);
    if (dayTotals.has(key)) {
      streakDays += 1;
    } else if (restDayOfWeek !== null && cursor.getDay() === restDayOfWeek) {
      // Rest day, nothing logged — skip without breaking or counting.
    } else {
      break;
    }
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }

  // Week-over-week: "this week so far" (Monday through today) against
  // the equivalent Monday-through-same-weekday slice of last week — not
  // full 7-day totals, since comparing a partial current week against a
  // complete previous one would always show a misleading drop, worse the
  // earlier in the week it is. Both slices cover the same day count, so
  // the comparison is fair at any point in the week. Reuses
  // `thisWeekStart` from the top of this function rather than a second
  // `mondayOf(now)` call — that's also what `weekSeconds` above is now
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
    // compare against — a percentage against zero is meaningless, not
    // "infinitely up."
    deltaPct: lastWeekSameSpanSeconds > 0 ? (thisWeekSoFarSeconds - lastWeekSameSpanSeconds) / lastWeekSameSpanSeconds : null,
  };

  const bestHour = hourly.reduce((best, h) => (h.seconds > best.seconds ? h : best), hourly[0]);

  // Same "at least 3 rated sessions" bar as mostSustainedTag below, for
  // the same reason — one lucky/unlucky rating in an otherwise-empty
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
  // number of days last week" fairness rule as weekOverWeek above —
  // reusing thisWeekStart/daysElapsedThisWeek rather than a second
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
    lastWeekFocusRatePct: lastWeekQuality.ratePct,
    // Percentage-point change (not a ratio) — null unless both weeks
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
  // week convention (see mondayOf() above) — the accumulation above still
  // uses getDay()'s native Sunday-first indexing, this just reorders the
  // same 7 entries for the chart.
  const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
  const weekday = MONDAY_FIRST.map((day) => weekdayByGetDay[day]);

  const byTag = [...tagTotals.values()]
    .map((t) => ({ ...t, avgSeconds: t.count ? t.seconds / t.count : 0 }))
    .sort((a, b) => b.seconds - a.seconds);

  // "Most productive" tag: longest average session length among tags with
  // at least 3 sessions (enough to not be a fluke from one long outlier),
  // not just whichever tag has the most total time — total time mostly
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
    hourlyTagSuggestions: computeHourlyTagSuggestions(sessions),
  };
}

const HOUR_LABEL_OPTS = { hour: "numeric" };
function hourLabel(hour) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, HOUR_LABEL_OPTS);
}

// Picks the single most notable, actionable thing to surface right now
// out of everything the app already knows — a prioritized list of
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
  // a deadline riding on that same tag — worth calling out together
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
      message: `"${behind[0].title}" is behind pace. You need ${formatHoursShort(behind[0].hoursPerDayNeeded)}/day to catch up.`,
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
    candidates.push({
      tone: "neutral",
      message: `You're focused most often around ${hourLabel(q.bestHour.hour)} (${Math.round(q.bestHour.ratePct)}% of rated sessions). Worth protecting that slot for deep work.`,
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
// in one list — cross-referencing by shared tag so a tag that's behind
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
            : `"${d.title}" is ${d.status} on pace, needs ${formatHoursShort(d.hoursPerDayNeeded)}/day to finish in time.`,
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

  const thisWeekSessions = sessions.filter((s) => new Date(s.started_at) >= thisMonday);
  const lastWeekSessions = sessions.filter((s) => {
    const started = new Date(s.started_at);
    return started >= lastWeekStart && started < lastWeekEnd;
  });

  const totalSeconds = thisWeekSessions.reduce((sum, s) => sum + durationSeconds(s), 0);
  const lastWeekSeconds = lastWeekSessions.reduce((sum, s) => sum + durationSeconds(s), 0);
  const deltaPct = lastWeekSeconds > 0 ? (totalSeconds - lastWeekSeconds) / lastWeekSeconds : null;

  const dayTotals = new Map();
  for (const s of thisWeekSessions) {
    const key = localDayKey(new Date(s.started_at));
    dayTotals.set(key, (dayTotals.get(key) || 0) + durationSeconds(s));
  }
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

