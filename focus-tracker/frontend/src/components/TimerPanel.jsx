import { useEffect, useRef, useState } from "react";
import { getRunningSession, startSession, stopSession, updateSession } from "../api.js";
import { formatClock, formatDuration } from "../format.js";
import { showRunningSessionNotification, clearRunningSessionNotification } from "../push.js";
import Dropdown from "./Dropdown.jsx";

const QUALITY_OPTIONS = [
  { value: "focused", label: "Focused" },
  { value: "neutral", label: "Neutral" },
  { value: "distracted", label: "Distracted" },
];

// Same threshold the backend's cron runaway check uses (routes/cron.js)
// — kept as two separate constants rather than shared, since one lives
// in a browser bundle and the other in a Node process with no shared
// module between them.
const RUNAWAY_THRESHOLD_SECONDS = 4 * 60 * 60;

// How long the tab needs to have been hidden/backgrounded before coming
// back is treated as "away," not just a quick app-switch or screen
// check. Below this, the away-time prompt would just be noise.
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

export default function TimerPanel({ tags, hourlyTagSuggestions, onSessionCompleted }) {
  const [running, setRunning] = useState(null); // the running session row, or null
  const [selectedTag, setSelectedTag] = useState("");
  const [userPickedTag, setUserPickedTag] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // What actually got done, captured while the timer is running rather
  // than after the fact — the backlog's ask was "captured when a session
  // is stopped," and having the field visible the whole time (instead of
  // only appearing in a post-stop prompt) means it can be jotted down
  // mid-session too, not just recalled after.
  const [note, setNote] = useState("");
  // Separate from the tag (topic) — a quick self-rating of how the
  // session actually went, captured the same way as the note: inline
  // while running, not a separate post-stop step.
  const [quality, setQuality] = useState(null);
  // { awayMs } while the "you were away" prompt is showing, else null.
  const [awayPrompt, setAwayPrompt] = useState(null);
  const tickRef = useRef(null);
  const hiddenAtRef = useRef(null);

  // Pre-selects whatever tag you most often work on at this hour of day
  // — but only if you haven't already picked one yourself, and only
  // while nothing is running (so it doesn't override an in-progress
  // session recovered from the backend).
  useEffect(() => {
    if (userPickedTag || running) return;
    const suggestion = hourlyTagSuggestions?.[new Date().getHours()];
    if (suggestion && tags.some((t) => t.id === suggestion.tagId)) {
      setSelectedTag(suggestion.tagId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourlyTagSuggestions, tags]);

  const suggestedTagId = !userPickedTag ? hourlyTagSuggestions?.[new Date().getHours()]?.tagId : null;

  // On load, check whether a session is already running (e.g. the page
  // was refreshed mid-session) so the timer picks back up rather than
  // silently losing track of it — see the comment on GET /sessions/running
  // in the backend for why this is persisted server-side at all.
  function refreshRunning() {
    return getRunningSession()
      .then((s) => {
        setRunning(s || null);
        if (s) {
          setSelectedTag(s.tag_id || "");
          showRunningSessionNotification(s);
        } else {
          clearRunningSessionNotification();
        }
      })
      .catch(() => {});
  }

  useEffect(() => {
    refreshRunning();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two unrelated jobs share this listener since they're both keyed off
  // the same event: (1) idle/away detection — record when the tab went
  // hidden while a session was running, and if it's been long enough by
  // the time it's visible again, offer to trim the away time out of the
  // session; (2) catching a session stopped remotely (the running-session
  // notification's Stop action, tapped while this tab was backgrounded)
  // — re-checking on every return to foreground means the UI doesn't
  // keep showing a timer that's actually already stopped.
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden) {
        if (running) hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      refreshRunning();
      if (hiddenAt && running) {
        const awayMs = Date.now() - hiddenAt;
        if (awayMs > IDLE_THRESHOLD_MS) setAwayPrompt({ awayMs });
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // The service worker posts this after handling the notification's Stop
  // action — same refresh as the visibility-change case above, but for
  // when the tab is actually visible/foregrounded when it happens (rare,
  // but possible on a device with the app open in one window and the
  // notification tapped from another).
  useEffect(() => {
    function handleMessage(event) {
      if (event.data?.type === "session-stopped-remotely") refreshRunning();
    }
    navigator.serviceWorker?.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) {
      clearInterval(tickRef.current);
      return undefined;
    }
    const update = () => {
      setElapsed((Date.now() - new Date(running.started_at).getTime()) / 1000);
    };
    update();
    tickRef.current = setInterval(update, 1000);
    return () => clearInterval(tickRef.current);
  }, [running]);

  async function handleStart() {
    setBusy(true);
    setError(null);
    setAwayPrompt(null);
    try {
      const s = await startSession(selectedTag || null, null);
      setRunning(s);
      showRunningSessionNotification(s);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (!running) return;
    setBusy(true);
    setError(null);
    try {
      const completed = await stopSession(running.id, note.trim() || null, quality);
      setRunning(null);
      setElapsed(0);
      setNote("");
      setQuality(null);
      clearRunningSessionNotification();
      onSessionCompleted(completed);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleTrimAway() {
    if (!running || !awayPrompt) return;
    const newStart = new Date(new Date(running.started_at).getTime() + awayPrompt.awayMs).toISOString();
    setAwayPrompt(null);
    try {
      await updateSession(running.id, { started_at: newStart });
      setRunning((r) => (r ? { ...r, started_at: newStart } : r));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="fd-panel fd-timer-panel">
      <div className="fd-panel__label">Timer</div>
      <div className={`fd-timer-display ${running ? "fd-timer-display--running" : ""}`}>
        {formatClock(elapsed)}
      </div>
      {awayPrompt && (
        <div className="fd-timer-away-prompt">
          <span>You were away for {formatDuration(awayPrompt.awayMs / 1000)}. Keep it in this session?</span>
          <div className="fd-timer-away-prompt__actions">
            <button type="button" className="fd-link-btn" onClick={() => setAwayPrompt(null)}>
              Keep it
            </button>
            <button type="button" className="fd-link-btn" onClick={handleTrimAway}>
              Trim {formatDuration(awayPrompt.awayMs / 1000)}
            </button>
          </div>
        </div>
      )}
      <Dropdown
        className="fd-select"
        value={selectedTag}
        onChange={(e) => {
          setSelectedTag(e.target.value);
          setUserPickedTag(true);
        }}
        disabled={!!running}
      >
        <option value="">No tag</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Dropdown>
      {suggestedTagId && !running && (
        <div className="fd-timer-suggestion">
          Suggested based on what you usually work on now
        </div>
      )}
      {running && (
        <input
          className="fd-timer-note"
          type="text"
          placeholder="What are you working on? (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
        />
      )}
      {running && (
        <div className="fd-timer-quality">
          {QUALITY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`fd-timer-quality__btn fd-timer-quality__btn--${o.value} ${
                quality === o.value ? "fd-timer-quality__btn--active" : ""
              }`}
              onClick={() => setQuality((q) => (q === o.value ? null : o.value))}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {running && elapsed > RUNAWAY_THRESHOLD_SECONDS && (
        <div className="fd-timer-runaway-warning">
          This has been running for {Math.floor(elapsed / 3600)}h+. Still going, or did you forget to
          stop it?
        </div>
      )}
      <button
        className={`fd-btn ${running ? "fd-btn--stop" : "fd-btn--start"}`}
        onClick={running ? handleStop : handleStart}
        disabled={busy}
      >
        {running ? "Stop" : "Start Session"}
      </button>
      {error && <div className="fd-inline-error">{error}</div>}
    </div>
  );
}
