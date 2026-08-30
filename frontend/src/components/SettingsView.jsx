import { Fragment, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import TagManager from "./TagManager.jsx";
import BudgetManager from "./BudgetManager.jsx";
import ThemeToggle from "./ThemeToggle.jsx";
import Dropdown from "./Dropdown.jsx";
import { resetData, sessionsExportUrl, getGoogleAuthStatus, googleAuthStartUrl, disconnectGoogleAccount, updateProfile } from "../api.js";
import { isPushSupported, getPushStatus, enablePush, disablePush } from "../push.js";
import { useDeviceName } from "../hooks/useDeviceName.js";
import { useToast } from "./Toast.jsx";
import { formatHour } from "../format.js";

const THEME_LABEL = { system: "Auto", light: "Light", dark: "Dark" };

// Reusable pill switch. Controlled - the parent owns the value so a
// single settings object stays the source of truth for both this screen
// and the notification logic in App.
function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`fd-switch ${checked ? "fd-switch--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="fd-switch__knob" />
    </button>
  );
}

function Row({ title, desc, muted, children }) {
  return (
    <div className={`fd-set-row ${muted ? "fd-set-row--muted" : ""}`}>
      <div className="fd-set-row__text">
        <div className="fd-set-row__title">{title}</div>
        {desc && <div className="fd-set-row__desc">{desc}</div>}
      </div>
      <div className="fd-set-row__control">{children}</div>
    </div>
  );
}

// A single "aim for N hours today" number, separate from weekly Budgets
// (tag-scoped, week-long) -- this is unscoped and shown on the Today
// tab's hero card (see HeroCard.jsx). Local `hours` state buffers the
// text input while typing (committed on blur, not on every keystroke,
// same reasoning as any other free-typed numeric field) -- everything
// else in Settings is a toggle/dropdown that can update on every change
// without that concern.
function DailyGoalRow({ settings, onUpdateSetting }) {
  const enabled = settings?.daily_focus_goal_seconds != null;
  const [hours, setHours] = useState(enabled ? settings.daily_focus_goal_seconds / 3600 : 4);

  useEffect(() => {
    if (settings?.daily_focus_goal_seconds != null) setHours(settings.daily_focus_goal_seconds / 3600);
  }, [settings?.daily_focus_goal_seconds]);

  function commit(value) {
    const n = Number(value);
    if (!n || n <= 0) return;
    onUpdateSetting("daily_focus_goal_seconds", Math.round(n * 3600));
  }

  function handleToggle(v) {
    onUpdateSetting("daily_focus_goal_seconds", v ? Math.round((Number(hours) || 4) * 3600) : null);
  }

  return (
    <Row title="Daily focus goal" desc="A simple daily target on the Today tab, separate from weekly Budgets.">
      <div className="fd-daily-goal-row">
        <Toggle checked={enabled} onChange={handleToggle} label="Daily focus goal" />
        {enabled && (
          <>
            <input
              type="number"
              min="0.5"
              step="0.5"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              onBlur={(e) => commit(e.target.value)}
              className="fd-daily-goal-input"
            />
            <span className="fd-daily-goal-suffix">h/day</span>
          </>
        )}
      </div>
    </Row>
  );
}

// Purely local label (see hooks/useDeviceName.js) - this row doesn't
// touch the backend at all, it just lets someone override the guessed
// "Chrome on Mac"-style default with something more personal ("Work
// laptop"), so the multi-device conflict banner reads as something
// recognizable instead of a browser/OS guess. Same local-buffer-then-
// commit-on-blur shape as DailyGoalRow above, for the same reason: this
// is free text, not a value that should PATCH on every keystroke.
function DeviceNameRow({ deviceName, onDeviceNameChange }) {
  const [value, setValue] = useState(deviceName);

  useEffect(() => {
    setValue(deviceName);
  }, [deviceName]);

  function commit() {
    if (value.trim() && value.trim() !== deviceName) onDeviceNameChange(value);
    else setValue(deviceName);
  }

  return (
    <Row title="This device" desc="Shown to you if two devices ever try to run a timer at once.">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        maxLength={40}
        className="fd-device-name-input"
      />
    </Row>
  );
}

const AUTOMATION_ROWS = [
  { key: "automation_reminders", title: "Reminders", desc: "Ping me when a reminder is due, even if the app is closed." },
  { key: "automation_deadline_pace", title: "Deadline pace changes", desc: "Warn me when a deadline slips to tight, behind, or overdue." },
  { key: "automation_streak", title: "Streak at risk", desc: "Nudge me in the evening if I haven't logged a session yet." },
  { key: "automation_runaway_timer", title: "Runaway timer", desc: "Warn me if a running session goes past 4 hours, probably forgot to stop it." },
  { key: "automation_weekly_digest", title: "Weekly digest", desc: "Total hours logged and your best day, in one push. Timing is configurable below." },
];

const EVENT_ROWS = [
  { key: "notify_session_completed", title: "Session completed", desc: "Confirm when a focus session is logged." },
  { key: "notify_deadline_completed", title: "Deadline completed", desc: "Celebrate when a deadline reaches 100%." },
  { key: "notify_budget_reached", title: "Budget goal reached", desc: "Let me know when a weekly time budget hits its target." },
];

// Device push: browser permission + subscription for THIS device. This
// is separate from the master mute below - you subscribe once here, then
// the toggles decide what actually comes through.
function DevicePush({ onChange }) {
  const [status, setStatus] = useState("checking");
  const [error, setError] = useState(null);
  const toast = useToast();

  useEffect(() => {
    if (!isPushSupported()) return setStatus("unsupported");
    getPushStatus().then(setStatus);
  }, []);

  async function enable() {
    setError(null);
    try {
      await enablePush();
      setStatus("subscribed");
      onChange?.();
      toast({ title: "Push enabled", body: "This device will receive notifications.", tone: "success" });
    } catch (err) {
      setError(err.message);
    }
  }

  async function disable() {
    await disablePush();
    setStatus("not-subscribed");
    onChange?.();
    toast({ title: "Push disabled on this device", tone: "default" });
  }

  if (status === "unsupported") {
    return <div className="fd-pace-note">Push notifications aren't supported in this browser.</div>;
  }
  if (status === "denied") {
    return (
      <div className="fd-pace-note">
        Notifications are blocked for this site. Turn them back on in your browser's site settings to receive push.
      </div>
    );
  }

  return (
    <Row
      title="Push on this device"
      desc={
        status === "subscribed"
          ? "This browser is set up to receive push notifications."
          : "Allow this browser to receive push notifications when the app is closed."
      }
    >
      {status === "subscribed" ? (
        <button className="fd-btn fd-btn--stop fd-btn--sm" onClick={disable}>Turn off</button>
      ) : (
        <button className="fd-btn fd-btn--start fd-btn--sm" onClick={enable}>Enable</button>
      )}
      {error && <div className="fd-inline-error">{error}</div>}
    </Row>
  );
}

function ExportSection() {
  const [format, setFormat] = useState("csv");

  return (
    <div className="fd-export-group">
      <div className="fd-export">
        <div className="fd-trend-toggle">
          <button
            type="button"
            className={`fd-trend-toggle__btn ${format === "csv" ? "fd-trend-toggle__btn--active" : ""}`}
            onClick={() => setFormat("csv")}
          >
            CSV
          </button>
          <button
            type="button"
            className={`fd-trend-toggle__btn ${format === "json" ? "fd-trend-toggle__btn--active" : ""}`}
            onClick={() => setFormat("json")}
          >
            JSON
          </button>
        </div>
        <a className="fd-btn fd-btn--start fd-btn--sm" href={sessionsExportUrl(format)} download={`sessions.${format}`}>
          Download {format.toUpperCase()}
        </a>
      </div>
    </div>
  );
}

// Google Calendar two-way sync. Three states: not configured on this
// server (no OAuth client set up - see HANDOVER.md), configured but not
// connected (show a Connect button), or connected (show account +
// disconnect + the poll-side toggle). Mirrors DevicePush's
// fetch-status-on-mount shape above.
function GoogleCalendarSection({ settings, onUpdateSetting }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  // Same reasoning as AuthGate's Google button -- this is a plain <a>
  // (real navigation, nothing to await), so this is purely a visual
  // "yes, that registered" cue set on click, not a request state.
  const [connectRedirecting, setConnectRedirecting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    getGoogleAuthStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connected: false }));
  }, []);

  async function disconnect() {
    setBusy(true);
    try {
      await disconnectGoogleAccount();
      setStatus({ configured: true, connected: false });
      toast({ title: "Google Calendar disconnected" });
    } catch (err) {
      toast({ title: "Couldn't disconnect", body: err.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (!status.configured) {
    return (
      <div className="fd-pace-note">
        Not set up on this server yet. Needs a Google OAuth client configured first. See HANDOVER.md.
      </div>
    );
  }

  if (!status.connected) {
    return (
      <Row
        title="Connect Google Calendar"
        desc="Two-way sync: deadlines and reminders mirror to a real Google Calendar, and edits made there sync back on the next check."
      >
        <a
          className={`fd-btn fd-btn--start fd-btn--sm ${connectRedirecting ? "fd-btn--busy" : ""}`}
          href={googleAuthStartUrl()}
          onClick={(e) => {
            if (connectRedirecting) {
              e.preventDefault();
              return;
            }
            setConnectRedirecting(true);
          }}
          aria-disabled={connectRedirecting}
        >
          {connectRedirecting && <span className="fd-btn-spinner fd-btn-spinner--dark" aria-hidden="true" />}
          {connectRedirecting ? "Redirecting…" : "Connect"}
        </a>
      </Row>
    );
  }

  return (
    <>
      <Row title="Google account" desc={status.email || "Connected"}>
        <button className="fd-btn fd-btn--stop fd-btn--sm" onClick={disconnect} disabled={busy}>
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
      </Row>
      <Row
        title="Sync changes from Google"
        desc="FocusDial always pushes its own changes out. If this is off, edits made directly in Google Calendar won't come back."
      >
        <Toggle
          checked={settings?.automation_google_sync !== false}
          onChange={(v) => onUpdateSetting("automation_google_sync", v)}
          label="Sync changes from Google"
        />
      </Row>
    </>
  );
}

const RESET_CATEGORIES = [
  { key: "sessions", label: "Focus sessions" },
  { key: "tags", label: "Tags" },
  { key: "budgets", label: "Budgets" },
  { key: "deadlines", label: "Deadlines" },
  { key: "reminders", label: "Reminders" },
  { key: "tasks", label: "Tasks" },
  { key: "preferences", label: "Notification preferences" },
];

function ResetSection({ onDataChanged }) {
  const [selected, setSelected] = useState({});
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const pendingTimer = useRef(null);

  const chosen = RESET_CATEGORIES.filter((c) => selected[c.key]).map((c) => c.key);

  function toggle(key) {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
    setConfirming(false);
  }

  function run() {
    const categories = chosen;
    const labels = RESET_CATEGORIES.filter((c) => categories.includes(c.key)).map((c) => c.label);
    setSelected({});
    setConfirming(false);

    // Same delay-then-commit pattern as every other delete in the app
    // (see hooks/useUndoableDelete.js) - not reused directly here since
    // that hook is built around hiding/restoring one item by id, and a
    // category wipe has no single item to hide (Settings doesn't render
    // the sessions/tags/etc. it's about to clear).
    const timer = setTimeout(async () => {
      pendingTimer.current = null;
      try {
        await resetData(categories);
        onDataChanged();
      } catch (err) {
        toast({ title: "Reset failed", body: err.message, tone: "danger" });
      }
    }, 3000);
    pendingTimer.current = timer;

    toast({
      title: "Data cleared",
      body: `Reset: ${labels.join(", ")}.`,
      tone: "warn",
      duration: 3000,
      actionLabel: "Undo",
      onAction: () => {
        if (pendingTimer.current) {
          clearTimeout(pendingTimer.current);
          pendingTimer.current = null;
        }
      },
    });
  }

  return (
    <div className="fd-reset">
      <div className="fd-reset__grid">
        {RESET_CATEGORIES.map((c) => (
          <label key={c.key} className={`fd-reset__item ${selected[c.key] ? "fd-reset__item--on" : ""}`}>
            <input type="checkbox" checked={!!selected[c.key]} onChange={() => toggle(c.key)} />
            {c.label}
          </label>
        ))}
      </div>
      {chosen.length > 0 && !confirming && (
        <button className="fd-btn fd-btn--danger fd-btn--sm" onClick={() => setConfirming(true)}>
          Clear selected ({chosen.length})
        </button>
      )}
      {confirming && (
        <div className="fd-reset__confirm">
          <span>This deletes the selected data. You'll have a few seconds to undo after.</span>
          <div className="fd-reset__confirm-actions">
            <button className="fd-link-btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="fd-btn fd-btn--danger fd-btn--sm" onClick={run}>
              Yes, delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Inline display-name editor. Starts read-only (matches every other row
// on this screen); clicking "Edit" swaps in an input + Save/Cancel.
function AccountName({ user, onUserUpdated }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(user?.displayName || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  function startEditing() {
    setValue(user?.displayName || "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Name can't be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProfile(trimmed);
      onUserUpdated(updated);
      setEditing(false);
      toast({ title: "Name updated" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Row title={user?.email || "Signed in"} desc={user?.displayName || "FocusDial account"}>
        <button className="fd-link-btn" onClick={startEditing}>Edit name</button>
      </Row>
    );
  }

  return (
    <div className="fd-set-row fd-account-name-edit-row">
      <div className="fd-set-row__text">
        <div className="fd-set-row__title">{user?.email || "Signed in"}</div>
        <div className="fd-set-row__desc">Editing name</div>
      </div>
      <div className="fd-account-name-edit">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={80}
          autoFocus
          disabled={busy}
        />
        <div className="fd-account-name-edit__actions">
          <button className="fd-btn fd-btn--start fd-btn--sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="fd-link-btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
        </div>
      </div>
      {error && <div className="fd-inline-error">{error}</div>}
    </div>
  );
}

export default function SettingsView({
  settings,
  onUpdateSetting,
  theme,
  onThemeChange,
  tags,
  budgets,
  onDataChanged,
  onTagsRefresh,
  user,
  onUserUpdated,
  onLogout,
  scrollTarget,
  onScrollTargetConsumed,
}) {
  // Auto-detected timezone, shown read-only - the app already syncs the
  // offset to the server on load for the closed-app automations; this
  // just surfaces what it detected.
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Unknown";
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offsetLabel = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;

  // Independent hook call rather than a prop from App - safe because
  // TimerPanel (the other place this is read) fully unmounts/remounts on
  // every tab switch, same as the comment there notes, so it always
  // re-reads localStorage fresh next time Today is opened. No live
  // cross-tab sync needed for a value that's only read once per session
  // start.
  const [deviceName, setDeviceName] = useDeviceName();

  const pushOn = settings?.push_enabled !== false;

  // Sections that can be deep-linked into via scrollTarget (currently
  // just "Manage budgets" from the Budgets tab's link, but keyed by
  // name so more can be added the same way later).
  const budgetsSectionRef = useRef(null);
  const [highlightSection, setHighlightSection] = useState(null);

  useEffect(() => {
    if (scrollTarget === "budgets" && budgetsSectionRef.current) {
      budgetsSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightSection("budgets");
      onScrollTargetConsumed?.();
      const timer = setTimeout(() => setHighlightSection(null), 1600);
      return () => clearTimeout(timer);
    }
  }, [scrollTarget, onScrollTargetConsumed]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fd-view fd-settings"
    >
      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">Account</div>
        <AccountName user={user} onUserUpdated={onUserUpdated} />
        <Row title="Session" desc="Sign out of this device.">
          <button className="fd-btn fd-btn--stop fd-btn--sm" onClick={onLogout}>
            Sign out
          </button>
        </Row>
      </section>

      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">Notifications</div>
        <DevicePush onChange={onDataChanged} />
        <Row
          title="Send push notifications"
          desc="Master switch for push across every device. In-app toasts still show while you're here."
        >
          <Toggle checked={pushOn} onChange={(v) => onUpdateSetting("push_enabled", v)} label="Send push notifications" />
        </Row>
      </section>

      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">What to notify me about</div>
        {!pushOn && (
          <div className="fd-set-card__notice">Push is off above, so the automations below are inactive until you turn it back on. In-app events aren't affected.</div>
        )}
        <div className="fd-set-card__subhead">Automations (while the app is closed)</div>
        {AUTOMATION_ROWS.map((r) => (
          <Fragment key={r.key}>
            <Row title={r.title} desc={r.desc} muted={!pushOn}>
              <Toggle
                checked={settings?.[r.key] !== false}
                onChange={(v) => onUpdateSetting(r.key, v)}
                label={r.title}
                disabled={!pushOn}
              />
            </Row>
            {r.key === "automation_weekly_digest" && settings?.automation_weekly_digest !== false && (
              <Row title="Digest timing" desc="Which day and hour it fires, in your local time." muted={!pushOn}>
                <div className="fd-digest-timing">
                  <Dropdown
                    className="fd-select fd-select--inline"
                    value={String(settings?.weekly_digest_day_of_week ?? 0)}
                    onChange={(e) => onUpdateSetting("weekly_digest_day_of_week", Number(e.target.value))}
                    disabled={!pushOn}
                  >
                    <option value="1">Mon</option>
                    <option value="2">Tue</option>
                    <option value="3">Wed</option>
                    <option value="4">Thu</option>
                    <option value="5">Fri</option>
                    <option value="6">Sat</option>
                    <option value="0">Sun</option>
                  </Dropdown>
                  <Dropdown
                    className="fd-select fd-select--inline"
                    value={String(settings?.weekly_digest_hour ?? 19)}
                    onChange={(e) => onUpdateSetting("weekly_digest_hour", Number(e.target.value))}
                    disabled={!pushOn}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={String(h)}>
                        {formatHour(h)}
                      </option>
                    ))}
                  </Dropdown>
                </div>
              </Row>
            )}
          </Fragment>
        ))}
        <div className="fd-set-card__subhead">In-app events</div>
        {EVENT_ROWS.map((r) => (
          <Row key={r.key} title={r.title} desc={r.desc}>
            <Toggle
              checked={settings?.[r.key] !== false}
              onChange={(v) => onUpdateSetting(r.key, v)}
              label={r.title}
            />
          </Row>
        ))}
      </section>

      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">Daily &amp; Streak</div>
        <DailyGoalRow settings={settings} onUpdateSetting={onUpdateSetting} />
        <Row
          title="Rest day"
          desc="A day off that doesn't break your streak, even with nothing logged."
        >
          <Dropdown
            className="fd-select"
            value={settings?.rest_day_of_week != null ? String(settings.rest_day_of_week) : ""}
            onChange={(e) => onUpdateSetting("rest_day_of_week", e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">None</option>
            <option value="1">Mon</option>
            <option value="2">Tue</option>
            <option value="3">Wed</option>
            <option value="4">Thu</option>
            <option value="5">Fri</option>
            <option value="6">Sat</option>
            <option value="0">Sun</option>
          </Dropdown>
        </Row>
        <Row
          title="Recovery grace"
          desc="Forgive one missed day per week, whichever day it happens to be, so a single slip-up doesn't reset your streak."
        >
          <Toggle
            checked={settings?.streak_recovery_grace_enabled === true}
            onChange={(v) => onUpdateSetting("streak_recovery_grace_enabled", v)}
            label="Recovery grace"
          />
        </Row>
      </section>

      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">Appearance</div>
        <Row title="Theme" desc={`Currently ${THEME_LABEL[theme] || "Auto"}. Tap to cycle Auto → Light → Dark.`}>
          <div className="fd-theme-row">
            <ThemeToggle theme={theme} onChange={onThemeChange} />
            <span className="fd-theme-row__label">{THEME_LABEL[theme] || "Auto"}</span>
          </div>
        </Row>
        <Row title="Time zone" desc="Detected automatically and used for evening streak checks.">
          <span className="fd-set-static">{tz} · {offsetLabel}</span>
        </Row>
        <DeviceNameRow deviceName={deviceName} onDeviceNameChange={setDeviceName} />
      </section>

      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">Manage tags</div>
        <TagManager tags={tags} onTagsChanged={onTagsRefresh} embedded />
      </section>

      <section
        ref={budgetsSectionRef}
        className={`fd-panel fd-set-card${highlightSection === "budgets" ? " fd-set-card--highlight" : ""}`}
      >
        <div className="fd-set-card__head">Manage budgets</div>
        <BudgetManager budgets={budgets} tags={tags} onDataChanged={onDataChanged} />
      </section>

      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">Export data</div>
        <div className="fd-set-card__subhead" style={{ marginTop: 0 }}>
          Download your full session history, a good before-you-reset step.
        </div>
        <ExportSection />
      </section>

      <section className="fd-panel fd-set-card">
        <div className="fd-set-card__head">Google Calendar</div>
        <GoogleCalendarSection settings={settings} onUpdateSetting={onUpdateSetting} />
      </section>

      <section className="fd-panel fd-set-card fd-set-card--danger">
        <div className="fd-set-card__head">Reset data</div>
        <div className="fd-set-card__subhead" style={{ marginTop: 0 }}>
          Pick what to clear. Each category is deleted permanently.
        </div>
        <ResetSection onDataChanged={onDataChanged} />
      </section>
    </motion.div>
  );
}
