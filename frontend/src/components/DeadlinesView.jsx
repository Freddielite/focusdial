import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  createDeadline,
  deleteDeadline,
  updateDeadline,
  logDeadlineProgress,
  getRunningSession,
  startSession,
  updateSession,
} from "../api.js";
import { formatDuration, formatCountdown } from "../format.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";
import Dropdown from "./Dropdown.jsx";
import { DatePicker, TimePicker } from "./DateTimeField.jsx";

// How often to re-check whether a timer is running, while this tab is
// open. Independent of TimerPanel's own state (which lives on the Today
// tab and may not even be mounted right now) -- this is what lets a
// deadline's hours tick up live from here without needing that panel on
// screen at the same time.
const RUNNING_POLL_MS = 15000;

// Live countdown + "is a matching session running right now" ticker,
// shared by every card in the list rather than one interval per card.
function useLiveNow() {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

function useRunningSession() {
  const [running, setRunning] = useState(null);
  const pollRef = useRef(null);
  const refresh = useRef(() => {});
  useEffect(() => {
    refresh.current = () => {
      getRunningSession()
        .then((s) => setRunning(s || null))
        .catch(() => {});
    };
    refresh.current();
    pollRef.current = setInterval(refresh.current, RUNNING_POLL_MS);
    document.addEventListener("visibilitychange", refresh.current);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", refresh.current);
    };
  }, []);
  // Exposing this lets a card that just started a session (see
  // handleStartOnTag below) update the running-session indicator/live
  // hours right away, instead of waiting up to RUNNING_POLL_MS for the
  // next scheduled poll to notice.
  return [running, () => refresh.current()];
}

// Displays a decimal-hours number the same "Xh Ym" way session durations
// already are elsewhere in the app (formatDuration works in seconds),
// instead of a raw decimal like "0.3h" -- matters a lot more now that a
// deadline's estimate/pace can be a small fraction of an hour.
function formatHours(hours) {
  return formatDuration(Math.max(0, hours) * 3600);
}

// Live feasibility read shown while *creating* a deadline, before it's
// even saved -- otherwise you only find out a deadline is unrealistic
// after committing to it. Mirrors the same math/thresholds as
// analytics.js's computeDeadlineProgress (kept as its own small copy
// here rather than imported, since this runs against in-progress form
// state -- strings that might not be valid dates yet -- not a saved
// deadline row).
function previewDeadlineStatus({ dueDate, dueTime, estHours, avgHours }) {
  if (!dueDate || !estHours || Number(estHours) <= 0) return null;
  const dueDatePart = dueDate.slice(0, 10);
  const startOfDue = new Date(`${dueDatePart}T00:00:00`);
  if (isNaN(startOfDue.getTime())) return null;
  const dueAt = dueTime
    ? new Date(`${dueDatePart}T${dueTime}`)
    : new Date(startOfDue.getTime() + 24 * 60 * 60 * 1000 - 1);

  const hoursLeft = (dueAt.getTime() - Date.now()) / 3_600_000;
  const remainingHours = Number(estHours);

  if (hoursLeft <= 0) {
    return { tone: "rust", label: "Already overdue", text: "That due date/time has already passed." };
  }
  if (hoursLeft < 24) {
    const fits = remainingHours <= hoursLeft;
    return {
      tone: fits ? "brass" : "rust",
      label: fits ? "Cutting it close" : "Not enough time",
      text: `Needs ${formatHours(remainingHours)}, with only ${formatHours(hoursLeft)} available.`,
    };
  }
  if (avgHours <= 0) {
    return { tone: "dim", label: "Not enough history yet", text: "Log a few more sessions to get a pace read." };
  }
  const daysLeft = hoursLeft / 24;
  const pacePerDay = remainingHours / daysLeft;
  const ratio = pacePerDay / avgHours;
  let tone, label;
  if (ratio <= 0.7) {
    tone = "focus-green";
    label = "Ahead of pace";
  } else if (ratio <= 1.05) {
    tone = "brass";
    label = "On track";
  } else if (ratio <= 1.5) {
    tone = "brass";
    label = "Tight";
  } else {
    tone = "rust";
    label = "Behind pace";
  }
  return { tone, label, text: `Would need ${formatHours(pacePerDay)}/day (you average ${formatHours(avgHours)}/day).` };
}

