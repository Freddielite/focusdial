import { useState } from "react";
import { startSession } from "../api.js";
import { useDeviceName } from "../hooks/useDeviceName.js";

// Feature 6's unscheduled-suggestion card. `suggestion` is whatever
// computeUnscheduledSuggestion (priorityEngine.js) returned, or this
// isn't rendered at all (see TodayView). Deliberately its own component
// rather than a variant of PriorityCard - the feature spec calls for it
// to "clearly read as a suggestion, not a task," so it gets its own
// visual treatment (outlined/dashed rather than solid, see App.css)
// instead of sharing a look with the task-backed card.
export default function SuggestionCard({ suggestion, hasRunningSession, onSessionStarted, onDismiss }) {
  const [deviceName] = useDeviceName();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  if (!suggestion) return null;

  async function handleStart() {
    setError("");
    setStarting(true);
    try {
      // Ad-hoc: no task_id, since the whole point of this card is
      // offering a session for something that was never scheduled as a
      // task in the first place (per the feature spec).
      await startSession(suggestion.tagId || null, null, null, deviceName);
      window.dispatchEvent(new Event("fd-session-started-elsewhere"));
      onSessionStarted?.();
    } catch (err) {
      setError(err.message || "Could not start a session.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="fd-panel fd-suggestion-card">
      <div className="fd-suggestion-card__eyebrow">Suggestion</div>
      <div className="fd-suggestion-card__reason">{suggestion.reason}</div>
      {error && <div className="fd-inline-error">{error}</div>}
      <div className="fd-suggestion-card__actions">
        <button
          type="button"
          className="fd-suggestion-card__start"
          onClick={handleStart}
          disabled={starting || hasRunningSession}
          title={hasRunningSession ? "A session is already running" : undefined}
        >
          {starting ? "Starting..." : "Start a session"}
        </button>
        <button type="button" className="fd-link-btn fd-suggestion-card__dismiss" onClick={() => onDismiss?.(suggestion.key)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
