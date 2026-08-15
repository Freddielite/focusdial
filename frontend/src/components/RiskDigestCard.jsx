import { motion, AnimatePresence } from "framer-motion";

function WarnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

// One glanceable "what needs attention" list on Today, combining
// Budgets and Deadlines instead of leaving it to two separate tabs - // see analytics.js's computeRiskDigest for the cross-matching (a tag
// behind on both its budget and a deadline shows as one line, not two).
// Renders nothing when everything's on track, rather than a hollow
// "all clear" card taking up space every single day.
export default function RiskDigestCard({ digest }) {
  if (!digest || digest.allClear) return null;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="fd-panel fd-risk-card"
    >
      <div className="fd-panel__label">Needs attention</div>
      <div className="fd-risk-card__list">
        <AnimatePresence initial={false}>
          {digest.items.map((item) => (
            <motion.div
              key={item.key}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={`fd-risk-card__item fd-risk-card__item--${item.tone}`}
            >
              <span className="fd-risk-card__icon">
                <WarnIcon />
              </span>
              <span>{item.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
