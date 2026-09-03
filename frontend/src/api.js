import { enqueue, collapsePendingCreate } from "./outbox.js";

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

// Wraps apiFetch for a specific list of mutating endpoints (see each
// export below) so that a genuine connectivity failure -- offline, not
// a real rejection from the backend -- queues the request in the
// outbox instead of throwing. Deliberately narrower than "retry on any
// TypeError": only fetch's own network-level TypeError qualifies (see
// isRetryable's comment on why that's the one case where the request
// provably never reached the server), so a slow/erroring backend still
// surfaces normally rather than silently vanishing into the queue.
//
// meta.op is 'create' | 'update' | 'delete' | 'action'. meta.resourceId
// is the id being updated/deleted/acted on (null for create). When
// that id is itself a not-yet-synced tempId ("local-..."), an
// update/delete folds into the still-pending create instead of queuing
// a second entry that would 404 once replayed -- see
// collapsePendingCreate's own comment. An 'action' targeting a tempId
// is NOT collapsed the same way -- bump/dismiss/convert/log-progress
// have real server-side effects a plain patch-merge can't represent
// (collapsing dismiss into the create's payload would silently drop
// the dismiss instead of applying it), so these are queued normally
// with the tempId still embedded in path/body, and useSyncManager
// resolves it to the real id once the create ahead of it in the queue
// has synced.
//
// meta.optimisticExtra merges into the patch used for the immediate
// return value and the list overlay ONLY -- never into what's actually
// sent to the server. It exists for fields the backend defaults on
// insert (e.g. a new task's status) that the create payload never
// includes, so the optimistic row matches what the server will
// eventually produce instead of missing a field every other view
// filters on.
async function queueableFetch(path, options, meta) {
  try {
    return await apiFetch(path, options);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    const patch = options.body
      ? { ...JSON.parse(options.body), ...(meta.optimisticExtra || {}) }
      : meta.optimisticExtra || null;
    if (meta.op !== "action" && meta.resourceId != null && String(meta.resourceId).startsWith("local-")) {
      const handled = await collapsePendingCreate(
        meta.kind,
        meta.resourceId,
        meta.op === "delete" ? "delete" : "update",
        patch
      );
      if (handled) return meta.op === "delete" ? null : { ...patch, id: meta.resourceId, __pending: true };
      // Fell through: not actually a pending create (stale id, or some
      // other edge case) -- queue it normally below rather than lose
      // the change outright.
    }
    const tempId = meta.op === "create" ? `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : null;
    await enqueue({
      kind: meta.kind,
      op: meta.op,
      httpMethod: (options.method || "POST").toUpperCase(),
      path,
      body: options.body || null,
      resourceId: meta.resourceId ?? null,
      tempId,
      patch,
    });
    return tempId ? { ...patch, id: tempId, __pending: true } : { __queued: true };
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

export const listTags = (includeArchived = false) =>
  apiFetch(includeArchived ? "/tags?include_archived=1" : "/tags");
export const createTag = (name, color) =>
  queueableFetch("/tags", { method: "POST", body: JSON.stringify({ name, color }) }, { kind: "tag", op: "create" });
export const deleteTag = (id) =>
  queueableFetch(`/tags/${id}`, { method: "DELETE" }, { kind: "tag", op: "delete", resourceId: id });
export const setTagArchived = (id, archived) =>
  queueableFetch(
    `/tags/${id}`,
    { method: "PATCH", body: JSON.stringify({ archived }) },
    { kind: "tag", op: "update", resourceId: id }
  );
// Rename/recolor. Same PATCH the archive toggle and budget assignment
// already use - the backend's COALESCE handling means sending just
// {name, color} here leaves archived/budget_id untouched.
export const updateTag = (id, name, color) =>
  queueableFetch(
    `/tags/${id}`,
    { method: "PATCH", body: JSON.stringify({ name, color }) },
    { kind: "tag", op: "update", resourceId: id }
  );

export const getRunningSession = () => apiFetch("/sessions/running");
export const startSession = (tag_id, note, task_id, device_name) =>
  apiFetch("/sessions/start", { method: "POST", body: JSON.stringify({ tag_id, note, task_id, device_name }) });
export const stopSession = (id, note, quality, interruptions) =>
  apiFetch(`/sessions/${id}/stop`, { method: "POST", body: JSON.stringify({ note, quality, interruptions }) });

export const createManualSession = (payload) =>
  queueableFetch("/sessions", { method: "POST", body: JSON.stringify(payload) }, { kind: "session", op: "create" });
// Also used by TimerPanel for note/quality/retag edits on a *running*
// session - not queueable-visible via the overlay in that case (a
// running session isn't in `history` yet, see App.jsx), but still
// safely queued and replayed once synced like any other edit.
export const updateSession = (id, payload) =>
  queueableFetch(
    `/sessions/${id}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    { kind: "session", op: "update", resourceId: id }
  );
export const deleteSession = (id) =>
  queueableFetch(`/sessions/${id}`, { method: "DELETE" }, { kind: "session", op: "delete", resourceId: id });

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
// Not an apiFetch call - this is a full-page redirect to Google's
// consent screen (and back to /api/auth/google/callback), not a JSON
// request/response.
export const googleAuthStartUrl = () => `${BASE_URL}/auth/google/start`;
export const disconnectGoogleAccount = () => apiFetch("/auth/google/disconnect", { method: "POST" });

export const listBudgets = () => apiFetch("/budgets");
export const createBudget = (name, weekly_target_hours, color) =>
  queueableFetch(
    "/budgets",
    { method: "POST", body: JSON.stringify({ name, weekly_target_hours, color }) },
    { kind: "budget", op: "create" }
  );
export const updateBudget = (id, payload) =>
  queueableFetch(
    `/budgets/${id}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    { kind: "budget", op: "update", resourceId: id }
  );
export const deleteBudget = (id) =>
  queueableFetch(`/budgets/${id}`, { method: "DELETE" }, { kind: "budget", op: "delete", resourceId: id });
export const assignTagToBudget = (tagId, budget_id) =>
  queueableFetch(
    `/tags/${tagId}`,
    { method: "PATCH", body: JSON.stringify({ budget_id }) },
    { kind: "tag", op: "update", resourceId: tagId }
  );

export const listDeadlines = () => apiFetch("/deadlines");
export const createDeadline = (payload) =>
  queueableFetch("/deadlines", { method: "POST", body: JSON.stringify(payload) }, { kind: "deadline", op: "create" });
export const updateDeadline = (id, payload) =>
  queueableFetch(
    `/deadlines/${id}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    { kind: "deadline", op: "update", resourceId: id }
  );
// 'action', not 'update' - a progress log doesn't overwrite fields on
// the deadline row the same way a plain PATCH does (see the route's own
// accumulation logic), so it isn't something the optimistic overlay
// can represent by merging a patch object. Still queued and replayed
// like everything else, just not visible until it syncs.
export const logDeadlineProgress = (id, hours) =>
  queueableFetch(
    `/deadlines/${id}/log`,
    { method: "POST", body: JSON.stringify({ hours }) },
    { kind: "deadline", op: "action", resourceId: id }
  );
export const deleteDeadline = (id) =>
  queueableFetch(`/deadlines/${id}`, { method: "DELETE" }, { kind: "deadline", op: "delete", resourceId: id });

export const getPushPublicKey = () => apiFetch("/push/public-key");
export const subscribeToPush = (subscription) =>
  apiFetch("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
export const unsubscribeFromPush = (endpoint) =>
  apiFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });

