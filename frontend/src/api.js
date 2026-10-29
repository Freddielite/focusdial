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
  // A timed-out POST is safe to retry now that it carries an
  // Idempotency-Key - the server replays instead of writing twice.
  if (err.name === "AbortError") return isIdempotentMethod(options) || Boolean(options.headers?.["Idempotency-Key"]);
  return false;
}

// Something a person can act on, for the rare response with no message.
function friendlyStatusMessage(status) {
  if (status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (status === 413) return "That's too large to save.";
  if (status >= 500) return "The server had a problem. Your change may not have saved - please try again.";
  if (status === 404) return "That item no longer exists. Refresh to see the latest.";
  return `Request failed (${status}). Please try again.`;
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
      const err = new Error(body.error || friendlyStatusMessage(res.status));
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

function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

async function apiFetch(path, options = {}) {
  // Every POST carries an Idempotency-Key, generated once per user action
  // and re-sent unchanged if this function retries. If the first attempt
  // actually reached the server (a network error can happen *after* the
  // request was sent), the retry gets the original response back instead
  // of creating a second session/deadline/task. See backend
  // lib/idempotency.js.
  if ((options.method || "GET").toUpperCase() === "POST" && !options.headers?.["Idempotency-Key"]) {
    options = { ...options, headers: { ...(options.headers || {}), "Idempotency-Key": newIdempotencyKey() } };
  }
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
export const verifyMfa = (code) => apiFetch("/auth/mfa/verify", { method: "POST", body: JSON.stringify({ code }) });
export const requestPasswordReset = (email) =>
  apiFetch("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email }) });
export const confirmPasswordReset = (token, password) =>
  apiFetch("/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, password }) });

// Account security (Settings -> Account & security).
export const changePassword = (currentPassword, newPassword) =>
  apiFetch("/account/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
export const listAccountSessions = () => apiFetch("/account/sessions");
export const revokeSessions = (keepCurrent, currentEndpoint) =>
  apiFetch("/account/sessions/revoke", { method: "POST", body: JSON.stringify({ keepCurrent, currentEndpoint }) });
export const getMfaStatus = () => apiFetch("/account/mfa");
export const startMfaSetup = () => apiFetch("/account/mfa/setup", { method: "POST" });
export const enableMfa = (code) => apiFetch("/account/mfa/enable", { method: "POST", body: JSON.stringify({ code }) });
export const disableMfa = (password, code) =>
  apiFetch("/account/mfa/disable", { method: "POST", body: JSON.stringify({ password, code }) });
export const regenerateRecoveryCodes = (code) =>
  apiFetch("/account/mfa/recovery-codes", { method: "POST", body: JSON.stringify({ code }) });
export const getSecurityActivity = () => apiFetch("/account/activity");
export const accountExportUrl = () => `${BASE_URL}/account/export`;
export const deleteAccount = (password, confirmEmail) =>
  apiFetch("/account/delete", { method: "POST", body: JSON.stringify({ password, confirmEmail }) });

// Full-page redirect, not a fetch - same reasoning as googleAuthStartUrl
// below.
export const googleLoginStartUrl = () => `${BASE_URL}/auth/google/login/start`;

export const listTags = (includeArchived = false) =>
  apiFetch(includeArchived ? "/tags?include_archived=1" : "/tags");
export const createTag = (name, color) =>
  apiFetch("/tags", { method: "POST", body: JSON.stringify({ name, color }) });
export const deleteTag = (id) =>
  apiFetch(`/tags/${id}`, { method: "DELETE" });
export const setTagArchived = (id, archived) =>
  apiFetch(`/tags/${id}`, { method: "PATCH", body: JSON.stringify({ archived }) });
// Rename/recolor. Same PATCH the archive toggle and budget assignment
// already use - the backend's COALESCE handling means sending just
// {name, color} here leaves archived/budget_id untouched.
export const updateTag = (id, name, color) =>
  apiFetch(`/tags/${id}`, { method: "PATCH", body: JSON.stringify({ name, color }) });

export const getRunningSession = () => apiFetch("/sessions/running");
export const startSession = (tag_id, note, task_id, device_name) =>
  apiFetch("/sessions/start", { method: "POST", body: JSON.stringify({ tag_id, note, task_id, device_name }) });
export const stopSession = (id, note, quality) =>
  apiFetch(`/sessions/${id}/stop`, { method: "POST", body: JSON.stringify({ note, quality }) });

export const createManualSession = (payload) =>
  apiFetch("/sessions", { method: "POST", body: JSON.stringify(payload) });
export const updateSession = (id, payload) =>
  apiFetch(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteSession = (id) =>
  apiFetch(`/sessions/${id}`, { method: "DELETE" });

// Returns { sessions, total, periodStats }. total is null when
// includeTotal is false -- callers that already know the total (paging
// without a mutation) pass that to skip the count query server-side;
// total is only worth recomputing on first load or after a
// create/delete. periodStats is null unless filters.from/filters.to is
// set (see routes/sessions.js) -- it's the Session Log's own scoped
// "totals for this range" summary, separate from the all-time Insights
// tab.
export const listRecentSessions = (limit = 10, offset = 0, includeTotal = true, filters = {}) => {
  const params = new URLSearchParams({ limit, offset, count: includeTotal ? 1 : 0 });
  if (filters.q) params.set("q", filters.q);
  if (filters.tagId) params.set("tag_id", filters.tagId);
  if (filters.quality) params.set("quality", filters.quality);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return apiFetch(`/sessions?${params.toString()}`);
};
export const getSessionHistory = () => apiFetch("/sessions/history");

// Not an apiFetch call - this is a direct download link handed to an <a>
// tag, since the response is a file (CSV/JSON with Content-Disposition),
// not a JSON body to parse.
export const sessionsExportUrl = (format) => `${BASE_URL}/sessions/export?format=${format}`;

export const getGoogleAuthStatus = () => apiFetch("/auth/google/status");
export const getTodayBusyBlocks = () => apiFetch("/calendar/today-busy");
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
export const deleteBudget = (id) =>
  apiFetch(`/budgets/${id}`, { method: "DELETE" });
export const assignTagToBudget = (tagId, budget_id) =>
  apiFetch(`/tags/${tagId}`, { method: "PATCH", body: JSON.stringify({ budget_id }) });

export const listDeadlines = () => apiFetch("/deadlines");
export const createDeadline = (payload) =>
  apiFetch("/deadlines", { method: "POST", body: JSON.stringify(payload) });
export const updateDeadline = (id, payload) =>
  apiFetch(`/deadlines/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const logDeadlineProgress = (id, hours) =>
  apiFetch(`/deadlines/${id}/log`, { method: "POST", body: JSON.stringify({ hours }) });
export const deleteDeadline = (id) =>
  apiFetch(`/deadlines/${id}`, { method: "DELETE" });

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
export const dismissReminder = (id) =>
  apiFetch(`/reminders/${id}/dismiss`, { method: "POST" });
export const deleteReminder = (id) =>
  apiFetch(`/reminders/${id}`, { method: "DELETE" });

export const listTasks = () => apiFetch("/tasks");
// Completed tasks with both a tag and an estimate, for the priority
// engine's estimate-learning feature (computeTagEstimateStats in
// priorityEngine.js) - see GET /tasks/completed for why this is a
// separate, filtered endpoint rather than a query param on listTasks.
export const listCompletedTasks = () => apiFetch("/tasks/completed");
export const createTask = (title, due_date, recurrence, tag_id, estimate_minutes) =>
  apiFetch("/tasks", { method: "POST", body: JSON.stringify({ title, due_date, recurrence, tag_id, estimate_minutes }) });
export const updateTask = (id, payload) =>
  apiFetch(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteTask = (id) =>
  apiFetch(`/tasks/${id}`, { method: "DELETE" });
// Feature 3's bump/defer action - resets a task's staleness clock
// without completing it or touching any other field. See the route's
// own comment for why this is a dedicated endpoint instead of an empty
// PATCH.
export const bumpTask = (id) =>
  apiFetch(`/tasks/${id}/bump`, { method: "POST" });

export const getSettings = () => apiFetch("/settings");
// Returns { model: null, trainedAt: null } for a new account or one
// without enough labeled sessions yet - see routes/qualityModel.js.
// Not an error case the caller needs to handle specially.
export const getQualityModel = () => apiFetch("/quality-model");
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
