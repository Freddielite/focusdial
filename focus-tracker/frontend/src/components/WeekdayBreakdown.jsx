import { formatDuration } from "../format.js";

// Matches the Monday-first order analytics.js already reorders `weekday`
// into (see computeSummary), consistent with this app's Monday-start week
// convention (mondayOf()) rather than JS's native Sunday-first getDay().
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function WeekdayBreakdown({ weekday, bestWeekday }) {
  const maxSeconds = Math.max(...weekday.map((d) => d.seconds), 1);

  return (
    <div className="fd-panel fd-weekday-panel">
      <div className="fd-panel__label">Best Day</div>
      <div className="fd-weekday-chart">
        {weekday.map((d, i) => {
          const isBest = bestWeekday.seconds > 0 && d.day === bestWeekday.day;
          return (
            <div key={d.day} className="fd-weekday-bar-col">
              <div
                className={`fd-weekday-bar ${isBest ? "fd-weekday-bar--best" : ""}`}
                style={{
                  height: `${Math.max((d.seconds / maxSeconds) * 100, d.seconds > 0 ? 3 : 0)}%`,
                }}
                title={`${DAY_LABELS[i]}: ${formatDuration(d.seconds)}`}
              />
              <div className="fd-weekday-bar-label">{DAY_LABELS[i]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
