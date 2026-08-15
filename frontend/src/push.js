import { getPushPublicKey, subscribeToPush, unsubscribeFromPush, sendNotify, API_BASE_URL } from "./api.js";

// App-driven events (session/deadline/budget) always show an in-app
// toast. They should ALSO push - but only when the app is backgrounded,
// so someone actively watching the toast doesn't get a redundant system
// notification for the same thing. document.hidden is true when the tab
// is in the background or the screen is off; that's exactly the "they
// won't see the toast" case. The server still gates each event by its
// own Settings toggle, so this is best-effort and safe to call freely.
export function maybePushEvent(type, title, body) {
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  sendNotify(type, title, body).catch(() => {});
}

// Push subscription keys arrive from the server as URL-safe base64;
// PushManager.subscribe() needs them as a raw Uint8Array instead - this
// is the standard conversion function used in essentially every Web
// Push tutorial, not something specific to this app.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function getPushStatus() {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  return existing ? "subscribed" : "not-subscribed";
}

// Must be called from a direct user gesture (a click handler) - browsers
// silently ignore or reject permission requests made outside one.
export async function enablePush() {
  if (!isPushSupported()) throw new Error("Push notifications aren't supported in this browser.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const { publicKey, configured } = await getPushPublicKey();
  if (!configured) {
    throw new Error("Push notifications aren't configured on the server yet (missing VAPID keys).");
  }

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await subscribeToPush(subscription.toJSON());
  return subscription;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await unsubscribeFromPush(existing.endpoint);
    await existing.unsubscribe();
  }
}

// Persistent "session running" notification with a Stop action, tapped
// from the lock screen or notification shade without reopening the app.
// Best-effort and silent: this only shows if push permission was already
// granted through the normal Settings flow - it never prompts on its
// own, since a session starting isn't a moment to interrupt someone with
// a permission dialog.
//
// The Stop action itself is Android/Chrome-only - WebKit (Safari, and
// therefore every iOS browser, since they're all WebKit under the hood)
// has never implemented the Notification actions API. iOS still gets
// the notification, just without a working button; tapping the body
// opens the app instead, same as any other notification. Not a bug to
// chase - there's no iOS API path to reach for here.
export async function showRunningSessionNotification(session) {
  if (!isPushSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification("Session running", {
      body: session.tag_name ? `Tracking: ${session.tag_name}` : "Untitled session",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "running-session", // replaces itself rather than stacking on repeated calls
      renotify: false,
      silent: true, // this is a status indicator, not an alert - no sound/vibration on (re)show
      // Anchors the OS's own "posted X ago" display to when the session
      // actually started, not to whenever this call happened to run - // without this, that indicator effectively restarts every time
      // this is re-called (page reload, tab refocus, etc.) instead of
      // ticking up correctly for the session's true duration, no polling
      // required to keep it accurate.
      timestamp: new Date(session.started_at).getTime(),
      actions: [{ action: "stop", title: "Stop" }], // ignored harmlessly on iOS/WebKit, see comment above
      data: {
        type: "running-session",
        url: "/",
        // Absolute so the service worker (which has no access to this
        // module's BASE_URL logic) can call it directly.
        stopUrl: `${API_BASE_URL}/sessions/${session.id}/stop`,
      },
    });
  } catch {
    // Notification API can still throw in some embedded/PWA contexts
    // even after the support+permission checks above - never worth
    // failing the actual session start over.
  }
}

export async function clearRunningSessionNotification() {
  if (!isPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.getNotifications({ tag: "running-session" });
    existing.forEach((n) => n.close());
  } catch {
    // Same reasoning as above - never worth surfacing to the user.
  }
}
