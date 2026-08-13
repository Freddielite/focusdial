import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../format.js";

// Fixed width per bar column so labels always have enough room to sit
// under their own bar without crowding into the next one — the chart
// scrolls horizontally instead of squeezing columns to fit.
const COLUMN_WIDTH = 44;

// Must match .fd-trend-chart's padding-top in App.css. Bar heights are
// percentages of the chart's USABLE height (below this padding), but
// the average line's "bottom" offset — being a plain CSS percentage —
// resolves against the chart's FULL height (padding included). Same
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

export default function TrendChart({ weeklyTotals, monthlyTotals, weekOverWeek }) {
  const [view, setView] = useState("week");
  const now = new Date();
  const data = view === "week" ? weeklyTotals : monthlyTotals;

  // The current (in-progress) period is excluded from the average and
  // drawn with a dashed outline instead of a solid fill — comparing a
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

  // Every bar gets a fixed-width column and its own label — the chart
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
            onClick={() => setView("week")}
          >
            Weekly
          </button>
          <button
            className={`fd-trend-toggle__btn ${view === "month" ? "fd-trend-toggle__btn--active" : ""}`}
            onClick={() => setView("month")}
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
              // 140px-usable-height ruler the bars use — see
              // CHART_TOP_PADDING above — instead of a bare percentage
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
              <div
                className={`fd-trend-bar ${d.isCurrent ? "fd-trend-bar--current" : ""}`}
                style={{ height: `${Math.max((d.seconds / maxSeconds) * 100, d.seconds > 0 ? 3 : 0)}%` }}
                title={`${view === "week" ? weekLabel(d.periodStart) : monthLabel(d.periodStart, now)}: ${formatDuration(d.seconds)}${d.isCurrent ? " (in progress)" : ""}`}
              />
              <div className="fd-trend-bar-label">
                {view === "week" ? weekLabel(d.periodStart) : monthLabel(d.periodStart, now)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
