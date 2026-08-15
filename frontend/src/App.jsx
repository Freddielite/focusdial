import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Splash from "./components/Splash.jsx";
import TabNav from "./components/TabNav.jsx";
import { useNotifications } from "./hooks/useNotifications.js";
import ThemeToggle from "./components/ThemeToggle.jsx";
import FocusMark from "./components/FocusMark.jsx";
import NotificationBell from "./components/NotificationBell.jsx";
import { useTheme } from "./hooks/useTheme.js";
import { useToast } from "./components/Toast.jsx";
import TodayView from "./components/TodayView.jsx";
import InsightsView from "./components/InsightsView.jsx";
import BudgetsView from "./components/BudgetsView.jsx";
import DeadlinesView from "./components/DeadlinesView.jsx";
import RemindersView from "./components/RemindersView.jsx";
import SettingsView from "./components/SettingsView.jsx";
import { maybePushEvent } from "./push.js";
import { formatDuration } from "./format.js";
import {
  listTags,
  getSessionHistory,
  listBudgets,
  listDeadlines,
  listReminders,
  listTasks,
  getSettings,
  updateSettings,
  setSlowRequestHandler,
} from "./api.js";
import { computeSummary, computeBudgetProgress, computeDeadlineProgress, computeInsightOfTheDay, computeRiskDigest, computeWeeklyReview, computeDeadlineTrackRecord, computeGoalProjection } from "./analytics.js";

const DEFAULT_SETTINGS = {
  push_enabled: true,
  automation_reminders: true,
  automation_deadline_pace: true,
  automation_streak: true,
  automation_runaway_timer: true,
  automation_weekly_digest: true,
  notify_session_completed: true,
  notify_deadline_completed: true,
  notify_budget_reached: true,
  rest_day_of_week: null,
  daily_focus_goal_seconds: null,
  weekly_digest_day_of_week: 0,
  weekly_digest_hour: 19,
};

const WORSENING_PACE = new Set(["tight", "behind", "overdue"]);
const PACE_COPY = {
  tight: "Pace is getting tight, a bit more each day keeps this on track.",
  behind: "You've fallen behind pace on this deadline.",
  overdue: "This deadline is now overdue.",
};

const VALID_TABS = new Set(["today", "insights", "budgets", "deadlines", "reminders", "settings"]);

