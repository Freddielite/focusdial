import { formatDuration } from "../format.js";
import { interruptionReasonLabel } from "../analytics.js";

// Same visual family as ConsistencyCard/FocusQualityCard (fd-quality-panel)
// rather than a new layout - this is one more "how's it actually going"
// stat alongside those, not a different kind of thing.
export default function InterruptionsCard({ interruptions }) {
  if (!interruptions) {
    return (
      <div className="fd-panel fd-quality-panel">
        <div className="fd-panel__label">Interruptions</div>
        <div className="fd-empty">
          No interruptions logged in the last two weeks. When you come back from being away mid-session, you can
          optionally tag what pulled you away - it'll show up here.
        </div>
      </div>
    );
  }

  const { totalCount, totalSeconds, sessionsWithInterruptions, sessionsInWindow, topReason, byReason, windowDays } =
    interruptions;

  return (
    <div className="fd-panel fd-quality-panel">
      <div className="fd-panel__label">Interruptions</div>
      <div className="fd-quality-panel__headline">
        <span className="fd-quality-panel__rate fd-quality-panel__rate--rust">{totalCount}</span>
        <span className="fd-quality-panel__rate-label">
          logged over the last {windowDays} days, costing about {formatDuration(totalSeconds)}
        </span>
      </div>
      <div className="fd-quality-panel__best-hour">
        {sessionsWithInterruptions} of {sessionsInWindow} sessions in that window had at least one.
        {topReason && (
          <>
            {" "}
            Most costly: <strong>{interruptionReasonLabel(topReason.reason)}</strong> (
            {formatDuration(topReason.seconds)} across {topReason.count}
            {topReason.count === 1 ? " time" : " times"}).
          </>
        )}
      </div>
      {byReason.length > 1 && (
        <div className="fd-interruption-breakdown">
          {byReason.map((r) => (
            <div key={r.reason} className="fd-interruption-breakdown__row">
              <span className="fd-interruption-breakdown__label">{interruptionReasonLabel(r.reason)}</span>
              <span className="fd-interruption-breakdown__value">
                {r.count}× · {formatDuration(r.seconds)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
