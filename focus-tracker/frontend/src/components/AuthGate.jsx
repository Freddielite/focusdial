import { useEffect, useState } from "react";
import FocusMark from "./FocusMark.jsx";
import { getAuthConfig, register, login, googleLoginStartUrl } from "../api.js";

export default function AuthGate({ onAuthenticated }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [googleLoginEnabled, setGoogleLoginEnabled] = useState(false);

  useEffect(() => {
    getAuthConfig()
      .then((c) => setGoogleLoginEnabled(c.googleLoginEnabled))
      .catch(() => setGoogleLoginEnabled(false));

    // A failed Google sign-in redirects here with ?authResult=error
    // (see routes/auth.js's callback) — this component is the only place
    // that failure is ever visible, since App.jsx/AuthRoot only render
    // once there's an authenticated user. Without this, a failed Google
    // sign-in previously gave no feedback at all — just silently dumped
    // back on this same screen with nothing explaining why.
    const params = new URLSearchParams(window.location.search);
    if (params.get("authResult") === "error") {
      setError("Couldn't sign in with Google. Please try again.");
      params.delete("authResult");
      const cleaned = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
      window.history.replaceState({}, "", cleaned);
    }
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === "login" ? await login(email, password) : await register(email, password, displayName);
      onAuthenticated(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fd-auth-screen">
      <div className="fd-panel fd-auth-card">
        <div className="fd-auth-brand">
          <FocusMark />
          <span>FocusDial</span>
        </div>

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

        <form className="fd-auth-form" onSubmit={handleSubmit}>
          {mode === "register" && (
            <label>
              Name (optional)
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "register" ? 8 : undefined}
              required
            />
          </label>
          {mode === "register" && <div className="fd-auth-hint">At least 8 characters.</div>}
          {error && <div className="fd-inline-error">{error}</div>}
          <button type="submit" className="fd-btn fd-btn--start" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        {googleLoginEnabled && (
          <>
            <div className="fd-auth-divider">or</div>
            <a className="fd-btn fd-auth-google" href={googleLoginStartUrl()}>
              <svg className="fd-google-icon" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.33A9 9 0 0 0 9 18z" />
                <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.94A9 9 0 0 0 0 9c0 1.45.35 2.83.94 4.03z" />
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .94 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
              </svg>
              <span>Continue with Google</span>
            </a>
          </>
        )}
      </div>
    </div>
  );
}