export const listReminders = () => apiFetch("/reminders");
export const createReminder = (payload) =>
  queueableFetch("/reminders", { method: "POST", body: JSON.stringify(payload) }, { kind: "reminder", op: "create" });
export const updateReminder = (id, payload) =>
  queueableFetch(
    `/reminders/${id}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    { kind: "reminder", op: "update", resourceId: id }
  );
// Conversion/dismiss are 'action', same reasoning as logDeadlineProgress
// above - they don't map onto a plain list-row patch.
export const convertReminderToDeadline = (id, payload) =>
  queueableFetch(
    `/reminders/${id}/convert-to-deadline`,
    { method: "POST", body: JSON.stringify(payload) },
    { kind: "reminder", op: "action", resourceId: id }
  );
export const convertReminderToTask = (id, payload) =>
  queueableFetch(
    `/reminders/${id}/convert-to-task`,
    { method: "POST", body: JSON.stringify(payload) },
    { kind: "reminder", op: "action", resourceId: id }
  );
export const dismissReminder = (id) =>
  queueableFetch(`/reminders/${id}/dismiss`, { method: "POST" }, { kind: "reminder", op: "action", resourceId: id });
export const deleteReminder = (id) =>
  queueableFetch(`/reminders/${id}`, { method: "DELETE" }, { kind: "reminder", op: "delete", resourceId: id });

export const listTasks = () => apiFetch("/tasks");
// Completed tasks with both a tag and an estimate, for the priority
// engine's estimate-learning feature (computeTagEstimateStats in
// priorityEngine.js) - see GET /tasks/completed for why this is a
// separate, filtered endpoint rather than a query param on listTasks.
export const listCompletedTasks = () => apiFetch("/tasks/completed");
export const createTask = (title, due_date, recurrence, tag_id, estimate_minutes) =>
  queueableFetch(
    "/tasks",
    { method: "POST", body: JSON.stringify({ title, due_date, recurrence, tag_id, estimate_minutes }) },
    // status isn't part of the create payload -- the backend defaults
    // it to 'open' on insert (see the tasks table). optimisticExtra
    // fills that in on the local/overlay row only, since TimerPanel,
    // ManualEntryForm, SessionEditModal, and the priority engine all
    // filter tasks by status === "open" to build their "link a task"
    // pickers -- without this a task created offline is invisible to
    // all of them until it syncs.
    { kind: "task", op: "create", optimisticExtra: { status: "open" } }
  );
export const updateTask = (id, payload) =>
  queueableFetch(
    `/tasks/${id}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    { kind: "task", op: "update", resourceId: id }
  );
