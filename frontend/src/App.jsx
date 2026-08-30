import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Splash from "./components/Splash.jsx";
import TopLoadingBar from "./components/TopLoadingBar.jsx";
import PullToRefresh from "./components/PullToRefresh.jsx";
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
import NamePromptModal from "./components/NamePromptModal.jsx";
import { maybePushEvent } from "./push.js";
import { formatDuration, firstName } from "./format.js";
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
import { computeSummary, computeBudgetProgress, computeDeadlineProgress, computeInsightOfTheDay, computeRiskDigest, computeWeeklyReview, computeDeadlineTrackRecord, computeGoalProjection, buildTagVocabulary } from "./analytics.js";

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
  streak_recovery_grace_enabled: false,
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
  // Every place this app addresses someone by name (greeting, weekly
  // review title, streak message, push notifications) wants just the
  // first word of whatever's in `displayName` - see firstName's own
  // comment in format.js. Computed once here rather than at each call
  // site so there's one place, not several, doing that reduction.
  const userFirstName = user?.displayName ? firstName(user.displayName) : null;
  const [showSplash, setShowSplash] = useState(true);
  // Local-only, not persisted - "Skip for now" means "not this session,"
  // not "never ask again." See NamePromptModal for why that's the
  // deliberate choice rather than a stored dismissal flag.
  const [namePromptDismissed, setNamePromptDismissed] = useState(false);
  // Home-screen shortcuts (see manifest.webmanifest's `shortcuts`) deep
  // link via ?tab=... - read once at mount rather than defaulting to
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
  // The page itself is the scroll container (.fd-main has no overflow
  // of its own), and nothing else resets that scroll position on tab
  // switches - so scrolling to the bottom of a long tab (Settings) and
  // then clicking a shorter one (Today) left the window sitting at the
  // same scrollY, which now lands somewhere in the middle or bottom of
  // the new tab instead of its top.
  //
  // Skipped when landing on Settings with a pending scrollTarget (the
  // Budgets tab's "Manage budgets" link) - see below.
  //
  // useLayoutEffect, not useEffect: plain useEffect fires after the
  // browser has already painted, so for one frame the new tab's
  // content would render at whatever scrollY the old tab was left at
  // (cut off mid-content, or floating in blank space if the new tab is
  // shorter) before snapping to top - a jump that was only visible
  // when there was scroll to correct, which made switching tabs feel
  // inconsistent depending on scroll position. useLayoutEffect runs
  // synchronously before paint, so the reset lands in the same frame
  // as the tab swap regardless of where you scrolled from.
  //
  // Deliberately keyed on activeTab alone, NOT settingsScrollTarget.
  // React runs every layout effect in the tree, parent or child, before
  // any passive effect runs - so on the commit where SettingsView
  // mounts with a pending scrollTarget, this effect fires first (while
  // it's still set) and correctly skips. But SettingsView's own
  // scrollIntoView effect is a passive effect: it starts the smooth
  // scroll and then immediately calls onScrollTargetConsumed to clear
  // settingsScrollTarget, which used to be in this effect's dependency
  // array. That clearing, on its own, re-ran this effect - now with the
  // guard false - and fired an instant window.scrollTo(0) directly on
  // top of the still-in-progress smooth scroll, snapping straight back
  // to the top before the section it had just scrolled to was ever
  // visible (the "Manage budgets" link looked like it did nothing but
  // reopen Settings at the top). Depending on activeTab only means
  // clearing settingsScrollTarget while staying on the same tab no
  // longer re-triggers this effect at all - it now only ever fires on
  // an actual tab change, still reading whatever settingsScrollTarget
  // holds at that moment via closure.
  useLayoutEffect(() => {
    if (activeTab === "settings" && settingsScrollTarget) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  const [theme, setTheme] = useTheme();
  const [nowTick, setNowTick] = useState(Date.now());
  const toast = useToast();
  const notifications = useNotifications();
  // Every event that's worth a toast is also worth a line in the bell
  // panel - one call keeps both in sync instead of duplicating the
  // payload at each of the six call sites below.
  const notify = useCallback(
    (payload) => {
      toast(payload);
      notifications.push(payload);
    },
    [toast, notifications]
  );

  const [tags, setTags] = useState([]);
  // Active + archived, fetched in parallel with the active-only `tags`
  // above. Only threaded to SessionLog (see below) - the one place that
  // needs to correctly display/edit a past session that already
  // references a tag someone's since archived, without surfacing
  // archived tags in every other "pick a tag" picker in the app.
  const [allTags, setAllTags] = useState([]);
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

  // The currently-running timer session (or null), reported up from
  // TimerPanel via onRunningChange. Used below to build `liveSessions` -
  // `history` with this session's live elapsed time appended as a
  // virtual entry, so today's total/this week's bar/streak/heatmap
  // reflect an active session instead of staying frozen until it's
  // stopped and actually lands in `history`.
  const [runningSession, setRunningSession] = useState(null);

  const [waking, setWaking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  async function loadAll() {
    try {
      const [tagData, allTagData, hist, budgetData, deadlineData, reminderData, taskData, settingsData] =
        await Promise.all([
          listTags(),
          listTags(true),
          getSessionHistory(),
          listBudgets(),
          listDeadlines(),
          listReminders(),
          listTasks(),
          getSettings().catch(() => DEFAULT_SETTINGS),
        ]);
      setTags(tagData);
      setAllTags(allTagData);
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

  // TagManager's create/delete/archive/unarchive only ever change the
  // tags table - nothing about sessions, budgets, deadlines, reminders,
  // tasks, or settings. Refetching all of those (loadAll's 7 parallel
  // calls, including the full session history - potentially thousands
  // of rows) just to reflect a tag edit was real, measurable overhead,
  // not just a feeling: archiving a tag visibly took as long as the
  // slowest of those 7 requests instead of the one PATCH it actually
  // needed. This refetches only what TagManager can actually change.
  async function refreshTags() {
    const [tagData, allTagData] = await Promise.all([listTags(), listTags(true)]);
    setTags(tagData);
    setAllTags(allTagData);
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
    // connection state - the handshake itself happens entirely on
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
      // instead - a failed sign-in never reaches this component at all,
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
    // without needing fresh server data - just re-evaluates the current
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

  // `history` plus the running session's live elapsed time, if one is
  // active - clamped so the very first tick after starting a timer
  // (before nowTick has caught up) can't produce a negative duration.
  // Everything that should feel "live" (today's total, this week's/
  // month's current bar, the heatmap's today cell, streak, deadline
  // pace) is derived from this instead of raw `history`. Deliberately
  // NOT used for the Session Log or the day-detail modal's session
  // list - those are meant to show actual completed records, the same
  // way they never showed an in-progress session before this existed.
  const liveSessions = useMemo(() => {
    if (!runningSession) return history;
    const startedAtMs = new Date(runningSession.started_at).getTime();
    const endedAt = new Date(Math.max(nowTick, startedAtMs));
    return [...history, { ...runningSession, ended_at: endedAt.toISOString() }];
  }, [history, runningSession, nowTick]);

  const summary = useMemo(
    () => computeSummary(liveSessions, settings.rest_day_of_week ?? null, settings.streak_recovery_grace_enabled ?? false),
    [liveSessions, settings.rest_day_of_week, settings.streak_recovery_grace_enabled]
  );
  // Learned from completed history only, deliberately not liveSessions -
  // the running session (if any) has no note/task yet to learn from, and
  // even if it did, using words from the session you're *currently*
  // trying to match against to also help decide its own match would be
  // circular.
  const tagVocabulary = useMemo(() => buildTagVocabulary(history), [history]);
  const budgetsWithProgress = useMemo(
    () => computeBudgetProgress(budgets, liveSessions),
    [budgets, liveSessions]
  );
  const deadlinesWithProgress = useMemo(
    () => computeDeadlineProgress(deadlines, liveSessions, summary.avgDailyFocusSeconds),
    [deadlines, liveSessions, summary.avgDailyFocusSeconds]
  );
  const insightOfTheDay = useMemo(
    () =>
      computeInsightOfTheDay({
        summary,
        budgetsProgress: budgetsWithProgress,
        deadlinesProgress: deadlinesWithProgress,
        displayName: userFirstName,
      }),
    [summary, budgetsWithProgress, deadlinesWithProgress, userFirstName]
  );
  const riskDigest = useMemo(
    () => computeRiskDigest({ budgetsProgress: budgetsWithProgress, deadlinesProgress: deadlinesWithProgress }),
    [budgetsWithProgress, deadlinesWithProgress]
  );
  const weeklyReview = useMemo(
    () => computeWeeklyReview({ sessions: liveSessions, deadlinesProgress: deadlinesWithProgress, reminders }),
    [liveSessions, deadlinesWithProgress, reminders]
  );
  const deadlineTrackRecord = useMemo(
    () => computeDeadlineTrackRecord(deadlinesWithProgress),
    [deadlinesWithProgress]
  );

  // In-app version of the same "streak at risk" check the backend cron
  // job does for push notifications - this one only needs to run while
  // the app is actually open. A configured rest day is never "at risk"
  // since it doesn't break the streak either way (see analytics.js).
  // Same for a still-available recovery grace: if this week's one
  // protected miss hasn't been spent yet, missing today would just
  // consume it rather than actually break the streak, so it's not
  // "at risk" in the sense this banner is warning about.
  const streakAtRisk = useMemo(() => {
    const nowDate = new Date(nowTick);
    const hour = nowDate.getHours();
    const isRestDay = settings.rest_day_of_week != null && nowDate.getDay() === settings.rest_day_of_week;
    const graceCovers = settings.streak_recovery_grace_enabled && summary.streakGraceAvailable;
    return hour >= 19 && summary.todaySeconds === 0 && summary.streakDays > 0 && !isRestDay && !graceCovers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nowTick,
    summary.todaySeconds,
    summary.streakDays,
    summary.streakGraceAvailable,
    settings.rest_day_of_week,
    settings.streak_recovery_grace_enabled,
  ]);

  // Same-pace "will I hit today's goal" projection, only worth surfacing
  // once enough of the day has actually happened to extrapolate from
  // (see computeGoalProjection) and only shown in the evening window - // an 11am reminder about tonight's goal is noise, not signal.
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
        // New week / target raised - allow it to fire again later.
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
          <TopLoadingBar active={!loaded || waking} />

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
                Loading. Please wait, this can take a moment.
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
            <PullToRefresh onRefresh={loadAll}>
            {!loaded ? (
              <div className="fd-loading">Loading your focus journal…</div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                {activeTab === "today" && (
                  <TodayView
                    key="today"
                    tags={tags}
                    allTags={allTags}
                    summary={summary}
                    streakAtRisk={streakAtRisk}
                    sessionsVersion={sessionsVersion}
                    tasks={tasks}
                    insightOfTheDay={insightOfTheDay}
                    dailyGoalSeconds={settings.daily_focus_goal_seconds}
                    goalProjection={goalProjection}
                    graceEnabled={settings.streak_recovery_grace_enabled}
                    tagVocabulary={tagVocabulary}
                    userName={userFirstName}
                    onRunningChange={setRunningSession}
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
                    history={history}
                    userName={userFirstName}
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
                    avgDailyFocusWindowDays={summary.avgDailyFocusWindowDays}
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
                    onTagsRefresh={refreshTags}
                    user={user}
                    onUserUpdated={onUserUpdated}
                    onLogout={onLogout}
                    scrollTarget={settingsScrollTarget}
                    onScrollTargetConsumed={() => setSettingsScrollTarget(null)}
                  />
                )}
              </AnimatePresence>
            )}
            </PullToRefresh>
          </main>
        </motion.div>
      )}

      {!showSplash && loaded && !user?.displayName && !namePromptDismissed && (
        <NamePromptModal onUserUpdated={onUserUpdated} onDismiss={() => setNamePromptDismissed(true)} />
      )}
    </div>
  );
}
