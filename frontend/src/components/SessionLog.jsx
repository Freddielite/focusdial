import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { formatDuration } from "../format.js";
import { deleteSession, listRecentSessions } from "../api.js";
import { useConfirm } from "./ConfirmDialog.jsx";
import { useUndoableDelete } from "../hooks/useUndoableDelete.js";
import SessionEditModal from "./SessionEditModal.jsx";
import Dropdown from "./Dropdown.jsx";
import { DatePicker } from "./DateTimeField.jsx";

// Same clock glyph as the Today tab icon - each row tints it with the
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

export const QUALITY_LABEL = { focused: "Focused", neutral: "Neutral", distracted: "Distracted" };
const PAGE_SIZE = 10;

// DatePicker works in local "YYYY-MM-DD" strings; the backend wants a
// real instant to compare started_at against. Building that instant in
// the browser (rather than sending the bare date and having the server
// guess a day boundary) is what keeps "Aug 12 to Aug 14" matching the
// sessions this person actually saw happen on those local calendar
// days, same reasoning as ManualEntryForm's own local-time-in/ISO-out
// conversion.
function rangeStartISO(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
function rangeEndISO(dateStr) {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

export default function SessionLog({ sessionsVersion, tags, tasks, onSessionDeleted, onSessionUpdated }) {
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null); // id of the session row being edited, or null
  // Optimistically hides a row the instant delete is confirmed, without
  // waiting for the real DELETE call (which useUndoableDelete holds off
  // on for a few seconds in case of Undo).
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const confirm = useConfirm();
  const requestDelete = useUndoableDelete();

  // Search/filter bar state. searchInput is what the text field shows;
  // search is the debounced value actually sent to the server, so
  // typing doesn't fire a request per keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tagId, setTagId] = useState("");
  const [quality, setQuality] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [periodStats, setPeriodStats] = useState(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(debounceRef.current);
  }, [searchInput]);

  const hasFilters = Boolean(search || tagId || quality || dateFrom || dateTo);
  const rangeInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo);

  function currentFilters() {
    return {
      q: search || undefined,
      tagId: tagId || undefined,
      quality: quality || undefined,
      from: dateFrom ? rangeStartISO(dateFrom) : undefined,
      to: dateTo ? rangeEndISO(dateTo) : undefined,
    };
  }

  async function load(pageNum, { withTotal = true } = {}) {
    if (rangeInvalid) {
      setError("'From' date must be before 'To' date.");
      setSessions([]);
      setPeriodStats(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { sessions: rows, total: count, periodStats: stats } = await listRecentSessions(
        PAGE_SIZE,
        (pageNum - 1) * PAGE_SIZE,
        withTotal,
        currentFilters()
      );
      setSessions(rows);
      if (count !== null) setTotal(count);
      setPeriodStats(stats ?? null);
      setPage(pageNum);
      setPendingIds(new Set());
      setEditingId(null);
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
  // after adding something to a list that's newest-first. The total can
  // genuinely have changed here (a session was added), so this is one
  // of the few calls that keeps the default withTotal: true.
  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsVersion]);

  // Any filter change also jumps back to page 1 (whatever page 3 meant
  // under the old filter set has no fixed meaning under the new one) and
  // needs a fresh total, since narrowing/widening the filters changes
  // how many rows match. Skipped on mount -- the sessionsVersion effect
  // above already covers the initial load, so this would otherwise fire
  // a redundant second request for the very first render.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, tagId, quality, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Plain paging: the row count on this page can change, the total
  // number of sessions across all pages cannot -- so skip re-querying
  // it on every click.
  function goToPage(pageNum) {
    load(pageNum, { withTotal: false });
  }

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setTagId("");
    setQuality("");
    setDateFrom("");
    setDateTo("");
  }

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
        // Deleting a row changes the total, so this is the other case
        // (besides initial load) that needs the real count back --
        // also lands on whatever the new last page is instead of
        // showing an empty page if this was the sole item on one past
        // page 1.
        const newTotal = Math.max(0, total - 1);
        const newLastPage = Math.max(1, Math.ceil(newTotal / PAGE_SIZE));
        load(Math.min(page, newLastPage));
      },
    });
  }

  function handleSaved(updated) {
    onSessionUpdated?.(updated);
    // An edit can't change how many sessions exist, just their content
    // -- no need to recount.
    load(page, { withTotal: false });
  }

  const visibleSessions = sessions.filter((s) => !pendingIds.has(s.id));

  return (
    <div className="fd-panel fd-log-panel">
      <div className="fd-panel__label">Recent Sessions</div>

      <div className="fd-log-filters">
        <input
          type="text"
          className="fd-log-filters__search"
          placeholder="Search note, tag, or task…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          aria-label="Search sessions"
        />
        <Dropdown className="fd-select fd-select--sm" value={tagId} onChange={(e) => setTagId(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Dropdown>
        <Dropdown className="fd-select fd-select--sm" value={quality} onChange={(e) => setQuality(e.target.value)}>
          <option value="">All qualities</option>
          {Object.entries(QUALITY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Dropdown>
        <div className="fd-log-filters__date-range">
          <DatePicker value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="From" className="fd-log-filters__date" />
          <span className="fd-log-filters__date-sep">to</span>
          <DatePicker value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="To" className="fd-log-filters__date" />
        </div>
        {hasFilters && (
          <button type="button" className="fd-link-btn fd-log-filters__clear" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {periodStats && !rangeInvalid && (
        <div className="fd-log-period-stats">
          <div className="fd-log-period-stats__item">
            <span className="fd-log-period-stats__value">{formatDuration(periodStats.totalSeconds)}</span>
            <span className="fd-log-period-stats__label">
              {periodStats.sessionCount} session{periodStats.sessionCount === 1 ? "" : "s"} in range
            </span>
          </div>
          <div className="fd-log-period-stats__item">
            {periodStats.topTag ? (
              <>
                <span className="fd-log-period-stats__value">
                  <span className="fd-quality-dot" style={{ background: periodStats.topTag.color || "var(--accent-session)" }} />
                  {periodStats.topTag.name}
                </span>
                <span className="fd-log-period-stats__label">top tag ({formatDuration(periodStats.topTag.totalSeconds)})</span>
              </>
            ) : (
              <>
                <span className="fd-log-period-stats__value">—</span>
                <span className="fd-log-period-stats__label">top tag</span>
              </>
            )}
          </div>
          <div className="fd-log-period-stats__item">
            <span className="fd-log-period-stats__value">
              {periodStats.quality.ratePct === null ? "—" : `${Math.round(periodStats.quality.ratePct)}%`}
            </span>
            <span className="fd-log-period-stats__label">
              focused{periodStats.quality.rated > 0 ? ` (${periodStats.quality.rated} rated)` : ", no ratings yet"}
            </span>
          </div>
        </div>
      )}

      {error && <div className="fd-inline-error">{error}</div>}
      {!loading && !error && visibleSessions.length === 0 && (
        <div className="fd-empty">
          {hasFilters ? "No sessions match your filters." : "No sessions yet. Start the timer above."}
        </div>
      )}
      <div className={`fd-log-list ${loading ? "fd-log-list--loading" : ""}`}>
        {visibleSessions.map((s) => {
          const seconds =
            (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000;
          return (
            <div key={s.id} className="fd-log-row-wrap">
              <div className="fd-log-row fd-check-card" style={{ "--check-accent": s.tag_color || "var(--accent-session)" }}>
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
                  {s.task_title && (
                    <span className="fd-check-card__note fd-log-row__task-badge">✓ {s.task_title}</span>
                  )}
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
                <button
                  className="fd-icon-btn"
                  onClick={() => setEditingId((id) => (id === s.id ? null : s.id))}
                  aria-label="Edit session"
                >
                  ✎
                </button>
                <button className="fd-icon-btn" onClick={() => handleDelete(s)} aria-label="Delete session">
                  ✕
                </button>
              </div>
              <AnimatePresence initial={false}>
                {editingId === s.id && (
                  <SessionEditModal
                    session={s}
                    tags={tags}
                    tasks={tasks}
                    onCancel={() => setEditingId(null)}
                    onSaved={(updated) => {
                      setEditingId(null);
                      handleSaved(updated);
                    }}
                  />
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
      {total > PAGE_SIZE && (
        <div className="fd-pagination">
          <button
            type="button"
            className="fd-link-btn"
            onClick={() => goToPage(page - 1)}
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
            onClick={() => goToPage(page + 1)}
            disabled={loading || page >= totalPages}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
