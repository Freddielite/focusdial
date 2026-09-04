import { useMemo, useState } from "react";
import { startSession } from "../api.js";
import { useDeviceName } from "../hooks/useDeviceName.js";
import { formatDuration } from "../format.js";

const MAX_PICKS = 3;

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// The one guided touchpoint at each end of the day - as opposed to
// everything else on Today (PriorityCard, OpenSlotsCard, insight cards),
// which are all always-visible and ambient. This is shown once per
// local day (see useDailyRitual.js) automatically, and can also be
// reopened manually from TodayView's "Plan my day"/"Reflect on today"
// links. Same component for both `mode`s since the shell (greeting,
// dismiss) is identical - only the body differs.
export default function DailyPlanModal({
  mode, // 'morning' | 'evening'
  displayName,
  onClose,
  dailyGoalSeconds,
  todaySeconds,
  todaySessions,
  googleConnected,
  busyBlocks,
  openSlots,
  ranked,
  onSessionStarted,
}) {
  const [deviceName] = useDeviceName();
  const [startingId, setStartingId] = useState(null);
  const [error, setError] = useState("");

  const picks = useMemo(
    () => (openSlots && ranked ? ranked.slice(0, Math.min(openSlots.count, ranked.length, MAX_PICKS)) : []),
    [openSlots, ranked]
  );

  const todayQuality = useMemo(() => {
    const counts = { focused: 0, neutral: 0, distracted: 0 };
    for (const s of todaySessions || []) {
      if (s.quality && counts[s.quality] != null) counts[s.quality] += 1;
    }
    return counts;
  }, [todaySessions]);

  async function handleStart(entry) {
    setError("");
    setStartingId(entry.task.id);
    try {
      await startSession(entry.task.tag_id || null, null, entry.task.id, deviceName);
      window.dispatchEvent(new Event("fd-session-started-elsewhere"));
      onSessionStarted?.();
      onClose();
    } catch (err) {
      setError(err.message || "Could not start a session for this task.");
    } finally {
      setStartingId(null);
    }
  }

  const greetingName = displayName ? `, ${displayName}` : "";

  return (
    <div className="fd-modal-overlay" onClick={onClose}>
      <div
        className="fd-panel fd-modal-panel fd-confirm-panel fd-daily-plan-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fd-panel__label">
          {mode === "morning" ? `Good morning${greetingName}` : `How did today go${greetingName}?`}
        </div>

        {mode === "morning" ? (
          <>
            {googleConnected && (
              <div className="fd-daily-plan-modal__section">
                <div className="fd-daily-plan-modal__section-title">On your calendar today</div>
                {busyBlocks.length === 0 ? (
                  <div className="fd-empty">Nothing on your calendar - the day's wide open.</div>
                ) : (
                  <div className="fd-daily-plan-modal__events">
                    {busyBlocks.map((b, i) => (
                      <div key={i} className="fd-daily-plan-modal__event">
                        <span className="fd-daily-plan-modal__event-time">
                          {formatTime(b.start)}-{formatTime(b.end)}
                        </span>
                        <span className="fd-daily-plan-modal__event-title">{b.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {dailyGoalSeconds > 0 && (
              <div className="fd-daily-plan-modal__section">
                <div className="fd-daily-plan-modal__section-title">Today's goal</div>
                <div className="fd-confirm-body">
                  {formatDuration(todaySeconds)} logged so far, toward {formatDuration(dailyGoalSeconds)}.
                </div>
              </div>
            )}

            {picks.length > 0 && (
              <div className="fd-daily-plan-modal__section">
                <div className="fd-daily-plan-modal__section-title">Here's what FocusDial recommends</div>
                {error && <div className="fd-inline-error">{error}</div>}
                <div className="fd-daily-plan-modal__events">
                  {picks.map((entry) => (
                    <div key={entry.task.id} className="fd-daily-plan-modal__event">
                      <span className="fd-daily-plan-modal__event-title">{entry.task.title}</span>
                      <button
                        type="button"
                        className="fd-link-btn"
                        onClick={() => handleStart(entry)}
                        disabled={startingId != null}
                      >
                        {startingId === entry.task.id ? "Starting…" : "Start"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="fd-daily-plan-modal__section">
              <div className="fd-confirm-body">
                {todaySessions.length === 0
                  ? "No sessions logged today."
                  : `${formatDuration(todaySeconds)} across ${todaySessions.length} session${
                      todaySessions.length === 1 ? "" : "s"
                    } today.`}
              </div>
              {(todayQuality.focused || todayQuality.neutral || todayQuality.distracted) > 0 && (
                <div className="fd-confirm-body">
                  {todayQuality.focused} focused · {todayQuality.neutral} neutral · {todayQuality.distracted}{" "}
                  distracted
                </div>
              )}
            </div>
          </>
        )}

        <div className="fd-confirm-actions">
          <button type="button" className="fd-btn fd-btn--start" onClick={onClose}>
            {mode === "morning" ? "Let's go" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
