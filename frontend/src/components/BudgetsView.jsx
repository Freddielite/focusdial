import { motion, AnimatePresence } from "framer-motion";
import { formatDuration } from "../format.js";

function statusForPct(pct) {
  if (pct >= 1) return { label: "Goal met", tone: "focus-green" };
  if (pct >= 0.7) return { label: "On track", tone: "brass" };
  return { label: "Behind", tone: "dim" };
}

// Wallet glyph — the budget category's icon. Each card is tinted with
// the budget's own color (b.color) rather than one fixed accent, same
// as the tag-dot/progress-bar already were — budgets already carry a
// per-item color, so the checklist icon reuses it instead of flattening
// to a single category color the way deadlines/reminders do.
function WalletIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="12" rx="3" />
      <path d="M3 11h18" />
      <circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

// View-only progress dashboard. Creating budgets, deleting them, and
// wiring tags to them all live in Settings → Manage now (see
// BudgetManager) so this tab stays a clean at-a-glance read of how the
// week is going.
export default function BudgetsView({ budgets, onGoToSettings }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fd-view"
    >
      <div className="fd-view__head">
        <div className="fd-panel__label" style={{ marginBottom: 0 }}>
          Weekly time budgets
        </div>
        {onGoToSettings && (
          <button className="fd-link-btn" onClick={onGoToSettings}>
            Manage budgets
          </button>
        )}
      </div>

      {budgets.length === 0 && (
        <div className="fd-empty">
          No budgets yet. Add one in Settings → Manage to start tracking a weekly time goal.
        </div>
      )}

      <div className="fd-budget-grid">
        <AnimatePresence initial={false}>
          {budgets.map((b) => {
            const status = statusForPct(b.pct);
            return (
              <motion.div
                key={b.id}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.25 }}
                className="fd-panel fd-budget-card"
                style={{ "--check-accent": b.color }}
              >
                <div className="fd-check-card">
                  <span className="fd-check-card__icon">
                    <WalletIcon />
                  </span>
                  <div className="fd-check-card__body">
                    <span className="fd-check-card__title">{b.name}</span>
                    <span className={`fd-check-card__meta fd-budget-card__status--${status.tone}`}>
                      ★ {status.label}
                    </span>
                  </div>
                  <div className="fd-check-card__value">
                    <span className="fd-check-card__value-num">{formatDuration(b.actualSeconds)}</span>
                    <span className="fd-check-card__value-unit">of {formatDuration(b.targetSeconds)}</span>
                  </div>
                </div>

                <div className="fd-tag-row__bar-track">
                  <motion.div
                    className="fd-tag-row__bar"
                    style={{ background: b.color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(b.pct, 1) * 100}%` }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                </div>

                {b.remainingSeconds > 0 && b.hoursLeftInWeek > 0 && (
                  <div className="fd-deadline-card__pace">
                    {b.hoursLeftInWeek < 24 ? (
                      <>
                        Need <strong>{formatDuration(b.remainingSeconds)}</strong> today to hit this week's
                        goal.
                      </>
                    ) : (
                      <>
                        Need <strong>{formatDuration(b.secondsPerDayNeeded)}/day</strong> for the rest of the
                        week ({formatDuration(b.remainingSeconds)} total) to hit this week's goal.
                      </>
                    )}
                  </div>
                )}

                {(b.tags || []).length > 0 && (
                  <div className="fd-budget-card__tags">
                    {b.tags.map((t) => (
                      <span key={t.id} className="fd-tag-chip fd-tag-chip--static" style={{ borderColor: t.color }}>
                        <span className="fd-tag-dot" style={{ background: t.color }} />
                        {t.name}
                      </span>
                    ))}
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
