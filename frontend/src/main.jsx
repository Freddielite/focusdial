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
}
