import { useState } from "react";
import { createManualSession } from "../api.js";
import { toLocalInputValue } from "../format.js";
import Dropdown from "./Dropdown.jsx";

const QUALITY_OPTIONS = [
  { value: "focused", label: "Focused" },
  { value: "neutral", label: "Neutral" },
  { value: "distracted", label: "Distracted" },
];

export default function ManualEntryForm({ tags, onSessionCreated }) {
  const [open, setOpen] = useState(false);
  const [tagId, setTagId] = useState("");
  const [start, setStart] = useState(toLocalInputValue(new Date(Date.now() - 30 * 60 * 1000)));
  const [end, setEnd] = useState(toLocalInputValue(new Date()));
  const [note, setNote] = useState("");
  const [quality, setQuality] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createManualSession({
        tag_id: tagId || null,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(end).toISOString(),
        note: note || null,
        quality: quality || null,
      });
      onSessionCreated(created);
      setNote("");
      setQuality(null);
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="fd-link-btn" onClick={() => setOpen(true)}>
        + Backfill a past session
      </button>
    );
  }

  return (
    <form className="fd-manual-form" onSubmit={handleSubmit}>
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
      </div>
      <div className="fd-manual-form__row">
        <label>
          Start
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
        </label>
        <label>
          End
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
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
        <button type="button" className="fd-link-btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
          Add Session
        </button>
      </div>
    </form>
  );
}
