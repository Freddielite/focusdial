import { useEffect, useState } from "react";
import { formatDuration } from "../format.js";
import { deleteSession, listRecentSessions } from "../api.js";
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
const PAGE_SIZE = 10;

export default function SessionLog({ sessionsVersion, tags, onSessionDeleted, onSessionUpdated }) {
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // the session row being edited, or null
  // Optimistically hides a row the instant delete is confirmed, without
  // waiting for the real DELETE call (which useUndoableDelete holds off
  // on for a few seconds in case of Undo).
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  async function load(pageNum) {
    setLoading(true);
    setError(null);
    try {
      const { sessions: rows, total: count } = await listRecentSessions(
        PAGE_SIZE,
        (pageNum - 1) * PAGE_SIZE
      );
      setSessions(rows);
      setTotal(count);
      setPage(pageNum);
      setPendingIds(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Fetches its own page independently of App.jsx's `loadAll` -- the
  // one thing it can't know on its own is "a new session just got
  // created/completed elsewhere on this tab" (Timer, Manual entry both
  // live outside this component), which is what `sessionsVersion`
  // signals. A bump there jumps back to page 1, same as most apps do
  // after adding something to a list that's newest-first.
  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsVersion]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      afterCommit: () => {
        onSessionDeleted?.(session.id);
        // If this was the last item on a page beyond the first, land on
        // whatever the new last page is instead of showing an empty
        // page -- otherwise deleting the sole item on the last page
        // leaves you stranded looking at nothing with no way back
        // except the Prev button.
        const newTotal = Math.max(0, total - 1);
        const newLastPage = Math.max(1, Math.ceil(newTotal / PAGE_SIZE));
        load(Math.min(page, newLastPage));
      },
    });
  }

  function handleSaved(updated) {
    onSessionUpdated?.(updated);
    load(page);
  }

  const visibleSessions = sessions.filter((s) => !pendingIds.has(s.id));

  return (
    <div className="fd-panel fd-log-panel">
      <div className="fd-panel__label">Recent Sessions</div>
      {error && <div className="fd-inline-error">{error}</div>}
      {!loading && visibleSessions.length === 0 && (
        <div className="fd-empty">No sessions yet. Start the timer above.</div>
      )}
      <div className={`fd-log-list ${loading ? "fd-log-list--loading" : ""}`}>
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
      {total > PAGE_SIZE && (
        <div className="fd-pagination">
          <button
            type="button"
            className="fd-link-btn"
            onClick={() => load(page - 1)}
            disabled={loading || page <= 1}
          >
            ← Prev
          </button>
          <span className="fd-pagination__status">
            Page {page} of {totalPages} · {total} sessions
          </span>
          <button
            type="button"
            className="fd-link-btn"
            onClick={() => load(page + 1)}
            disabled={loading || page >= totalPages}
          >
            Next →
          </button>
        </div>
      )}
      {editing && (
        <SessionEditModal
          session={editing}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            handleSaved(updated);
          }}
        />
      )}
    </div>
  );
}