export default function App({ user, onLogout, onUserUpdated }) {
  const [showSplash, setShowSplash] = useState(true);
  // Home-screen shortcuts (see manifest.webmanifest's `shortcuts`) deep
  // link via ?tab=... — read once at mount rather than defaulting to
  // "today" and switching in an effect, so there's no visible flash of
  // the wrong tab before the switch happens.
  const [activeTab, setActiveTab] = useState(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return VALID_TABS.has(tab) ? tab : "today";
  });
  // Set when a link elsewhere (e.g. Budgets tab's "Manage budgets")
  // wants Settings to open scrolled to and highlighting a specific
  // section, instead of just landing at the top. SettingsView consumes
  // and clears it once it's scrolled there.
  const [settingsScrollTarget, setSettingsScrollTarget] = useState(null);
  const [theme, setTheme] = useTheme();
  const [nowTick, setNowTick] = useState(Date.now());
  const toast = useToast();
  const notifications = useNotifications();
  // Every event that's worth a toast is also worth a line in the bell
  // panel — one call keeps both in sync instead of duplicating the
  // payload at each of the six call sites below.
  const notify = useCallback(
    (payload) => {
      toast(payload);
      notifications.push(payload);
    },
    [toast, notifications]
  );

  const [tags, setTags] = useState([]);
  const [history, setHistory] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [deadlines, setDeadlines] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  // Bumped whenever a session is started/stopped or manually added
  // elsewhere on the Today tab (Timer, Manual entry) -- SessionLog fetches
  // its own paginated data independently (see its own component), so
  // this is the one signal it needs from outside itself: "something new
  // landed, go back to page 1 and reload."
  const [sessionsVersion, setSessionsVersion] = useState(0);

  const [waking, setWaking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  async function loadAll() {
    try {
      const [tagData, hist, budgetData, deadlineData, reminderData, taskData, settingsData] =
        await Promise.all([
          listTags(),
          getSessionHistory(),
          listBudgets(),
          listDeadlines(),
          listReminders(),
          listTasks(),
          getSettings().catch(() => DEFAULT_SETTINGS),
        ]);
      setTags(tagData);
      setHistory(hist);
      setBudgets(budgetData);
      setDeadlines(deadlineData);
      setReminders(reminderData);
      setTasks(taskData);
      if (settingsData) setSettings({ ...DEFAULT_SETTINGS, ...settingsData });
      setError(null);
      setLoaded(true);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    setSlowRequestHandler(setWaking);
    loadAll();

    // Registers the browser's real UTC offset with the backend once per
    // load, so the cron job (see backend/src/routes/cron.js) can
    // approximate "what day/hour is it for this person" for streak and
    // deadline checks made while the app itself is closed. Sign is
    // flipped because JS's getTimezoneOffset() is backwards from the
    // usual +N convention (returns -60 for UTC+1, not +60).
    //
    // Also registers the real IANA zone name (e.g. "Africa/Lagos") when
    // the browser exposes one (universally supported in evergreen
    // browsers at this point) -- cron.js prefers this over the raw
    // offset, since a fixed offset alone can't account for DST
    // transitions. Both are sent; the offset stays as a fallback for
    // whatever cron.js can't resolve the zone name for.
    let resolvedTimezone = null;
    try {
      resolvedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      // Intl unavailable/misconfigured -- offset-only fallback below.
    }
    updateSettings({
      timezone_offset_minutes: -new Date().getTimezoneOffset(),
      timezone: resolvedTimezone,
    }).catch(() => {});

    // Backend's OAuth callback (routes/googleAuth.js) redirects back
    // here with this query param rather than the frontend polling for
    // connection state — the handshake itself happens entirely on
    // Google's + the backend's side, so this is just picking up the
    // result. history.replaceState strips the param afterward so a
    // refresh doesn't re-show the toast.
    const params = new URLSearchParams(window.location.search);
    const googleAuthResult = params.get("googleAuth");
    const authResult = params.get("authResult");
    if (googleAuthResult === "connected") {
      toast({ title: "Google Calendar connected", body: "Deadlines and reminders will now sync." });
    } else if (googleAuthResult === "error") {
      toast({ title: "Couldn't connect Google Calendar", body: "Please try again.", tone: "danger" });
    } else if (authResult === "success") {
      // The failure case (authResult=error) is handled in AuthGate.jsx
      // instead — a failed sign-in never reaches this component at all,
      // since AuthRoot only renders App once there's an authenticated
      // user.
      toast({ title: "Signed in with Google" });
    }
    if (googleAuthResult) {
      params.delete("googleAuth");
    }
    if (authResult) {
      params.delete("authResult");
    }
    if (params.has("tab")) {
      params.delete("tab");
    }
    if (googleAuthResult || authResult || window.location.search.includes("tab=")) {
      const cleaned = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
      window.history.replaceState({}, "", cleaned);
    }

    // Drives the streak-at-risk check and the in-app reminder toasts
    // without needing fresh server data — just re-evaluates the current
    // time every minute.
    const tickTimer = setInterval(() => setNowTick(Date.now()), 60000);

    return () => {
      setSlowRequestHandler(null);
      clearInterval(tickTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optimistic settings update: flip the toggle immediately, persist in
  // the background, and roll back if the server rejects it. Keeps the
  // Settings switches feeling instant while staying the single source of
  // truth the notification logic below reads from.
  async function updateSetting(key, value) {
    const prev = settings;
    setSettings((s) => ({ ...s, [key]: value }));
    try {
      await updateSettings({ [key]: value });
    } catch (err) {
      setSettings(prev);
      toast({ title: "Couldn't save that setting", body: err.message, tone: "danger" });
    }
  }

  const summary = useMemo(
    () => computeSummary(history, settings.rest_day_of_week ?? null),
    [history, settings.rest_day_of_week]
  );
  const budgetsWithProgress = useMemo(
    () => computeBudgetProgress(budgets, history),
    [budgets, history]
  );
  const deadlinesWithProgress = useMemo(
    () => computeDeadlineProgress(deadlines, history, summary.avgDailyFocusSeconds),
    [deadlines, history, summary.avgDailyFocusSeconds]
  );
  const insightOfTheDay = useMemo(
    () => computeInsightOfTheDay({ summary, budgetsProgress: budgetsWithProgress, deadlinesProgress: deadlinesWithProgress }),
    [summary, budgetsWithProgress, deadlinesWithProgress]
  );
  const riskDigest = useMemo(
    () => computeRiskDigest({ budgetsProgress: budgetsWithProgress, deadlinesProgress: deadlinesWithProgress }),
    [budgetsWithProgress, deadlinesWithProgress]
  );
  const weeklyReview = useMemo(
    () => computeWeeklyReview({ sessions: history, deadlinesProgress: deadlinesWithProgress, reminders }),
    [history, deadlinesWithProgress, reminders]
  );
  const deadlineTrackRecord = useMemo(
    () => computeDeadlineTrackRecord(deadlinesWithProgress),
    [deadlinesWithProgress]
  );

  // In-app version of the same "streak at risk" check the backend cron
  // job does for push notifications — this one only needs to run while
  // the app is actually open. A configured rest day is never "at risk"
  // since it doesn't break the streak either way (see analytics.js).
  const streakAtRisk = useMemo(() => {
    const nowDate = new Date(nowTick);
    const hour = nowDate.getHours();
    const isRestDay = settings.rest_day_of_week != null && nowDate.getDay() === settings.rest_day_of_week;
    return hour >= 19 && summary.todaySeconds === 0 && summary.streakDays > 0 && !isRestDay;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowTick, summary.todaySeconds, summary.streakDays, settings.rest_day_of_week]);

  // Same-pace "will I hit today's goal" projection, only worth surfacing
  // once enough of the day has actually happened to extrapolate from
  // (see computeGoalProjection) and only shown in the evening window —
  // an 11am reminder about tonight's goal is noise, not signal.
  const goalProjection = useMemo(() => {
    const nowDate = new Date(nowTick);
    if (nowDate.getHours() < 18) return null;
    return computeGoalProjection({
      todaySeconds: summary.todaySeconds,
      dailyGoalSeconds: settings.daily_focus_goal_seconds,
      now: nowDate,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowTick, summary.todaySeconds, settings.daily_focus_goal_seconds]);

  // ---- Notification orchestration --------------------------------
  // Every event shows an in-app toast. The three "in-app events"
  // (session/deadline/budget) additionally fire a push, but only when
  // the app is backgrounded (see maybePushEvent). The three cron-driven
  // automations (reminders/pace/streak) already push from the server, so
  // here they only surface a toast when the app is open. Each is gated
  // by its own Settings toggle so a toggle silences both channels.
  const paceStatusRef = useRef(new Map());
  const budgetMetRef = useRef(new Set());
  const toastedReminderRef = useRef(new Set());
  const prevStreakRef = useRef(false);
  const initRef = useRef(false);

  // Seed the "previous state" refs on the first populated load so we
  // don't toast a backlog of already-true conditions on startup.
  useEffect(() => {
    if (!loaded || initRef.current) return;
    for (const d of deadlinesWithProgress) paceStatusRef.current.set(d.id, d.status);
    for (const b of budgetsWithProgress) if (b.pct >= 1) budgetMetRef.current.add(b.id);
    for (const r of reminders) {
      if (new Date(r.remind_at) <= new Date()) toastedReminderRef.current.add(r.id);
    }
    prevStreakRef.current = streakAtRisk;
    initRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Deadlines: completion + worsening pace.
  useEffect(() => {
    if (!initRef.current) return;
    for (const d of deadlinesWithProgress) {
      const prev = paceStatusRef.current.get(d.id);
      if (prev === d.status) continue;

      if (d.status === "done" && prev !== "done") {
        if (settings.notify_deadline_completed) {
          notify({ title: "Deadline complete", body: `“${d.title}” is done.`, tone: "success" });
          maybePushEvent("deadline_completed", "Deadline complete", `“${d.title}” is done.`);
        }
      } else if (WORSENING_PACE.has(d.status) && !WORSENING_PACE.has(prev)) {
        if (settings.automation_deadline_pace) {
          notify({ title: `Pace change: ${d.title}`, body: PACE_COPY[d.status], tone: "warn" });
        }
      }
      paceStatusRef.current.set(d.id, d.status);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadlinesWithProgress]);

  // Budgets: crossing the weekly target.
  useEffect(() => {
    if (!initRef.current) return;
    for (const b of budgetsWithProgress) {
      const wasMet = budgetMetRef.current.has(b.id);
      if (b.pct >= 1 && !wasMet) {
        budgetMetRef.current.add(b.id);
        if (settings.notify_budget_reached) {
          notify({ title: "Budget goal reached", body: `“${b.name}” hit its weekly target.`, tone: "success" });
          maybePushEvent("budget_reached", "Budget goal reached", `“${b.name}” hit its weekly target.`);
        }
      } else if (b.pct < 1 && wasMet) {
        // New week / target raised — allow it to fire again later.
        budgetMetRef.current.delete(b.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetsWithProgress]);

  // Reminders coming due while the app is open.
  useEffect(() => {
    if (!initRef.current) return;
    const now = new Date();
    for (const r of reminders) {
      if (r.status !== "pending") continue;
      if (new Date(r.remind_at) <= now && !toastedReminderRef.current.has(r.id)) {
        toastedReminderRef.current.add(r.id);
        if (settings.automation_reminders) {
          notify({ title: "Reminder", body: r.title, tone: "default" });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminders, nowTick]);

  // Streak flipping into "at risk".
  useEffect(() => {
    if (!initRef.current) return;
    if (streakAtRisk && !prevStreakRef.current && settings.automation_streak) {
      notify({
        title: "Streak at risk",
        body: `Log a session before midnight to keep your ${summary.streakDays}-day streak.`,
        tone: "warn",
      });
    }
    prevStreakRef.current = streakAtRisk;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streakAtRisk]);

  function handleSessionCompleted(completed) {
    if (completed?.started_at && completed?.ended_at && settings.notify_session_completed) {
      const secs = (new Date(completed.ended_at) - new Date(completed.started_at)) / 1000;
      const body = `${formatDuration(secs)} logged.`;
      notify({ title: "Session complete", body, tone: "success" });
      maybePushEvent("session_completed", "Session complete", body);
    }
    loadAll();
    setSessionsVersion((v) => v + 1);
  }
  function handleSessionCreated() {
    loadAll();
    setSessionsVersion((v) => v + 1);
  }
  // SessionLog owns its own paginated fetch of the raw session list now
  // (see that component), so this only needs to keep the *analytics*
  // copy (`history`, from GET /sessions/history) in sync -- everything
  // derived from it (today's total, streaks, tag-linked deadline
  // progress, etc.) would otherwise stay stale until the next full
  // reload.
  function handleSessionDeleted(id) {
    setHistory((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div className="fd-app">
      <AnimatePresence>{showSplash && <Splash onComplete={() => setShowSplash(false)} />}</AnimatePresence>

      {!showSplash && (
        <motion.div
          className="fd-shell"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          <header className="fd-header">
            <div className="fd-header__brand">
              <FocusMark size={22} strokeWidth={2.1} className="fd-header__mark" />
              FocusDial
            </div>
            <TabNav active={activeTab} onChange={setActiveTab} />
            <div className="fd-header__actions">
              <NotificationBell notifications={notifications} />
              <ThemeToggle theme={theme} onChange={setTheme} />
            </div>
          </header>

          <AnimatePresence>
            {waking && (
              <motion.div
                className="fd-banner"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
              >
                Waking up the server. Free-tier hosting spins down when idle, first response can
                take up to a minute.
              </motion.div>
            )}
            {!waking && error && (
              <motion.div
                className="fd-banner fd-banner--error"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
              >
                {error}
              </motion.div>
            )}
            {!waking && !error && streakAtRisk && (
              <motion.div
                className="fd-banner fd-banner--streak"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
              >
                Your {summary.streakDays}-day streak is at risk. Log a session before midnight to
                keep it going.
              </motion.div>
            )}
          </AnimatePresence>

          <main className="fd-main">
            {!loaded ? (
              <div className="fd-loading">Loading your focus journal…</div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                {activeTab === "today" && (
                  <TodayView
                    key="today"
                    tags={tags}
                    summary={summary}
                    streakAtRisk={streakAtRisk}
                    sessionsVersion={sessionsVersion}
                    tasks={tasks}
                    insightOfTheDay={insightOfTheDay}
                    dailyGoalSeconds={settings.daily_focus_goal_seconds}
                    goalProjection={goalProjection}
                    onSessionCompleted={handleSessionCompleted}
                    onSessionCreated={handleSessionCreated}
                    onSessionDeleted={handleSessionDeleted}
                    onDataChanged={loadAll}
                  />
                )}
                {activeTab === "insights" && (
                  <InsightsView
                    key="insights"
                    summary={summary}
                    riskDigest={riskDigest}
                    weeklyReview={weeklyReview}
                    deadlineTrackRecord={deadlineTrackRecord}
                  />
                )}
                {activeTab === "budgets" && (
                  <BudgetsView
                    key="budgets"
                    budgets={budgetsWithProgress}
                    onGoToSettings={() => {
                      setSettingsScrollTarget("budgets");
                      setActiveTab("settings");
                    }}
                  />
                )}
                {activeTab === "deadlines" && (
                  <DeadlinesView
                    key="deadlines"
                    deadlines={deadlinesWithProgress}
                    tags={tags}
                    avgDailyFocusSeconds={summary.avgDailyFocusSeconds}
                    onDataChanged={loadAll}
                  />
                )}
                {activeTab === "reminders" && (
                  <RemindersView key="reminders" reminders={reminders} tags={tags} onDataChanged={loadAll} />
                )}
                {activeTab === "settings" && (
                  <SettingsView
                    key="settings"
                    settings={settings}
                    onUpdateSetting={updateSetting}
                    theme={theme}
                    onThemeChange={setTheme}
                    tags={tags}
                    budgets={budgetsWithProgress}
                    onDataChanged={loadAll}
                    user={user}
                    onUserUpdated={onUserUpdated}
                    onLogout={onLogout}
                    scrollTarget={settingsScrollTarget}
                    onScrollTargetConsumed={() => setSettingsScrollTarget(null)}
                  />
                )}
              </AnimatePresence>
            )}
          </main>
        </motion.div>
      )}
    </div>
  );
}
