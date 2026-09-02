// Local queue for mutations that couldn't reach the backend because the
// device was offline (see api.js's queueableFetch, which is what
// actually writes here). Backed by IndexedDB so the queue survives a
// reload/app restart, not just an in-memory tab session -- someone who
// starts a task offline, closes the app, and reopens it hours later
// online should still have that task waiting to sync.
//
// Each entry:
//   { id, kind, op, httpMethod, path, body, resourceId, tempId, patch,
//     createdAt, attempts, lastError }
// - kind: which resource this is ('tag' | 'task' | 'deadline' |
//   'budget' | 'reminder' | 'session' | 'settings') -- used to group
//   entries for the sync-status UI and to target the right list when
//   overlaying pending changes onto already-loaded data.
// - op: 'create' | 'update' | 'delete' | 'action'. 'action' covers
//   one-off endpoints (bump a task, dismiss a reminder, log deadline
//   progress, stop a running session) that don't map onto a plain
//   create/update/delete of a list row, so they're queued and replayed
//   like the others but intentionally left out of the optimistic
//   overlay below -- they'll simply take effect once synced.
// - httpMethod/path/body: exactly what to replay against the backend,
//   verbatim -- see useSyncManager.js.
// - resourceId: the real server id being updated/deleted/acted on, or
//   null for a create.
// - tempId: client-generated id for a 'create' op, used as this row's
//   `id` in the optimistic overlay until the real id exists.
// - patch: the parsed request body, used to build/merge the optimistic
//   row (kept separate from `body` -- the JSON string -- so the overlay
//   doesn't need to reparse it on every render).

const DB_NAME = "focusdial-outbox";
const DB_VERSION = 1;
const STORE = "queue";

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Plain pub-sub rather than a context/provider -- the only consumer is
// useSyncManager's own polling-on-change refresh, so a full context
// would just be ceremony around one callback list.
const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((fn) => fn());
}

export async function enqueue(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const record = { ...entry, createdAt: Date.now(), attempts: 0, lastError: null };
    const req = tx.objectStore(STORE).add(record);
    req.onsuccess = () => {
      record.id = req.result;
    };
    tx.oncomplete = () => {
      notify();
      resolve(record);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function listAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  });
}

export async function remove(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => {
      notify();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function markAttempt(id, err) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return;
      record.attempts += 1;
      record.lastError = err ? String(err.message || err) : null;
      store.put(record);
    };
    tx.oncomplete = () => {
      notify();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// Same-session edit/delete of something that was itself created while
// offline: there's nothing synced yet to PATCH/DELETE on the server, so
// rather than queue a second entry that would 404 once replayed
// (there's no such id at the backend), fold the change directly into
// the still-pending 'create' entry -- an edit merges into its payload,
// a delete just removes the create outright, since the row never
// existed anywhere but here. Returns true if it found and handled a
// matching pending create, false if this wasn't one (a real, already-
// synced item being edited/deleted offline, which the caller should
// queue normally instead).
export async function collapsePendingCreate(kind, tempId, mode, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    let handled = false;
    req.onsuccess = () => {
      const match = req.result.find((e) => e.kind === kind && e.op === "create" && e.tempId === tempId);
      if (!match) return;
      handled = true;
      if (mode === "delete") {
        store.delete(match.id);
      } else {
        match.patch = { ...(match.patch || {}), ...(patch || {}) };
        match.body = JSON.stringify(match.patch);
        store.put(match);
      }
    };
    tx.oncomplete = () => {
      if (handled) notify();
      resolve(handled);
    };
    tx.onerror = () => reject(tx.error);
  });
}

// Merges queued-but-not-yet-synced changes onto an already-loaded list
// so they're visible immediately instead of only appearing after the
// next successful sync + refetch. 'action' ops are deliberately skipped
// (see the op comment up top) -- there's no list-row shape for e.g. "bump
// this task" to merge in ahead of time.
export function applyOverlay(list, kind, entries, idKey = "id") {
  const relevant = entries.filter((e) => e.kind === kind);
  if (!relevant.length) return list;
  let result = list;
  for (const e of relevant) {
    if (e.op === "create") {
      result = [...result, { ...(e.patch || {}), [idKey]: e.tempId, __pending: true }];
    } else if (e.op === "update") {
      result = result.map((item) =>
        String(item[idKey]) === String(e.resourceId) ? { ...item, ...(e.patch || {}), __pending: true } : item
      );
    } else if (e.op === "delete") {
      result = result.filter((item) => String(item[idKey]) !== String(e.resourceId));
    }
  }
  return result;
}
