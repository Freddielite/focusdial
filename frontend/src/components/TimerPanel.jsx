import { useEffect, useRef, useState } from "react";
import { getRunningSession, startSession, stopSession, updateSession, updateTask } from "../api.js";
import { formatClock, formatDuration } from "../format.js";
import { showRunningSessionNotification, clearRunningSessionNotification } from "../push.js";
import { matchTagForText, INTERRUPTION_REASONS } from "../analytics.js";
import { useDeviceName } from "../hooks/useDeviceName.js";
import { enqueue } from "../outbox.js";
import Dropdown from "./Dropdown.jsx";

const QUALITY_OPTIONS = [
  { value: "focused", label: "Focused" },
  { value: "neutral", label: "Neutral" },
  { value: "distracted", label: "Distracted" },
];

// Same threshold the backend's cron runaway check uses (routes/cron.js)
// - kept as two separate constants rather than shared, since one lives
// in a browser bundle and the other in a Node process with no shared
// module between them.
const RUNAWAY_THRESHOLD_SECONDS = 4 * 60 * 60;

// How long the tab needs to have been hidden/backgrounded before coming
// back is treated as "away," not just a quick app-switch or screen
// check. Below this, the away-time prompt would just be noise.
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

export default function TimerPanel({ tags, tasks, hourlyTagSuggestions, tagVocabulary, onSessionCompleted, onDataChanged, onRunningChange }) {
  const [running, setRunning] = useState(null); // the running session row, or null
  const [deviceName] = useDeviceName();

  // Reports the running session (or null) up to App.jsx so totals
  // elsewhere in the app - today's total, the current week's trend bar,
  // the heatmap's today cell, deadline pace - can reflect a session's
  // live elapsed time instead of staying frozen until it's stopped.
  // TimerPanel's own second-by-second `elapsed` display below is
  // unaffected either way - this is purely for everything *outside*
  // this panel.
  //
  // Deliberately NOT a useEffect watching `running` - this panel fully
  // unmounts/remounts every time the Today tab is switched away from
  // and back to (see App.jsx, activeTab === "today" && <TodayView .../>),
  // which resets `running` to its useState(null) initial value before
  // refreshRunning()'s async check below has had a chance to confirm
  // whether anything's actually running. A watching effect would report
  // that guess immediately, so switching back to Today while a session
  // was running would visibly dip today's total back to its pre-timer
  // value for a beat before correcting - confirmed this exact flash
  // happens before adding the guard below. Instead, only report at the
  // handful of points where `running` is being set to a value we're
  // actually sure of (a server response, a completed start/stop) - see
  // reportRunning below, used in place of setRunning at each of those.
  function reportRunning(value) {
    setRunning(value);
    onRunningChange?.(value);
  }
  const [selectedTag, setSelectedTag] = useState("");
  const [userPickedTag, setUserPickedTag] = useState(false);
  const [quickStartText, setQuickStartText] = useState("");

  // Live-matches typed text against buildTagVocabulary's learned
  // per-tag words (see analytics.js) and pre-selects the tag on a
  // confident match - same "quietly pre-select, don't force it" spirit
  // as the hourly-suggestion effect further down, and deliberately
  // gated the same way: a manual dropdown pick (userPickedTag) always
  // wins and further typing won't override it. On no confident match,
  // this does nothing at all - selectedTag is left exactly as it was,
  // so the person picks manually from the dropdown below rather than
  // getting a guessed fallback.
  function handleQuickStartChange(e) {
    const text = e.target.value;
    setQuickStartText(text);
    if (userPickedTag) return;
    const matchedTagId = matchTagForText(text, tagVocabulary);
    if (matchedTagId) setSelectedTag(matchedTagId);
  }

  const [selectedTask, setSelectedTask] = useState("");
  // Defaults on whenever a task is linked -- most people linking a
  // session to a specific task are doing that task right now, so "yes,
  // mark it done" is the more common outcome than not; unchecking is
  // one click if that's wrong this time.
  const [markTaskDone, setMarkTaskDone] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The running session returned by a 409 from POST /sessions/start --
  // i.e. another device (or another tab) already has a timer going.
  // Kept separate from `error` since it renders as its own warning
  // banner with actions (switch to it / dismiss), not a plain inline
  // error string -- see the backlog item this addresses: warn instead
  // of just failing silently or unhelpfully.
  const [conflict, setConflict] = useState(null);
  // What actually got done, captured while the timer is running rather
  // than after the fact - the backlog's ask was "captured when a session
  // is stopped," and having the field visible the whole time (instead of
  // only appearing in a post-stop prompt) means it can be jotted down
  // mid-session too, not just recalled after.
  const [note, setNote] = useState("");
  // Separate from the tag (topic) - a quick self-rating of how the
  // session actually went, captured the same way as the note: inline
  // while running, not a separate post-stop step.
  const [quality, setQuality] = useState(null);
  // { awayMs, reason } while the "you were away" prompt is showing, else
  // null. `reason`, once set, just drives the selected-chip highlight
  // below (see handleInterruptionReason) - the actual log entry is
  // already in `interruptions` by the time it's set.
  const [awayPrompt, setAwayPrompt] = useState(null);
  // Accumulated locally over the running session's lifetime (reset on
  // Start, read once at Stop) rather than sent to the server one at a
  // time as they happen - see db.js's `sessions.interruptions` column
  // comment for why a single batched write at the end is enough for
  // what this is (an ambient, best-effort log, not something anything
  // needs to react to in real time).
  const [interruptions, setInterruptions] = useState([]);
  // Whether the "change tag" control is expanded while a session is
  // running. Separate from selectedTag, which is what pre-selects the
  // *next* session's tag -- reusing that same dropdown for the running
  // session's tag would conflate two different things (what to start
  // next vs. what's running right now), so this gets its own small
  // inline control instead.
  const [retagging, setRetagging] = useState(false);
  const [retagBusy, setRetagBusy] = useState(false);
  const tickRef = useRef(null);
  const hiddenAtRef = useRef(null);

  // Pre-selects whatever tag you most often work on at this hour of day
  // - but only if you haven't already picked one yourself, and only
  // while nothing is running (so it doesn't override an in-progress
  // session recovered from the backend). The more assertive "start now?"
  // version of this used to live here too (its own nudge card, with a
  // Start button and its own dismiss state); it's been folded into
  // SuggestionCard/computeUnscheduledSuggestion instead, so there's one
  // "good time to start X" prompt in the app, not two independently
  // built ones that could both fire at once (see HANDOVER). This effect
  // now only ever does the quiet pre-select, never the assertive nudge.
  useEffect(() => {
    if (userPickedTag || running) return;
    const suggestion = hourlyTagSuggestions?.[new Date().getHours()];
    if (suggestion && tags.some((t) => t.id === suggestion.tagId)) {
      setSelectedTag(suggestion.tagId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourlyTagSuggestions, tags]);

  const suggestion = hourlyTagSuggestions?.[new Date().getHours()];
  const suggestedTagId =
    !userPickedTag && suggestion && tags.some((t) => t.id === suggestion.tagId) ? suggestion.tagId : null;

  const openTasks = (tasks || []).filter((t) => t.status === "open");
  // Looked up fresh on every render (not stored) so a title edited or a
  // task deleted elsewhere while this timer is running is still shown
  // correctly rather than a stale snapshot from whenever it was linked.
  const linkedTask = running?.task_id ? tasks?.find((t) => t.id === running.task_id) : null;

  // On load, check whether a session is already running (e.g. the page
  // was refreshed mid-session) so the timer picks back up rather than
  // silently losing track of it - see the comment on GET /sessions/running
  // in the backend for why this is persisted server-side at all.
  function refreshRunning() {
    return getRunningSession()
      .then((s) => {
        // Whether this call is discovering a session this component
        // didn't already know about - a fresh mount recovering state
        // after being backgrounded/reloaded, or a remote switch to a
        // different session entirely - as opposed to the routine 60s
        // poll or a visibility-change re-check on a session it's had
        // running the whole time. Only the former should restore
        // note/quality below; on the latter, this device's own in-memory
        // values (including anything typed in the last 800ms that
        // hasn't been PATCHed yet - see the debounced-note effect) are
        // newer than whatever the server has and shouldn't be clobbered
        // by re-applying them on every routine poll.
        const isNewSession = !running || running.id !== s?.id;
        reportRunning(s || null);
        if (s) {
          setSelectedTag(s.tag_id || "");
          setSelectedTask(s.task_id || "");
          // Note and quality are captured while the session is running
          // (see the debounced-note and quality-click effects below,
          // which PATCH them to the server as they're set) specifically
          // so they survive this refetch - without this, a remount
          // triggered by the tab being backgrounded/reloaded (very
          // common on mobile: the OS suspends or kills a background
          // PWA's JS context) would reset both fields to their useState
          // defaults even though the person had already filled them in,
          // since neither one otherwise has anywhere to come back from.
          if (isNewSession) {
            setNote(s.note || "");
            setQuality(s.quality || null);
          }
          showRunningSessionNotification(s);
          // Whatever's actually running now (this poll is the source of
          // truth) supersedes any stale conflict banner from an earlier
          // failed start attempt -- the timer display below takes over
          // that job instead.
          setConflict(null);
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

  // Light periodic re-check on top of the load/visibility/service-worker
  // triggers above -- those only catch a remote change when *this* tab
  // gets backgrounded and refocused, or when this tab itself tries to
  // start/stop something. A tab left open and focused the whole time
  // (the exact case where someone might not think to check another
  // device) would otherwise never learn a session was started or
  // stopped elsewhere until something else happened to trigger a
  // refresh. One GET every minute is cheap and keeps both this tab's
  // timer and the conflict banner below honest without needing a
  // websocket for something this infrequent.
  useEffect(() => {
    const interval = setInterval(refreshRunning, 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two unrelated jobs share this listener since they're both keyed off
  // the same event: (1) idle/away detection - record when the tab went
  // hidden while a session was running, and if it's been long enough by
  // the time it's visible again, offer to trim the away time out of the
  // session; (2) catching a session stopped remotely (the running-session
  // notification's Stop action, tapped while this tab was backgrounded)
  // - re-checking on every return to foreground means the UI doesn't
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
  // action - same refresh as the visibility-change case above, but for
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

  // Same idea as the service-worker message above, but for a session
  // started from elsewhere in the same tab rather than stopped from a
  // different one - the priority engine's "Do This Next" and Suggestion
  // cards (PriorityCard.jsx, SuggestionCard.jsx) call startSession()
  // directly rather than going through this component, so without this
  // listener this panel wouldn't know a session had started until its
  // next scheduled refreshRunning() (every 60s, or on the next
  // visibility change) - the timer would look like it hadn't reacted to
  // the tap at all for up to a minute.
  useEffect(() => {
    window.addEventListener("fd-session-started-elsewhere", refreshRunning);
    return () => window.removeEventListener("fd-session-started-elsewhere", refreshRunning);
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

  // Ticks the "started X ago" text in the multi-device conflict banner
  // below while it's showing -- without this, that elapsed time was
  // computed once from Date.now() at render and then frozen for as long
  // as the banner stayed open, unlike every other live-elapsed display
  // in this app. A separate 1s interval from the running-timer one
  // above rather than reusing it, since this needs to tick specifically
  // while `conflict` is set and `running` is not -- the two states are
  // mutually exclusive (see the render guard below).
  const [conflictNowMs, setConflictNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!conflict) return undefined;
    setConflictNowMs(Date.now());
    const id = setInterval(() => setConflictNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [conflict]);

  // Persists the in-progress note to the server so it survives a remount
  // (see refreshRunning's restore above) instead of only being written
  // once, at Stop. Debounced rather than firing on every keystroke -
  // note is free text, so a PATCH per character would be wasteful and
  // could easily out-of-order themselves on a slow connection. 800ms
  // is long enough to not fire mid-word for normal typing speed, short
  // enough that backgrounding the app moments after typing still has a
  // saved copy to come back to. Skipped while nothing's really running
  // yet (id == null, the optimistic placeholder from handleStart) since
  // there's no session id to PATCH until the server confirms.
  useEffect(() => {
    if (!running || running.id == null) return undefined;
    const timeout = setTimeout(() => {
      updateSession(running.id, { note: note.trim() || null }).catch(() => {});
    }, 800);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, running?.id]);

  // Same reasoning as the note effect above, but quality only changes on
  // a button click (never continuous typing), so it's saved immediately
  // rather than debounced.
  useEffect(() => {
    if (!running || running.id == null) return undefined;
    updateSession(running.id, { quality }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality, running?.id]);

  async function handleStart(tagIdOverride) {
    setBusy(true);
    setError(null);
    setConflict(null);
    setAwayPrompt(null);
    setInterruptions([]);
    const tagToUse = tagIdOverride !== undefined ? tagIdOverride : selectedTag || null;
    const initialNote = quickStartText.trim() || null;
    // Shows the timer running from the instant of this click rather than
    // waiting on the round trip - meaningful given how long that trip
    // can be against a cold-started backend (up to 45s, see api.js's
    // REQUEST_TIMEOUT_MS/"waking up" banner). `id: null` is how the rest
    // of this component tells this apart from a real running session
    // (see the "Change tag" guard and handleRetag/handleStop below) -
    // there's nothing to PATCH or stop yet. Deliberately NOT passed to
    // showRunningSessionNotification below - that needs a real id to
    // build a working "Stop" action, so the OS notification still only
    // appears once the server actually confirms.
    const optimistic = {
      id: null,
      tag_id: tagToUse,
      task_id: selectedTask || null,
      started_at: new Date().toISOString(),
      note: initialNote,
      source: "timer",
    };
    reportRunning(optimistic);
    try {
      const s = await startSession(tagToUse, initialNote, selectedTask || null, deviceName);
      setSelectedTag(tagToUse || "");
      setUserPickedTag(true);
      // Whatever was typed into quick-start already saved as the
      // session's note above - also seeds the stop-time note field
      // (below, in handleStop) so if the person adds more detail when
      // they stop, it's an edit to what they already said, not a blank
      // field that silently drops it.
      setNote(quickStartText.trim());
      setQuickStartText("");
      reportRunning(s);
      showRunningSessionNotification(s);
    } catch (err) {
      if (err instanceof TypeError) {
        // Genuinely offline, not a real rejection from the server - the
        // optimistic session above is all there is for now (no id to
        // PATCH/stop yet), so keep it running locally rather than
        // rolling it back. `offlineStarted` tells handleStop to queue
        // the whole thing as one finished session once it's stopped,
        // instead of trying to PATCH a session the backend has never
        // heard of - see handleStop below.
        setSelectedTag(tagToUse || "");
        setUserPickedTag(true);
        setNote(quickStartText.trim());
        setQuickStartText("");
        reportRunning({ ...optimistic, offlineStarted: true });
        setBusy(false);
        return;
      }
      // Nothing actually started (or, for a 409, something already was
      // running elsewhere and the optimistic guess above was simply
      // wrong) - roll it back rather than leave the UI claiming a
      // session is running that the server never created.
      reportRunning(null);
      // A 409 here means this device's own view was stale: it thought
      // nothing was running, but another device (or another tab) already
      // has a session going -- started after this device last checked,
      // or started here before this refresh landed. Showing the actual
      // running session (what it's tagged, when it started) instead of
      // a generic error string is the point -- see the backend's
      // fetchRunningSessionRow, which is what puts `err.body.running`
      // here.
      if (err.status === 409 && err.body?.running) {
        setConflict(err.body.running);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  // "Switch to it" on the conflict banner -- rather than re-fetching,
  // just adopt the session object the 409 already handed us: same data
  // GET /sessions/running would return, one fewer round trip, and it
  // also sets up the tag/task dropdowns and notification exactly like
  // refreshRunning() does on load.
  function handleAdoptConflict() {
    if (!conflict) return;
    reportRunning(conflict);
    setSelectedTag(conflict.tag_id || "");
    setSelectedTask(conflict.task_id || "");
    showRunningSessionNotification(conflict);
    setConflict(null);
  }

  // Changes the tag of the session that's already running, without
  // stopping it -- a plain PATCH (the same endpoint the session-edit
  // form already uses), so the elapsed time so far stays intact instead
  // of being lost to a stop-and-restart. Useful on its own, and it's
  // also what a Deadline card's "Switch running timer to X" action
  // relies on when it's the one initiating the change instead.
  async function handleRetag(newTagId) {
    if (!running || running.id == null) return;
    setRetagBusy(true);
    setError(null);
    try {
      const updated = await updateSession(running.id, { tag_id: newTagId || null });
      reportRunning(updated);
      setSelectedTag(newTagId || "");
      setRetagging(false);
      showRunningSessionNotification(updated);
      onDataChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setRetagBusy(false);
    }
  }

  async function handleStop() {
    if (!running) return;
    // id == null and not offlineStarted means the original Start call
    // is still in flight (waiting on a possibly-slow/cold-starting
    // backend) - nothing to stop yet either way, same guard as before.
    if (running.id == null && !running.offlineStarted) return;
    setBusy(true);
    setError(null);
    const endedAtIso = new Date().toISOString();
    try {
      let completed;
      if (running.offlineStarted) {
        // Never reached the backend at all - nothing to PATCH/stop
        // server-side, so the whole session (start through stop) is
        // queued as a single manual-session create instead of a
        // start/stop pair. See queueableFetch's own comment for why a
        // plain create like this doesn't need any id-chaining to sync
        // correctly later.
        completed = {
          tag_id: running.tag_id,
          task_id: running.task_id,
          started_at: running.started_at,
          ended_at: endedAtIso,
          note: note.trim() || null,
          quality,
          interruptions,
        };
        await enqueue({
          kind: "session",
          op: "action",
          httpMethod: "POST",
          path: "/sessions",
          body: JSON.stringify(completed),
          resourceId: null,
          tempId: null,
          patch: null,
        });
      } else {
        try {
          completed = await stopSession(running.id, note.trim() || null, quality, interruptions);
        } catch (err) {
          if (!(err instanceof TypeError)) throw err;
          // Started online (this session has a real id) but the
          // connection dropped before Stop could reach the backend -
          // queue the real stop call, and build the same completed
          // shape locally so today's total/streak/etc. reflect it right
          // away instead of waiting on sync.
          completed = { ...running, ended_at: endedAtIso, note: note.trim() || null, quality, interruptions };
          await enqueue({
            kind: "session",
            op: "action",
            httpMethod: "POST",
            path: `/sessions/${running.id}/stop`,
            body: JSON.stringify({ note: note.trim() || null, quality, interruptions }),
            resourceId: running.id,
            tempId: null,
            patch: null,
          });
        }
      }
      // Closes the loop the other direction from a Deadline's "add as
      // task" -- finishing work linked to a Task can now mark it done
      // right from the stop action, instead of that being a second,
      // easy-to-forget trip to the Tasks list. Queued the same as any
      // other task edit (see api.js) if this is also offline.
      if (running.task_id && markTaskDone) {
        await updateTask(running.task_id, { status: "done" }).catch(() => {});
        onDataChanged?.();
      }
      reportRunning(null);
      setElapsed(0);
      setNote("");
      setQuality(null);
      setSelectedTask("");
      setMarkTaskDone(true);
      setRetagging(false);
      setInterruptions([]);
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
      setRunning((r) => {
        const next = r ? { ...r, started_at: newStart } : r;
        onRunningChange?.(next);
        return next;
      });
    } catch (err) {
      setError(err.message);
    }
  }

  // Optional, separate from the Keep it/Trim decision above - tapping a
  // reason just logs it (feeds the Interruptions insights card once the
  // session is stopped) and highlights the selected chip; it doesn't by
  // itself resolve the away-prompt, which still needs Keep it or Trim.
  function handleInterruptionReason(reason) {
    setAwayPrompt((p) => (p ? { ...p, reason } : p));
    setInterruptions((prev) => [
      ...prev,
      { reason, away_seconds: Math.round(awayPrompt.awayMs / 1000), at: new Date().toISOString() },
    ]);
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
          <div className="fd-timer-away-prompt__reasons">
            <span className="fd-timer-away-prompt__reasons-label">What kept you away? (optional)</span>
            <div className="fd-chip-row">
              {INTERRUPTION_REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  className={`fd-chip ${awayPrompt.reason === r.value ? "fd-chip--active" : ""}`}
                  onClick={() => handleInterruptionReason(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {conflict && !running && (
        <div className="fd-timer-conflict">
          <span className="fd-timer-conflict__text">
            Already running on {conflict.device_name ? <strong>{conflict.device_name}</strong> : "another device"}:{" "}
            <strong>{conflict.tag_name || "No tag"}</strong>, started{" "}
            {formatDuration((conflictNowMs - new Date(conflict.started_at).getTime()) / 1000)} ago.
          </span>
          <div className="fd-timer-conflict__actions">
            <button type="button" className="fd-link-btn" onClick={handleAdoptConflict}>
              Switch to it here
            </button>
            <button type="button" className="fd-icon-btn" onClick={() => setConflict(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        </div>
      )}
      {!running && (
        <input
          type="text"
          className="fd-quick-start-input"
          placeholder="What are you working on?"
          value={quickStartText}
          onChange={handleQuickStartChange}
        />
      )}
      {running ? (
        <div className="fd-timer-tag-live">
          <span className="fd-timer-tag-live__label">
            Tracking: <strong>{tags.find((t) => t.id === running.tag_id)?.name || "No tag"}</strong>
          </span>
          {running.id != null && (
            <button
              type="button"
              className="fd-link-btn"
              onClick={() => setRetagging((v) => !v)}
              disabled={retagBusy}
            >
              {retagging ? "Cancel" : "Change tag"}
            </button>
          )}
        </div>
      ) : (
        <Dropdown
          className="fd-select"
          value={selectedTag}
          onChange={(e) => {
            setSelectedTag(e.target.value);
            setUserPickedTag(true);
          }}
        >
          <option value="">No tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Dropdown>
      )}
      {running && retagging && (
        <Dropdown
          className="fd-select"
          value={running.tag_id || ""}
          onChange={(e) => handleRetag(e.target.value)}
          disabled={retagBusy}
        >
          <option value="">No tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Dropdown>
      )}
      {suggestedTagId && !running && (
        <div className="fd-timer-suggestion">
          Suggested based on what you usually work on now
        </div>
      )}
      {!running && openTasks.length > 0 && (
        <Dropdown className="fd-select" value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)}>
          <option value="">No linked task</option>
          {openTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </Dropdown>
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
      {running && interruptions.length > 0 && !awayPrompt && (
        <div className="fd-timer-interruption-note">
          {interruptions.length} interruption{interruptions.length === 1 ? "" : "s"} logged this session.
        </div>
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
      {running && linkedTask && (
        <label className="fd-checkbox-row fd-timer-task-done">
          <input type="checkbox" checked={markTaskDone} onChange={(e) => setMarkTaskDone(e.target.checked)} />
          Mark "{linkedTask.title}" done when I stop
        </label>
      )}
      {running && elapsed > RUNAWAY_THRESHOLD_SECONDS && (
        <div className="fd-timer-runaway-warning">
          This has been running for {Math.floor(elapsed / 3600)}h+. Still going, or did you forget to
          stop it?
        </div>
      )}
      <button
        className={`fd-btn ${running ? "fd-btn--stop" : "fd-btn--start"}`}
        onClick={() => (running ? handleStop() : handleStart())}
        disabled={busy}
      >
        {running ? "Stop" : "Start Session"}
      </button>
      {error && <div className="fd-inline-error">{error}</div>}
    </div>
  );
}
