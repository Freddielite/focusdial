// Relative path by default (works via Vite's dev proxy to localhost:4000,
// and works if ever served from the same origin as the backend). Set
// VITE_API_URL only when the frontend is hosted separately from the
// backend (e.g. Vercel + Render).
const BASE_URL = `${import.meta.env.VITE_API_URL || ""}/api`;

// Exported so push.js can hand the service worker a full, working stop
// URL inside a notification's data - the SW runs as a separate script
// outside this module graph and has no other way to know the backend's
// origin, especially once frontend/backend are split across
// Vercel/Render (different origins).
export const API_BASE_URL = BASE_URL;

let slowRequestHandler = null;
export function setSlowRequestHandler(fn) {
  slowRequestHandler = fn;
}

// Fires when a request comes back 401 - lets App.jsx drop straight to
// the login screen on a genuinely expired/missing session, instead of
// every affected component separately showing its own confusing "failed
// to load" error.
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

const SLOW_REQUEST_MS = 2500;
// Render's free tier spins the backend down after idle and can take
// 20-50s to wake back up on the next request -- the old 20s timeout
// routinely fired mid-wake, right before the server would've actually
// responded, which is what made requests look like they "took time to
// work most of the time" (first attempt times out, a manual retry a
// moment later succeeds because the server's warm by then).
const REQUEST_TIMEOUT_MS = 45000;
const RETRY_DELAY_MS = 800;
let slowCount = 0;

function isIdempotentMethod(options) {
  const method = (options.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

// A bare network failure (DNS hiccup, connection refused while the
// backend is still asleep) surfaces as a generic TypeError from fetch
// itself, before any response exists -- the request never reached the
// server, so retrying it is always safe regardless of method. Our own
// timeout (AbortError) is different: the server may well have already
// received and started acting on it, so it's only safe to silently
// retry for read-only (GET/HEAD) calls; a POST/PATCH/DELETE that times
// out surfaces the error normally rather than risk a duplicate write.
function isRetryable(err, options) {
  if (err instanceof TypeError) return true;
  if (err.name === "AbortError") return isIdempotentMethod(options);
  return false;
}

async function attemptFetch(path, options, timeoutMs) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      // Required for the session cookie to actually be sent - without
      // this, a cross-origin deploy (frontend on Vercel, backend on
      // Render) silently drops it and every request looks logged-out.
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) unauthorizedHandler?.();
      const err = new Error(body.error || `Request failed with status ${res.status}`);
      // Attached so callers can branch on more than just the message
      // string -- e.g. /sessions/start's 409 conflict body carries the
      // actual running session (see TimerPanel's multi-device conflict
      // handling), which a plain Error message can't hold.
      err.status = res.status;
      err.body = body;
      throw err;
    }
    if (res.status === 204) return null;
    return await res.json();
  } finally {
    clearTimeout(abortTimer);
  }
}

