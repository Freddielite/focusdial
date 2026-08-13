import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createDeadline, deleteDeadline, updateDeadline, logDeadlineProgress, getRunningSession } from "../api.js";
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
  useEffect(() => {
    function refresh() {
      getRunningSession()
        .then((s) => setRunning(s || null))
        .catch(() => {});
    }
    refresh();
    pollRef.current = setInterval(refresh, RUNNING_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return running;
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
  async function submit(e) {
    e.preventDefault();
    const hours = Number(value);
    if (!hours || hours <= 0) return;
    await logDeadlineProgress(deadline.id, hours);
    setValue("");
    onLogged();
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
      />
      <button type="submit" className="fd-link-btn">
        Log
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
    if (!title.trim() || !dueDate) return;
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
          Estimated hours
          <input type="number" min="0.5" step="0.5" value={estHours} onChange={(e) => setEstHours(e.target.value)} required />
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
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();
  const nowMs = useLiveNow();
  const runningSession = useRunningSession();

  const avgHours = avgDailyFocusSeconds / 3600;
  const active = deadlines.filter((d) => d.status !== "done" && d.status !== "archived" && !pendingIds.has(d.id));

  async function handleCreate(e) {
    e.preventDefault();
    if (!title.trim() || !dueDate) return;
    setError(null);
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
                Estimated hours needed
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  value={estHours}
                  onChange={(e) => setEstHours(e.target.value)}
                  required
                />
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
            {error && <div className="fd-inline-error">{error}</div>}
            <div className="fd-manual-form__actions">
              <button type="submit" className="fd-btn fd-btn--start">
                Add Deadline
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
                    <span className="fd-check-card__value-num">{completedHours.toFixed(1)}h</span>
                    <span className="fd-check-card__value-unit">of {Number(d.estimated_hours).toFixed(1)}h</span>
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
                      <>
                        Need <strong>{pacePerDay.toFixed(1)}h/day</strong> to finish in time
                        {avgHours > 0 && ` (you average ${avgHours.toFixed(1)}h/day)`}.
                      </>
                    ) : (
                      <>
                        <strong>{remainingHours.toFixed(1)}h</strong> of estimated work still remaining,
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
    </motion.div>
  );
}
