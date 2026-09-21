import { formatDuration } from "../format.js";

function scoreTone(score) {
  if (score >= 75) return "focus-green";
  if (score >= 45) return "dim";
  return "rust";
}

function scoreLabel(score) {
  if (score >= 75) return "Steady";
  if (score >= 45) return "Uneven";
  return "Spiky";
}

// Answers "how steady is my daily focus time," not "how much" -- a
// different question from every total/average elsewhere in Insights.
// Two accounts can average the same daily total with totally different
// feels (a little every day vs. rare binges); this is the first thing
// in the app that looks at the spread instead of the sum. See
// computeConsistencyScore in analytics.js for the actual math.
export default function ConsistencyCard({ consistency }) {
  if (!consistency) {
    return (
      <div className="fd-panel fd-quality-panel">
        <div className="fd-panel__label">Consistency</div>
        <div className="fd-empty">
          Log sessions on at least 5 of the last 14 completed days to see how steady your focus time is.
        </div>
      </div>
    );
  }

  const { score, avgSeconds, activeDays, windowDays } = consistency;

  return (
    <div className="fd-panel fd-quality-panel">
      <div className="fd-panel__label">Consistency</div>
      <div className="fd-quality-panel__headline">
        <span className={`fd-quality-panel__rate fd-quality-panel__rate--${scoreTone(score)}`}>{score}</span>
        <span className="fd-quality-panel__rate-label">{scoreLabel(score)} over the last {windowDays} completed days</span>
      </div>
      <div className="fd-quality-panel__best-hour">
        Averaging <strong>{formatDuration(avgSeconds)}</strong>/day, logged on {activeDays} of the last {windowDays} completed days.
      </div>
      <div className="fd-quality-panel__coverage">
        Higher score means steadier day-to-day totals, not just a higher average.
      </div>
    </div>
  );
}