async function apiFetch(path, options = {}) {
  let countedSlow = false;
  const timer = setTimeout(() => {
    countedSlow = true;
    slowCount += 1;
    slowRequestHandler?.(true);
  }, SLOW_REQUEST_MS);
  try {
    try {
      return await attemptFetch(path, options, REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (!isRetryable(err, options)) {
        if (err.name === "AbortError") throw new Error("Request timed out. Check your connection and try again.");
        throw err;
      }
      // One retry only, after a short pause - a sleeping backend is
      // usually awake by now; a second failure means something's
      // actually wrong rather than just cold-starting, so that one is
      // surfaced to the caller as normal.
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      try {
        return await attemptFetch(path, options, REQUEST_TIMEOUT_MS);
      } catch (err2) {
        if (err2.name === "AbortError") throw new Error("Request timed out. Check your connection and try again.");
        throw err2;
      }
    }
  } finally {
    clearTimeout(timer);
    if (countedSlow) {
      slowCount = Math.max(0, slowCount - 1);
      if (slowCount === 0) slowRequestHandler?.(false);
    }
  }
}

export const getAuthConfig = () => apiFetch("/auth/config");
export const getMe = () => apiFetch("/auth/me");
export const register = (email, password, displayName) =>
  apiFetch("/auth/register", { method: "POST", body: JSON.stringify({ email, password, displayName }) });
export const login = (email, password) =>
  apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
export const logout = () => apiFetch("/auth/logout", { method: "POST" });
export const updateProfile = (displayName) =>
  apiFetch("/auth/me", { method: "PATCH", body: JSON.stringify({ displayName }) });
// Full-page redirect, not a fetch - same reasoning as googleAuthStartUrl
// below.
export const googleLoginStartUrl = () => `${BASE_URL}/auth/google/login/start`;

export const listTags = () => apiFetch("/tags");
export const createTag = (name, color) =>
  apiFetch("/tags", { method: "POST", body: JSON.stringify({ name, color }) });
export const deleteTag = (id) => apiFetch(`/tags/${id}`, { method: "DELETE" });

export const getRunningSession = () => apiFetch("/sessions/running");
export const startSession = (tag_id, note, task_id) =>
  apiFetch("/sessions/start", { method: "POST", body: JSON.stringify({ tag_id, note, task_id }) });
export const stopSession = (id, note, quality) =>
  apiFetch(`/sessions/${id}/stop`, { method: "POST", body: JSON.stringify({ note, quality }) });

export const createManualSession = (payload) =>
  apiFetch("/sessions", { method: "POST", body: JSON.stringify(payload) });
export const updateSession = (id, payload) =>
  apiFetch(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteSession = (id) => apiFetch(`/sessions/${id}`, { method: "DELETE" });

// Returns { sessions, total }. total is null when includeTotal is false
// -- callers that already know the total (paging without a mutation)
// pass that to skip the count query server-side; total is only worth
// recomputing on first load or after a create/delete.
export const listRecentSessions = (limit = 10, offset = 0, includeTotal = true) =>
  apiFetch(`/sessions?limit=${limit}&offset=${offset}&count=${includeTotal ? 1 : 0}`);
export const getSessionHistory = () => apiFetch("/sessions/history");

// Not an apiFetch call - this is a direct download link handed to an <a>
// tag, since the response is a file (CSV/JSON with Content-Disposition),
// not a JSON body to parse.
export const sessionsExportUrl = (format) => `${BASE_URL}/sessions/export?format=${format}`;

export const getGoogleAuthStatus = () => apiFetch("/auth/google/status");
// Not an apiFetch call - this is a full-page redirect to Google's
// consent screen (and back to /api/auth/google/callback), not a JSON
// request/response.
export const googleAuthStartUrl = () => `${BASE_URL}/auth/google/start`;
export const disconnectGoogleAccount = () => apiFetch("/auth/google/disconnect", { method: "POST" });

export const listBudgets = () => apiFetch("/budgets");
export const createBudget = (name, weekly_target_hours, color) =>
  apiFetch("/budgets", { method: "POST", body: JSON.stringify({ name, weekly_target_hours, color }) });
export const updateBudget = (id, payload) =>
  apiFetch(`/budgets/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteBudget = (id) => apiFetch(`/budgets/${id}`, { method: "DELETE" });
export const assignTagToBudget = (tagId, budget_id) =>
  apiFetch(`/tags/${tagId}`, { method: "PATCH", body: JSON.stringify({ budget_id }) });

export const listDeadlines = () => apiFetch("/deadlines");
export const createDeadline = (payload) =>
  apiFetch("/deadlines", { method: "POST", body: JSON.stringify(payload) });
export const updateDeadline = (id, payload) =>
  apiFetch(`/deadlines/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const logDeadlineProgress = (id, hours) =>
  apiFetch(`/deadlines/${id}/log`, { method: "POST", body: JSON.stringify({ hours }) });
export const deleteDeadline = (id) => apiFetch(`/deadlines/${id}`, { method: "DELETE" });

export const getPushPublicKey = () => apiFetch("/push/public-key");
export const subscribeToPush = (subscription) =>
  apiFetch("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
export const unsubscribeFromPush = (endpoint) =>
  apiFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });

export const listReminders = () => apiFetch("/reminders");
export const createReminder = (payload) =>
  apiFetch("/reminders", { method: "POST", body: JSON.stringify(payload) });
export const updateReminder = (id, payload) =>
  apiFetch(`/reminders/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const convertReminderToDeadline = (id, payload) =>
  apiFetch(`/reminders/${id}/convert-to-deadline`, { method: "POST", body: JSON.stringify(payload) });
export const convertReminderToTask = (id, payload) =>
  apiFetch(`/reminders/${id}/convert-to-task`, { method: "POST", body: JSON.stringify(payload) });
export const dismissReminder = (id) => apiFetch(`/reminders/${id}/dismiss`, { method: "POST" });
export const deleteReminder = (id) => apiFetch(`/reminders/${id}`, { method: "DELETE" });

export const listTasks = () => apiFetch("/tasks");
export const createTask = (title, due_date) =>
  apiFetch("/tasks", { method: "POST", body: JSON.stringify({ title, due_date }) });
export const updateTask = (id, payload) =>
  apiFetch(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteTask = (id) => apiFetch(`/tasks/${id}`, { method: "DELETE" });

export const getSettings = () => apiFetch("/settings");
export const updateSettings = (payload) =>
  apiFetch("/settings", { method: "PUT", body: JSON.stringify(payload) });

// Fire a push for one of the three app-driven events (session_completed,
// deadline_completed, budget_reached). The client only calls this while
// the page is backgrounded - see maybePushEvent in push.js - so the user
// gets an in-app toast when looking and a push when not.
export const sendNotify = (type, title, body) =>
  apiFetch("/notify", { method: "POST", body: JSON.stringify({ type, title, body }) });

export const resetData = (categories) =>
  apiFetch("/data/reset", { method: "POST", body: JSON.stringify({ categories }) });
