import { motion } from "framer-motion";
import HeroCard from "./HeroCard.jsx";
import TimerPanel from "./TimerPanel.jsx";
import ManualEntryForm from "./ManualEntryForm.jsx";
import StatsStrip from "./StatsStrip.jsx";
import SessionLog from "./SessionLog.jsx";
import TasksWidget from "./TasksWidget.jsx";

export default function TodayView({
  tags,
  summary,
  streakAtRisk,
  sessionsVersion,
  tasks,
  onSessionCompleted,
  onSessionCreated,
  onSessionDeleted,
  onDataChanged,
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fd-view"
    >
      <HeroCard summary={summary} streakAtRisk={streakAtRisk} />

      <div className="fd-main__top">
        <div className="fd-main__timer-col">
          <TimerPanel tags={tags} hourlyTagSuggestions={summary.hourlyTagSuggestions} onSessionCompleted={onSessionCompleted} />
          <ManualEntryForm tags={tags} onSessionCreated={onSessionCreated} />
        </div>
        <div className="fd-main__side-col">
          <StatsStrip summary={summary} />
          <TasksWidget tasks={tasks} onDataChanged={onDataChanged} />
        </div>
      </div>
      <SessionLog
        sessionsVersion={sessionsVersion}
        tags={tags}
        onSessionDeleted={onSessionDeleted}
        onSessionUpdated={onDataChanged}
      />
    </motion.div>
  );
}
