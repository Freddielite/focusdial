import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import App from "./App.jsx";
import AuthGate from "./components/AuthGate.jsx";
import { getMe, logout, setUnauthorizedHandler } from "./api.js";

// Small full-screen spinner shown for the gap between clicking "Sign
// out" and the server actually clearing the session - logout() is a
// real network round-trip, so without this the screen just sat frozen
// until it resolved.
function AuthLoadingScreen({ label }) {
  return (
    <motion.div
      className="fd-auth-loading"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: "easeInOut" }}
    >
      <div className="fd-spinner" aria-hidden="true" />
      <span>{label}</span>
    </motion.div>
  );
}

// logout() can resolve in a handful of milliseconds on localhost, which
// made the loading screen flash for less than a frame and look like it
// never showed up at all. This keeps it visible for at least this long
// regardless of how fast the request actually was.
const MIN_LOGOUT_SCREEN_MS = 600;

export default function AuthRoot() {
  const [status, setStatus] = useState("loading"); // "loading" | "authed" | "anon" | "loggingOut"
  const [user, setUser] = useState(null);

  useEffect(() => {
    getMe()
      .then((r) => {
        if (r.user) {
          setUser(r.user);
          setStatus("authed");
        } else {
          setStatus("anon");
        }
      })
      .catch(() => setStatus("anon"));

    // If a session expires mid-use (cookie cleared, server-side logout
    // from elsewhere, etc.), any API call will 401 - this drops straight
    // back to the login screen instead of every affected component
    // separately showing its own confusing "failed to load" error.
    setUnauthorizedHandler(() => {
      setUser(null);
      setStatus("anon");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  function handleAuthenticated(loggedInUser) {
    setUser(loggedInUser);
    setStatus("authed");
  }

  async function handleLogout() {
    setStatus("loggingOut");
    const startedAt = Date.now();
    try {
      await logout();
    } catch (err) {
      // Not fatal - we still clear the local session below regardless - // but swallowing this completely last time made a real failure
      // here indistinguishable from "nothing happened". Logging it so
      // it at least shows up in devtools if this keeps happening.
      console.error("logout request failed:", err);
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_LOGOUT_SCREEN_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_LOGOUT_SCREEN_MS - elapsed));
    }
    setUser(null);
    setStatus("anon");
  }

  if (status === "loading") return null; // Splash inside App covers the app's own load; this is just the pre-check

  return (
    <>
      {status === "anon" && <AuthGate onAuthenticated={handleAuthenticated} />}
      {/* Kept mounted through "loggingOut" (rather than swapped out
          alongside AuthGate in one AnimatePresence) so there's no
          transition between App - a huge, non-motion subtree - and
          another child for framer-motion to coordinate. The overlay
          below just renders on top of it while the request is in
          flight. */}
      {status !== "anon" && user && <App user={user} onLogout={handleLogout} onUserUpdated={setUser} />}
      <AnimatePresence>
        {status === "loggingOut" && <AuthLoadingScreen key="logging-out" label="Signing out…" />}
      </AnimatePresence>
    </>
  );
}
