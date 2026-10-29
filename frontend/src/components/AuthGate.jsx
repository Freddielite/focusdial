import { useEffect, useState } from "react";
import FocusMark from "./FocusMark.jsx";
import { getAuthConfig, register, login, verifyMfa, requestPasswordReset, confirmPasswordReset, googleLoginStartUrl } from "../api.js";

const MESSAGES = {
  error: "Couldn't sign in with Google. Please try again.",
  unverified: "Google hasn't verified that email address, so it can't be linked to an existing account. Sign in with your password instead.",
};

export default function AuthGate({ onAuthenticated, initialMode = "login" }) {
  // "login" | "register" | "mfa" | "forgot" | "reset"
  const [mode, setMode] = useState(initialMode);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState(null);
  const [resetToken, setResetToken] = useState(null);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [googleLoginEnabled, setGoogleLoginEnabled] = useState(false);
  // The Google button is a plain <a> (a real top-level navigation, not a
  // fetch) -- there's nothing to "await," so this is purely visual: set
  // synchronously on click, the browser still follows href right after
  // the handler returns, but the person sees the button react instantly
  // instead of nothing happening for however long the redirect chain
  // takes, which is what made them think it hadn't registered and tap
  // it again.
  const [googleRedirecting, setGoogleRedirecting] = useState(false);

  useEffect(() => {
    getAuthConfig()
      .then((c) => {
        setGoogleLoginEnabled(c.googleLoginEnabled);
        setPasswordResetEnabled(c.passwordResetEnabled !== false);
      })
      .catch(() => setGoogleLoginEnabled(false));

    // A failed Google sign-in redirects here with ?authResult=error
    // (see routes/auth.js's callback) - this component is the only place
    // that failure is ever visible, since App.jsx/AuthRoot only render
    // once there's an authenticated user. Without this, a failed Google
    // sign-in previously gave no feedback at all - just silently dumped
    // back on this same screen with nothing explaining why.
    const params = new URLSearchParams(window.location.search);
    const authResult = params.get("authResult");
    const token = params.get("resetToken");
    if (authResult === "mfa") setMode("mfa");
    else if (MESSAGES[authResult]) setError(MESSAGES[authResult]);
    if (token) {
      setResetToken(token);
      setMode("reset");
    }
    if (authResult || token) {
      // The reset token is removed from the address bar (and history)
      // right away so it isn't left in the URL or shared by accident.
      params.delete("authResult");
      params.delete("resetToken");
      const cleaned = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
      window.history.replaceState({}, "", cleaned);
    }
  }, []);

  function switchMode(next) {
    setMode(next);
    setError(null);
    setNotice(null);
    setCode("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "login") {
        const result = await login(email, password);
        if (result.mfaRequired) {
          setPassword("");
          switchMode("mfa");
        } else onAuthenticated(result);
      } else if (mode === "register") {
        onAuthenticated(await register(email, password, displayName));
      } else if (mode === "mfa") {
        const user = await verifyMfa(code.trim());
        if (typeof user.recoveryCodesRemaining === "number" && user.recoveryCodesRemaining <= 2) {
          window.alert(
            `You have ${user.recoveryCodesRemaining} recovery code${user.recoveryCodesRemaining === 1 ? "" : "s"} left. Make new ones in Settings → Account & security.`
          );
        }
        onAuthenticated(user);
      } else if (mode === "forgot") {
        const r = await requestPasswordReset(email);
        setNotice(r.message);
      } else if (mode === "reset") {
        await confirmPasswordReset(resetToken, password);
        setPassword("");
        setResetToken(null);
        switchMode("login");
        setNotice("Password changed. Sign in with your new password - you've been signed out everywhere else.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const showTabs = mode === "login" || mode === "register";
  const submitLabel = {
    login: "Sign in",
    register: "Create account",
    mfa: "Verify",
    forgot: "Email me a reset link",
    reset: "Set new password",
  }[mode];

  return (
    <div className="fd-auth-screen">
      <div className="fd-panel fd-auth-card">
        <div className="fd-auth-brand">
          <FocusMark />
          <span>FocusDial</span>
        </div>

        {showTabs && (
        <div className="fd-auth-tabs">
          <button
            type="button"
            className={`fd-auth-tab ${mode === "login" ? "fd-auth-tab--active" : ""}`}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`fd-auth-tab ${mode === "register" ? "fd-auth-tab--active" : ""}`}
            onClick={() => setMode("register")}
          >
            Create account
          </button>
        </div>
        )}
        {mode === "mfa" && <h2 className="fd-auth-heading">Two-step verification</h2>}
        {mode === "forgot" && <h2 className="fd-auth-heading">Reset your password</h2>}
        {mode === "reset" && <h2 className="fd-auth-heading">Choose a new password</h2>}

        <form className="fd-auth-form" onSubmit={handleSubmit} noValidate={false}>
          {mode === "register" && (
            <label>
              Name (optional)
              <input type="text" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
            </label>
          )}
          {(mode === "login" || mode === "register" || mode === "forgot") && (
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required />
            </label>
          )}
          {(mode === "login" || mode === "register" || mode === "reset") && (
            <label>
              {mode === "reset" ? "New password" : "Password"}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "login" ? undefined : 8}
                required
              />
            </label>
          )}
          {(mode === "register" || mode === "reset") && <div className="fd-auth-hint">At least 8 characters.</div>}
          {mode === "mfa" && (
            <label>
              Code from your authenticator app, or a recovery code
              <input
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={20}
                required
                autoFocus
              />
            </label>
          )}
          {notice && (
            <div className="fd-auth-hint" role="status">
              {notice}
            </div>
          )}
          {error && (
            <div className="fd-inline-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
            {busy ? "Please wait…" : submitLabel}
          </button>
          {mode === "login" && passwordResetEnabled && (
            <button type="button" className="fd-auth-link" onClick={() => switchMode("forgot")}>
              Forgot password?
            </button>
          )}
          {(mode === "forgot" || mode === "mfa" || mode === "reset") && (
            <button type="button" className="fd-auth-link" onClick={() => switchMode("login")}>
              Back to sign in
            </button>
          )}
          {mode === "mfa" && (
            <div className="fd-auth-hint">Lost your phone? Enter one of the recovery codes you saved when you turned this on.</div>
          )}
        </form>

        {googleLoginEnabled && showTabs && (
          <>
            <div className="fd-auth-divider">or</div>
            <a
              className={`fd-btn fd-auth-google ${googleRedirecting ? "fd-auth-google--busy" : ""}`}
              href={googleLoginStartUrl()}
              onClick={(e) => {
                if (googleRedirecting) {
                  e.preventDefault(); // already on the way, ignore a second tap
                  return;
                }
                setGoogleRedirecting(true);
              }}
              aria-disabled={googleRedirecting}
            >
              {googleRedirecting ? (
                <span className="fd-btn-spinner" aria-hidden="true" />
              ) : (
                <svg className="fd-google-icon" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.33A9 9 0 0 0 9 18z" />
                  <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.94A9 9 0 0 0 0 9c0 1.45.35 2.83.94 4.03z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .94 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
                </svg>
              )}
              <span>{googleRedirecting ? "Redirecting…" : "Continue with Google"}</span>
            </a>
          </>
        )}
      </div>
    </div>
  );
}