// Lets estimated/logged time be entered as separate Hours + Minutes
// fields instead of one decimal number -- typing "0.25" for a
// 15-minute task, or being blocked by a 30-minute step/minimum, isn't a
// natural way to set a short deadline. Still reads/writes a single
// decimal-hours number underneath, so nothing downstream (the DB
// column, the pace math) needs to change.
function HoursMinutesInput({ value, onChange }) {
  const totalMinutes = Math.round((Number(value) || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;

  function commit(newH, newM) {
    const clampedH = Math.max(0, newH);
    const clampedM = Math.max(0, Math.min(59, newM));
    onChange(clampedH + clampedM / 60);
  }

  return (
    <div className="fd-hm-input">
      <input
        type="number"
        min="0"
        step="1"
        value={h}
        onChange={(e) => commit(Number(e.target.value) || 0, m)}
        aria-label="Hours"
      />
      <span className="fd-hm-input__unit">h</span>
      <input
        type="number"
        min="0"
        max="59"
        step="5"
        value={m}
        onChange={(e) => commit(h, Number(e.target.value) || 0)}
        aria-label="Minutes"
      />
      <span className="fd-hm-input__unit">m</span>
    </div>
  );
}

// Live ticking dd:hh:mm:ss to the deadline's exact due moment (see
// dueAt in analytics.js), independent of the day-granularity "daysLeft"
// used for the pace/status read elsewhere on the card.
function Countdown({ dueAt, nowMs }) {
  const { overdue, text } = formatCountdown(dueAt, nowMs);
  return (
    <span className={`fd-countdown ${overdue ? "fd-countdown--overdue" : ""}`}>
      {overdue ? `Overdue by ${text}` : `${text} left`}
    </span>
  );
}

// Same flag glyph as the Deadlines tab icon, tinted with the deadline
// category accent so every deadline card reads as one visual family.
function FlagIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v18" />
      <path d="M6 4h11l-2 3 2 3H6" />
    </svg>
  );
}

const STATUS_COPY = {
  done: { label: "Goal met", tone: "focus-green" },
  overdue: { label: "Overdue", tone: "rust" },
  ahead: { label: "Ahead of pace", tone: "focus-green" },
  onTrack: { label: "On track", tone: "brass" },
  tight: { label: "Tight, pick up the pace", tone: "brass" },
  behind: { label: "Behind pace", tone: "rust" },
  unknown: { label: "Not enough history yet", tone: "dim" },
};

function LogProgressInline({ deadline, onLogged }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const hours = Number(value);
    if (!hours || hours <= 0 || busy) return;
    setBusy(true);
    try {
      await logDeadlineProgress(deadline.id, hours);
      setValue("");
      onLogged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="fd-log-progress" onSubmit={submit}>
      <input
        type="number"
        step="0.25"
        min="0.25"
        placeholder="Hours worked"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
      />
      <button type="submit" className="fd-link-btn" disabled={busy}>
        {busy ? "Logging…" : "Log"}
      </button>
    </form>
  );
}

