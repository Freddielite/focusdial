import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createBudget, updateBudget, deleteBudget, assignTagToBudget } from "../api.js";
import { formatDuration } from "../format.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";
import Dropdown from "./Dropdown.jsx";

const SWATCHES = ["#E0A93D", "#4DA3FF", "#FF7A5C", "#4CD37D", "#FF6FA3"];

// The management half of budgets — create, delete, and wire tags to a
// weekly goal. The Budgets tab stays read-only (progress bars); this is
// where the goals actually get set up, living in Settings alongside tag
// management so all the "configure my tracking" controls are together.
// Inline edit form for a budget row -- name/weekly target/color,
// pre-filled from the budget being edited. Expands within the row
// itself rather than a modal, matching the create form just above it
// in this same manager.
function BudgetEditForm({ budget, onCancel, onSaved }) {
  const currentSeconds = budget.targetSeconds ?? budget.weekly_target_seconds;
  const [name, setName] = useState(budget.name);
  const [hours, setHours] = useState(currentSeconds / 3600);
  const [color, setColor] = useState(budget.color);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateBudget(budget.id, {
        name: name.trim(),
        weekly_target_hours: Number(hours),
        color,
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
      className="fd-budget-manager__form fd-inline-edit-form"
      onSubmit={handleSubmit}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="fd-manual-form__row">
        <label>
          Budget name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        </label>
        <label>
          Weekly target (hours)
          <input type="number" min="0.5" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} required />
        </label>
      </div>
      <div className="fd-swatches">
        {SWATCHES.map((sw) => (
          <button
            key={sw}
            type="button"
            className={`fd-swatch ${color === sw ? "fd-swatch--selected" : ""}`}
            style={{ background: sw }}
            onClick={() => setColor(sw)}
            aria-label={`Select color ${sw}`}
          />
        ))}
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

export default function BudgetManager({ budgets, tags, onDataChanged }) {
  const [name, setName] = useState("");
  const [hours, setHours] = useState(10);
  const [color, setColor] = useState(SWATCHES[0]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  const unassignedTags = tags.filter((t) => !t.budget_id);
  const visibleBudgets = budgets.filter((b) => !pendingIds.has(b.id));

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBudget(name.trim(), Number(hours), color);
      setName("");
      onDataChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteBudget(budget) {
    const ok = await confirm({
      title: `Delete "${budget.name}"?`,
      body: "Tags assigned to it just lose the assignment, they aren't deleted.",
    });
    if (!ok) return;

    setPendingIds((prev) => new Set(prev).add(budget.id));
    requestDelete({
      id: budget.id,
      label: "Budget",
      onHide: () => {},
      onRestore: () =>
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(budget.id);
          return next;
        }),
      deleteFn: () => deleteBudget(budget.id),
      afterCommit: onDataChanged,
    });
  }

  return (
    <div className="fd-budget-manager">
      <form className="fd-budget-manager__form" onSubmit={handleCreate}>
        <div className="fd-manual-form__row">
          <label>
            Budget name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Deep work" required />
          </label>
          <label>
            Weekly target (hours)
            <input type="number" min="0.5" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} required />
          </label>
        </div>
        <div className="fd-swatches">
          {SWATCHES.map((sw) => (
            <button
              key={sw}
              type="button"
              className={`fd-swatch ${color === sw ? "fd-swatch--selected" : ""}`}
              style={{ background: sw }}
              onClick={() => setColor(sw)}
              aria-label={`Select color ${sw}`}
            />
          ))}
        </div>
        {error && <div className="fd-inline-error">{error}</div>}
        <div className="fd-manual-form__actions">
          <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
            {busy ? "Adding…" : "Add budget"}
          </button>
        </div>
      </form>

      {visibleBudgets.length === 0 ? (
        <div className="fd-empty">No budgets yet. Add one above to track a weekly time goal.</div>
      ) : (
        <div className="fd-budget-manager__list">
          <AnimatePresence>
            {visibleBudgets.map((b) => (
              <motion.div
                key={b.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="fd-budget-manager__row"
              >
                <div className="fd-budget-manager__row-head">
                  <span className="fd-tag-dot" style={{ background: b.color }} />
                  <span className="fd-budget-manager__name">{b.name}</span>
                  <span className="fd-budget-manager__target">{formatDuration(b.targetSeconds ?? b.weekly_target_seconds)}/wk</span>
                  <button
                    className="fd-icon-btn"
                    onClick={() => setEditingId((id) => (id === b.id ? null : b.id))}
                    aria-label={`Edit ${b.name}`}
                  >
                    ✎
                  </button>
                  <button className="fd-icon-btn" onClick={() => handleDeleteBudget(b)} aria-label={`Delete ${b.name}`}>✕</button>
                </div>
                <div className="fd-budget-card__tags">
                  {(b.tags || []).map((t) => (
                    <span key={t.id} className="fd-tag-chip" style={{ borderColor: t.color }}>
                      <span className="fd-tag-dot" style={{ background: t.color }} />
                      {t.name}
                      <button className="fd-icon-btn" onClick={() => assignTagToBudget(t.id, null).then(onDataChanged)} aria-label={`Remove ${t.name}`}>✕</button>
                    </span>
                  ))}
                  {unassignedTags.length > 0 && (
                    <Dropdown
                      className="fd-select fd-select--inline"
                      value=""
                      onChange={(e) => e.target.value && assignTagToBudget(e.target.value, b.id).then(onDataChanged)}
                    >
                      <option value="">+ Add tag</option>
                      {unassignedTags.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </Dropdown>
                  )}
                </div>
                <AnimatePresence initial={false}>
                  {editingId === b.id && (
                    <BudgetEditForm
                      budget={b}
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
      )}
    </div>
  );
}
