import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../format.js";

// Fixed width per bar column so labels always have enough room to sit
// under their own bar without crowding into the next one - the chart
// scrolls horizontally instead of squeezing columns to fit.
const COLUMN_WIDTH = 44;

// Must match .fd-trend-chart's padding-top in App.css. Bar heights are
// percentages of the chart's USABLE height (below this padding), but
// the average line's "bottom" offset - being a plain CSS percentage - // resolves against the chart's FULL height (padding included). Same
// percentage value, two different rulers, so the line floated above
// where it should sit relative to the bars. Reusing this constant in a
// calc() below (100% - CHART_TOP_PADDING) puts both on the same ruler.
const CHART_TOP_PADDING = 20;

function weekLabel(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function monthLabel(date, now) {
  const opts = { month: "short" };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "2-digit";
  return date.toLocaleDateString(undefined, opts);
}

// End of the period a given bar covers - a week runs Monday through the
// following Monday (exclusive), a month through the 1st of the next one.
// Needed to slice `history` down to just the sessions that landed inside
// the clicked bar, the same overlap-by-start-time approach
// WeekdayBreakdown/CalendarHeatmap use for their own detail views.
function periodEnd(periodStart, view) {
  if (view === "week") return new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);
}

function sessionsForPeriod(history, periodStart, view) {
  const end = periodEnd(periodStart, view);
  return history
    .filter((s) => {
      const started = new Date(s.started_at);
      return started >= periodStart && started < end;
    })
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
}

function tagBreakdownFor(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.tag_id || "untagged";
    const seconds = (new Date(s.ended_at) - new Date(s.started_at)) / 1000;
    const existing = map.get(key) || {
      name: s.tag_name || "Untagged",
      color: s.tag_color || "var(--accent-session)",
      seconds: 0,
      count: 0,
    };
    existing.seconds += seconds;
    existing.count += 1;
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => b.seconds - a.seconds);
}