// Inline edit form for a deadline card -- same fields as creation
// (title/tag/due date/time/estimated hours), pre-filled from the
// deadline being edited. Lives inside the card itself (expand/collapse)
// rather than a modal, matching how the create form already expands
// inline above the list.
function DeadlineEditForm({ deadline, tags, onCancel, onSaved }) {
  const [title, setTitle] = useState(deadline.title);
  const [tagId, setTagId] = useState(deadline.tag_id || "");
  const [dueDate, setDueDate] = useState(deadline.due_date?.slice(0, 10) || "");
  const [dueTime, setDueTime] = useState(deadline.due_time || "");
  const [estHours, setEstHours] = useState(Number(deadline.estimated_hours));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!dueDate) {
      setError("Due date is required.");
      return;
    }
    if (!estHours || Number(estHours) <= 0) {
      setError("Estimated time must be more than 0 minutes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateDeadline(deadline.id, {
        title: title.trim(),
        tag_id: tagId || null,
        due_date: dueDate,
        due_time: dueTime || null,
        estimated_hours: Number(estHours),
      });
      onSaved(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.form
      className="fd-manual-form fd-inline-edit-form"
      onSubmit={handleSubmit}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="fd-manual-form__row">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required />
        </label>
      </div>
      <div className="fd-manual-form__row fd-manual-form__row--dates">
        <label>
          Due date
          <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </label>
        <label>
          Due time (optional)
          <TimePicker value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
        </label>
        <label>
          Estimated time needed
          <HoursMinutesInput value={estHours} onChange={setEstHours} />
        </label>
      </div>
      <div className="fd-manual-form__row">
        <label>
          Track via tag (optional)
          <Dropdown className="fd-select" value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">No tag, I'll log progress manually</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Dropdown>
        </label>
      </div>
      {error && <div className="fd-inline-error">{error}</div>}
      <div className="fd-manual-form__actions">
        <button type="button" className="fd-link-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </motion.form>
  );
}

