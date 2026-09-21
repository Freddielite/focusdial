import { formatDuration } from "../format.js";

export default function TagBreakdown({ byTag, mostSustainedTag }) {
  const maxSeconds = Math.max(...byTag.map((t) => t.seconds), 1);

  return (
    <div className="fd-panel fd-tag-panel">
      <div className="fd-panel__label">By Tag</div>
      {byTag.length === 0 && <div className="fd-empty">No sessions logged yet.</div>}
      <div className="fd-tag-list">
        {byTag.map((t) => (
          <div key={t.tagId || "untagged"} className="fd-tag-row">
            <div className="fd-tag-row__head">
              <span className="fd-tag-dot" style={{ background: t.color }} />
              <span className="fd-tag-row__name">{t.name}</span>
              <span className="fd-tag-row__total">{formatDuration(t.seconds)}</span>
            </div>
            <div className="fd-tag-row__bar-track">
              <div
                className="fd-tag-row__bar"
                style={{ width: `${(t.seconds / maxSeconds) * 100}%`, background: t.color }}
              />
            </div>
          </div>
        ))}
      </div>
      {mostSustainedTag && (
        <div className="fd-insight">
          Your longest average sessions are on <strong>{mostSustainedTag.name}</strong> (
          {formatDuration(mostSustainedTag.avgSeconds)} average), that's likely where you focus
          most deeply.
        </div>
      )}
    </div>
  );
}
