const DIRECTION_ICON = { more: "▲", less: "▼" };

// Turns the weekday chart already shown in WeekdayBreakdown into
// plain-language callouts -- "23% more on Tuesdays than your daily
// average" says the same thing the bar chart shows, but as a sentence
// instead of something you have to eyeball and do the mental math on
// yourself. See computeComparativeInsights in analytics.js for the
// occurrence/deviation bars that decide what's actually worth saying.
//
// "less" isn't styled as a warning (unlike RiskDigestCard's rust tone)
// -- a quiet weekend or a lighter Friday isn't something wrong, just an
// observation, so both directions get the same neutral treatment aside
// from the arrow.
export default function ComparativeInsightsCard({ insights }) {
  if (!insights || insights.length === 0) {
    return (
      <div className="fd-panel fd-comparative-card">
        <div className="fd-panel__label">Comparative Insights</div>
        <div className="fd-empty">
          Keep logging sessions across a few weeks and this will start calling out days that
          run noticeably above or below your usual pace.
        </div>
      </div>
    );
  }

  return (
    <div className="fd-panel fd-comparative-card">
      <div className="fd-panel__label">Comparative Insights</div>
      <div className="fd-comparative-card__list">
        {insights.map((item) => (
          <div key={item.id} className={`fd-comparative-card__item fd-comparative-card__item--${item.direction}`}>
            <span className="fd-comparative-card__icon">{DIRECTION_ICON[item.direction]}</span>
            <span>{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
