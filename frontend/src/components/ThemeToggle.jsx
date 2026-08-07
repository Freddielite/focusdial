import { AnimatePresence, motion } from "framer-motion";

// Cycle order matches the label order people expect from the old
// segmented control: Auto → Light → Dark → Auto. One button, and the
// icon itself tells you the current mode (half-dial for Auto, sun for
// Light, moon for Dark), the way the ledger app's crescent button does.
const ORDER = ["system", "light", "dark"];
const NEXT = { system: "light", light: "dark", dark: "system" };
const LABEL = { system: "Auto", light: "Light", dark: "Dark" };

function Icon({ theme }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
  if (theme === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...common}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    );
  }
  // Auto — the half-filled dial, echoing FocusDial's mark
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function ThemeToggle({ theme, onChange }) {
  const current = ORDER.includes(theme) ? theme : "system";
  return (
    <button
      type="button"
      className="fd-theme-btn"
      onClick={() => onChange(NEXT[current])}
      aria-label={`Theme: ${LABEL[current]}. Tap to switch.`}
      title={`Theme: ${LABEL[current]}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={current}
          className="fd-theme-btn__icon"
          initial={{ rotate: -35, opacity: 0, scale: 0.6 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          exit={{ rotate: 35, opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.22 }}
        >
          <Icon theme={current} />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
