import { useState } from "react";
import { formatDuration } from "../format.js";
import { deleteSession } from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";
import SessionEditModal from "./SessionEditModal.jsx";

// Same clock glyph as the Today tab icon — each row tints it with the
// session's tag color when one is set, falling back to the session
// category accent otherwise (matches how budget cards use their own
// per-item color instead of one flat category color).
function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const QUALITY_LABEL = { focused: "Focused", neutral: "Neutral", distracted: "Distracted" };

export default function SessionLog({ sessions, tags, onSessionDeleted, onSessionUpdated }) {
  const [editing, setEditing] = useState(null); // the session row being edited, or null
  // Optimistically hides a row the instant delete is confirmed, without
  // waiting for the real DELETE call (which useUndoableDelete holds off
  // on for a few seconds in case of Undo) — sessions live in App.jsx's
  // state, not this component's, so hiding here is purely a render-layer
  // filter rather than mutating the actual list.
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  async function handleDelete(session) {
    const ok = await confirm({
      title: "Delete this session?",
      body: `${session.tag_name || "Untagged"} - ${formatDuration(
        (new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 1000
      )}. You'll have a few seconds to undo.`,
    });
    if (!ok) return;

    setPendingIds((prev) => new Set(prev).add(session.id));
    requestDelete({
      id: session.id,
      label: "Session",
      onHide: () => {}, // already hidden above, before the confirm-delay toast even shows
      onRestore: () =>
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        }),
      deleteFn: () => deleteSession(session.id),
      afterCommit: () => onSessionDeleted(session.id),
    });
  }

  const visibleSessions = sessions.filter((s) => !pendingIds.has(s.id));

  return (
    <div className="fd-panel fd-log-panel">
      <div className="fd-panel__label">Recent Sessions</div>
      {visibleSessions.length === 0 && <div className="fd-empty">No sessions yet. Start the timer above.</div>}
      <div className="fd-log-list">
        {visibleSessions.map((s) => {
          const seconds =
            (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
          return (
            <div key={s.id} className="fd-log-row fd-check-card" style={{ "--check-accent": s.tag_color || "var(--accent-session)" }}>
              <span className="fd-check-card__icon">
                <ClockIcon />
              </span>
              <div className="fd-check-card__body">
                <span className="fd-check-card__title">{s.tag_name || "Untagged"}</span>
                <span className="fd-check-card__meta">
                  ★{" "}
                  {new Date(s.started_at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                {s.note && <span className="fd-check-card__note">{s.note}</span>}
              </div>
              <div className="fd-check-card__value">
                <span className="fd-check-card__value-num">
                  {s.quality && (
                    <span
                      className={`fd-quality-dot fd-quality-dot--${s.quality}`}
                      title={QUALITY_LABEL[s.quality]}
                    />
                  )}
                  {formatDuration(seconds)}
                </span>
              </div>
              <button className="fd-icon-btn" onClick={() => setEditing(s)} aria-label="Edit session">
                ✎
              </button>
              <button className="fd-icon-btn" onClick={() => handleDelete(s)} aria-label="Delete session">
                ✕
              </button>
            </div>
          );
        })}
      </div>
      {editing && (
        <SessionEditModal
          session={editing}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={onSessionUpdated}
        />
      )}
    </div>
  );
}
