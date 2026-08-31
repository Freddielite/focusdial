import { motion } from "framer-motion";
import HeroCard from "./HeroCard.jsx";
import InsightCard from "./InsightCard.jsx";
import TimerPanel from "./TimerPanel.jsx";
import ManualEntryForm from "./ManualEntryForm.jsx";
import StatsStrip from "./StatsStrip.jsx";
import SessionLog from "./SessionLog.jsx";
import TasksWidget from "./TasksWidget.jsx";
import PriorityCard from "./PriorityCard.jsx";
import SuggestionCard from "./SuggestionCard.jsx";

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
  priorityRanking,
  suggestion,
  hasRunningSession,
  onRunningChange,
  onSessionCompleted,
  onSessionCreated,
  onSessionStarted,
  onDismissSuggestion,
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
      <HeroCard
        summary={summary}
        streakAtRisk={streakAtRisk}
        dailyGoalSeconds={dailyGoalSeconds}
        goalProjection={goalProjection}
        startTimeAnomaly={summary.startTimeAnomaly}
        graceEnabled={graceEnabled}
        userName={userName}
      />
      <InsightCard insight={insightOfTheDay} />

      {/* Feature 1 + Feature 6 of the priority engine. Sit above the
          task list per the feature spec ("a prominent card... above the
          existing task list") - placed here, above the two-column
          fd-main__top block, rather than squeezed into the side column
          next to TasksWidget, since "prominent" reads as full-width like
          HeroCard/InsightCard above, not a narrow column card. Suggestion
          only ever appears when PriorityCard isn't already confident
          about something (see computeUnscheduledSuggestion's own
          SUGGESTION_MIN_COMPETING_SCORE gate), so the two are never
          fighting for attention at once - but both use `ranked.length`
          being 0 as one of several reasons they might not render, so
          both are checked independently rather than one implying the
          other. */}
      {priorityRanking.ranked.length > 0 && (
        <PriorityCard
          ranked={priorityRanking.ranked}
          hasRunningSession={hasRunningSession}
          onSessionStarted={onSessionStarted}
        />
      )}
      {suggestion && (
        <SuggestionCard
          suggestion={suggestion}
          hasRunningSession={hasRunningSession}
          onSessionStarted={onSessionStarted}
          onDismiss={onDismissSuggestion}
        />
      )}

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
          <TasksWidget tasks={tasks} tags={tags} tagEstimateStats={priorityRanking.tagEstimateStats} onDataChanged={onDataChanged} />
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
