// The priority engine: turns tasks + session history into a single
// ranked "what to do next" list (Feature 1), an estimate-accuracy hint
// per tag (Feature 2), a staleness score (Feature 3), a category-balance
// read (Feature 4), an energy/time-of-day fit (Feature 5), and an
// unscheduled-session suggestion (Feature 6).
//
// Kept as its own module rather than folded into analytics.js: same
// "local logic, no parallel system" spirit (pure functions over data the
// app already has, nothing async, nothing that reaches the network) but
// analytics.js was already sizeable and this is a genuinely separate
// concern (ranking open tasks) from what analytics.js does (summarizing
// past sessions). All the tunable numbers live in priorityWeights.js,
// imported here rather than inlined, so they can be adjusted without
// touching this scoring logic.
//
// No em dashes anywhere below, including reason strings shown in the UI
// - matches the rest of this codebase's copy.

import { durationSeconds, startOfLocalDay } from "./analytics.js";
import {
  PRIORITY_WEIGHTS,
  URGENCY_NO_DEADLINE_BASELINE,
  URGENCY_HORIZON_DAYS,
  EFFORT_FIT_MIN_TAG_SESSIONS,
  EFFORT_FIT_MAX_RATIO,
  NEUTRAL_FACTOR_SCORE,
  CATEGORY_BALANCE_WINDOW_DAYS,
  CATEGORY_BALANCE_MIN_HISTORICAL_SESSIONS,
  CATEGORY_BALANCE_NEGLECT_RATIO,
  STALENESS_THRESHOLD_DAYS,
  STALENESS_MAX_DAYS,
  DEEP_WORK_MIN_MEDIAN_MINUTES,
  ENERGY_FIT_MIN_TAG_SESSIONS,
  ENERGY_FIT_HOUR_STRENGTH_MULTIPLIER,
  ENERGY_FIT_MIN_HOUR_SAMPLES,
  SUGGESTION_COOLDOWN_HOURS,
  SUGGESTION_MIN_COMPETING_SCORE,
} from "./priorityWeights.js";

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Median rather than mean throughout this file: a single unusually long
// or short session (someone forgetting to stop the timer, a two-minute
// test click) shouldn't swing a tag's "typical length" the way it would
// swing an average - the same robustness reason the app already applies
// medians and 15%-style relative gaps elsewhere in analytics.js.

/**
 * Per-tag typical (median) session length, used by effort-fit and by
 * classifyTagType below. Only returns an entry for tags that clear
 * EFFORT_FIT_MIN_TAG_SESSIONS / ENERGY_FIT_MIN_TAG_SESSIONS - both
 * factors share this same minimum since they're both "trust a pattern
 * only once there's enough of it" checks over the same underlying data.
 */
export function computeTagTypicalSeconds(sessions) {
  const byTag = new Map(); // tagId -> seconds[]
  for (const s of sessions) {
    if (!s.tag_id) continue;
    const arr = byTag.get(s.tag_id) || [];
    arr.push(durationSeconds(s));
    byTag.set(s.tag_id, arr);
  }
  const result = new Map();
  for (const [tagId, seconds] of byTag) {
    if (seconds.length < Math.min(EFFORT_FIT_MIN_TAG_SESSIONS, ENERGY_FIT_MIN_TAG_SESSIONS)) continue;
    result.set(tagId, { medianSeconds: median(seconds), count: seconds.length });
  }
  return result;
}

/**
 * Feature 2: per-tag estimate accuracy, as a plain ratio (actual time
 * logged / time estimated), averaged across a tag's recent completed
 * tasks. `completedTasks` is expected to already be filtered to tasks
 * with both a tag and an estimate (see GET /tasks/completed) - this
 * function doesn't re-filter, it just cross-references each one against
 * `sessions` (which already has task_id on every row) to find the
 * actual time logged against it.
 *
 * Deliberately not stored anywhere: recomputed fresh from
 * tasks/sessions every time it's needed, the same "recompute, don't
 * maintain incremental state" pattern every other figure in
 * analytics.js already follows, so there's nothing here that can drift
 * out of sync with the underlying data.
 */
