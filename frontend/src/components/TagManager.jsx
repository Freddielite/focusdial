import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createTag, deleteTag, listTags, setTagArchived, updateTag } from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";

const SWATCHES = ["#E0A93D", "#4DA3FF", "#FF7A5C", "#4CD37D", "#FF6FA3"];

export default function TagManager({ tags, onTagsChanged, embedded = false }) {
  const [open, setOpen] = useState(embedded);
  const [name, setName] = useState("");
  const [color, setColor] = useState(SWATCHES[0]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  // Archived tags aren't in `tags` (that's the active-only list every
  // other picker in the app uses too) - fetched separately, and only
  // once someone actually opens this section, since most visits here
  // are just "add a tag" and don't need it.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedTags, setArchivedTags] = useState(null); // null = not fetched yet
  const [archivedBusyId, setArchivedBusyId] = useState(null);

  // Inline rename/recolor - one chip editable at a time (opening a second
  // one just moves editingId, same as how the archived section's own
  // toggle works). Kept local to this component rather than per-chip
  // state, since only one edit form should ever be open at once.
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(SWATCHES[0]);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState(null);

  function startEdit(tag) {
    setEditingId(tag.id);
    setEditName(tag.name);
    // Existing custom colors (set before the swatch picker existed, or
    // via a future custom-color path) won't match one of the five
    // SWATCHES exactly - falling back to the tag's own color keeps the
    // dot showing what's actually saved instead of silently snapping to
    // the first swatch.
    setEditColor(tag.color);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleRename(tag) {
    const trimmed = editName.trim();
    if (!trimmed || editBusy) return;
    if (trimmed === tag.name && editColor === tag.color) {
      // Nothing actually changed - just close the form instead of
      // firing a no-op PATCH.
      cancelEdit();
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      await updateTag(tag.id, trimmed, editColor);
      setEditingId(null);
      await onTagsChanged();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditBusy(false);
    }
  }

  async function toggleArchivedSection() {
    if (!archivedOpen && archivedTags === null) {
      const all = await listTags(true);
      setArchivedTags(all.filter((t) => t.archived));
    }
    setArchivedOpen((v) => !v);
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createTag(name.trim(), color);
      setName("");
      await onTagsChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(tag) {
    const ok = await confirm({
      title: `Delete "${tag.name}"?`,
      body: "Sessions and deadlines using this tag keep their history, they'll just show as untagged.",
    });
    if (!ok) return;

    setPendingIds((prev) => new Set(prev).add(tag.id));
    requestDelete({
      id: tag.id,
      label: "Tag",
      onHide: () => {},
      onRestore: () =>
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(tag.id);
          return next;
        }),
      deleteFn: () => deleteTag(tag.id),
      afterCommit: onTagsChanged,
    });
  }

  // Unlike delete, archiving isn't destructive or undo-worthy in the
  // same way - the tag and all its history stay exactly as they were,
  // it just stops showing up as a choice for new sessions. No confirm
  // dialog, no undo toast needed for something this reversible (a
  // second click un-does it).
  async function handleArchive(tag) {
    setPendingIds((prev) => new Set(prev).add(tag.id));
    try {
      const updated = await setTagArchived(tag.id, true);
      // Optimistically add it into the archived list right away instead
      // of invalidating to null - nulling it out meant "Loading..."
      // stuck forever unless the section was manually closed and
      // reopened, since nothing else ever re-triggered a fetch. This
      // stays correct either way, whether or not the section happens to
      // be open right now, with no extra round trip.
      setArchivedTags((prev) =>
        prev === null ? prev : [...prev, updated].sort((a, b) => a.name.localeCompare(b.name))
      );
      // Wait for `tags` to actually be refetched before releasing
      // pendingIds below. Releasing it first (as this used to) meant
      // visibleTags briefly stopped hiding the tag while the still-
      // stale `tags` prop hadn't caught up yet - the tag flashed back
      // into view for a beat, then vanished again once the real
      // refresh landed. That's the "goes, comes back, goes again."
      await onTagsChanged();
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(tag.id);
        return next;
      });
    }
  }

  async function handleUnarchive(tag) {
    setArchivedBusyId(tag.id);
    try {
      await setTagArchived(tag.id, false);
      setArchivedTags((prev) => (prev ? prev.filter((t) => t.id !== tag.id) : prev));
      // Same reasoning as handleArchive above - wait for `tags` to
      // reflect the change before this function's `finally` re-enables
      // the button, so a fast double-click can't fire a second request
      // against a still-stale view.
      await onTagsChanged();
    } finally {
      setArchivedBusyId(null);
    }
  }

  if (!open) {
    return (
      <button className="fd-link-btn" onClick={() => setOpen(true)}>
        Manage tags
      </button>
    );
  }

  const visibleTags = tags.filter((t) => !pendingIds.has(t.id));

  return (
    <div className={`fd-tag-manager ${embedded ? "fd-tag-manager--embedded" : ""}`}>
      <div className="fd-tag-manager__list">
        <AnimatePresence initial={false}>
          {visibleTags.map((t) =>
            editingId === t.id ? (
              <motion.form
                key={t.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fd-tag-chip fd-tag-chip--editing"
                style={{ borderColor: editColor }}
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRename(t);
                }}
              >
                <input
                  type="text"
                  className="fd-tag-chip__edit-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelEdit();
                  }}
                  maxLength={40}
                  autoFocus
                  disabled={editBusy}
                />
                <div className="fd-swatches fd-swatches--inline">
                  {SWATCHES.map((sw) => (
                    <button
                      key={sw}
                      type="button"
                      className={`fd-swatch ${editColor === sw ? "fd-swatch--selected" : ""}`}
                      style={{ background: sw }}
                      onClick={() => setEditColor(sw)}
                      aria-label={`Select color ${sw}`}
                      disabled={editBusy}
                    />
                  ))}
                </div>
                <button
                  type="submit"
                  className="fd-icon-btn"
                  disabled={editBusy || !editName.trim()}
                  aria-label={`Save ${t.name}`}
                >
                  {editBusy ? "…" : "Save"}
                </button>
                <button
                  type="button"
                  className="fd-icon-btn"
                  onClick={cancelEdit}
                  disabled={editBusy}
                  aria-label="Cancel"
                >
                  Cancel
                </button>
                {editError && <div className="fd-inline-error fd-tag-chip__edit-error">{editError}</div>}
              </motion.form>
            ) : (
              <motion.span
                key={t.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: 20 }}
                className="fd-tag-chip"
                style={{ borderColor: t.color }}
              >
                <span className="fd-tag-dot" style={{ background: t.color }} />
                <span className="fd-tag-chip__name">{t.name}</span>
                <button
                  className="fd-icon-btn"
                  onClick={() => startEdit(t)}
                  aria-label={`Rename ${t.name}`}
                  title="Rename or recolor this tag"
                >
                  Edit
                </button>
                <button
                  className="fd-icon-btn"
                  onClick={() => handleArchive(t)}
                  aria-label={`Archive ${t.name}`}
                  title="Archive - hides it from new sessions, keeps its history"
                >
                  Archive
                </button>
                <button
                  className="fd-icon-btn fd-icon-btn--delete"
                  onClick={() => handleDelete(t)}
                  aria-label={`Delete ${t.name}`}
                >
                  ✕
                </button>
              </motion.span>
            )
          )}
        </AnimatePresence>
      </div>
      <form className="fd-tag-manager__form" onSubmit={handleAdd}>
        <input
          type="text"
          placeholder="New tag name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
        />
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
        <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      {error && <div className="fd-inline-error">{error}</div>}

      <button type="button" className="fd-link-btn fd-tag-manager__archived-toggle" onClick={toggleArchivedSection}>
        {archivedOpen ? "Hide archived tags" : "Show archived tags"}
        <span className={`fd-dropdown__chevron fd-tag-manager__chevron ${archivedOpen ? "fd-dropdown__chevron--open" : ""}`}>
          ▾
        </span>
      </button>
      <AnimatePresence initial={false}>
        {archivedOpen && (
          <motion.div
            key="archived-section"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
            className="fd-tag-manager__list fd-tag-manager__list--archived"
            style={{ overflow: "hidden" }}
          >
            {archivedTags === null ? (
              <span className="fd-empty">Loading…</span>
            ) : archivedTags.length === 0 ? (
              <span className="fd-empty">No archived tags.</span>
            ) : (
              <AnimatePresence initial={false}>
                {archivedTags.map((t) => (
                  <motion.span
                    key={t.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="fd-tag-chip fd-tag-chip--archived"
                    style={{ borderColor: t.color }}
                  >
                    <span className="fd-tag-dot" style={{ background: t.color }} />
                    <span className="fd-tag-chip__name">{t.name}</span>
                    <button
                      className="fd-icon-btn"
                      onClick={() => handleUnarchive(t)}
                      disabled={archivedBusyId === t.id}
                      aria-label={`Unarchive ${t.name}`}
                      title="Unarchive - makes it available for new sessions again"
                    >
                      {archivedBusyId === t.id ? "…" : "Unarchive"}
                    </button>
                  </motion.span>
                ))}
              </AnimatePresence>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!embedded && (
        <button className="fd-link-btn" onClick={() => setOpen(false)}>
          Done
        </button>
      )}
    </div>
  );
}
