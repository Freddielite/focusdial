import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createManualSession, updateTask } from "../api.js";
import { toLocalInputValue } from "../format.js";
import Dropdown from "./Dropdown.jsx";
import { DateTimePicker } from "./DateTimeField.jsx";

// Same hand-drawn icon convention as TodayView's Plan my day/Reflect on
// today cards - a plain plus, since this isn't a "kind of day" concept
// like sun/moon, just an add action.
function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

const QUALITY_OPTIONS = [
  { value: "focused", label: "Focused" },
  { value: "neutral", label: "Neutral" },
  { value: "distracted", label: "Distracted" },
];

export default function ManualEntryForm({ tags, tasks, onSessionCreated, onDataChanged }) {
  const [open, setOpen] = useState(false);
  const [tagId, setTagId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [markTaskDone, setMarkTaskDone] = useState(true);
  const [start, setStart] = useState(toLocalInputValue(new Date(Date.now() - 30 * 60 * 1000)));
  const [end, setEnd] = useState(toLocalInputValue(new Date()));
  const [note, setNote] = useState("");
  const [quality, setQuality] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const openTasks = (tasks || []).filter((t) => t.status === "open");

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createManualSession({
        tag_id: tagId || null,
        task_id: taskId || null,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(end).toISOString(),
        note: note || null,
        quality: quality || null,
      });
      if (taskId && markTaskDone) {
        await updateTask(taskId, { status: "done" }).catch(() => {});
        onDataChanged?.();
      }
      onSessionCreated(created);
      setNote("");
      setQuality(null);
      setTaskId("");
      setMarkTaskDone(true);
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    // Same AnimatePresence + motion.form treatment DeadlinesView's own
    // add-form uses (same .fd-manual-form class, in fact) - this one
    // was missed when it was rebuilt as a card a few messages back, so
    // it popped open/closed abruptly instead of animating like every
    // other toggle-form in the app.
    <AnimatePresence mode="wait" initial={false}>
      {!open ? (
        <motion.button
          key="collapsed"
          type="button"
          className="fd-daily-ritual-card fd-backfill-card"
          onClick={() => setOpen(true)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <span className="fd-daily-ritual-card__icon">
            <PlusIcon />
          </span>
          <span className="fd-daily-ritual-card__label">Backfill a past session</span>
        </motion.button>
      ) : (
        <motion.form
          key="expanded"
          className="fd-manual-form"
          onSubmit={handleSubmit}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25 }}
        >
        <div className="fd-manual-form__row">
          <label>
            Tag
            <Dropdown className="fd-select" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">No tag</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Dropdown>
          </label>
          {openTasks.length > 0 && (
            <label>
              Linked task (optional)
              <Dropdown className="fd-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">No linked task</option>
                {openTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </Dropdown>
            </label>
          )}
        </div>
        <div className="fd-manual-form__row fd-manual-form__row--dates">
          <label>
            Start
            <DateTimePicker value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label>
            End
            <DateTimePicker value={end} onChange={(e) => setEnd(e.target.value)} required />
          </label>
        </div>
        <div className="fd-manual-form__row">
          <label>
            Note (optional)
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </label>
        </div>
        <div className="fd-manual-form__row">
          <label>
            Quality (optional)
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
          </label>
        </div>
        {taskId && (
          <div className="fd-manual-form__row">
            <label className="fd-checkbox-row">
              <input type="checkbox" checked={markTaskDone} onChange={(e) => setMarkTaskDone(e.target.checked)} />
              Mark the linked task done too
            </label>
          </div>
        )}
        {error && <div className="fd-inline-error">{error}</div>}
        <div className="fd-manual-form__actions">
          <button type="button" className="fd-link-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
            Add Session
          </button>
        </div>
        </motion.form>
      )}
    </AnimatePresence>
  );
}
