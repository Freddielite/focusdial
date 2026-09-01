import { formatDuration } from "../format.js";

function trendTone(deltaPct) {
  if (deltaPct == null) return "dim";
  if (deltaPct > 0) return "focus-green";
  if (deltaPct < 0) return "rust";
  return "dim";
}

// Same calendar-date (not elapsed-time) "today"/"tomorrow" logic as
// WeeklyReviewCard's own copy of these four helpers - duplicated rather
// than imported from there, since these are presentation-only and this
// card is meant to stay just as self-contained as its weekly
// counterpart (see computeMonthlyReview's own comment on why it isn't
// sharing code with computeWeeklyReview either).
function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function calendarDaysUntil(target, now) {
  const diffMs = startOfLocalDay(target).getTime() - startOfLocalDay(now).getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

function formatDaysUntil(days) {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

function formatDueIn(dueAt, now) {
  return formatDaysUntil(calendarDaysUntil(dueAt, now));
}

function formatRemindIn(remindAt, now) {
  return formatDaysUntil(calendarDaysUntil(remindAt, now));
}

function isUrgent(target, now) {
  return calendarDaysUntil(target, now) <= 1;
}

// Weekday names can't label a day within a month the way they can
// within a week (see computeMonthlyReview's comment on `bestDay`), so
// this formats the actual Date it hands back instead - same short-date
// convention used for a specific day elsewhere (RemindersView,
// TasksWidget, MilestonesCard).
function formatDayLabel(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Monthly counterpart to WeeklyReviewCard, right below it in Insights -
// same "how was this period" question at a longer cadence, for whoever
// wants the zoomed-out view instead of (or alongside) the weekly one.
// See analytics.js's computeMonthlyReview for what feeds this.
export default function MonthlyReviewCard({ review }) {
  const now = new Date();
  const hasData = review.totalSeconds > 0;

  return (
    <div className="fd-panel fd-weekly-review">
      <div className="fd-panel__label">{review.monthLabel} Review</div>

      {!hasData ? (
        <div className="fd-empty">No focus sessions logged yet this month.</div>
      ) : (
        <>
          <div className="fd-weekly-review__headline">
            <span className="fd-weekly-review__total">{formatDuration(review.totalSeconds)}</span>
            <span className="fd-weekly-review__total-label">logged this month so far</span>
          </div>
          {review.deltaPct != null && (
            <div className={`fd-weekly-review__trend fd-weekly-review__trend--${trendTone(review.deltaPct)}`}>
              {review.deltaPct > 0 ? "▲" : review.deltaPct < 0 ? "▼" : "•"} {Math.abs(Math.round(review.deltaPct * 100))}%
              vs. the same point last month ({formatDuration(review.lastMonthSeconds)})
            </div>
          )}

          <div className="fd-weekly-review__stats">
            {review.bestDay && (
              <div className="fd-weekly-review__stat">
                <span className="fd-weekly-review__stat-label">Best day</span>
                <span className="fd-weekly-review__stat-value">
                  {formatDayLabel(review.bestDay.date)} ({formatDuration(review.bestDay.seconds)})
                </span>
              </div>
            )}
            {review.topTag && (
              <div className="fd-weekly-review__stat">
                <span className="fd-weekly-review__stat-label">Top tag</span>
                <span className="fd-weekly-review__stat-value">
                  <span className="fd-tag-dot" style={{ background: review.topTag.color }} />
                  {review.topTag.name} ({formatDuration(review.topTag.seconds)})
                </span>
              </div>
            )}
            {review.qualityRatePct != null && (
              <div className="fd-weekly-review__stat">
                <span className="fd-weekly-review__stat-label">This month's focus rate</span>
                <span className="fd-weekly-review__stat-value">
                  {Math.round(review.qualityRatePct)}% ({review.qualityRatedCount}/{review.qualityTotalCount} rated)
                </span>
              </div>
            )}
          </div>
        </>
      )}

      <div className="fd-weekly-review__upcoming">
        <div className="fd-weekly-review__upcoming-label">Coming up (next 30 days)</div>
        {review.upcomingDeadlines.length === 0 && review.upcomingReminders.length === 0 ? (
          <div className="fd-empty">Nothing due in the next 30 days.</div>
        ) : (
          <ul className="fd-weekly-review__upcoming-list">
            {review.upcomingDeadlines.map((d) => {
              const urgent = isUrgent(d.dueAt, now);
              return (
                <li
                  key={`deadline-${d.id}`}
                  className={`fd-upcoming-row fd-upcoming-row--deadline${urgent ? " fd-upcoming-row--urgent" : ""}`}
                >
                  <span className="fd-upcoming-row__type">Deadline</span>
                  <span className="fd-upcoming-row__title">{d.title}</span>
                  <span className="fd-upcoming-row__when">{formatDueIn(d.dueAt, now)}</span>
                </li>
              );
            })}
            {review.upcomingReminders.map((r) => {
              const remindAt = new Date(r.remind_at);
              const urgent = isUrgent(remindAt, now);
              return (
                <li
                  key={`reminder-${r.id}`}
                  className={`fd-upcoming-row fd-upcoming-row--reminder${urgent ? " fd-upcoming-row--urgent" : ""}`}
                >
                  <span className="fd-upcoming-row__type">Reminder</span>
                  <span className="fd-upcoming-row__title">{r.title}</span>
                  <span className="fd-upcoming-row__when">{formatRemindIn(remindAt, now)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
