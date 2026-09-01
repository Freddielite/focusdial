import { motion } from "framer-motion";
import HourDial from "./HourDial.jsx";
import CalendarHeatmap from "./CalendarHeatmap.jsx";
import TagBreakdown from "./TagBreakdown.jsx";
import TrendChart from "./TrendChart.jsx";
import WeekdayBreakdown from "./WeekdayBreakdown.jsx";
import ComparativeInsightsCard from "./ComparativeInsightsCard.jsx";
import FocusQualityCard from "./FocusQualityCard.jsx";
import ConsistencyCard from "./ConsistencyCard.jsx";
import RiskDigestCard from "./RiskDigestCard.jsx";
import WeeklyReviewCard from "./WeeklyReviewCard.jsx";
import MonthlyReviewCard from "./MonthlyReviewCard.jsx";
import DeadlineTrackRecordCard from "./DeadlineTrackRecordCard.jsx";
import EstimateAccuracyCard from "./EstimateAccuracyCard.jsx";
import MilestonesCard from "./MilestonesCard.jsx";

export default function InsightsView({
  summary,
  riskDigest,
  weeklyReview,
  monthlyReview,
  deadlineTrackRecord,
  history,
  userName,
  tagEstimateStats,
  allTags,
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fd-view"
    >
      <WeeklyReviewCard review={weeklyReview} userName={userName} />
      <MonthlyReviewCard review={monthlyReview} />
      <div className="fd-main__insights">
        <HourDial hourly={summary.hourly} bestHour={summary.bestHour} />
        <RiskDigestCard digest={riskDigest} />
        <CalendarHeatmap daily={summary.daily} streakDays={summary.streakDays} history={history} />
        <TagBreakdown byTag={summary.byTag} mostSustainedTag={summary.mostSustainedTag} />
        <WeekdayBreakdown weekday={summary.weekday} bestWeekday={summary.bestWeekday} history={history} />
        <ComparativeInsightsCard insights={summary.comparativeInsights} />
        <FocusQualityCard quality={summary.quality} />
        <ConsistencyCard consistency={summary.consistency} />
        <DeadlineTrackRecordCard trackRecord={deadlineTrackRecord} />
        <EstimateAccuracyCard stats={tagEstimateStats} tags={allTags} />
        <MilestonesCard milestones={summary.milestones} />
      </div>
      <TrendChart
        weeklyTotals={summary.weeklyTotals}
        monthlyTotals={summary.monthlyTotals}
        weekOverWeek={summary.weekOverWeek}
        history={history}
      />
    </motion.div>
  );
}
