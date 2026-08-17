import { useEffect } from "react";
import { motion } from "framer-motion";

const LOCK_DELAY_MS = 650; // when the brackets finish closing and the dot/flash fire
const HOLD_AFTER_LOCK_MS = 750;

// Reticle mark: same four corner-bracket paths as FocusMark.jsx (kept as a
// separate static component there since it's used elsewhere - header, toast
// default icon - and doesn't need to be animated in those spots). Here the
// brackets are wrapped in a motion.g that scales in from outside the
// viewBox toward center, so they visually "converge" onto the focus point
// like a camera racking into focus, instead of just fading in place.
export default function Splash({ onComplete }) {
  useEffect(() => {
    const timer = setTimeout(onComplete, LOCK_DELAY_MS + HOLD_AFTER_LOCK_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      className="fd-splash"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.6, ease: "easeInOut" } }}
    >
      <div className="fd-splash__body">
        <svg
          className="fd-splash__mark"
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <motion.g
            style={{ transformOrigin: "12px 12px" }}
            initial={{ scale: 1.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.85, ease: [0.16, 1, 0.3, 1] }}
          >
            <path d="M8 4H5a1 1 0 0 0-1 1v3" />
            <path d="M16 4h3a1 1 0 0 1 1 1v3" />
            <path d="M4 16v3a1 1 0 0 0 1 1h3" />
            <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
          </motion.g>

          {/* Center point - pops in with a slight spring overshoot right as
              the brackets finish closing, selling the "lock" moment. */}
          <motion.circle
            cx="12"
            cy="12"
            r="1.6"
            fill="currentColor"
            stroke="none"
            style={{ transformOrigin: "12px 12px" }}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.65, type: "spring", stiffness: 420, damping: 14 }}
          />

          {/* Brass flash ring that expands and fades from the center point
              at the same instant - the "focus acquired" beat. */}
          <motion.circle
            cx="12"
            cy="12"
            r="1.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            initial={{ opacity: 0.8, r: 1.6 }}
            animate={{ opacity: 0, r: 9 }}
            transition={{ delay: 0.65, duration: 0.55, ease: "easeOut" }}
          />
        </svg>
      </div>
    </motion.div>
  );
}
