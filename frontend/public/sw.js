// Deliberately minimal - this exists to satisfy Chrome's install
// requirement (a registered service worker with a fetch handler), not to
// provide full offline support. API requests always hit the network
// directly (this app's data changes constantly; serving stale cached
// session data would be actively wrong, not just imperfect). Static
// same-origin assets use a cache-first, update-in-background strategy so
// repeat loads feel instant.

// v2: navigation requests (the page shell) are now network-first (see
// the fetch handler below) -- bumping the cache name so any shell
// entries cached under the old cache-first behavior get dropped by the
// activate handler instead of lingering forever under the same key.
const CACHE_NAME = "focusdial-shell-v2";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return; // let the browser handle API calls and cross-origin requests normally
  }

  // The page shell (any top-level navigation) always goes network-first.
  // Its URL never changes between deploys the way the hashed /assets/*.js
  // it references does, so cache-first here means a stale shell -- and
  // the stale JS bundle it points at -- can get served indefinitely,
  // including right after landing back from a Google OAuth redirect
  // (the exact moment freshness matters most). A network failure still
  // falls back to whatever's cached, so this stays offline-friendly.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(request)))
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Displays a system notification when the backend's cron job (see
// backend/src/routes/cron.js) sends a push - this fires even if the app
// tab isn't open, as long as the browser process is running (and, per
// Chrome/Edge/Firefox, even if it isn't, on most desktop/Android setups).
self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || "FocusDial", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag,
      data: { url: data.url || "/" },
    })
  );
});

// Focuses an already-open tab if one exists, otherwise opens a new one - // standard pattern for "clicking a notification should bring you to the
// app, not spawn duplicate tabs every time.
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};

  // The running-session notification's Stop button (Android/Chrome
  // only - see push.js's showRunningSessionNotification for why this
  // action is absent on iOS). Called directly from here rather than
  // waking the app first, since the whole point is working even when
  // the app isn't open. credentials: "include" is required the same way
  // it is everywhere else in this app - the session cookie doesn't ride
  // along automatically on a cross-origin fetch without it.
  if (event.action === "stop" && data.type === "running-session" && data.stopUrl) {
    event.notification.close();
    event.waitUntil(
      fetch(data.stopUrl, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" })
        .catch((err) => console.error("stop-from-notification failed:", err))
        .then(() =>
          // Tells any open tab to refresh its timer state - stopping via
          // the notification wouldn't otherwise be reflected there until
          // the next reload.
          self.clients.matchAll({ type: "window", includeUncontrolled: true })
        )
        .then((clientList) => {
          if (clientList) clientList.forEach((c) => c.postMessage({ type: "session-stopped-remotely" }));
        })
    );
    return;
  }

  event.notification.close();
  const targetUrl = data.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
