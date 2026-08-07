import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createTask, updateTask, deleteTask } from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";

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

export default function TasksWidget({ tasks, onDataChanged }) {
  const [title, setTitle] = useState("");
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  const visibleTasks = tasks.filter((t) => !pendingIds.has(t.id));

  async function handleAdd(e) {
    e.preventDefault();
    if (!title.trim()) return;
    await createTask(title.trim(), null);
    setTitle("");
    onDataChanged();
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
        />
        <button type="submit" className="fd-link-btn">
          Add
        </button>
      </form>
      {visibleTasks.length === 0 && <div className="fd-empty">Nothing on your list right now.</div>}
      <div className="fd-task-list">
        <AnimatePresence initial={false}>
          {visibleTasks.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, x: 20 }}
              className={`fd-task-row${t.deadline_id ? " fd-task-row--deadline" : ""}`}
            >
              <button className="fd-task-checkbox" onClick={() => handleToggle(t)} aria-label="Mark done" />
              {t.deadline_id && (
                <span className="fd-task-row__badge" title="From a deadline">
                  <FlagIcon />
                </span>
              )}
              <span className="fd-task-row__title">{t.title}</span>
              {t.due_date && (
                <span className="fd-task-row__due">
                  {new Date(t.due_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              )}
              <button className="fd-icon-btn" onClick={() => handleDelete(t)} aria-label="Delete task">
                ✕
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
