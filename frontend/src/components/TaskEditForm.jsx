import { useState } from "react";
import { motion } from "framer-motion";
import { updateTask } from "../api.js";
import { DatePicker } from "./DateTimeField.jsx";
import Dropdown from "./Dropdown.jsx";

// Inline edit form for a task row -- title/due date/recurrence/tag/
// estimate, pre-filled from the task being edited. Expands within the
// row itself (see TasksWidget's editingId toggle), same shape as
// SessionEditModal expanding within a session row rather than a modal.
export default function TaskEditForm({ task, tags, onCancel, onSaved }) {
  const [title, setTitle] = useState(task.title);
  const [dueDate, setDueDate] = useState(task.due_date ? task.due_date.slice(0, 10) : "");
  const [recurrence, setRecurrence] = useState(task.recurrence || "none");
  const [tagId, setTagId] = useState(task.tag_id || "");
  const [estimateMinutes, setEstimateMinutes] = useState(task.estimate_minutes ? String(task.estimate_minutes) : "");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // due_date/recurrence/tag_id/estimate_minutes are always sent,
      // even as null, so the backend's explicit "was this key sent"
      // check (see PATCH /tasks/:id) treats a cleared field as a
      // deliberate clear rather than "nothing to do."
      const updated = await updateTask(task.id, {
        title: title.trim(),
        due_date: dueDate || null,
        recurrence: dueDate ? recurrence : "none",
        tag_id: tagId || null,
        estimate_minutes: Number(estimateMinutes) || null,
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
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={100}
            disabled={busy}
            required
          />
        </label>
      </div>
      <div className="fd-manual-form__row">
        <label>
          Category
          <Dropdown className="fd-select" value={tagId} onChange={(e) => setTagId(e.target.value)} disabled={busy}>
            <option value="">No category</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Dropdown>
        </label>
        <label>
          Estimate (minutes)
          <input
            type="number"
            min="1"
            value={estimateMinutes}
            onChange={(e) => setEstimateMinutes(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <div className="fd-manual-form__row fd-manual-form__row--dates">
        <label>
          Due date
          <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        {dueDate && (
          <label>
            Repeats
            <Dropdown
              className="fd-select"
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value)}
              disabled={busy}
            >
              <option value="none">Doesn't repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Dropdown>
          </label>
        )}
        {dueDate && (
          <button
            type="button"
            className="fd-link-btn"
            onClick={() => {
              setDueDate("");
              setRecurrence("none");
            }}
            disabled={busy}
          >
            Clear date
          </button>
        )}
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
