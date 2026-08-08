import { formatDuration } from "../format.js";
import FocusMark from "./FocusMark.jsx";

// The Today hero — FocusDial's take on the ledger app's balance card.
// Instead of a money balance it leads with today's focus time (the one
// number that answers "how's today going"), with this-week and streak
// as the supporting stats, and a status pill that reads the way "In the
// black" does: a plain-language verdict, not a metric.
function statusPill(summary, streakAtRisk) {
  if (streakAtRisk) return { label: "Streak at risk", tone: "warn" };
  if (summary.todaySeconds > 0) return { label: "In focus today", tone: "good" };
  if (summary.streakDays > 0) return { label: "Streak alive", tone: "brass" };
  return { label: "Fresh start", tone: "dim" };
}

export default function HeroCard({ summary, streakAtRisk }) {
  const pill = statusPill(summary, streakAtRisk);
  const streakText =
    summary.streakDays > 0 ? `${summary.streakDays}-day streak` : "No streak yet";

  return (
    <section className="fd-hero">
      <div className="fd-hero__glow" aria-hidden="true" />
      <div className="fd-hero__inner">
        <div className="fd-hero__top">
          <span className="fd-hero__eyebrow">
            <FocusMark size={13} strokeWidth={2.4} className="fd-hero__mark" /> Focus today
          </span>
          <span className={`fd-hero__pill fd-hero__pill--${pill.tone}`}>{pill.label}</span>
        </div>

        <div className="fd-hero__value">{formatDuration(summary.todaySeconds)}</div>

        <div className="fd-hero__divider" />

        <div className="fd-hero__stats">
          <div className="fd-hero__stat">
            <span className="fd-hero__dot fd-hero__dot--green" />
            <span className="fd-hero__stat-label">This week</span>
            <span className="fd-hero__stat-value">{formatDuration(summary.weekSeconds)}</span>
          </div>
          <div className="fd-hero__stat">
            <span className="fd-hero__dot fd-hero__dot--brass" />
            <span className="fd-hero__stat-label">Streak</span>
            <span className="fd-hero__stat-value">{streakText}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
