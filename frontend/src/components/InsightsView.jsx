import { motion } from "framer-motion";
import HourDial from "./HourDial.jsx";
import CalendarHeatmap from "./CalendarHeatmap.jsx";
import TagBreakdown from "./TagBreakdown.jsx";
import TrendChart from "./TrendChart.jsx";
import WeekdayBreakdown from "./WeekdayBreakdown.jsx";
import FocusQualityCard from "./FocusQualityCard.jsx";
import RiskDigestCard from "./RiskDigestCard.jsx";
import WeeklyReviewCard from "./WeeklyReviewCard.jsx";

export default function InsightsView({ summary, riskDigest, weeklyReview }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fd-view"
    >
      <WeeklyReviewCard review={weeklyReview} />
      <div className="fd-main__insights">
        <HourDial hourly={summary.hourly} bestHour={summary.bestHour} />
        <RiskDigestCard digest={riskDigest} />
        <CalendarHeatmap daily={summary.daily} streakDays={summary.streakDays} />
        <TagBreakdown byTag={summary.byTag} mostSustainedTag={summary.mostSustainedTag} />
        <WeekdayBreakdown weekday={summary.weekday} bestWeekday={summary.bestWeekday} />
        <FocusQualityCard quality={summary.quality} />
      </div>
      <TrendChart
        weeklyTotals={summary.weeklyTotals}
        monthlyTotals={summary.monthlyTotals}
        weekOverWeek={summary.weekOverWeek}
      />
    </motion.div>
  );
}
