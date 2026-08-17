import { formatDuration } from "../format.js";
import FocusMark from "./FocusMark.jsx";

// The Today hero - FocusDial's take on the ledger app's balance card.
// Instead of a money balance it leads with today's focus time (the one
// number that answers "how's today going"), with this-week and streak
// as the supporting stats, and a status pill that reads the way "In the
// black" does: a plain-language verdict, not a metric.

// Was its own line above this card (see HANDOVER.md's "name
// personalization" session for the original Greeting.jsx) - moved into
// the eyebrow slot on request, since a name-aware "Still up, Freddie."
// reads better sitting right on the card it's introducing than
// floating separately above it. Falls back to the plain "Focus today"
// label whenever there's no name to greet - same reasoning
// Greeting.jsx originally used for returning null: a greeting with
// nothing to greet reads as an unfinished template, not a deliberate
// choice.
function timeOfDayGreeting(hour) {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function eyebrowLabel(name) {
  if (!name) return "Focus today";
  return `${timeOfDayGreeting(new Date().getHours())}, ${name}.`;
}

function statusPill(summary, streakAtRisk, goalMet) {
  if (streakAtRisk) return { label: "Streak at risk", tone: "warn" };
  if (goalMet) return { label: "Goal met", tone: "good" };
  if (summary.todaySeconds > 0) return { label: "In focus today", tone: "good" };
  if (summary.streakDays > 0) return { label: "Streak alive", tone: "brass" };
  return { label: "Fresh start", tone: "dim" };
}

export default function HeroCard({
  summary,
  streakAtRisk,
  dailyGoalSeconds,
  goalProjection,
  startTimeAnomaly,
  graceEnabled,
  userName,
}) {
  const hasGoal = dailyGoalSeconds != null && dailyGoalSeconds > 0;
  const goalPct = hasGoal ? Math.min(1, summary.todaySeconds / dailyGoalSeconds) : 0;
  const goalMet = hasGoal && summary.todaySeconds >= dailyGoalSeconds;
  const pill = statusPill(summary, streakAtRisk, goalMet);
  const streakText =
    summary.streakDays > 0 ? `${summary.streakDays}-day streak` : "No streak yet";
  // Only worth a note once there's an actual streak to protect - an
  // unused grace on a fresh start isn't information anyone needs yet.
  const showGraceNote = graceEnabled && summary.streakDays > 0;

  return (
    <section className="fd-hero">
      <div className="fd-hero__glow" aria-hidden="true" />
      <div className="fd-hero__inner">
        <div className="fd-hero__top">
          <span className={`fd-hero__eyebrow ${userName ? "fd-hero__eyebrow--greeting" : ""}`}>
            <FocusMark size={13} strokeWidth={2.4} className="fd-hero__mark" /> {eyebrowLabel(userName)}
          </span>
          <span className={`fd-hero__pill fd-hero__pill--${pill.tone}`}>{pill.label}</span>
        </div>

        {startTimeAnomaly && (
          <div className="fd-hero__anomaly">
            Later start than usual today - first session at{" "}
            {Math.round(startTimeAnomaly.todayStartMinute / 60)}h{String(startTimeAnomaly.todayStartMinute % 60).padStart(2, "0")},
            vs your typical {Math.round(startTimeAnomaly.avgStartMinute / 60)}h
            {String(Math.round(startTimeAnomaly.avgStartMinute) % 60).padStart(2, "0")}.
          </div>
        )}

        <div className="fd-hero__value">{formatDuration(summary.todaySeconds)}</div>

        {hasGoal && (
          <div className="fd-hero__goal">
            <div className="fd-hero__goal-track">
              <div
                className={`fd-hero__goal-fill ${goalMet ? "fd-hero__goal-fill--met" : ""}`}
                style={{ width: `${goalPct * 100}%` }}
              />
            </div>
            <span className="fd-hero__goal-label">
              {goalMet ? "Goal met, " : ""}
              {formatDuration(summary.todaySeconds)} of {formatDuration(dailyGoalSeconds)} today
            </span>
            {goalProjection && (
              <div
                className={`fd-hero__projection ${goalProjection.onPace ? "fd-hero__projection--good" : "fd-hero__projection--warn"}`}
              >
                {goalProjection.onPace
                  ? "At today's pace, you're on track to hit your goal."
                  : `At today's pace, you'll fall short. ${formatDuration(goalProjection.remainingSeconds)} more needed to catch up.`}
              </div>
            )}
          </div>
        )}

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
            <span className="fd-hero__stat-value">
              {streakText}
              {showGraceNote && (
                <span
                  className={`fd-hero__grace ${summary.streakGraceAvailable ? "fd-hero__grace--available" : "fd-hero__grace--used"}`}
                  title={
                    summary.streakGraceAvailable
                      ? "This week's protected miss hasn't been used yet"
                      : "This week's protected miss has already been used"
                  }
                >
                  {summary.streakGraceAvailable ? "🛡" : "🛡︎"}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
