import { motion } from "framer-motion";

// Same glyph family as the app's other icon badges (Bulb = "here's a
// thought"), tinted per-tone rather than tied to one fixed category
// color the way Budgets/Deadlines/Reminders icons are - this card's
// color changes with what it's actually saying (danger/warning/
// positive/neutral), not a fixed identity.
function BulbIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a6 6 0 0 0-4 10.5c.7.6 1 1.3 1 2.5h6c0-1.2.3-1.9 1-2.5A6 6 0 0 0 12 2z" />
    </svg>
  );
}

// One auto-generated observation, picked from everything the app
// already knows (see analytics.js's computeInsightOfTheDay) - the
// single most notable thing today, rather than making the person read
// every chart on the Insights tab themselves to notice it.
export default function InsightCard({ insight }) {
  if (!insight) return null;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`fd-panel fd-insight-card fd-insight-card--${insight.tone}`}
    >
      <span className="fd-insight-card__icon">
        <BulbIcon />
      </span>
      <p className="fd-insight-card__message">{insight.message}</p>
    </motion.div>
  );
}
