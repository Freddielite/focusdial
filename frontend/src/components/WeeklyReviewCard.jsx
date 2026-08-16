import { formatDuration } from "../format.js";

function trendTone(deltaPct) {
  if (deltaPct == null) return "dim";
  if (deltaPct > 0) return "focus-green";
  if (deltaPct < 0) return "rust";
  return "dim";
}

// Both formatters below used to compare raw elapsed time (hours/ms since
// now) instead of calendar dates -- which meant a reminder or deadline
// due early tomorrow morning would read "today" any time it was less
// than 24h away, even at 11pm the night before. "Today"/"tomorrow" is a
// calendar-date question, not an elapsed-time one, so this compares
// local day boundaries instead.
function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function calendarDaysUntil(target, now) {
  const diffMs = startOfLocalDay(target).getTime() - startOfLocalDay(now).getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

function formatDueIn(dueAt, now) {
  const days = calendarDaysUntil(dueAt, now);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

function formatRemindIn(remindAt, now) {
  const days = calendarDaysUntil(remindAt, now);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

// The in-app counterpart to the Sunday push digest (routes/cron.js) --
// same "how was this week" question, richer answer, always available
// rather than a one-shot notification you either saw or didn't. See
// analytics.js's computeWeeklyReview for what feeds this.
export default function WeeklyReviewCard({ review, userName }) {
  const now = new Date();
  const hasData = review.totalSeconds > 0;

  return (
    <div className="fd-panel fd-weekly-review">
      <div className="fd-panel__label">{userName ? `${userName}'s Weekly Review` : "Weekly Review"}</div>

      {!hasData ? (
        <div className="fd-empty">No focus sessions logged yet this week.</div>
      ) : (
        <>
          <div className="fd-weekly-review__headline">
            <span className="fd-weekly-review__total">{formatDuration(review.totalSeconds)}</span>
            <span className="fd-weekly-review__total-label">logged this week so far</span>
          </div>
          {review.deltaPct != null && (
            <div className={`fd-weekly-review__trend fd-weekly-review__trend--${trendTone(review.deltaPct)}`}>
              {review.deltaPct > 0 ? "▲" : review.deltaPct < 0 ? "▼" : "•"} {Math.abs(Math.round(review.deltaPct * 100))}%
              vs. the same point last week ({formatDuration(review.lastWeekSeconds)})
            </div>
          )}

          <div className="fd-weekly-review__stats">
            {review.bestDay && (
              <div className="fd-weekly-review__stat">
                <span className="fd-weekly-review__stat-label">Best day</span>
                <span className="fd-weekly-review__stat-value">
                  {review.bestDay.label} ({formatDuration(review.bestDay.seconds)})
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
                <span className="fd-weekly-review__stat-label">This week's focus rate</span>
                <span className="fd-weekly-review__stat-value">
                  {Math.round(review.qualityRatePct)}% ({review.qualityRatedCount}/{review.qualityTotalCount} rated)
                </span>
              </div>
            )}
          </div>
        </>
      )}

      <div className="fd-weekly-review__upcoming">
        <div className="fd-weekly-review__upcoming-label">Coming up (next 7 days)</div>
        {review.upcomingDeadlines.length === 0 && review.upcomingReminders.length === 0 ? (
          <div className="fd-empty">Nothing due in the next 7 days.</div>
        ) : (
          <ul className="fd-weekly-review__upcoming-list">
            {review.upcomingDeadlines.map((d) => (
              <li key={`deadline-${d.id}`}>
                <span className="fd-weekly-review__upcoming-tag fd-weekly-review__upcoming-tag--deadline">Deadline</span>
                {d.title}, {formatDueIn(d.dueAt, now)}
              </li>
            ))}
            {review.upcomingReminders.map((r) => (
              <li key={`reminder-${r.id}`}>
                <span className="fd-weekly-review__upcoming-tag fd-weekly-review__upcoming-tag--reminder">Reminder</span>
                {r.title}, {formatRemindIn(new Date(r.remind_at), now)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
