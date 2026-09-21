// Answers a question the real-time pace/status logic never does: over
// time, do you actually hit your deadlines? See
// analytics.js:computeDeadlineTrackRecord for how "resolved" and
// "on time" are decided. Renders nothing until at least one deadline
// has actually been resolved one way or another, same "don't show a
// hollow stat" reasoning as RiskDigestCard.
export default function DeadlineTrackRecordCard({ trackRecord }) {
  if (!trackRecord || trackRecord.resolved === 0) return null;
  const { onTime, late, missed, resolved, onTimeRatePct } = trackRecord;

  return (
    <div className="fd-panel fd-quality-panel">
      <div className="fd-panel__label">Deadline Track Record</div>
      <div className="fd-quality-panel__headline">
        <span className="fd-quality-panel__rate">{Math.round(onTimeRatePct)}%</span>
        <span className="fd-quality-panel__rate-label">of resolved deadlines finished on time</span>
      </div>
      <div className="fd-quality-panel__coverage">
        {onTime} on time · {late} late · {missed} missed, out of {resolved} resolved
      </div>
    </div>
  );
}
