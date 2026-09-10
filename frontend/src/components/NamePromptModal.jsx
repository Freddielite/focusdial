import { useState } from "react";
import { motion } from "framer-motion";
import { updateProfile } from "../api.js";

// Shown once per session (via App.jsx's `dismissed` local state, not
// persisted) whenever the signed-in account has no display_name yet -
// covers both a genuinely new signup and any existing account from
// before this existed. "Skip for now" is a real, respected option, not
// a nag: if skipped, this just won't reappear until the app is
// reloaded, and every place that would've used the name (see HeroCard,
// WeeklyReviewCard, computeInsightOfTheDay, and the push notifications
// in cron.js) already falls back to reading fine without one - nothing
// downstream assumes a name is set.
export default function NamePromptModal({ onUserUpdated, onDismiss }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter a name, or skip for now.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProfile(trimmed);
      onUserUpdated(updated);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <motion.div
      className="fd-modal-overlay"
      onClick={onDismiss}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <motion.div
        className="fd-panel fd-modal-panel fd-confirm-panel"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ duration: 0.2 }}
      >
        <div className="fd-panel__label">What should we call you?</div>
        <div className="fd-confirm-body">
          Used to personalize greetings, your weekly review, and notifications - not shown to anyone else.
        </div>
        <form onSubmit={handleSave}>
          <input
            type="text"
            className="fd-select"
            placeholder="Your name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={80}
            autoFocus
          />
          {error && <div className="fd-inline-error">{error}</div>}
          <div className="fd-confirm-actions">
            <button type="button" className="fd-link-btn" onClick={onDismiss}>
              Skip for now
            </button>
            <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