export const deleteTask = (id) =>
  queueableFetch(`/tasks/${id}`, { method: "DELETE" }, { kind: "task", op: "delete", resourceId: id });
// Feature 3's bump/defer action - resets a task's staleness clock
// without completing it or touching any other field. See the route's
// own comment for why this is a dedicated endpoint instead of an empty
// PATCH. 'action', same reasoning as the other one-off endpoints above.
export const bumpTask = (id) =>
  queueableFetch(`/tasks/${id}/bump`, { method: "POST" }, { kind: "task", op: "action", resourceId: id });

export const getSettings = () => apiFetch("/settings");
// Queued like everything else above if offline - App.jsx's updateSetting
// already applies the change optimistically and only rolls it back on a
// real rejection, so a queued (not thrown) result here just means that
// optimistic value quietly sticks until sync confirms it server-side.
export const updateSettings = (payload) =>
  queueableFetch("/settings", { method: "PUT", body: JSON.stringify(payload) }, { kind: "settings", op: "action" });

// Fire a push for one of the three app-driven events (session_completed,
// deadline_completed, budget_reached). The client only calls this while
// the page is backgrounded - see maybePushEvent in push.js - so the user
// gets an in-app toast when looking and a push when not.
export const sendNotify = (type, title, body) =>
  apiFetch("/notify", { method: "POST", body: JSON.stringify({ type, title, body }) });

export const resetData = (categories) =>
  apiFetch("/data/reset", { method: "POST", body: JSON.stringify({ categories }) });
