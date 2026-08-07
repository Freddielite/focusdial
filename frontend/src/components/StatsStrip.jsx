import { formatDuration } from "../format.js";

export default function StatsStrip({ summary }) {
  const tiles = [
    { label: "Today", value: formatDuration(summary.todaySeconds) },
    { label: "This Week", value: formatDuration(summary.weekSeconds) },
    { label: "All Time", value: formatDuration(summary.allTimeSeconds) },
  ];
  return (
    <div className="fd-stats-strip">
      {tiles.map((t) => (
        <div key={t.label} className="fd-stat-tile">
          <div className="fd-stat-tile__value">{t.value}</div>
          <div className="fd-stat-tile__label">{t.label}</div>
        </div>
      ))}
    </div>
  );
}
