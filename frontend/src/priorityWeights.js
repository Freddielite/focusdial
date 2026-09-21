// All the tunable numbers behind the priority engine (see
// priorityEngine.js), kept in one place per the feature spec's own
// request - every factor below is a 0..1 sub-score, combined by
// PRIORITY_WEIGHTS into a single number. Adjusting how much any one
// factor matters, or where a threshold kicks in, means changing a
// constant here, not touching the scoring logic itself.
//
// Every default below is a first guess, not a measured value - there
// was no existing usage data to tune against. Each one is called out in
// HANDOVER.md's session entry as a "reasonable default, easy to
// revisit" per the feature spec's own instruction for anything it left
// unspecified.

// How much each 0..1 sub-score contributes to a task's final priority
// score. Kept summing to 1 purely for readability (so a sub-score of,
// say, 0.8 has an intuitive weight in the final number) - the scoring
// code itself doesn't require that, so this can be edited freely as
// long as no weight goes negative.
export const PRIORITY_WEIGHTS = {
  urgency: 0.35,
  effortFit: 0.15,
  categoryBalance: 0.2,
  staleness: 0.2,
  energyFit: 0.1,
};

// Urgency (deadline-driven). A task with no due date at all gets this
// flat baseline rather than 0 - it should never outrank something
// genuinely close to due, but it shouldn't vanish from consideration
// either just for not having a date attached.
export const URGENCY_NO_DEADLINE_BASELINE = 0.2;
// Days-until-due at and beyond which urgency is already effectively
// maxed - a task due today and a task due in 6 months are both "not
// urgent by proximity" in meaningfully different ways, but past this
// point (heading toward 0 days left, i.e. very SOON) the curve is
// already close enough to 1 that a longer horizon doesn't change much.
// Concretely this is used as the divisor in a 1/(1+daysLeft) falloff,
// not a hard cutoff.
export const URGENCY_HORIZON_DAYS = 3;

// Effort-fit compares a task's own estimate against how long sessions
// under its tag typically run (see computeTagEstimateStats) - the
// user-facing "compare against your typical session length" option from
// the scoping conversation, done per-tag rather than as one global
// average so a 45-minute Research task isn't penalized for not looking
// like a 10-minute Admin task. A task with no estimate, or a tag with
// too little session history to have a typical length yet, gets this
// flat neutral score instead of being penalized for missing data it was
// never asked to provide.
export const EFFORT_FIT_NEUTRAL_SCORE = 0.5;
// Shared "not enough data to say anything meaningful" score, used by
// effort-fit, category-balance, and energy-fit alike whenever their own
// underlying tag/hour data hasn't cleared its own minimum-sample bar
// yet. Sitting exactly in the middle means missing data neither helps
// nor hurts a task's ranking - it just falls back to what the other
// factors say.
export const NEUTRAL_FACTOR_SCORE = 0.5;
// Minimum sessions under a tag before its "typical length" is trusted -
// same "don't manufacture a pattern from noise" bar analytics.js already
// uses elsewhere (mostSustainedTag, computeContextSwitchCost).
export const EFFORT_FIT_MIN_TAG_SESSIONS = 3;
// How far an estimate can be from the tag's typical length before
// effort-fit bottoms out at 0 - expressed as a ratio (2 = twice as long
// or half as long as typical is already the worst score, not just
// "somewhat worse").
export const EFFORT_FIT_MAX_RATIO = 2;

// Category balance: rolling window over which "how much time has this
// category gotten lately" is measured, matched to the existing
// consistency-score window (analytics.js's CONSISTENCY_WINDOW_DAYS) per
// the feature spec's own suggestion to reuse it rather than invent a
// second one.
export const CATEGORY_BALANCE_WINDOW_DAYS = 14;
// A tag needs at least this many sessions in its all-time history before
// it has an established "usual share" worth comparing the recent window
// against - a tag used once, historically, doesn't have a real baseline
// to fall short of yet.
export const CATEGORY_BALANCE_MIN_HISTORICAL_SESSIONS = 3;
// A tag counts as neglected once its recent-window share of total time
// has dropped to this fraction (or less) of its historical share - e.g.
// 0.3 means "down to 30% or less of its usual slice of the pie."
export const CATEGORY_BALANCE_NEGLECT_RATIO = 0.3;

// Staleness: days untouched before the boost starts, and the day count
// at which it's already maxed out. Escalates linearly between the two -
// a task untouched for 3 days gets no boost yet, one untouched for 14+
// gets the full boost, everything between scales proportionally.
export const STALENESS_THRESHOLD_DAYS = 3;
export const STALENESS_MAX_DAYS = 14;

// Energy/time-of-day fit. No explicit "deep-work vs quick-admin" field
// exists anywhere (see the scoping conversation) - a tag's type is
// inferred from its own median session length instead. Chosen as
// minutes rather than seconds purely for readability of this constant.
export const DEEP_WORK_MIN_MEDIAN_MINUTES = 25;
// A tag needs at least this many sessions before its type (and its best
// hour-of-day) is trusted - same reasoning as EFFORT_FIT_MIN_TAG_SESSIONS.
export const ENERGY_FIT_MIN_TAG_SESSIONS = 3;
// An hour "counts" as a type's best-performing window once its total
// logged time for that type is at least this multiple of that type's
// average per-hour total across the day - e.g. 1.3 means "30% above a
// flat/average hour," not just "the single highest hour no matter how
// small the gap."
export const ENERGY_FIT_HOUR_STRENGTH_MULTIPLIER = 1.3;
// Minimum sessions logged in a given hour, for a given type, before that
// hour is trusted as part of the "best window" for that type - a single
// lucky session at 2am under a deep-work tag shouldn't crown 2am as the
// best deep-work hour.
export const ENERGY_FIT_MIN_HOUR_SAMPLES = 3;

// Feature 6 (unscheduled suggestion): how long a dismissed suggestion
// stays suppressed before the same category/reason can be suggested
// again. Per the feature spec's own instruction ("fine to avoid
// repeating the identical suggestion again within a short cooldown
// window") without a specific number given - a day feels long enough
// that dismissing something isn't immediately followed by the same
// nudge again, short enough that a genuinely still-neglected category
// comes back up the next day rather than staying suppressed for a week.
export const SUGGESTION_COOLDOWN_HOURS = 24;
// A suggestion only fires when nothing on the "Do This Next" card
// clears this score - below this, the existing task list isn't saying
// anything useful enough to lead with, so an unscheduled suggestion (if
// one applies) gets to be the headline instead.
export const SUGGESTION_MIN_COMPETING_SCORE = 0.35;

// Below this many past sessions started in the same hour, the "you
// usually work on X around this time" fallback (see
// computeUnscheduledSuggestion's second branch) stays quiet rather than
// becoming an actionable suggestion - one session that happened to land
// in this hour once isn't a real pattern worth interrupting someone
// for. Same "at least 3" bar used elsewhere in this file
// (ENERGY_FIT_MIN_HOUR_SAMPLES) and in analytics.js
// (mostSustainedTag, bestFocusHour) for the same reason. Originally
// lived in TimerPanel.jsx as its own separate nudge's threshold before
// that nudge was folded into this suggestion (see HANDOVER) - moved
// here now that it's this file's logic using it, not TimerPanel's.
export const SUGGESTION_MIN_USUAL_TAG_SESSIONS = 3;
