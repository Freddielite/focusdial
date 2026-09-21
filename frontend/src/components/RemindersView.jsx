import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  createReminder,
  updateReminder,
  dismissReminder,
  deleteReminder,
  convertReminderToDeadline,
  convertReminderToTask,
} from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";
import Dropdown from "./Dropdown.jsx";
import { DatePicker, DateTimePicker } from "./DateTimeField.jsx";

// Same bell glyph as the Reminders tab icon and the notification bell,
// tinted with the reminder category accent.
function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function timeOf(date) {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function shortDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function ConvertPanel({ reminder, tags, onDone, onDelete, onEdit }) {
  const [mode, setMode] = useState(null); // 'deadline' | 'task' | null
  const [dueDate, setDueDate] = useState("");
  const [estHours, setEstHours] = useState(5);
  const [tagId, setTagId] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submitDeadline(e) {
    e.preventDefault();
    if (!dueDate || !estHours || busy) return;
    setBusy(true);
    setError(null);
    try {
      await convertReminderToDeadline(reminder.id, {
        due_date: dueDate,
        estimated_hours: Number(estHours),
        tag_id: tagId || null,
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitTask(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await convertReminderToTask(reminder.id, { due_date: dueDate || null });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!mode) {
    return (
      <div className="fd-reminder-actions">
        <button className="fd-link-btn" onClick={() => setMode("deadline")}>
          → Deadline
        </button>
        <button className="fd-link-btn" onClick={() => setMode("task")}>
          → Task
        </button>
        <button className="fd-link-btn" onClick={() => dismissReminder(reminder.id).then(onDone)}>
          Dismiss
        </button>
        <button className="fd-icon-btn" onClick={onEdit} aria-label="Edit reminder">
          ✎
        </button>
        <button className="fd-icon-btn" onClick={() => onDelete(reminder)} aria-label="Delete">
          ✕
        </button>
      </div>
    );
  }

  if (mode === "task") {
    return (
      <form className="fd-manual-form" onSubmit={submitTask}>
        <div className="fd-manual-form__row">
          <label>
            Due date (optional)
            <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>
        {error && <div className="fd-inline-error">{error}</div>}
        <div className="fd-manual-form__actions">
          <button type="button" className="fd-link-btn" onClick={() => setMode(null)} disabled={busy}>
            Back
          </button>
          <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
            {busy ? "Creating…" : "Create Task"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="fd-manual-form" onSubmit={submitDeadline}>
      <div className="fd-manual-form__row fd-manual-form__row--dates">
        <label>
          Due date
          <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </label>
        <label>
          Estimated hours
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
          Track via tag (optional)
          <Dropdown className="fd-select" value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">No tag</option>
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
        <button type="button" className="fd-link-btn" onClick={() => setMode(null)} disabled={busy}>
          Back
        </button>
        <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
          {busy ? "Creating…" : "Create Deadline"}
        </button>
      </div>
    </form>
  );
}

// Inline edit form for a reminder card -- title/remind-at/repeat/note,
// pre-filled from the reminder being edited. Expands within the card
// itself, same pattern as the deadline edit form and the create form
// above.
function ReminderEditForm({ reminder, onCancel, onSaved }) {
  const [title, setTitle] = useState(reminder.title);
  const [remindAt, setRemindAt] = useState(toLocalInputValue(new Date(reminder.remind_at)));
  const [note, setNote] = useState(reminder.note || "");
  const [recurrence, setRecurrence] = useState(reminder.recurrence || "none");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim() || !remindAt) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateReminder(reminder.id, {
        title: title.trim(),
        note: note || null,
        remind_at: new Date(remindAt).toISOString(),
        recurrence,
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
          Remind me at
          <DateTimePicker value={remindAt} onChange={(e) => setRemindAt(e.target.value)} required />
        </label>
        <label>
          Repeat
          <Dropdown className="fd-select" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="none">Doesn't repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Dropdown>
        </label>
      </div>
      <div className="fd-manual-form__row">
        <label>
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
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

export default function RemindersView({ reminders, tags, onDataChanged }) {
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState(toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [note, setNote] = useState("");
  const [recurrence, setRecurrence] = useState("none");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  const now = new Date();
  const due = reminders.filter((r) => new Date(r.remind_at) <= now && !pendingIds.has(r.id));
  const upcoming = reminders.filter((r) => new Date(r.remind_at) > now && !pendingIds.has(r.id));

  async function handleDeleteReminder(reminder) {
    const ok = await confirm({ title: `Delete "${reminder.title}"?` });
    if (!ok) return;

    setPendingIds((prev) => new Set(prev).add(reminder.id));
    requestDelete({
      id: reminder.id,
      label: "Reminder",
      onHide: () => {},
      onRestore: () =>
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(reminder.id);
          return next;
        }),
      deleteFn: () => deleteReminder(reminder.id),
      afterCommit: onDataChanged,
    });
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!title.trim() || !remindAt || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createReminder({
        title: title.trim(),
        note: note || null,
        remind_at: new Date(remindAt).toISOString(),
        recurrence,
      });
      setTitle("");
      setNote("");
      setFormOpen(false);
      onDataChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
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
          Reminders
        </div>
        <button className="fd-link-btn" onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? "Cancel" : "+ New Reminder"}
        </button>
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
                Remind me at
                <DateTimePicker value={remindAt} onChange={(e) => setRemindAt(e.target.value)} required />
              </label>
              <label>
                Repeat
                <Dropdown className="fd-select" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
                  <option value="none">Doesn't repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </Dropdown>
              </label>
            </div>
            <div className="fd-manual-form__row">
              <label>
                Note (optional)
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
              </label>
            </div>
            {error && <div className="fd-inline-error">{error}</div>}
            <div className="fd-manual-form__actions">
              <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
                {busy ? "Creating…" : "Create Reminder"}
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {due.length > 0 && (
        <div>
          <div className="fd-panel__label">Due Now</div>
          <div className="fd-reminder-list">
            <AnimatePresence initial={false}>
              {due.map((r) => (
                <motion.div
                  key={r.id}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  className="fd-panel fd-reminder-card fd-reminder-card--due fd-check-card--reminder"
                >
                  <div className="fd-check-card">
                    <span className="fd-check-card__icon">
                      <BellIcon />
                    </span>
                    <div className="fd-check-card__body">
                      <span className="fd-check-card__title">{r.title}</span>
                      <span className="fd-check-card__meta">★ Due now</span>
                    </div>
                    <div className="fd-check-card__value">
                      <span className="fd-check-card__value-num">{timeOf(new Date(r.remind_at))}</span>
                      <span className="fd-check-card__value-unit">{shortDate(new Date(r.remind_at))}</span>
                    </div>
                  </div>
                  {r.note && <div className="fd-reminder-card__note">{r.note}</div>}
                  <ConvertPanel
                    reminder={r}
                    tags={tags}
                    onDone={onDataChanged}
                    onDelete={handleDeleteReminder}
                    onEdit={() => setEditingId((id) => (id === r.id ? null : r.id))}
                  />
                  <AnimatePresence initial={false}>
                    {editingId === r.id && (
                      <ReminderEditForm
                        reminder={r}
                        onCancel={() => setEditingId(null)}
                        onSaved={() => {
                          setEditingId(null);
                          onDataChanged();
                        }}
                      />
                    )}
                  </AnimatePresence>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      <div>
        <div className="fd-panel__label">Upcoming</div>
        {upcoming.length === 0 && <div className="fd-empty">No upcoming reminders.</div>}
        <div className="fd-reminder-list">
          <AnimatePresence initial={false}>
            {upcoming.map((r) => (
              <motion.div
                key={r.id}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                className="fd-panel fd-reminder-card fd-check-card--reminder"
              >
                <div className="fd-check-card">
                  <span className="fd-check-card__icon">
                    <BellIcon />
                  </span>
                  <div className="fd-check-card__body">
                    <span className="fd-check-card__title">{r.title}</span>
                    <span className="fd-check-card__meta">★ {shortDate(new Date(r.remind_at))}</span>
                  </div>
                  <div className="fd-check-card__value">
                    <span className="fd-check-card__value-num">{timeOf(new Date(r.remind_at))}</span>
                    <span className="fd-check-card__value-unit">
                      {r.recurrence !== "none" ? `repeats ${r.recurrence}` : "once"}
                    </span>
                  </div>
                </div>
                {r.note && <div className="fd-reminder-card__note">{r.note}</div>}
                <div className="fd-reminder-actions">
                  <button
                    className="fd-icon-btn"
                    onClick={() => setEditingId((id) => (id === r.id ? null : r.id))}
                    aria-label="Edit reminder"
                  >
                    ✎
                  </button>
                  <button
                    className="fd-icon-btn"
                    onClick={() => handleDeleteReminder(r)}
                    aria-label="Delete"
                  >
                    ✕
                  </button>
                </div>
                <AnimatePresence initial={false}>
                  {editingId === r.id && (
                    <ReminderEditForm
                      reminder={r}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        onDataChanged();
                      }}
                    />
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
