import { useState } from "react";
import { formatDuration } from "../format.js";
import { startOfLocalDay } from "../analytics.js";
import { QUALITY_LABEL } from "./SessionLog.jsx";

const WEEKS = 12;
const DAYS = 7;

function timeRange(session) {
  const opts = { hour: "numeric", minute: "2-digit" };
  return `${new Date(session.started_at).toLocaleTimeString(undefined, opts)} \u2013 ${new Date(
    session.ended_at
  ).toLocaleTimeString(undefined, opts)}`;
}

// `history` only carries id/tag_id/started_at/ended_at/source/quality/
// tag_name/tag_color (see /sessions/history's own comment on why it's a
// separate, leaner shape from the paginated Session Log endpoint) -
// no note or task title here, so the modal doesn't show either.
//
// A session is included for a given day if it overlaps that day's
// [00:00, 24:00) window at all, not just if it started there - the same
// "which sessions touch this day" question splitSessionByLocalDay
// answers for the totals themselves (see analytics.js). `crossesBefore`/
// `crossesAfter` flag when a listed session actually started the
// previous day or continues into the next one, so the list can say so
// explicitly - otherwise the day's total (which only counts the portion
// that actually landed here) would look like it disagrees with a
// session shown at its full duration for no visible reason.
function sessionsForDay(history, dayDate) {
  const dayStart = startOfLocalDay(dayDate);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return history
    .filter((s) => new Date(s.started_at) < dayEnd && new Date(s.ended_at) > dayStart)
    .map((s) => ({
      ...s,
      crossesBefore: new Date(s.started_at) < dayStart,
      crossesAfter: new Date(s.ended_at) > dayEnd,
    }))
    .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
}

export default function CalendarHeatmap({ daily, streakDays, history }) {
  const [selectedDay, setSelectedDay] = useState(null);
  const maxSeconds = Math.max(...daily.map((d) => d.seconds), 1);

  // daily is 84 entries, oldest first, ending today. Reshape into 12
  // columns of 7 (weeks) for the grid, padding the first column if the
  // data doesn't start on a natural week boundary - simplest to just
  // chunk sequentially rather than aligning to actual calendar weeks,
  // since the point is "recent consistency at a glance," not a literal
  // calendar.
  const weeks = [];
  for (let i = 0; i < WEEKS; i++) {
    weeks.push(daily.slice(i * DAYS, i * DAYS + DAYS));
  }

  function levelFor(seconds) {
    if (seconds === 0) return 0;
    const ratio = seconds / maxSeconds;
    if (ratio > 0.66) return 3;
    if (ratio > 0.33) return 2;
    return 1;
  }

  const dayLabel = (d) =>
    d.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="fd-panel fd-heatmap-panel">
      <div className="fd-panel__label">Consistency</div>
      <div className="fd-heatmap">
        {weeks.map((week, wi) => (
          <div key={wi} className="fd-heatmap__col">
            {week.map((day) => (
              <button
                key={day.dateKey}
                type="button"
                className={`fd-heatmap__cell fd-heatmap__cell--${levelFor(day.seconds)}`}
                title={`${day.date.toLocaleDateString()}: ${formatDuration(day.seconds)}`}
                onClick={() => setSelectedDay(day)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="fd-heatmap-caption">
        <span className="fd-streak-badge">{streakDays}</span> day streak
        {streakDays > 0 ? " Keep it going." : " Log a session to start one."}
      </div>

      {selectedDay && (
        <div className="fd-modal-overlay" onClick={() => setSelectedDay(null)}>
          <div className="fd-panel fd-modal-panel fd-day-detail-panel" onClick={(e) => e.stopPropagation()}>
            <div className="fd-panel__label" style={{ marginBottom: 0 }}>
              {dayLabel(selectedDay)}
            </div>
            <div className="fd-day-detail__total">{formatDuration(selectedDay.seconds)} logged</div>

            {(() => {
              const sessions = sessionsForDay(history, selectedDay.date);
              if (sessions.length === 0) {
                return <div className="fd-empty">Nothing logged this day.</div>;
              }
              return (
                <div className="fd-log-list fd-day-detail__list">
                  {sessions.map((s) => (
                    <div key={s.id} className="fd-log-row-wrap">
                      <div
                        className="fd-log-row fd-check-card"
                        style={{ "--check-accent": s.tag_color || "var(--accent-session)" }}
                      >
                        <div className="fd-check-card__body">
                          <span className="fd-check-card__title">{s.tag_name || "Untagged"}</span>
                          <span className="fd-check-card__meta">{timeRange(s)}</span>
                          {(s.crossesBefore || s.crossesAfter) && (
                            <span className="fd-check-card__note">
                              {s.crossesBefore && "\u2190 started the day before"}
                              {s.crossesBefore && s.crossesAfter && " \u00b7 "}
                              {s.crossesAfter && "continues past midnight \u2192"}
                            </span>
                          )}
                        </div>
                        <div className="fd-check-card__value">
                          <span className="fd-check-card__value-num">
                            {s.quality && (
                              <span
                                className={`fd-quality-dot fd-quality-dot--${s.quality}`}
                                title={QUALITY_LABEL[s.quality]}
                              />
                            )}
                            {formatDuration((new Date(s.ended_at) - new Date(s.started_at)) / 1000)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            <button type="button" className="fd-link-btn fd-day-detail__close" onClick={() => setSelectedDay(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
