import { useState } from "react";
import { createTag, deleteTag } from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";

const SWATCHES = ["#E0A93D", "#4DA3FF", "#FF7A5C", "#4CD37D", "#FF6FA3"];

export default function TagManager({ tags, onTagsChanged, embedded = false }) {
  const [open, setOpen] = useState(embedded);
  const [name, setName] = useState("");
  const [color, setColor] = useState(SWATCHES[0]);
  const [error, setError] = useState(null);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  async function handleAdd(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      await createTag(name.trim(), color);
      setName("");
      onTagsChanged();
    } catch (err) {
      setError(err.message);
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
        {visibleTags.map((t) => (
          <span key={t.id} className="fd-tag-chip" style={{ borderColor: t.color }}>
            <span className="fd-tag-dot" style={{ background: t.color }} />
            {t.name}
            <button className="fd-icon-btn" onClick={() => handleDelete(t)} aria-label={`Delete ${t.name}`}>
              ✕
            </button>
          </span>
        ))}
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
        <button type="submit" className="fd-btn fd-btn--start">
          Add
        </button>
      </form>
      {error && <div className="fd-inline-error">{error}</div>}
      {!embedded && (
        <button className="fd-link-btn" onClick={() => setOpen(false)}>
          Done
        </button>
      )}
    </div>
  );
}