export function computeTagEstimateStats(completedTasks, sessions) {
  const ratiosByTag = new Map(); // tagId -> ratio[]
  for (const task of completedTasks) {
    const estimateSeconds = task.estimate_minutes * 60;
    if (!estimateSeconds) continue;
    const actualSeconds = sessions
      .filter((s) => s.task_id === task.id)
      .reduce((sum, s) => sum + durationSeconds(s), 0);
    if (actualSeconds <= 0) continue; // task marked done but nothing was ever logged against it - not a real estimate data point
    const arr = ratiosByTag.get(task.tag_id) || [];
    arr.push(actualSeconds / estimateSeconds);
    ratiosByTag.set(task.tag_id, arr);
  }
  const result = new Map();
  for (const [tagId, ratios] of ratiosByTag) {
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    result.set(tagId, { ratio: avg, samples: ratios.length });
  }
  return result;
}

// A ratio within this band of 1 isn't worth surfacing as a hint - "this
// usually takes about what you said" isn't useful information. Matches
// the 15%-relative-gap bar the rest of the app already uses for "is this
// difference big enough to mention."
const ESTIMATE_HINT_MIN_DEVIATION = 0.15;
// Needs at least two past data points before suggesting anything - one
// completed task under a tag is an anecdote, not a pattern.
const ESTIMATE_HINT_MIN_SAMPLES = 2;

/**
 * Feature 2's hint text builder: "based on your history, this usually
 * takes ~X" - or null when there isn't enough of a pattern yet, or the
 * pattern doesn't meaningfully disagree with what was typed. Never
 * overwrites `enteredMinutes` - purely a suggestion string to show
 * alongside it, per the feature spec.
 */
export function estimateHintMinutes(tagId, enteredMinutes, tagEstimateStats) {
  if (!tagId || !enteredMinutes) return null;
  const stats = tagEstimateStats.get(tagId);
  if (!stats || stats.samples < ESTIMATE_HINT_MIN_SAMPLES) return null;
  if (Math.abs(stats.ratio - 1) < ESTIMATE_HINT_MIN_DEVIATION) return null;
  return Math.round(enteredMinutes * stats.ratio);
}

/**
 * Feature 5's "deep-work vs quick-admin" classification, inferred
 * automatically from a tag's own typical session length rather than a
 * manually-set flag (see the scoping conversation) - self-adjusting as
 * actual habits under that tag change, no setting to maintain.
 * Returns null when the tag doesn't have enough history yet to classify
 * either way.
 */
export function classifyTagType(tagId, tagTypicalSeconds) {
  const info = tagTypicalSeconds.get(tagId);
  if (!info) return null;
  return info.medianSeconds >= DEEP_WORK_MIN_MEDIAN_MINUTES * 60 ? "deep-work" : "quick-admin";
}

/**
 * Feature 5's "best hour(s) per type." Buckets every session's duration
 * into its start hour (0-23) and its tag's inferred type, then flags an
 * hour as "strong" for a type once its total logged time there is at
 * least ENERGY_FIT_HOUR_STRENGTH_MULTIPLIER times that type's average
 * per-hour total across the day - and at least ENERGY_FIT_MIN_HOUR_SAMPLES
 * sessions actually landed in that hour, so one long outlier session
 * can't crown an hour "best" on its own.
 */
export function computeTypeHourStrength(sessions, tagTypicalSeconds) {
  const secondsByTypeHour = { "deep-work": Array(24).fill(0), "quick-admin": Array(24).fill(0) };
  const countByTypeHour = { "deep-work": Array(24).fill(0), "quick-admin": Array(24).fill(0) };
  for (const s of sessions) {
    if (!s.tag_id) continue;
    const type = classifyTagType(s.tag_id, tagTypicalSeconds);
    if (!type) continue;
    const hour = new Date(s.started_at).getHours();
    secondsByTypeHour[type][hour] += durationSeconds(s);
    countByTypeHour[type][hour] += 1;
  }
  const strongHoursByType = {};
  for (const type of ["deep-work", "quick-admin"]) {
    const totals = secondsByTypeHour[type];
    const meanPerHour = totals.reduce((a, b) => a + b, 0) / 24;
    const strong = new Set();
    if (meanPerHour > 0) {
      for (let hour = 0; hour < 24; hour++) {
        if (
          countByTypeHour[type][hour] >= ENERGY_FIT_MIN_HOUR_SAMPLES &&
          totals[hour] >= meanPerHour * ENERGY_FIT_HOUR_STRENGTH_MULTIPLIER
        ) {
          strong.add(hour);
        }
      }
    }
    strongHoursByType[type] = strong;
  }
  return strongHoursByType; // { "deep-work": Set<hour>, "quick-admin": Set<hour> }
}

