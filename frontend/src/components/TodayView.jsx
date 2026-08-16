import { motion } from "framer-motion";
import Greeting from "./Greeting.jsx";
import HeroCard from "./HeroCard.jsx";
import InsightCard from "./InsightCard.jsx";
import TimerPanel from "./TimerPanel.jsx";
import ManualEntryForm from "./ManualEntryForm.jsx";
import StatsStrip from "./StatsStrip.jsx";
import SessionLog from "./SessionLog.jsx";
import TasksWidget from "./TasksWidget.jsx";

export default function TodayView({
  tags,
  allTags,
  summary,
  streakAtRisk,
  sessionsVersion,
  tasks,
  insightOfTheDay,
  dailyGoalSeconds,
  goalProjection,
  graceEnabled,
  tagVocabulary,
  userName,
  onRunningChange,
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
      <Greeting name={userName} />
      <HeroCard
        summary={summary}
        streakAtRisk={streakAtRisk}
        dailyGoalSeconds={dailyGoalSeconds}
        goalProjection={goalProjection}
        startTimeAnomaly={summary.startTimeAnomaly}
        graceEnabled={graceEnabled}
      />
      <InsightCard insight={insightOfTheDay} />

      <div className="fd-main__top">
        <div className="fd-main__timer-col">
          <TimerPanel
            tags={tags}
            tasks={tasks}
            hourlyTagSuggestions={summary.hourlyTagSuggestions}
            tagVocabulary={tagVocabulary}
            onSessionCompleted={onSessionCompleted}
            onDataChanged={onDataChanged}
            onRunningChange={onRunningChange}
          />
          <ManualEntryForm tags={tags} tasks={tasks} onSessionCreated={onSessionCreated} onDataChanged={onDataChanged} />
        </div>
        <div className="fd-main__side-col">
          <StatsStrip summary={summary} />
          <TasksWidget tasks={tasks} onDataChanged={onDataChanged} />
        </div>
      </div>
      <SessionLog
        sessionsVersion={sessionsVersion}
        tags={allTags}
        tasks={tasks}
        onSessionDeleted={onSessionDeleted}
        onSessionUpdated={onDataChanged}
      />
    </motion.div>
  );
}
