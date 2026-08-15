import { useState } from "react";
import { motion } from "framer-motion";
import { updateSession } from "../api.js";
import { toLocalInputValue } from "../format.js";
import Dropdown from "./Dropdown.jsx";
import { DateTimePicker } from "./DateTimeField.jsx";

const QUALITY_OPTIONS = [
  { value: "focused", label: "Focused" },
  { value: "neutral", label: "Neutral" },
  { value: "distracted", label: "Distracted" },
];

// Inline edit form for a session row -- tag/start/end/note/quality,
// pre-filled from the session being edited. Expands within the row
// itself (see SessionLog's editingId toggle) rather than a modal,
// matching how Budgets/Deadlines/Reminders edit in place.
export default function SessionEditModal({ session, tags, tasks, onCancel, onSaved }) {
  const [tagId, setTagId] = useState(session.tag_id || "");
  const [taskId, setTaskId] = useState(session.task_id || "");
  const [start, setStart] = useState(toLocalInputValue(new Date(session.started_at)));
  const [end, setEnd] = useState(toLocalInputValue(new Date(session.ended_at)));
  const [note, setNote] = useState(session.note || "");
  const [quality, setQuality] = useState(session.quality || null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Open tasks, plus whatever's currently linked even if it's since
  // been marked done - otherwise saving this form without touching the
  // task field would silently unlink it, since a "done" task wouldn't
  // appear as a selectable option at all.
  const taskOptions = (tasks || []).filter((t) => t.status === "open" || t.id === session.task_id);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await updateSession(session.id, {
        tag_id: tagId || null,
        task_id: taskId || null,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(end).toISOString(),
        note: note || null,
        quality: quality || null,
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
        {taskOptions.length > 0 && (
          <label>
            Linked task
            <Dropdown className="fd-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">No linked task</option>
              {taskOptions.map((t) => (
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
