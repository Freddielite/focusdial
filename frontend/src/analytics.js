// All the "does the thinking for you" logic lives here, computed from raw
// session history rather than as a server-side aggregate — see the comment
// on GET /sessions/history in the backend for why (timezone correctness).

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
  const today = startOfLocalDay(new Date());
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
    const daysLeft = Math.round((dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    const hoursPerDayNeeded = daysLeft > 0 ? remainingHours / daysLeft : remainingHours;

    let status;
    if (d.status === "done" || d.status === "archived") {
      // Manually set (e.g. the checkmark in DeadlinesView) — this is a
      // deliberate user action, so it must win over the derived pace
      // status instead of being silently recalculated away.
      status = d.status;
    } else if (remainingHours <= 0) {
      status = "done";
    } else if (daysLeft <= 0) {
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
      status,
    };
  });
}

// For each hour of day (0-23), which tag has the most historical seconds
// logged starting in that hour — used to pre-select a tag when starting
// a new timer around that time. Returns a plain object keyed by hour
// (0-23) to { tagId, name } or null for hours with no clear tag history.
export function computeHourlyTagSuggestions(sessions) {
  // hour -> tagId -> seconds
  const perHourTagSeconds = Array.from({ length: 24 }, () => new Map());
  const tagInfo = new Map(); // tagId -> { name, color }

  for (const s of sessions) {
    if (!s.tag_id) continue;
    const hour = new Date(s.started_at).getHours();
    const seconds = durationSeconds(s);
    const bucket = perHourTagSeconds[hour];
    bucket.set(s.tag_id, (bucket.get(s.tag_id) || 0) + seconds);
    if (!tagInfo.has(s.tag_id)) {
      tagInfo.set(s.tag_id, { name: s.tag_name, color: s.tag_color });
    }
  }

  const suggestions = {};
  perHourTagSeconds.forEach((bucket, hour) => {
    if (bucket.size === 0) {
      suggestions[hour] = null;
      return;
    }
    let bestTagId = null;
    let bestSeconds = 0;
    bucket.forEach((seconds, tagId) => {
      if (seconds > bestSeconds) {
        bestSeconds = seconds;
        bestTagId = tagId;
      }
    });
    suggestions[hour] = bestTagId ? { tagId: bestTagId, ...tagInfo.get(bestTagId) } : null;
  });
  return suggestions;
}

export function computeSummary(sessions, restDayOfWeek = null) {
  const now = new Date();
  const todayKey = localDayKey(now);
  const weekAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const weekAgoStart = startOfLocalDay(weekAgo);

  let todaySeconds = 0;
  let weekSeconds = 0;
  let allTimeSeconds = 0;

  const dayTotals = new Map(); // localDayKey -> seconds, for streak + heatmap
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, seconds: 0 }));
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
    if (started >= weekAgoStart) weekSeconds += seconds;

    // Attributes the whole session to the hour it started in, rather than
    // splitting a session that crosses an hour boundary proportionally —
    // a reasonable simplification for a "which hour am I usually
    // focused in" insight, not a billing system.
    hourly[started.getHours()].seconds += seconds;
    weekdayByGetDay[started.getDay()].seconds += seconds;

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
  // the comparison is fair at any point in the week.
  const thisMonday = mondayOf(now);
  const daysElapsedThisWeek = Math.floor((startOfLocalDay(now) - thisMonday) / 86400000) + 1;
  let thisWeekSoFarSeconds = 0;
  let lastWeekSameSpanSeconds = 0;
  for (let i = 0; i < daysElapsedThisWeek; i++) {
    const day = new Date(thisMonday.getTime() + i * 24 * 60 * 60 * 1000);
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
    daily,
    weeklyTotals: computeWeeklyTotals(sessions),
    monthlyTotals: computeMonthlyTotals(sessions),
    avgDailyFocusSeconds: computeAvgDailyFocusSeconds(sessions),
    hourlyTagSuggestions: computeHourlyTagSuggestions(sessions),
  };
}
