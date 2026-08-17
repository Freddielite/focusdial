import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

// Inline stroke icons (no icon dependency). Each is drawn at 22×22 in a
// 24-box so it optically matches the serif wordmark's weight. They pull
// double duty: labels-beside on the desktop header, icons-over-label in
// the fixed mobile bottom bar (see App.css).
function TabIcon({ id }) {
  const p = {
    width: 22, height: 22, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
  };
  switch (id) {
    case "today":
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "insights":
      return <svg {...p}><path d="M3 3v18h18" /><path d="M7 15l3-4 3 2 4-6" /></svg>;
    case "budgets":
      return <svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>;
    case "deadlines":
      return <svg {...p}><path d="M5 3v18" /><path d="M5 4h11l-2 3 2 3H5" /></svg>;
    case "reminders":
      return <svg {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>;
    case "settings":
      return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>;
    default:
      return null;
  }
}

export const TABS = [
  { id: "today", label: "Today" },
  { id: "insights", label: "Insights" },
  { id: "budgets", label: "Budgets" },
  { id: "deadlines", label: "Deadlines" },
  { id: "reminders", label: "Reminders" },
  { id: "settings", label: "Settings" },
];

// The indicator used to be a per-button element animated via framer-motion's
// layoutId shared-layout transition. That approach measures start/end
// position with getBoundingClientRect(), which is viewport-relative - if the
// page had been scrolled since the last measurement, the FLIP delta framer
// computes is off by the scroll amount, so instead of sliding across it
// snaps. offsetLeft/offsetWidth are relative to the nearest positioned
// ancestor (the nav itself), not the viewport, so they're unaffected by
// scroll position entirely - sidesteps the bug rather than chasing it.
export default function TabNav({ active, onChange }) {
  const navRef = useRef(null);
  const btnRefs = useRef({});
  const [indicator, setIndicator] = useState(null);

  useLayoutEffect(() => {
    function measure() {
      const btn = btnRefs.current[active];
      if (!btn) return;
      const isMobile = window.matchMedia("(max-width: 720px)").matches;
      const left = isMobile
        ? btn.offsetLeft + btn.offsetWidth / 2 - 13
        : btn.offsetLeft + 12;
      const width = isMobile ? 26 : btn.offsetWidth - 24;
      setIndicator({ left, width });
    }
    measure();

    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    if (navRef.current) ro.observe(navRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [active]);

  return (
    <nav className="fd-tabnav" aria-label="Sections" ref={navRef}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => (btnRefs.current[tab.id] = el)}
          className={`fd-tabnav__btn ${active === tab.id ? "fd-tabnav__btn--active" : ""}`}
          onClick={() => onChange(tab.id)}
          aria-current={active === tab.id ? "page" : undefined}
        >
          <span className="fd-tabnav__icon"><TabIcon id={tab.id} /></span>
          <span className="fd-tabnav__label">{tab.label}</span>
        </button>
      ))}
      {indicator && (
        <motion.div
          className="fd-tabnav__indicator"
          initial={false}
          animate={{ left: indicator.left, width: indicator.width }}
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
    </nav>
  );
}
