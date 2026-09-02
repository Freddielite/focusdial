import { useCallback, useEffect, useRef, useState } from "react";
import * as outbox from "../outbox.js";
import { API_BASE_URL } from "../api.js";

// Matches the tempId shape queueableFetch generates (api.js) --
// "local-<timestamp>-<random>". Used to find and resolve references to
// a not-yet-synced item embedded in a later queue entry's path/body
// (e.g. bumping a task that was itself created while offline).
const TEMP_ID_PATTERN = /local-\d+-[a-z0-9]+/g;

function substituteTempIds(str, tempIdMap) {
  if (!str) return str;
  return str.replace(TEMP_ID_PATTERN, (match) => tempIdMap.get(match) || match);
}

function hasUnresolvedTempId(str) {
  if (!str) return false;
  return new RegExp(TEMP_ID_PATTERN.source).test(str);
}

async function replay(entry) {
  const res = await fetch(`${API_BASE_URL}${entry.path}`, {
    method: entry.httpMethod,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: entry.body || undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Sync failed with status ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Drains the outbox in the order things were queued, stopping at the
// first entry that comes back with a real server error (as opposed to
// still being offline) rather than skipping it -- a later entry can
// depend on an earlier one having landed (e.g. bumping a task that was
// itself created offline, whose path/body still reference that task's
// tempId), so replaying out of order or dropping a failed one silently
// could leave data in a worse state than just pausing and trying the
// whole queue again later.
//
// tempIdMap resolves exactly that dependency: it's filled in as each
// 'create' entry replays successfully (tempId -> the real id the
// server just assigned), and every later entry's path/body has any
// tempId it contains substituted for the resolved real id before being
// sent. Entries are already chronological, so a create is always
// processed before anything that references it -- the only way
// hasUnresolvedTempId can still be true after substitution is if that
// earlier create hasn't synced yet (e.g. it just failed for a real,
// non-connectivity reason), in which case this pauses here rather than
// firing a request that references an id the server has never heard of.
export function useSyncManager(onSynced) {
  const [pending, setPending] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState(null);
  const flushingRef = useRef(false);
  const onSyncedRef = useRef(onSynced);
  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);

  const refresh = useCallback(() => {
    outbox.listAll().then(setPending).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return outbox.subscribe(refresh);
  }, [refresh]);

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    flushingRef.current = true;
    setSyncing(true);
    let changed = false;
    let stoppedOnError = null;
    try {
      const entries = await outbox.listAll();
      const tempIdMap = new Map();
      for (const entry of entries) {
        const resolvedPath = substituteTempIds(entry.path, tempIdMap);
        const resolvedBody = substituteTempIds(entry.body, tempIdMap);
        if (hasUnresolvedTempId(resolvedPath) || hasUnresolvedTempId(resolvedBody)) {
          // Whatever this depends on hasn't synced yet in this pass --
          // stop here rather than send a request referencing an id the
          // server doesn't have. The next flush (on reconnect, or the
          // periodic retry) picks back up from the top.
          stoppedOnError = "Waiting on an earlier change to sync first";
          break;
        }
        try {
          const result = await replay({ ...entry, path: resolvedPath, body: resolvedBody });
          if (entry.op === "create" && entry.tempId && result?.id != null) {
            tempIdMap.set(entry.tempId, String(result.id));
          }
          await outbox.remove(entry.id);
          changed = true;
        } catch (err) {
          // A TypeError here means the connection dropped again mid-
          // flush -- just stop quietly, the next online event or the
          // periodic retry will pick back up where this left off. Any
          // other error is a real rejection from the backend, worth
          // surfacing so it doesn't fail silently forever.
          if (!(err instanceof TypeError)) {
            await outbox.markAttempt(entry.id, err);
            stoppedOnError = err.message || "Sync failed";
          }
          break;
        }
      }
    } finally {
      setSyncing(false);
      setLastError(stoppedOnError);
      flushingRef.current = false;
      if (changed) onSyncedRef.current?.();
    }
  }, []);

  useEffect(() => {
    window.addEventListener("online", flush);
    const interval = setInterval(flush, 20000);
    flush();
    return () => {
      window.removeEventListener("online", flush);
      clearInterval(interval);
    };
  }, [flush]);

  return { pending, syncing, lastError, flushNow: flush };
}
