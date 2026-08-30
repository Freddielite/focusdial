import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createTask, updateTask, deleteTask } from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";
import { DatePicker, CalendarGlyph } from "./DateTimeField.jsx";
import Dropdown from "./Dropdown.jsx";

// Same flag glyph used in DeadlinesView, so a task created from a
// deadline (see "Also add to my task list") is instantly recognizable
// as the same kind of item rather than a plain task.
function FlagIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v18" />
      <path d="M6 4h11l-2 3 2 3H6" />
    </svg>
  );
}

// A plain calendar-day comparison, not a precise moment -- tasks only
// ever carry a due_date (no time-of-day, unlike deadlines), so "overdue"
// here means "that calendar day has already fully passed," using the
// same local-midnight convention the rest of the app's day-boundary
// logic already uses (localDayKey/startOfLocalDay in analytics.js).
function isTaskOverdue(task) {
  if (!task.due_date || task.status === "done") return false;
  const due = new Date(task.due_date);
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const today = new Date();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return dueDay.getTime() < todayDay.getTime();
}

export default function TasksWidget({ tasks, onDataChanged }) {
  const [title, setTitle] = useState("");
  // Collapsed by default -- this form is meant to stay a fast one-line
  // "quick task" add, so a due date is an opt-in extra step (the small
  // 📅 toggle) rather than a field always sitting there for the common
  // case of a task with no due date at all.
  const [dueDate, setDueDate] = useState("");
  const [showDueDate, setShowDueDate] = useState(false);
  // Repeat only means anything once there's a due date to advance from
  // (see routes/tasks.js's own validation) - reset alongside dueDate
  // being cleared so a hidden, stale "weekly" choice can't silently
  // ride along on a later task that never re-opened the due-date area.
  const [recurrence, setRecurrence] = useState("none");
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  const visibleTasks = tasks.filter((t) => !pendingIds.has(t.id));

  async function handleAdd(e) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await createTask(title.trim(), dueDate || null, dueDate ? recurrence : "none");
      setTitle("");
      setDueDate("");
      setShowDueDate(false);
      setRecurrence("none");
      onDataChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(task) {
    await updateTask(task.id, { status: "done" });
    onDataChanged();
  }

  async function handleDelete(task) {
    const ok = await confirm({ title: `Delete "${task.title}"?` });
    if (!ok) return;

    setPendingIds((prev) => new Set(prev).add(task.id));
    requestDelete({
      id: task.id,
      label: "Task",
      onHide: () => {},
      onRestore: () =>
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        }),
      deleteFn: () => deleteTask(task.id),
      afterCommit: onDataChanged,
    });
  }

  return (
    <div className="fd-panel fd-tasks-panel">
      <div className="fd-panel__label">Quick Tasks</div>
      <form className="fd-quick-task-form" onSubmit={handleAdd}>
        <input
          type="text"
          placeholder="Add a task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          disabled={busy}
        />
        <button
          type="button"
          className={`fd-icon-btn ${dueDate ? "fd-icon-btn--active" : ""}`}
          onClick={() => setShowDueDate((v) => !v)}
          aria-label="Set due date"
          title="Set due date"
          disabled={busy}
        >
          <CalendarGlyph />
        </button>
        <button type="submit" className="fd-link-btn" disabled={busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      {showDueDate && (
        <div className="fd-quick-task-due">
          <DatePicker value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          {dueDate && (
            <>
              <Dropdown className="fd-select fd-select--sm" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
                <option value="none">Doesn't repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Dropdown>
              <button
                type="button"
                className="fd-link-btn"
                onClick={() => {
                  setDueDate("");
                  setRecurrence("none");
                }}
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}
      {visibleTasks.length === 0 && <div className="fd-empty">Nothing on your list right now.</div>}
      <div className="fd-task-list">
        <AnimatePresence initial={false}>
          {visibleTasks.map((t) => {
            const overdue = isTaskOverdue(t);
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: 20 }}
                className={`fd-task-row${t.deadline_id ? " fd-task-row--deadline" : ""}${
                  overdue ? " fd-task-row--overdue" : ""
                }`}
              >
                <button className="fd-task-checkbox" onClick={() => handleToggle(t)} aria-label="Mark done" />
                {t.deadline_id && (
                  <span className="fd-task-row__badge" title="From a deadline">
                    <FlagIcon />
                  </span>
                )}
                <span className="fd-task-row__title">{t.title}</span>
                {t.due_date && (
                  <span className={`fd-task-row__due ${overdue ? "fd-task-row__due--overdue" : ""}`}>
                    {overdue ? "Overdue · " : ""}
                    {new Date(t.due_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    {t.recurrence && t.recurrence !== "none" && (
                      <span title="A new task is created for the next occurrence once this one's marked done">
                        {" "}· repeats {t.recurrence}
                      </span>
                    )}
                  </span>
                )}
                <button className="fd-icon-btn" onClick={() => handleDelete(t)} aria-label="Delete task">
                  ✕
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