export default function TrendChart({ weeklyTotals, monthlyTotals, weekOverWeek, history }) {
  const [view, setView] = useState("week");
  // The clicked bar's data point, or null. Cleared on a view toggle
  // (week/month) since a selection from one view's bars doesn't map to
  // anything meaningful in the other.
  const [selected, setSelected] = useState(null);
  const now = new Date();
  const data = view === "week" ? weeklyTotals : monthlyTotals;

  // The current (in-progress) period is excluded from the average and
  // drawn with a dashed outline instead of a solid fill - comparing a
  // half-finished week against completed ones would be misleading, and
  // the visual distinction makes that obvious at a glance rather than
  // needing a caption to explain it.
  //
  // computeWeeklyTotals/computeMonthlyTotals always zero-fill a fixed
  // window (12 weeks / 6 months) regardless of when the account was
  // first used, so a new account shows mostly empty leading periods.
  // Averaging over those dragged the line down near 0%, which visually
  // collided with the axis labels below it. Average only from the
  // first period that actually has time logged, same "since you
  // started" reasoning computeAvgDailyFocusSeconds already uses.
  const firstUsedIndex = data.findIndex((d) => d.seconds > 0);
  const completed = data
    .filter((d) => !d.isCurrent)
    .filter((d) => firstUsedIndex === -1 || data.indexOf(d) >= firstUsedIndex);
  const average = completed.length
    ? completed.reduce((sum, d) => sum + d.seconds, 0) / completed.length
    : 0;
  const maxSeconds = Math.max(...data.map((d) => d.seconds), average, 1);

  const scrollRef = useRef(null);

  // Every bar gets a fixed-width column and its own label - the chart
  // scrolls horizontally instead of thinning bars/labels to fit, so
  // nothing overlaps at any screen width. Land on the most recent
  // period (right edge) since that's what you came here to check.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [view, data.length]);

  return (
    <div className="fd-panel fd-trend-panel">
      <div className="fd-trend-panel__head">
        <div className="fd-panel__label" style={{ marginBottom: 0 }}>
          Trend
        </div>
        {view === "week" && weekOverWeek && weekOverWeek.deltaPct !== null && (
          <span
            className={`fd-wow-badge ${weekOverWeek.deltaPct >= 0 ? "fd-wow-badge--up" : "fd-wow-badge--down"}`}
            title="This week so far vs. the same days last week"
          >
            {weekOverWeek.deltaPct >= 0 ? "▲" : "▼"} {Math.abs(Math.round(weekOverWeek.deltaPct * 100))}% vs last
            week
          </span>
        )}
        <div className="fd-trend-toggle">
          <button
            className={`fd-trend-toggle__btn ${view === "week" ? "fd-trend-toggle__btn--active" : ""}`}
            onClick={() => {
              setView("week");
              setSelected(null);
            }}
          >
            Weekly
          </button>
          <button
            className={`fd-trend-toggle__btn ${view === "month" ? "fd-trend-toggle__btn--active" : ""}`}
            onClick={() => {
              setView("month");
              setSelected(null);
            }}
          >
            Monthly
          </button>
        </div>
      </div>

      <div className="fd-trend-chart-scroll" ref={scrollRef}>
        <div className="fd-trend-chart" style={{ minWidth: `${data.length * COLUMN_WIDTH}px` }}>
          {average > 0 && (
            <div
              className="fd-trend-average-line"
              // Clamped (in fraction terms, before the calc) so the line
              // never sits low enough to overlap the axis labels under
              // the bars, and never gets pushed past the top of the
              // chart on the flip side. The calc() puts this on the same
              // 140px-usable-height ruler the bars use - see
              // CHART_TOP_PADDING above - instead of a bare percentage
              // of the chart's full padded height.
              style={{
                bottom: `calc((100% - ${CHART_TOP_PADDING}px) * ${Math.min(Math.max(average / maxSeconds, 0.1), 0.92)})`,
              }}
            >
              <span className="fd-trend-average-label">avg {formatDuration(average)}</span>
            </div>
          )}
          {data.map((d) => (
            <div key={d.periodStart.toISOString()} className="fd-trend-bar-col" style={{ width: `${COLUMN_WIDTH}px` }}>
              <button
                type="button"
                className={`fd-trend-bar ${d.isCurrent ? "fd-trend-bar--current" : ""}`}
                style={{ height: `${Math.max((d.seconds / maxSeconds) * 100, d.seconds > 0 ? 3 : 0)}%` }}
                title={`${view === "week" ? weekLabel(d.periodStart) : monthLabel(d.periodStart, now)}: ${formatDuration(d.seconds)}${d.isCurrent ? " (in progress)" : ""}`}
                onClick={() => setSelected(d)}
              />
              <div className="fd-trend-bar-label">
                {view === "week" ? weekLabel(d.periodStart) : monthLabel(d.periodStart, now)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {selected &&
        (() => {
          const detailSessions = sessionsForPeriod(history, selected.periodStart, view);
          const detailTags = tagBreakdownFor(detailSessions);
          const maxTagSeconds = Math.max(...detailTags.map((t) => t.seconds), 1);
          const label = view === "week" ? weekLabel(selected.periodStart) : monthLabel(selected.periodStart, now);
          return (
            <div className="fd-modal-overlay" onClick={() => setSelected(null)}>
              <div className="fd-panel fd-modal-panel fd-day-detail-panel" onClick={(e) => e.stopPropagation()}>
                <div className="fd-panel__label" style={{ marginBottom: 0 }}>
                  {view === "week" ? `Week of ${label}` : label}
                  {selected.isCurrent ? " (in progress)" : ""}
                </div>
                <div className="fd-day-detail__total">
                  {formatDuration(selected.seconds)} logged
                  {detailSessions.length > 0 &&
                    ` across ${detailSessions.length} session${detailSessions.length === 1 ? "" : "s"}`}
                </div>

                {detailTags.length === 0 ? (
                  <div className="fd-empty">Nothing logged this {view === "week" ? "week" : "month"}.</div>
                ) : (
                  <div className="fd-tag-list fd-day-detail__list">
                    {detailTags.map((t) => (
                      <div key={t.name} className="fd-tag-row">
                        <div className="fd-tag-row__head">
                          <span className="fd-tag-dot" style={{ background: t.color }} />
                          <span className="fd-tag-row__name">
                            {t.name} ({t.count})
                          </span>
                          <span className="fd-tag-row__total">{formatDuration(t.seconds)}</span>
                        </div>
                        <div className="fd-tag-row__bar-track">
                          <div
                            className="fd-tag-row__bar"
                            style={{ width: `${(t.seconds / maxTagSeconds) * 100}%`, background: t.color }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <button type="button" className="fd-link-btn fd-day-detail__close" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
