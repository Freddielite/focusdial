import React from "react";
import ReactDOM from "react-dom/client";
import AuthRoot from "./AuthRoot.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import { ConfirmProvider } from "./components/ConfirmDialog.jsx";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <AuthRoot />
      </ConfirmProvider>
    </ToastProvider>
  </React.StrictMode>
);

// Registered after load so it never delays first paint. Guarded by a
// feature check since this also needs to run fine in dev/preview
// environments that may not support service workers.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });

  // sw.js calls skipWaiting()+clients.claim(), so a new version takes
  // control of an already-open tab immediately on deploy rather than
  // waiting for it to close -- but that alone doesn't make a tab that's
  // already running re-fetch anything. Without this, an open tab kept
  // running whatever JS was already in memory (stale layout, old
  // copy, etc.) until something happened to trigger a real reload,
  // which is what made the app look like it "reverted" on open and only
  // caught up after a manual refresh. `controllerchange` only fires
  // when the controller actually changes (i.e. once per deploy that
  // lands while a tab's open), so this reloads exactly when it needs to
  // and not on every ordinary load.
  let refreshedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshedForUpdate) return;
    refreshedForUpdate = true;
    window.location.reload();
  });
}
