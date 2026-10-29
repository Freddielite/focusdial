import { useEffect, useState } from "react";
import {
  changePassword,
  listAccountSessions,
  revokeSessions,
  getMfaStatus,
  startMfaSetup,
  enableMfa,
  disableMfa,
  regenerateRecoveryCodes,
  getSecurityActivity,
  accountExportUrl,
  deleteAccount,
} from "../api.js";
import { currentPushEndpoint } from "../push.js";

// Settings -> Account & security. Password, two-step verification (with
// recovery codes for a lost phone), signed-in devices, the person's own
// security activity, a full data export, and account deletion.

const EVENT_LABELS = {
  login: "Signed in",
  login_failed: "Failed sign-in attempt",
  logout: "Signed out",
  register: "Account created",
  password_changed: "Password changed",
  password_set: "Password set",
  password_change_failed: "Wrong current password entered",
  password_reset_requested: "Password reset requested",
  password_reset_completed: "Password reset",
  mfa_enabled: "Two-step verification turned on",
  mfa_disabled: "Two-step verification turned off",
  mfa_failed: "Wrong verification code",
  mfa_recovery_codes_regenerated: "New recovery codes made",
  sessions_revoked: "Signed out of devices",
  google_linked: "Google account linked",
};

function Field({ label, children }) {
  return (
    <label className="fd-sec-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Panel({ title, desc, children }) {
  return (
    <div className="fd-sec-panel">
      <div className="fd-set-row__title">{title}</div>
      {desc && <div className="fd-set-row__desc">{desc}</div>}
      <div className="fd-sec-panel__body">{children}</div>
    </div>
  );
}

function Status({ error, ok }) {
  if (error) return <div className="fd-inline-error" role="alert">{error}</div>;
  if (ok) return <div className="fd-sec-ok" role="status">{ok}</div>;
  return null;
}

function RecoveryCodes({ codes }) {
  const text = codes.join("\n");
  return (
    <div className="fd-sec-codes">
      <p className="fd-set-row__desc">
        Save these somewhere safe (a password manager is ideal). Each one works once if you lose your phone. They won't be shown again.
      </p>
      <pre aria-label="Recovery codes">{text}</pre>
      <div className="fd-sec-actions">
        <button className="fd-btn fd-btn--sm" type="button" onClick={() => navigator.clipboard?.writeText(text)}>
          Copy
        </button>
        <a
          className="fd-btn fd-btn--sm"
          download="focusdial-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`FocusDial recovery codes\n\n${text}\n`)}`}
        >
          Download
        </a>
      </div>
    </div>
  );
}

function PasswordPanel({ user }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const hasPassword = user?.hasPassword !== false;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await changePassword(current, next);
      setCurrent("");
      setNext("");
      setOk(
        r.otherSessionsRevoked > 0
          ? `Password ${hasPassword ? "changed" : "set"}. Signed out ${r.otherSessionsRevoked} other device${r.otherSessionsRevoked === 1 ? "" : "s"}.`
          : `Password ${hasPassword ? "changed" : "set"}.`
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={hasPassword ? "Change password" : "Set a password"}
      desc={hasPassword ? "Other devices are signed out when you change it." : "You sign in with Google. A password lets you sign in without it too."}
    >
      <form onSubmit={submit} className="fd-sec-form">
        {hasPassword && (
          <Field label="Current password">
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
        )}
        <Field label="New password (at least 8 characters)">
          <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Status error={error} ok={ok} />
        <button className="fd-btn fd-btn--start fd-btn--sm" disabled={busy}>
          {busy ? "Saving…" : hasPassword ? "Change password" : "Set password"}
        </button>
      </form>
    </Panel>
  );
}

function MfaPanel({ user }) {
  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(null); // null | "disable" | "regenerate"

  const refresh = () => getMfaStatus().then(setStatus).catch((err) => setError(err.message));
  useEffect(() => {
    refresh();
  }, []);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <Panel title="Two-step verification" desc="Loading…" />;

  if (codes) {
    return (
      <Panel title="Two-step verification is on" desc="Your recovery codes:">
        <RecoveryCodes codes={codes} />
        <button className="fd-btn fd-btn--start fd-btn--sm" type="button" onClick={() => setCodes(null)}>
          I've saved them
        </button>
      </Panel>
    );
  }

  if (!status.enabled) {
    return (
      <Panel
        title="Two-step verification"
        desc="Ask for a 6-digit code from an authenticator app (1Password, Google Authenticator, Authy…) when signing in."
      >
        {!setup ? (
          <button className="fd-btn fd-btn--start fd-btn--sm" disabled={busy} onClick={() => run(async () => setSetup(await startMfaSetup()))}>
            Set up
          </button>
        ) : (
          <form
            className="fd-sec-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await enableMfa(code.trim());
                setCodes(r.recoveryCodes);
                setSetup(null);
                setCode("");
                await refresh();
              });
            }}
          >
            <ol className="fd-sec-steps">
              <li>
                In your authenticator app, add an account and enter this key (or{" "}
                <a href={setup.otpauthUrl}>open it in your authenticator</a> on this device):
                <code className="fd-sec-secret">{setup.secret.match(/.{1,4}/g).join(" ")}</code>
              </li>
              <li>Enter the 6-digit code it shows.</li>
            </ol>
            <Field label="6-digit code">
              <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
            <Status error={error} />
            <div className="fd-sec-actions">
              <button className="fd-btn fd-btn--start fd-btn--sm" disabled={busy}>Turn on</button>
              <button type="button" className="fd-link-btn" onClick={() => setSetup(null)}>Cancel</button>
            </div>
          </form>
        )}
        {!setup && <Status error={error} />}
      </Panel>
    );
  }

  return (
    <Panel title="Two-step verification is on" desc={`${status.recoveryCodesRemaining} unused recovery code${status.recoveryCodesRemaining === 1 ? "" : "s"} left.`}>
      {!mode && (
        <div className="fd-sec-actions">
          <button className="fd-btn fd-btn--sm" onClick={() => setMode("regenerate")}>New recovery codes</button>
          <button className="fd-btn fd-btn--stop fd-btn--sm" onClick={() => setMode("disable")}>Turn off</button>
        </div>
      )}
      {mode && (
        <form
          className="fd-sec-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (mode === "disable") await disableMfa(password, code.trim());
              else setCodes((await regenerateRecoveryCodes(code.trim())).recoveryCodes);
              setMode(null);
              setCode("");
              setPassword("");
              await refresh();
            });
          }}
        >
          {mode === "disable" && user?.hasPassword !== false && (
            <Field label="Password">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          )}
          <Field label={mode === "disable" ? "Code from your app (or a recovery code)" : "Code from your app"}>
            <input autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <Status error={error} />
          <div className="fd-sec-actions">
            <button className={`fd-btn fd-btn--sm ${mode === "disable" ? "fd-btn--stop" : "fd-btn--start"}`} disabled={busy}>
              {mode === "disable" ? "Turn off two-step verification" : "Make new codes"}
            </button>
            <button type="button" className="fd-link-btn" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function DevicesPanel({ onSignedOutEverywhere }) {
  const [sessions, setSessions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);

  const refresh = () => listAccountSessions().then(setSessions).catch((err) => setError(err.message));
  useEffect(() => {
    refresh();
  }, []);

  const others = sessions ? sessions.filter((s) => !s.current).length : 0;

  async function revoke(keepCurrent) {
    if (!keepCurrent && !window.confirm("Sign out on every device, including this one?")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await revokeSessions(keepCurrent, keepCurrent ? await currentPushEndpoint() : null);
      if (!keepCurrent) return onSignedOutEverywhere();
      setOk(`Signed out ${r.revoked} other device${r.revoked === 1 ? "" : "s"}.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Signed-in devices"
      desc={sessions ? `Signed in on ${sessions.length} device${sessions.length === 1 ? "" : "s"} (including this one).` : "Loading…"}
    >
      <Status error={error} ok={ok} />
      <div className="fd-sec-actions">
        <button className="fd-btn fd-btn--sm" disabled={busy || others === 0} onClick={() => revoke(true)}>
          Sign out other devices
        </button>
        <button className="fd-btn fd-btn--stop fd-btn--sm" disabled={busy} onClick={() => revoke(false)}>
          Sign out everywhere
        </button>
      </div>
    </Panel>
  );
}

function ActivityPanel() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    getSecurityActivity().then(setRows).catch((err) => setError(err.message));
  }, []);
  return (
    <Panel title="Recent security activity" desc="Sign-ins and account changes. If something here wasn't you, change your password and sign out everywhere.">
      <Status error={error} />
      {rows && rows.length === 0 && <div className="fd-set-row__desc">Nothing yet.</div>}
      {rows && rows.length > 0 && (
        <ul className="fd-sec-activity">
          {rows.slice(0, 10).map((r, i) => (
            <li key={i}>
              <span>{EVENT_LABELS[r.event] || r.event}</span>
              <time dateTime={r.created_at}>
                {new Date(r.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DeletePanel({ user, onDeleted }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const hasPassword = user?.hasPassword !== false;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(hasPassword ? password : undefined, hasPassword ? undefined : confirmEmail);
      onDeleted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Delete account"
      desc="Permanently deletes your account and all its data: sessions, tags, budgets, deadlines, tasks, reminders, and the Google Calendar connection (plus the events FocusDial added to it). This can't be undone - download your data first."
    >
      {!open ? (
        <button className="fd-btn fd-btn--stop fd-btn--sm" onClick={() => setOpen(true)}>Delete my account…</button>
      ) : (
        <form className="fd-sec-form" onSubmit={submit}>
          {hasPassword ? (
            <Field label="Enter your password to confirm">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          ) : (
            <Field label={`Type your email (${user?.email}) to confirm`}>
              <input type="email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} required />
            </Field>
          )}
          <Status error={error} />
          <div className="fd-sec-actions">
            <button className="fd-btn fd-btn--stop fd-btn--sm" disabled={busy}>{busy ? "Deleting…" : "Delete everything"}</button>
            <button type="button" className="fd-link-btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </Panel>
  );
}

export default function AccountSecurity({ user, onSignedOut }) {
  return (
    <div className="fd-sec">
      <PasswordPanel user={user} />
      <MfaPanel user={user} />
      <DevicesPanel onSignedOutEverywhere={onSignedOut} />
      <ActivityPanel />
      <Panel title="Download all my data" desc="Everything stored for your account, as one JSON file.">
        <a className="fd-btn fd-btn--sm" href={accountExportUrl()} download>
          Download
        </a>
      </Panel>
      <DeletePanel user={user} onDeleted={onSignedOut} />
    </div>
  );
}
