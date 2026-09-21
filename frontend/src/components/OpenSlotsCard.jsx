import { useState } from "react";
import { startSession } from "../api.js";
import { useDeviceName } from "../hooks/useDeviceName.js";
import { formatDuration } from "../format.js";

const MAX_SHOWN = 4;

// Complements PriorityCard's single "Do this next" pick with a view of
// the whole remaining day: how many more sessions could plausibly fit
// (computeOpenSlots, analytics.js) and what to spend them on (the same
// ranked list PriorityCard reads from, just more of it). The two aren't
// mutually exclusive - PriorityCard answers "what's the one best thing
// right now", this answers "what does today look like end to end."
export default function OpenSlotsCard({ openSlots, ranked, hasRunningSession, onSessionStarted }) {
  const [deviceName] = useDeviceName();
  const [startingId, setStartingId] = useState(null);
  const [error, setError] = useState("");

  if (!openSlots || ranked.length === 0) return null;
  const picks = ranked.slice(0, Math.min(openSlots.count, ranked.length, MAX_SHOWN));
  if (picks.length === 0) return null;

  async function handleStart(entry) {
    setError("");
    setStartingId(entry.task.id);
    try {
      await startSession(entry.task.tag_id || null, null, entry.task.id, deviceName);
      // Same cross-component nudge PriorityCard/TimerPanel already use -
      // see PriorityCard.jsx's own comment for why this exists.
      window.dispatchEvent(new Event("fd-session-started-elsewhere"));
      onSessionStarted?.();
    } catch (err) {
      setError(err.message || "Could not start a session for this task.");
    } finally {
      setStartingId(null);
    }
  }

  return (
    <div className="fd-panel fd-open-slots-card">
      <div className="fd-open-slots-card__eyebrow">
        You have {openSlots.count} open slot{openSlots.count === 1 ? "" : "s"} today
      </div>
      <div className="fd-open-slots-card__subtitle">
        Here's what FocusDial recommends
        {picks.length < ranked.length ? ` (top ${picks.length} of ${ranked.length} open tasks)` : ""}:
      </div>
      {error && <div className="fd-inline-error">{error}</div>}
      <div className="fd-open-slots-card__list">
        {picks.map((entry) => (
          <div key={entry.task.id} className="fd-open-slots-card__row">
            <div className="fd-open-slots-card__row-text">
              <span className="fd-open-slots-card__row-title">{entry.task.title}</span>
              <span className="fd-open-slots-card__row-reason">{entry.reason}</span>
            </div>
            <button
              type="button"
              className="fd-open-slots-card__row-start"
              onClick={() => handleStart(entry)}
              disabled={startingId != null || hasRunningSession}
              title={hasRunningSession ? "A session is already running" : undefined}
            >
              {startingId === entry.task.id ? "Starting..." : "Start"}
            </button>
          </div>
        ))}
      </div>
      <div className="fd-open-slots-card__footnote">
        Based on ~{formatDuration(openSlots.avgSessionSeconds)} average sessions and{" "}
        {formatDuration(openSlots.remainingSeconds)} left toward today's goal.
        {openSlots.limitedByCalendar && " Trimmed to fit around what's already on your calendar today."}
      </div>
    </div>
  );
}