export default function DeadlinesView({ deadlines, tags, avgDailyFocusSeconds, onDataChanged }) {
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [tagId, setTagId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [estHours, setEstHours] = useState(10);
  const [addAsTask, setAddAsTask] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();
  const nowMs = useLiveNow();
  const [runningSession, refreshRunningSession] = useRunningSession();
  const [startingId, setStartingId] = useState(null);
  const [startError, setStartError] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const COMPLETED_PER_PAGE = 5;
  const [completedPage, setCompletedPage] = useState(1);

  const avgHours = avgDailyFocusSeconds / 3600;
  const active = deadlines.filter((d) => d.status !== "done" && d.status !== "archived" && !pendingIds.has(d.id));
  const completed = deadlines
    .filter((d) => d.status === "done")
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const completedTotalPages = Math.max(1, Math.ceil(completed.length / COMPLETED_PER_PAGE));
  // Clamped rather than reset outright -- if the list shrinks (e.g. one
  // of these gets deleted elsewhere) while sitting on a now-out-of-range
  // page, this lands on the new last page instead of an empty one.
  const completedPageClamped = Math.min(completedPage, completedTotalPages);
  const completedPageItems = completed.slice(
    (completedPageClamped - 1) * COMPLETED_PER_PAGE,
    completedPageClamped * COMPLETED_PER_PAGE
  );

  // The whole point of linking a deadline to a tag is that time logged
  // under that tag counts toward it -- so if you're about to work on
  // this deadline specifically, you shouldn't have to go to the Today
  // tab and manually pick the matching tag from a dropdown yourself.
  // This starts a real session with that tag already applied.
  async function handleStartOnTag(d) {
    setStartError(null);
    setStartingId(d.id);
    try {
      await startSession(d.tag_id);
      refreshRunningSession();
      onDataChanged();
    } catch (err) {
      setStartError({ id: d.id, message: err.message || "Could not start a session." });
    } finally {
      setStartingId(null);
    }
  }

  // Covers the case that used to be a dead end: a session is already
  // running on some other tag, so starting a fresh one on this
  // deadline's tag would just 409. Retagging the *existing* session in
  // place (a plain PATCH, same one the session-edit form already uses)
  // is strictly better than stopping and restarting -- it keeps
  // whatever elapsed time has already accumulated, rather than
  // throwing it away.
  async function handleRetagRunningSession(d) {
    if (!runningSession) return;
    setStartError(null);
    setStartingId(d.id);
    try {
      await updateSession(runningSession.id, { tag_id: d.tag_id });
      refreshRunningSession();
      onDataChanged();
    } catch (err) {
      setStartError({ id: d.id, message: err.message || "Could not switch the running timer's tag." });
    } finally {
      setStartingId(null);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!dueDate) {
      setError("Due date is required.");
      return;
    }
    if (!estHours || Number(estHours) <= 0) {
      setError("Estimated time must be more than 0 minutes.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await createDeadline({
        title: title.trim(),
        tag_id: tagId || null,
        due_date: dueDate,
        due_time: dueTime || null,
        estimated_hours: Number(estHours),
        add_as_task: addAsTask,
      });
      setTitle("");
      setDueDate("");
      setDueTime("");
      setAddAsTask(false);
      setFormOpen(false);
      onDataChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkDone(id) {
    await updateDeadline(id, { status: "done" });
    onDataChanged();
  }

  async function handleDelete(deadline) {
    const ok = await confirm({ title: `Delete "${deadline.title}"?` });
    if (!ok) return;

    setPendingIds((prev) => new Set(prev).add(deadline.id));
    requestDelete({
      id: deadline.id,
      label: "Deadline",
      onHide: () => {},
      onRestore: () =>
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(deadline.id);
          return next;
        }),
      deleteFn: () => deleteDeadline(deadline.id),
      afterCommit: onDataChanged,
    });
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fd-view"
    >
      <div className="fd-view__head">
        <div className="fd-panel__label" style={{ marginBottom: 0 }}>
          Deadline Planner
        </div>
        <button className="fd-link-btn" onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? "Cancel" : "+ New Deadline"}
        </button>
      </div>

      <div className="fd-pace-note">
        Your real average: <strong>{formatDuration(avgDailyFocusSeconds)}/day</strong> over the last
        30 days, used below to judge whether each plan is realistic.
      </div>

      <AnimatePresence>
        {formOpen && (
          <motion.form
            className="fd-manual-form"
            onSubmit={handleCreate}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="fd-manual-form__row">
              <label>
                Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required />
              </label>
            </div>
            <div className="fd-manual-form__row fd-manual-form__row--dates">
              <label>
                Due date
                <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
              </label>
              <label>
                Due time (optional)
                <TimePicker value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
              </label>
              <label>
                Estimated time needed
                <HoursMinutesInput value={estHours} onChange={setEstHours} />
              </label>
            </div>
            <div className="fd-manual-form__row">
              <label>
                Track via tag (optional, progress auto-calculated from sessions)
                <Dropdown className="fd-select" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                  <option value="">No tag, I'll log progress manually</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Dropdown>
              </label>
            </div>
            <div className="fd-manual-form__row">
              <label className="fd-checkbox-row">
                <input type="checkbox" checked={addAsTask} onChange={(e) => setAddAsTask(e.target.checked)} />
                Also add to my task list
              </label>
            </div>
            {(() => {
              const preview = previewDeadlineStatus({ dueDate, dueTime, estHours, avgHours });
              return preview ? (
                <div className="fd-deadline-create-preview">
                  <span className={`fd-deadline-card__status fd-deadline-card__status--${preview.tone}`}>
                    {preview.label}
                  </span>
                  <span className="fd-deadline-create-preview__text">{preview.text}</span>
                </div>
              ) : null;
            })()}
            {error && <div className="fd-inline-error">{error}</div>}
            <div className="fd-manual-form__actions">
              <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
                {busy ? "Adding…" : "Add Deadline"}
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {active.length === 0 && (
        <div className="fd-empty">No active deadlines. Add one above to get a daily pace plan.</div>
      )}

      <div className="fd-deadline-list">
        <AnimatePresence initial={false}>
          {active.map((d) => {
            // If a timer is running right now on this deadline's own tag,
            // add the still-in-progress elapsed time on top of the saved
            // completedHours from analytics.js (which only counts sessions
            // that have already been stopped) -- purely a display-time
            // addition, so it doesn't touch the actual data until the
            // session is stopped and saved for real.
            const liveHours =
              d.tag_id && runningSession?.tag_id === d.tag_id
                ? (nowMs - new Date(runningSession.started_at).getTime()) / 3_600_000
                : 0;
            const completedHours = d.completedHours + liveHours;
            const remainingHours = Math.max(0, Number(d.estimated_hours) - completedHours);
            const pct = remainingHours <= 0 ? 1 : Math.min(1, completedHours / Number(d.estimated_hours));
            // Same dueAt the countdown above is ticking against, so this
            // can never show a different "time left" than the countdown
            // does -- previously this recomputed pace from analytics.js's
            // separately-derived (and coarser, whole-day) daysLeft, which
            // is what let the two numbers drift apart and disagree.
            const hoursLeftLive = (d.dueAt.getTime() - nowMs) / 3_600_000;
            const daysLeftLive = hoursLeftLive / 24;
            const pacePerDay = daysLeftLive > 0 ? remainingHours / daysLeftLive : remainingHours;
            // The status pill (Ahead/On Track/Tight/Behind/Overdue) used
            // to come straight from analytics.js's d.status, which is
            // only recomputed the next time the app refetches its data --
            // so the countdown could already be sitting at 00:00:00 while
            // the pill still said "Ahead of pace" for a while after. This
            // recomputes it every second from the same live numbers above
            // (same thresholds as computeDeadlineProgress), so it flips
            // the instant the countdown reaches zero, not some indeterminate
            // time later. A manually-set status (done/archived) still wins.
            let liveStatusKey;
            if (d.status === "done" || d.status === "archived") liveStatusKey = d.status;
            else if (remainingHours <= 0) liveStatusKey = "done";
            else if (hoursLeftLive <= 0) liveStatusKey = "overdue";
            else if (avgHours <= 0) liveStatusKey = "unknown";
            else {
              const ratio = pacePerDay / avgHours;
              if (ratio <= 0.7) liveStatusKey = "ahead";
              else if (ratio <= 1.05) liveStatusKey = "onTrack";
              else if (ratio <= 1.5) liveStatusKey = "tight";
              else liveStatusKey = "behind";
            }
            const status = STATUS_COPY[liveStatusKey] || STATUS_COPY.unknown;
            return (
              <motion.div
                key={d.id}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ duration: 0.25 }}
                className="fd-panel fd-deadline-card fd-check-card--deadline"
              >
                <div className="fd-check-card">
                  <span className="fd-check-card__icon">
                    <FlagIcon />
                  </span>
                  <div className="fd-check-card__body">
                    <span className="fd-check-card__title">{d.title}</span>
                    <span className="fd-check-card__meta">
                      ★ <Countdown dueAt={d.dueAt} nowMs={nowMs} />
                      {liveHours > 0 && <span className="fd-countdown__live-dot" title="Timer running on this tag" />}
                    </span>
                  </div>
                  <div className="fd-check-card__value">
                    <span className="fd-check-card__value-num">{formatHours(completedHours)}</span>
                    <span className="fd-check-card__value-unit">of {formatHours(Number(d.estimated_hours))}</span>
                  </div>
                  <div className="fd-deadline-card__actions">
                    <button
                      className="fd-icon-btn"
                      onClick={() => setEditingId((id) => (id === d.id ? null : d.id))}
                      aria-label="Edit deadline"
                    >
                      ✎
                    </button>
                    <button className="fd-icon-btn" onClick={() => handleMarkDone(d.id)} aria-label="Mark done">
                      ✓
                    </button>
                    <button className="fd-icon-btn" onClick={() => handleDelete(d)} aria-label="Delete">
                      ✕
                    </button>
                  </div>
                </div>

                <div className="fd-tag-row__bar-track">
                  <motion.div
                    className="fd-tag-row__bar"
                    style={{ background: "var(--accent-deadline)" }}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct * 100}%` }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                </div>

                {remainingHours > 0 && (
                  <div className="fd-deadline-card__pace">
                    {hoursLeftLive > 0 ? (
                      hoursLeftLive < 24 ? (
                        <>
                          Need <strong>{formatHours(remainingHours)}</strong> of work, with only{" "}
                          <strong>{formatHours(hoursLeftLive)}</strong> left before it's due.
                        </>
                      ) : (
                        <>
                          Need <strong>{formatHours(pacePerDay)}/day</strong> ({formatHours(remainingHours)}{" "}
                          total) to finish in time
                          {avgHours > 0 && ` (you average ${formatHours(avgHours)}/day)`}.
                        </>
                      )
                    ) : (
                      <>
                        <strong>{formatHours(remainingHours)}</strong> of estimated work still remaining,
                        past the deadline.
                      </>
                    )}
                  </div>
                )}

                <div className={`fd-deadline-card__status fd-deadline-card__status--${status.tone}`}>
                  {status.label}
                </div>

                {!d.tag_id && d.status !== "done" && (
                  <LogProgressInline deadline={d} onLogged={onDataChanged} />
                )}

                {d.tag_id && d.status !== "done" && (
                  <>
                    {runningSession ? (
                      runningSession.tag_id !== d.tag_id && (
                        <button
                          type="button"
                          className="fd-btn fd-btn--start fd-deadline-card__start"
                          onClick={() => handleRetagRunningSession(d)}
                          disabled={startingId === d.id}
                        >
                          {startingId === d.id
                            ? "Switching…"
                            : `Switch running timer to ${d.tag_name || "this tag"}`}
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="fd-btn fd-btn--start fd-deadline-card__start"
                        onClick={() => handleStartOnTag(d)}
                        disabled={startingId === d.id}
                      >
                        {startingId === d.id ? "Starting…" : `▶ Start session on ${d.tag_name || "this tag"}`}
                      </button>
                    )}
                    {startError?.id === d.id && <div className="fd-inline-error">{startError.message}</div>}
                  </>
                )}

                <AnimatePresence initial={false}>
                  {editingId === d.id && (
                    <DeadlineEditForm
                      deadline={d}
                      tags={tags}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        onDataChanged();
                      }}
                    />
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {completed.length > 0 && (
        <div className="fd-deadline-completed">
          <button
            type="button"
            className="fd-deadline-completed__toggle"
            onClick={() => setShowCompleted((v) => !v)}
            aria-expanded={showCompleted}
          >
            <span>{showCompleted ? "Hide" : "Show"} completed ({completed.length})</span>
            <span className={`fd-deadline-completed__chevron ${showCompleted ? "fd-deadline-completed__chevron--open" : ""}`}>
              ▾
            </span>
          </button>
          <AnimatePresence initial={false}>
            {showCompleted && (
              <motion.div
                className="fd-deadline-completed__list"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
              >
                {completedPageItems.map((d) => {
                  // Same approximation computeDeadlineTrackRecord uses:
                  // updated_at at the moment the checkmark set status to
                  // "done" is the closest thing to a real completed_at
                  // this schema has.
                  const completedAt = new Date(d.updated_at);
                  const onTime = completedAt.getTime() <= d.dueAt.getTime();
                  return (
                    <div key={d.id} className="fd-deadline-completed__item">
                      <div className="fd-deadline-completed__title-row">
                        <span className="fd-deadline-completed__title">{d.title}</span>
                        <span
                          className={`fd-deadline-card__status fd-deadline-card__status--${
                            onTime ? "focus-green" : "rust"
                          }`}
                        >
                          {onTime ? "On time" : "Late"}
                        </span>
                      </div>
                      <div className="fd-deadline-completed__meta">
                        {formatHours(d.completedHours)} of {formatHours(Number(d.estimated_hours))} · completed{" "}
                        {completedAt.toLocaleDateString()}
                      </div>
                    </div>
                  );
                })}
                {completedTotalPages > 1 && (
                  <div className="fd-pagination">
                    <button
                      type="button"
                      className="fd-link-btn"
                      onClick={() => setCompletedPage((p) => Math.max(1, p - 1))}
                      disabled={completedPageClamped <= 1}
                    >
                      ← Prev
                    </button>
                    <span className="fd-pagination__status">
                      Page {completedPageClamped} of {completedTotalPages} · {completed.length} completed
                    </span>
                    <button
                      type="button"
                      className="fd-link-btn"
                      onClick={() => setCompletedPage((p) => Math.min(completedTotalPages, p + 1))}
                      disabled={completedPageClamped >= completedTotalPages}
                    >
                      Next →
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
