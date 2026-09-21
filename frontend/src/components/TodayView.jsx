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
import OpenSlotsCard from "./OpenSlotsCard.jsx";

// Same hand-drawn feather-style icon convention as NotificationBell.jsx/
// InsightCard.jsx (stroke=currentColor, no fill) rather than an icon
// library - sun for the morning plan, moon for the evening reflection,
// same pairing as the dark-mode toggle already uses elsewhere in the app.
function SunIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
    </svg>
  );
}

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
  openSlots,
  onOpenDailyPlan,
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
      {onOpenDailyPlan && (
        <div className="fd-daily-ritual-cards">
          <button type="button" className="fd-daily-ritual-card" onClick={() => onOpenDailyPlan("morning")}>
            <span className="fd-daily-ritual-card__icon">
              <SunIcon />
            </span>
            <span className="fd-daily-ritual-card__label">Plan my day</span>
          </button>
          <button type="button" className="fd-daily-ritual-card" onClick={() => onOpenDailyPlan("evening")}>
            <span className="fd-daily-ritual-card__icon">
              <MoonIcon />
            </span>
            <span className="fd-daily-ritual-card__label">Reflect on today</span>
          </button>
        </div>
      )}
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
      <OpenSlotsCard
        openSlots={openSlots}
        ranked={priorityRanking.ranked}
        hasRunningSession={hasRunningSession}
        onSessionStarted={onSessionStarted}
      />

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
