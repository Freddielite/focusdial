import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import FocusMark from "./FocusMark.jsx";

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

// Same tone glyphs as Toast.jsx, kept in sync so an entry looks the same
// whether you caught it as a toast or found it later in the bell panel.
function ToneIcon({ tone }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
  if (tone === "success") return <svg {...common}><path d="M20 6 9 17l-5-5" /></svg>;
  if (tone === "warn") return <svg {...common}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>;
  if (tone === "danger") return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>;
  return <FocusMark size={16} strokeWidth={2.1} />;
}

function timeAgo(ts) {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

const PANEL_WIDTH = 340;
const VIEWPORT_MARGIN = 12; // min gap kept between the panel and either screen edge
const GAP_BELOW_BELL = 10;

export default function NotificationBell({ notifications }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { top, left, width, originX } in viewport px, or null until measured
  const wrapRef = useRef(null);
  const { items, unreadCount, markRead, markAllRead, clearAll } = notifications;

  // Anchoring the panel to the bell's own small wrapper (as before) broke
  // on phones: the bell isn't flush against the screen edge - the theme
  // toggle sits to its right - so a right:0 offset off that wrapper let
  // the panel's left edge run off-screen. Measuring the bell's actual
  // getBoundingClientRect and clamping against window width fixes that
  // on any layout, not just this one.
  function measure() {
    const btn = wrapRef.current?.querySelector(".fd-bell-btn");
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const idealLeft = rect.right - width; // right-align to the bell by default
    const left = Math.min(
      Math.max(idealLeft, VIEWPORT_MARGIN),
      window.innerWidth - width - VIEWPORT_MARGIN
    );
    const top = rect.bottom + GAP_BELOW_BELL;
    // Where the bell's center falls within the panel's own box, for the
    // grow-from-icon transform-origin - clamped so it never lands
    // outside the panel itself on very narrow screens.
    const originX = Math.min(Math.max(rect.left + rect.width / 2 - left, 12), width - 12);
    setPos({ top, left, width, originX });
  }

  useEffect(() => {
    if (!open) return undefined;
    measure();
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClickOutside);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  return (
    <div className="fd-bell-wrap" ref={wrapRef}>
      <button
        type="button"
        className="fd-theme-btn fd-bell-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        title="Notifications"
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="fd-bell-btn__badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
        )}
      </button>

      <AnimatePresence>
        {open && pos && (
          <motion.div
            className="fd-bell-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            style={{ top: pos.top, left: pos.left, width: pos.width, transformOrigin: `${pos.originX}px top` }}
            initial={{ opacity: 0, scale: 0.85, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: -6 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
          >
            <div className="fd-bell-panel__head">
              <span>Notifications</span>
              <button className="fd-bell-panel__close" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>

            {items.length > 0 && (
              <div className="fd-bell-panel__actions">
                <button className="fd-link-btn" onClick={markAllRead} disabled={unreadCount === 0}>
                  Mark all read
                </button>
                <button className="fd-link-btn" onClick={clearAll}>
                  Clear all
                </button>
              </div>
            )}

            <div className="fd-bell-panel__list">
              {items.length === 0 ? (
                <div className="fd-bell-empty">Nothing yet. You're all caught up.</div>
              ) : (
                items.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`fd-bell-item ${n.read ? "" : "fd-bell-item--unread"}`}
                    onClick={() => markRead(n.id)}
                  >
                    <span className={`fd-bell-item__icon fd-bell-item__icon--${n.tone}`}>
                      <ToneIcon tone={n.tone} />
                    </span>
                    <span className="fd-bell-item__body">
                      <span className="fd-bell-item__title">{n.title}</span>
                      {n.body && <span className="fd-bell-item__text">{n.body}</span>}
                      <span className="fd-bell-item__time">{timeAgo(n.createdAt)}</span>
                    </span>
                    {!n.read && <span className="fd-bell-item__dot" aria-hidden="true" />}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
