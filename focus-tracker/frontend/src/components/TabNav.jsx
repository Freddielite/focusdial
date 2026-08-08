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

export default function TabNav({ active, onChange }) {
  return (
    <nav className="fd-tabnav" aria-label="Sections">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`fd-tabnav__btn ${active === tab.id ? "fd-tabnav__btn--active" : ""}`}
          onClick={() => onChange(tab.id)}
          aria-current={active === tab.id ? "page" : undefined}
        >
          <span className="fd-tabnav__icon"><TabIcon id={tab.id} /></span>
          <span className="fd-tabnav__label">{tab.label}</span>
          {active === tab.id && (
            <motion.div className="fd-tabnav__indicator" layoutId="tabnav-indicator" />
          )}
        </button>
      ))}
    </nav>
  );
}
