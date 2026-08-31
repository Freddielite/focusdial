import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createTask, updateTask, deleteTask, bumpTask } from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";
import { DatePicker, CalendarGlyph } from "./DateTimeField.jsx";
import Dropdown from "./Dropdown.jsx";
import TaskEditForm from "./TaskEditForm.jsx";
import { estimateHintMinutes } from "../priorityEngine.js";
import { STALENESS_THRESHOLD_DAYS } from "../priorityWeights.js";

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

// Priced-tag glyph for the optional tag-picker toggle - kept visually
// distinct from FlagIcon (which marks a task's *origin*, not its
// category) and from CalendarGlyph, so the row of three optional icons
// next to the quick-add input each read as a different kind of extra.
function TagGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L4 3a1 1 0 0 0-1 1l.24 5.59a2 2 0 0 0 .59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.83Z" />
      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Hourglass glyph for the optional effort-estimate toggle.
function EstimateGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h12M6 22h12" />
      <path d="M6 2c0 5 5 6.5 6 8 1-1.5 6-3 6-8M6 22c0-5 5-6.5 6-8 1 1.5 6 3 6 8" />
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

// Feature 3's lightweight visual indicator - a task counts as stale in
// the list at the same threshold the priority engine's staleness score
// starts boosting at (STALENESS_THRESHOLD_DAYS), so the dot on a task
// row and the score behind "Do This Next" always agree on what "stale"
// means, rather than two different numbers that could quietly drift
// apart.
function daysStale(task, now) {
  return (now.getTime() - new Date(task.last_touched_at).getTime()) / (24 * 60 * 60 * 1000);
}

export default function TasksWidget({ tasks, tags, tagEstimateStats, onDataChanged }) {
  const [title, setTitle] = useState("");
  // Collapsed by default -- this form is meant to stay a fast one-line
  // "quick task" add, so a due date is an opt-in extra step (the small
  // 📅 toggle) rather than a field always sitting there for the common
  // case of a task with no due date at all. Tag and estimate follow the
  // exact same collapsed-by-default pattern, for the same reason (see
  // the scoping conversation before this feature was built) - most
  // tasks typed here are still meant to be a one-line brain dump, not a
  // form.
  const [dueDate, setDueDate] = useState("");
  const [showDueDate, setShowDueDate] = useState(false);
  const [tagId, setTagId] = useState("");
  const [showTag, setShowTag] = useState(false);
  const [estimateMinutes, setEstimateMinutes] = useState("");
  const [showEstimate, setShowEstimate] = useState(false);
  // Repeat only means anything once there's a due date to advance from
  // (see routes/tasks.js's own validation) - reset alongside dueDate
  // being cleared so a hidden, stale "weekly" choice can't silently
  // ride along on a later task that never re-opened the due-date area.
  const [recurrence, setRecurrence] = useState("none");
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  // Which task row (by id) has its edit form expanded, or null - same
  // single-row-at-a-time toggle shape as SessionLog's editingId, so
  // only one task can be mid-edit at once.
  const [editingId, setEditingId] = useState(null);
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();
  const now = new Date();

  const visibleTasks = tasks.filter((t) => !pendingIds.has(t.id));

  // Feature 2's "based on your history, this usually takes ~X" hint -
  // purely informational, never overwrites what was typed (see
  // estimateHintMinutes's own comment in priorityEngine.js).
  const enteredMinutes = Number(estimateMinutes) || null;
  const hint = tagId && enteredMinutes ? estimateHintMinutes(tagId, enteredMinutes, tagEstimateStats) : null;

  async function handleAdd(e) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await createTask(title.trim(), dueDate || null, dueDate ? recurrence : "none", tagId || null, enteredMinutes);
      setTitle("");
      setDueDate("");
      setShowDueDate(false);
      setRecurrence("none");
      setTagId("");
      setShowTag(false);
      setEstimateMinutes("");
      setShowEstimate(false);
      onDataChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(task) {
    await updateTask(task.id, { status: "done" });
    onDataChanged();
  }

  async function handleBump(task) {
    await bumpTask(task.id);
    onDataChanged();
  }

  async function handleDelete(task) {
    const ok = await confirm({ title: `Delete "${task.title}"?` });
    if (!ok) return;

    setEditingId((id) => (id === task.id ? null : id));
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
          className={`fd-icon-btn ${tagId ? "fd-icon-btn--active" : ""}`}
          onClick={() => setShowTag((v) => !v)}
          aria-label="Set category"
          title="Set category"
          disabled={busy}
        >
          <TagGlyph />
        </button>
        <button
          type="button"
          className={`fd-icon-btn ${estimateMinutes ? "fd-icon-btn--active" : ""}`}
          onClick={() => setShowEstimate((v) => !v)}
          aria-label="Set time estimate"
          title="Set time estimate"
          disabled={busy}
        >
          <EstimateGlyph />
        </button>
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
      {showTag && (
        <div className="fd-quick-task-due">
          <Dropdown className="fd-select fd-select--sm" value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">No category</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Dropdown>
          {tagId && (
            <button type="button" className="fd-link-btn" onClick={() => setTagId("")}>
              Clear
            </button>
          )}
        </div>
      )}
      {showEstimate && (
        <div className="fd-quick-task-due">
          <input
            type="number"
            min="1"
            className="fd-quick-task-estimate-input"
            placeholder="Minutes"
            value={estimateMinutes}
            onChange={(e) => setEstimateMinutes(e.target.value)}
          />
          {hint && <span className="fd-quick-task-estimate-hint">Usually takes ~{hint}m for you</span>}
          {estimateMinutes && (
            <button type="button" className="fd-link-btn" onClick={() => setEstimateMinutes("")}>
              Clear
            </button>
          )}
        </div>
      )}
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
            const stale = daysStale(t, now) >= STALENESS_THRESHOLD_DAYS;
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: 20 }}
                className="fd-task-row-wrap"
              >
                <div
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
                  {stale && (
                    <span
                      className="fd-task-row__stale-dot"
                      title={`Untouched for ${Math.floor(daysStale(t, now))} days`}
                    />
                  )}
                  <span className="fd-task-row__title">{t.title}</span>
                  {t.tag_name && (
                    <span className="fd-task-row__tag" style={{ borderColor: t.tag_color, color: t.tag_color }}>
                      {t.tag_name}
                    </span>
                  )}
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
                  {stale && (
                    <button
                      className="fd-icon-btn"
                      onClick={() => handleBump(t)}
                      aria-label="Not time-sensitive yet, reset staleness"
                      title="Not time-sensitive yet - reset staleness"
                    >
                      ↻
                    </button>
                  )}
                  <button
                    className="fd-icon-btn"
                    onClick={() => setEditingId((id) => (id === t.id ? null : t.id))}
                    aria-label="Edit task"
                    title="Edit task"
                  >
                    ✎
                  </button>
                  <button className="fd-icon-btn" onClick={() => handleDelete(t)} aria-label="Delete task">
                    ✕
                  </button>
                </div>
                <AnimatePresence initial={false}>
                  {editingId === t.id && (
                    <TaskEditForm
                      task={t}
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
    </div>
  );
}