/**
 * Feature 4: rolling recent-window time distribution per tag, compared
 * against each tag's all-time historical share, using the same window
 * length as the existing consistency score (CATEGORY_BALANCE_WINDOW_DAYS)
 * per the feature spec's own suggestion to reuse it. A tag only gets
 * flagged "neglected" once it has an established historical share to
 * fall short of (CATEGORY_BALANCE_MIN_HISTORICAL_SESSIONS) - a tag used
 * once, ever, doesn't have a real baseline yet.
 */
export function computeCategoryBalance(sessions, tags, now = new Date()) {
  const windowStart = new Date(now.getTime() - CATEGORY_BALANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const historicalSecondsByTag = new Map();
  const historicalCountByTag = new Map();
  const recentSecondsByTag = new Map();
  let historicalTotal = 0;
  let recentTotal = 0;
  for (const s of sessions) {
    if (!s.tag_id) continue;
    const seconds = durationSeconds(s);
    historicalSecondsByTag.set(s.tag_id, (historicalSecondsByTag.get(s.tag_id) || 0) + seconds);
    historicalCountByTag.set(s.tag_id, (historicalCountByTag.get(s.tag_id) || 0) + 1);
    historicalTotal += seconds;
    if (new Date(s.started_at) >= windowStart) {
      recentSecondsByTag.set(s.tag_id, (recentSecondsByTag.get(s.tag_id) || 0) + seconds);
      recentTotal += seconds;
    }
  }
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const result = new Map();
  for (const [tagId, historicalSeconds] of historicalSecondsByTag) {
    if ((historicalCountByTag.get(tagId) || 0) < CATEGORY_BALANCE_MIN_HISTORICAL_SESSIONS) continue;
    if (historicalTotal <= 0) continue;
    const historicalShare = historicalSeconds / historicalTotal;
    const recentSeconds = recentSecondsByTag.get(tagId) || 0;
    // recentTotal can be 0 (nothing logged at all in the window, under
    // any tag) - treat that as a 0 share rather than skip, since "you've
    // logged nothing lately" is exactly the case this feature exists to
    // catch, not an edge case to fall through.
    const recentShare = recentTotal > 0 ? recentSeconds / recentTotal : 0;
    const neglected = recentShare <= historicalShare * CATEGORY_BALANCE_NEGLECT_RATIO;
    const tag = tagById.get(tagId);
    result.set(tagId, {
      tagId,
      tagName: tag?.name || "Untagged",
      tagColor: tag?.color || "var(--accent-session)",
      historicalShare,
      recentShare,
      recentSeconds,
      neglected,
    });
  }
  return result;
}

// Same fix analytics.js's computeDueAt already applies to deadlines:
// due_date comes back as a DATE column, which the pg driver hands back
// as a UTC-midnight Date that JSON.stringify turns into a full ISO
// string (e.g. "2026-09-05T00:00:00.000Z") - parsing that directly and
// diffing against a local `now` would silently shift the effective due
// moment by the local UTC offset. Tasks have no due_time (only deadlines
// do), so "due" always means end of that calendar day, local time.
function taskDueAt(dueDate) {
  const datePart = String(dueDate).slice(0, 10);
  const startOfDueDay = startOfLocalDay(new Date(datePart));
  return new Date(startOfDueDay.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function urgencyScore(task, now) {
  if (!task.due_date) return URGENCY_NO_DEADLINE_BASELINE;
  const daysLeft = (taskDueAt(task.due_date).getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (daysLeft <= 0) return 1; // due today or already overdue
  return clamp01(1 / (1 + daysLeft / URGENCY_HORIZON_DAYS));
}

function effortFitScore(task, tagTypicalSeconds) {
  if (!task.estimate_minutes || !task.tag_id) return NEUTRAL_FACTOR_SCORE;
  const info = tagTypicalSeconds.get(task.tag_id);
  if (!info) return NEUTRAL_FACTOR_SCORE;
  const estimateSeconds = task.estimate_minutes * 60;
  const ratio = Math.max(estimateSeconds, info.medianSeconds) / Math.min(estimateSeconds, info.medianSeconds);
  return clamp01(1 - (ratio - 1) / (EFFORT_FIT_MAX_RATIO - 1));
}

function categoryBalanceScore(task, categoryBalance) {
  if (!task.tag_id) return NEUTRAL_FACTOR_SCORE;
  const info = categoryBalance.get(task.tag_id);
  if (!info) return NEUTRAL_FACTOR_SCORE; // no established baseline yet
  if (!info.neglected) return 0.2; // normal rotation, nothing to nudge
  // Deeper neglect scores higher within a fixed band, rather than an
  // unbounded scale - the point is "this needs attention," not
  // precisely ranking degrees of neglect against each other.
  const shortfall =
    info.historicalShare > 0 ? 1 - clamp01(info.recentShare / (info.historicalShare * CATEGORY_BALANCE_NEGLECT_RATIO)) : 1;
  return 0.6 + 0.4 * clamp01(shortfall);
}

function stalenessScore(task, now) {
  const daysSince = (now.getTime() - new Date(task.last_touched_at).getTime()) / (24 * 60 * 60 * 1000);
  if (daysSince <= STALENESS_THRESHOLD_DAYS) return 0;
  if (daysSince >= STALENESS_MAX_DAYS) return 1;
  return (daysSince - STALENESS_THRESHOLD_DAYS) / (STALENESS_MAX_DAYS - STALENESS_THRESHOLD_DAYS);
}

function energyFitScore(task, tagTypicalSeconds, typeHourStrength, now) {
  if (!task.tag_id) return NEUTRAL_FACTOR_SCORE;
  const type = classifyTagType(task.tag_id, tagTypicalSeconds);
  if (!type) return NEUTRAL_FACTOR_SCORE;
  return typeHourStrength[type].has(now.getHours()) ? 1 : 0.2;
}

function daysUntil(dueDate, now) {
  return Math.ceil((taskDueAt(dueDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Builds the card's one-line "why" string from whichever factors
 * actually contributed - only ones clearing a "notably high" bar make it
 * in, so a task that's just generically fine across the board doesn't
 * get a padded-out sentence pretending every factor mattered. Capped at
 * two clauses; more than that reads as noise, not a reason.
 */
function buildReason(task, scores, now) {
  const REASON_BAR = 0.6;
  const clauses = [];
  if (scores.urgency >= REASON_BAR && task.due_date) {
    const days = daysUntil(task.due_date, now);
    clauses.push(
      days <= 0 ? "due today or overdue" : days === 1 ? "due tomorrow" : `deadline in ${days} days`
    );
  }
  if (scores.staleness >= REASON_BAR) {
    clauses.push("has been sitting untouched a while");
  }
  if (scores.categoryBalance >= REASON_BAR) {
    clauses.push(`you've neglected ${task.tag_name || "this category"} lately`);
  }
  if (scores.energyFit >= REASON_BAR) {
    clauses.push("matches your focus window right now");
  }
  if (scores.effortFit >= REASON_BAR && task.estimate_minutes) {
    clauses.push("fits the time this usually takes");
  }
  if (clauses.length === 0) return "next up on your list";
  const top = clauses.slice(0, 2);
  return top.length === 1 ? capitalize(top[0]) : `${capitalize(top[0])}, ${top[1]}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Feature 1: scores every open task and returns them ranked highest
 * first, each with its combined score and a human reason string. Also
 * returns the supporting maps (tagTypicalSeconds, categoryBalance,
 * tagEstimateStats) since other call sites (task-creation estimate hint,
 * the category-neglect notice, the unscheduled suggestion) need the same
 * underlying computations and shouldn't redo them separately.
 */
export function computePriorityRanking(tasks, sessions, completedTasks, tags, now = new Date()) {
  const tagTypicalSeconds = computeTagTypicalSeconds(sessions);
  const tagEstimateStats = computeTagEstimateStats(completedTasks, sessions);
  const categoryBalance = computeCategoryBalance(sessions, tags, now);
  const typeHourStrength = computeTypeHourStrength(sessions, tagTypicalSeconds);
  const tagById = new Map(tags.map((t) => [t.id, t]));

  const ranked = tasks
    .filter((t) => t.status === "open")
    .map((task) => {
      const withTagName = { ...task, tag_name: task.tag_name || tagById.get(task.tag_id)?.name };
      const scores = {
        urgency: urgencyScore(task, now),
        effortFit: effortFitScore(task, tagTypicalSeconds),
        categoryBalance: categoryBalanceScore(task, categoryBalance),
        staleness: stalenessScore(task, now),
        energyFit: energyFitScore(task, tagTypicalSeconds, typeHourStrength, now),
      };
      const score =
        scores.urgency * PRIORITY_WEIGHTS.urgency +
        scores.effortFit * PRIORITY_WEIGHTS.effortFit +
        scores.categoryBalance * PRIORITY_WEIGHTS.categoryBalance +
        scores.staleness * PRIORITY_WEIGHTS.staleness +
        scores.energyFit * PRIORITY_WEIGHTS.energyFit;
      return { task, scores, score, reason: buildReason(withTagName, scores, now) };
    })
    .sort((a, b) => b.score - a.score);

  return { ranked, tagTypicalSeconds, tagEstimateStats, categoryBalance, typeHourStrength };
}

/**
 * Feature 6: a distinct "you haven't scheduled this but maybe should"
 * suggestion, independent of whether any open task exists at all. Only
 * offered when the "Do This Next" ranking isn't already saying something
 * confident enough to lead with (SUGGESTION_MIN_COMPETING_SCORE) - the
 * two cards are meant to complement each other, not compete for
 * attention at the same time.
 *
 * `dismissedAt` is a plain object of { [suggestionKey]: isoTimestamp },
 * expected to be persisted client-side (see useSuggestionDismissals) -
 * a suggestion whose key was dismissed within SUGGESTION_COOLDOWN_HOURS
 * is skipped, without that ever counting against future different
 * suggestions (a different key entirely) or permanently suppressing the
 * same one once the cooldown passes, per the feature spec.
 */
export function computeUnscheduledSuggestion({
  categoryBalance,
  typeHourStrength,
  tagTypicalSeconds,
  topRankedScore,
  dismissedAt = {},
  now = new Date(),
}) {
  if (topRankedScore != null && topRankedScore >= SUGGESTION_MIN_COMPETING_SCORE) return null;

  const isDismissed = (key) => {
    const at = dismissedAt[key];
    if (!at) return false;
    return now.getTime() - new Date(at).getTime() < SUGGESTION_COOLDOWN_HOURS * 60 * 60 * 1000;
  };

  const hour = now.getHours();

  // Prefer a neglected category that also happens to line up with its
  // type's best hour right now - the specific, well-supported case the
  // feature spec's own example reason string describes.
  let bestNeglected = null;
  for (const info of categoryBalance.values()) {
    if (!info.neglected) continue;
    const type = classifyTagType(info.tagId, tagTypicalSeconds);
    if (!type || !typeHourStrength[type].has(hour)) continue;
    if (!bestNeglected || info.recentShare < bestNeglected.recentShare) bestNeglected = info;
  }
  if (bestNeglected && !isDismissed(bestNeglected.tagId)) {
    const daysNeglected = Math.round(
      CATEGORY_BALANCE_WINDOW_DAYS * (1 - bestNeglected.recentShare / Math.max(bestNeglected.historicalShare, 0.0001))
    );
    return {
      key: bestNeglected.tagId,
      tagId: bestNeglected.tagId,
      tagName: bestNeglected.tagName,
      tagColor: bestNeglected.tagColor,
      reason: `You haven't done much ${bestNeglected.tagName} lately, and this is usually your best focus window for it.`,
    };
  }

  // Fall back to a generic "this is your best deep-work window and
  // nothing's competing for it" nudge when no specific neglected
  // category applies right now.
  if (typeHourStrength["deep-work"].has(hour) && !isDismissed("generic-deep-work")) {
    return {
      key: "generic-deep-work",
      tagId: null,
      tagName: null,
      tagColor: "var(--accent-session)",
      reason: "This is usually your best deep-work window. Want to start an ad-hoc session?",
    };
  }

  return null;
}
