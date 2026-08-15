import { formatDuration } from "../format.js";

const WEEKS = 12;
const DAYS = 7;

export default function CalendarHeatmap({ daily, streakDays }) {
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

  return (
    <div className="fd-panel fd-heatmap-panel">
      <div className="fd-panel__label">Consistency</div>
      <div className="fd-heatmap">
        {weeks.map((week, wi) => (
          <div key={wi} className="fd-heatmap__col">
            {week.map((day) => (
              <div
                key={day.dateKey}
                className={`fd-heatmap__cell fd-heatmap__cell--${levelFor(day.seconds)}`}
                title={`${day.date.toLocaleDateString()}: ${formatDuration(day.seconds)}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="fd-heatmap-caption">
        <span className="fd-streak-badge">{streakDays}</span> day streak
        {streakDays > 0 ? " Keep it going." : " Log a session to start one."}
      </div>
    </div>
  );
}
