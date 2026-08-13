function hourLabel(hour) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

function trendTone(deltaPct) {
  if (deltaPct == null) return "dim";
  if (deltaPct > 0) return "focus-green";
  if (deltaPct < 0) return "rust";
  return "dim";
}

// Surfaces the one thing the Focused/Neutral/Distracted rating on each
// session was actually collected for -- until this card existed, that
// rating fed nothing: it was captured on every session and never once
// aggregated or shown back. This is "how good were my sessions," a
// different question from every other Insights card, which all answer
// "how much" or "when," never "how well."
export default function FocusQualityCard({ quality }) {
  const hasData = quality.ratedCount > 0;

  return (
    <div className="fd-panel fd-quality-panel">
      <div className="fd-panel__label">Focus Quality</div>
      {!hasData ? (
        <div className="fd-empty">
          Rate a few sessions Focused / Neutral / Distracted (Timer or Manual entry) to see your focus rate here.
        </div>
      ) : (
        <>
          <div className="fd-quality-panel__headline">
            <span className="fd-quality-panel__rate">{Math.round(quality.focusRatePct)}%</span>
            <span className="fd-quality-panel__rate-label">of rated sessions were Focused</span>
          </div>
          {quality.deltaPct != null && (
            <div className={`fd-quality-panel__trend fd-quality-panel__trend--${trendTone(quality.deltaPct)}`}>
              {quality.deltaPct > 0 ? "▲" : quality.deltaPct < 0 ? "▼" : "—"} {Math.abs(Math.round(quality.deltaPct))} pts
              vs. last week ({quality.lastWeekFocusRatePct != null ? `${Math.round(quality.lastWeekFocusRatePct)}%` : "—"})
            </div>
          )}
          {quality.bestHour && (
            <div className="fd-quality-panel__best-hour">
              Best focus window: <strong>{hourLabel(quality.bestHour.hour)}</strong> ({Math.round(quality.bestHour.ratePct)}% focused)
            </div>
          )}
          <div className="fd-quality-panel__coverage">
            {quality.ratedCount} of {quality.totalCount} sessions rated
          </div>
        </>
      )}
    </div>
  );
}
