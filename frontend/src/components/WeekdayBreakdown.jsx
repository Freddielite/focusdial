import { useState } from "react";
import { formatDuration } from "../format.js";

// Matches the Monday-first order analytics.js already reorders `weekday`
// into (see computeSummary), consistent with this app's Monday-start week
// convention (mondayOf()) rather than JS's native Sunday-first getDay().
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABELS_FULL = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

// `d.day` is the JS-native getDay() value (0 = Sunday ... 6 = Saturday) -
// weekday[] is already reordered Monday-first for display, but each
// entry kept its original getDay() in `.day` (see computeSummary), which
// is what a session's own started_at.getDay() can be compared against
// directly here without needing another remap.
//
// Session-level overlap (matching on where a session *started*), not the
// day-split segments the bar's own total is built from - same
// simplification CalendarHeatmap's sessionsForDay makes for the same
// reason: a detail list showing exactly which logged sessions landed on
// this weekday is more useful here than perfectly reconciling a session
// that crossed midnight into a fraction of a day.
function sessionsForWeekday(history, dayOfWeek) {
  return history
    .filter((s) => new Date(s.started_at).getDay() === dayOfWeek)
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
}

function tagBreakdownFor(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.tag_id || "untagged";
    const seconds = (new Date(s.ended_at) - new Date(s.started_at)) / 1000;
    const existing = map.get(key) || {
      name: s.tag_name || "Untagged",
      color: s.tag_color || "var(--accent-session)",
      seconds: 0,
      count: 0,
    };
    existing.seconds += seconds;
    existing.count += 1;
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => b.seconds - a.seconds);
}

export default function WeekdayBreakdown({ weekday, bestWeekday, history }) {
  const [selected, setSelected] = useState(null); // the clicked weekday entry, or null
  const maxSeconds = Math.max(...weekday.map((d) => d.seconds), 1);

  const detailSessions = selected ? sessionsForWeekday(history, selected.day) : [];
  const detailTags = tagBreakdownFor(detailSessions);
  const maxTagSeconds = Math.max(...detailTags.map((t) => t.seconds), 1);

  return (
    <div className="fd-panel fd-weekday-panel">
      <div className="fd-panel__label">Best Day</div>
      <div className="fd-weekday-chart">
        {weekday.map((d, i) => {
          const isBest = bestWeekday.seconds > 0 && d.day === bestWeekday.day;
          return (
            <div key={d.day} className="fd-weekday-bar-col">
              <button
                type="button"
                className={`fd-weekday-bar ${isBest ? "fd-weekday-bar--best" : ""}`}
                style={{
                  height: `${Math.max((d.seconds / maxSeconds) * 100, d.seconds > 0 ? 3 : 0)}%`,
                }}
                title={`${DAY_LABELS[i]}: ${formatDuration(d.seconds)}`}
                onClick={() => setSelected(d)}
              />
              <div className="fd-weekday-bar-label">{DAY_LABELS[i]}</div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="fd-modal-overlay" onClick={() => setSelected(null)}>
          <div className="fd-panel fd-modal-panel fd-day-detail-panel" onClick={(e) => e.stopPropagation()}>
            <div className="fd-panel__label" style={{ marginBottom: 0 }}>
              {DAY_LABELS_FULL[weekday.indexOf(selected)]}
            </div>
            <div className="fd-day-detail__total">
              {formatDuration(selected.seconds)} logged all-time
              {detailSessions.length > 0 &&
                ` across ${detailSessions.length} session${detailSessions.length === 1 ? "" : "s"}`}
            </div>

            {detailTags.length === 0 ? (
              <div className="fd-empty">Nothing logged on this day yet.</div>
            ) : (
              <div className="fd-tag-list fd-day-detail__list">
                {detailTags.map((t) => (
                  <div key={t.name} className="fd-tag-row">
                    <div className="fd-tag-row__head">
                      <span className="fd-tag-dot" style={{ background: t.color }} />
                      <span className="fd-tag-row__name">
                        {t.name} ({t.count})
                      </span>
                      <span className="fd-tag-row__total">{formatDuration(t.seconds)}</span>
                    </div>
                    <div className="fd-tag-row__bar-track">
                      <div
                        className="fd-tag-row__bar"
                        style={{ width: `${(t.seconds / maxTagSeconds) * 100}%`, background: t.color }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button type="button" className="fd-link-btn fd-day-detail__close" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
