import { formatDuration } from "../format.js";

// Same short-date convention already used elsewhere for a specific
// calendar day (RemindersView, TasksWidget, TrendChart's weekLabel) -
// `{ month: "short", day: "numeric" }` rather than a full date, since
// the year is rarely the interesting part of "when was my best day."
function formatDayLabel(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "Was this a good stretch, historically" - a different question from
// everything else in Insights, which is all either "right now" or
// "typically." See computeMilestones in analytics.js for how each of
// these three is actually found; all three come bundled in
// `summary.milestones` rather than as separate props, same as
// consistency/comparativeInsights/etc. already do.
export default function MilestonesCard({ milestones }) {
  const { longestSession, bestDay, longestStreak } = milestones || {};
  const hasAny = longestSession || bestDay || longestStreak;

  if (!hasAny) {
    return (
      <div className="fd-panel fd-milestones-card">
        <div className="fd-panel__label">Personal Records</div>
        <div className="fd-empty">Log a few sessions and this fills in with your all-time bests.</div>
      </div>
    );
  }

  return (
    <div className="fd-panel fd-milestones-card">
      <div className="fd-panel__label">Personal Records</div>
      <div className="fd-milestones-card__list">
        {longestSession && (
          <div className="fd-milestones-card__row">
            <div className="fd-milestones-card__row-head">
              <span className="fd-milestones-card__title">Longest session</span>
              <span className="fd-milestones-card__value">{formatDuration(longestSession.seconds)}</span>
            </div>
            <div className="fd-milestones-card__meta">
              {longestSession.tagName && (
                <>
                  <span className="fd-tag-dot" style={{ background: longestSession.tagColor || "#8C8074" }} />
                  {longestSession.tagName} ·{" "}
                </>
              )}
              {longestSession.date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </div>
          </div>
        )}
        {bestDay && (
          <div className="fd-milestones-card__row">
            <div className="fd-milestones-card__row-head">
              <span className="fd-milestones-card__title">Best day</span>
              <span className="fd-milestones-card__value">{formatDuration(bestDay.seconds)}</span>
            </div>
            <div className="fd-milestones-card__meta">{formatDayLabel(bestDay.date)}</div>
          </div>
        )}
        {longestStreak && (
          <div className="fd-milestones-card__row">
            <div className="fd-milestones-card__row-head">
              <span className="fd-milestones-card__title">Longest streak</span>
              <span className="fd-milestones-card__value">{longestStreak.days}-day</span>
            </div>
            <div className="fd-milestones-card__meta">
              {longestStreak.isCurrent
                ? "That's your current streak, still running."
                : `Ended ${formatDayLabel(longestStreak.endDateKey)}`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
