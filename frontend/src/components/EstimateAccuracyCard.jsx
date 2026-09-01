import { ESTIMATE_HINT_MIN_SAMPLES } from "../priorityEngine.js";

// Surfaces computeTagEstimateStats (priorityEngine.js's Feature 2) as its
// own Insights view rather than leaving it to only ever back the Quick
// Tasks estimate hint - "your estimate accuracy by category" was called
// out as a natural follow-up once there's enough completed-task history
// to make it worth looking at (see HANDOVER's Session 45 follow-up
// ideas), and the underlying stats already exist; this just gives them
// a place to be seen on their own.
//
// Same >=2-samples bar as the Quick Tasks hint (ESTIMATE_HINT_MIN_SAMPLES,
// imported rather than redefined here) - a tag with only one completed,
// estimated task doesn't have a real pattern yet, just one data point.

// Same 15%-relative-gap bar the rest of the app already uses for "is
// this difference big enough to mention" (computeContextSwitchCost,
// computeComparativeInsights, the estimate hint itself) - a ratio this
// close to 1 reads as "about right," not a real over/under-estimate.
const ACCURATE_BAND = 0.15;
// Beyond this, "usually takes X% longer" stops being a mild miss and
// starts being a real planning problem worth a stronger color - the
// same "some things need a louder signal than others" split
// computeDeadlineProgress's tight/behind statuses already draw.
const SEVERE_OVER_RATIO = 1.5;

function describeRatio(ratio) {
  if (Math.abs(ratio - 1) < ACCURATE_BAND) {
    return { text: "Estimates for this category are usually about right.", tone: "good" };
  }
  if (ratio > 1) {
    return {
      text: `Usually takes about ${Math.round((ratio - 1) * 100)}% longer than estimated.`,
      tone: ratio >= SEVERE_OVER_RATIO ? "warn" : "brass",
    };
  }
  // Finishing faster than estimated isn't a problem the way running
  // long is - same "less isn't styled as a warning" reasoning
  // ComparativeInsightsCard already applies to a quieter-than-average
  // weekday - so this gets the neutral/dim tone, not a color implying
  // something's wrong.
  return {
    text: `Usually finishes about ${Math.round((1 - ratio) * 100)}% faster than estimated.`,
    tone: "dim",
  };
}

// `tags` should be the full active+archived list (see App.jsx's
// `allTags`), not just active tags - a completed, estimated task logged
// under a since-archived tag is still real estimate-accuracy history
// and should still show its real name/color, not fall back to
// "Untagged."
export default function EstimateAccuracyCard({ stats, tags }) {
  const tagById = new Map((tags || []).map((t) => [t.id, t]));
  const rows = [...stats.entries()]
    .filter(([, info]) => info.samples >= ESTIMATE_HINT_MIN_SAMPLES)
    .map(([tagId, info]) => {
      const tag = tagById.get(tagId);
      const described = describeRatio(info.ratio);
      return {
        tagId,
        name: tag?.name || "Untagged",
        color: tag?.color || "#8C8074",
        ratio: info.ratio,
        samples: info.samples,
        ...described,
      };
    })
    // Biggest surprises first - same "lead with the largest deviation"
    // ordering ComparativeInsightsCard's candidates already use.
    .sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));

  if (rows.length === 0) {
    return (
      <div className="fd-panel fd-estimate-card">
        <div className="fd-panel__label">Estimate Accuracy</div>
        <div className="fd-empty">
          Complete a few tasks with a category and a time estimate to see how your estimates
          compare to actual time logged.
        </div>
      </div>
    );
  }

  return (
    <div className="fd-panel fd-estimate-card">
      <div className="fd-panel__label">Estimate Accuracy</div>
      <div className="fd-tag-list">
        {rows.map((r) => (
          <div key={r.tagId} className="fd-estimate-card__row">
            <div className="fd-tag-row__head">
              <span className="fd-tag-dot" style={{ background: r.color }} />
              <span className="fd-tag-row__name">{r.name}</span>
              <span className={`fd-estimate-card__pill fd-estimate-card__pill--${r.tone}`}>
                {r.ratio.toFixed(1)}x
              </span>
            </div>
            <div className="fd-estimate-card__meta">
              {r.text} ({r.samples} task{r.samples === 1 ? "" : "s"})
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
