import { useMemo, useState } from "react";
import { startSession } from "../api.js";
import { useDeviceName } from "../hooks/useDeviceName.js";
import FocusMark from "./FocusMark.jsx";

// Feature 1's "Do This Next" card. Takes the already-computed `ranked`
// list from computePriorityRanking (see priorityEngine.js) rather than
// computing anything itself - this component is purely presentation and
// the "skip to see the next-highest task" interaction, so it stays
// simple and testable independent of the scoring logic.
export default function PriorityCard({ ranked, hasRunningSession, onSessionStarted }) {
  const [deviceName] = useDeviceName();
  const [skipCount, setSkipCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  // Skipping cycles further down the ranked list rather than removing a
  // task from consideration permanently - it resets (skipCount back to 0)
  // whenever the ranked list itself changes identity, e.g. a task was
  // completed or a new one was added, since "skip" only ever meant "not
  // this one, right now."
  const current = useMemo(() => ranked[skipCount % Math.max(ranked.length, 1)] || null, [ranked, skipCount]);

  if (!current) return null;

  async function handleStart() {
    setError("");
    setStarting(true);
    try {
      await startSession(current.task.tag_id || null, null, current.task.id, deviceName);
      // Lets TimerPanel notice a session started from outside itself -
      // see the matching listener added to TimerPanel's existing
      // service-worker-message effect. TimerPanel's own polling would
      // eventually pick this up too (every 60s, or on next visibility
      // change), but without this it would look like nothing happened
      // for up to a minute after tapping Start here.
      window.dispatchEvent(new Event("fd-session-started-elsewhere"));
      onSessionStarted?.();
    } catch (err) {
      setError(err.message || "Could not start a session for this task.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="fd-panel fd-priority-card">
      <div className="fd-priority-card__eyebrow">
        <FocusMark size={13} strokeWidth={2.4} className="fd-priority-card__mark" />
        Do this next
      </div>
      <div className="fd-priority-card__title">{current.task.title}</div>
      <div className="fd-priority-card__reason">{current.reason}</div>
      {error && <div className="fd-inline-error">{error}</div>}
      <div className="fd-priority-card__actions">
        <button
          type="button"
          className="fd-priority-card__start"
          onClick={handleStart}
          disabled={starting || hasRunningSession}
          title={hasRunningSession ? "A session is already running" : undefined}
        >
          {starting ? "Starting..." : "Start"}
        </button>
        {ranked.length > 1 && (
          <button
            type="button"
            className="fd-link-btn fd-priority-card__skip"
            onClick={() => setSkipCount((c) => c + 1)}
          >
            Not this one
          </button>
        )}
      </div>
    </div>
  );
}
