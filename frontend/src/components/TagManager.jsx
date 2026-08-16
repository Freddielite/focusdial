import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createTag, deleteTag, listTags, setTagArchived } from "../api.js";
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
      onTagsChanged();
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
      await setTagArchived(tag.id, true);
      onTagsChanged();
      setArchivedTags(null); // stale until reopened - simplest way to keep it correct
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
      onTagsChanged();
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
          {visibleTags.map((t) => (
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
          ))}
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
      </button>
      <AnimatePresence initial={false}>
        {archivedOpen && (
          <motion.div
            key="archived-section"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
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
