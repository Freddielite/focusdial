import { useState } from "react";

const STORAGE_KEY = "focusdial-daily-ritual-seen";

// Purely local, same reasoning as useDeviceName/useSuggestionDismissals -
// "have I already shown today's morning plan on this device" doesn't
// need a round trip to the backend, and there's no real harm in a second
// device showing its own once too. Keyed by local calendar day so it
// naturally resets every morning without any cleanup logic.
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function readStore() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

export function useDailyRitualSeen() {
  const [store, setStore] = useState(readStore);
  const key = todayKey();
  const entry = store[key] || {};

  function mark(part) {
    setStore((prev) => {
      const next = { ...prev, [key]: { ...(prev[key] || {}), [part]: true } };
      // Only the current day's entry is worth keeping - trims anything
      // from a previous day in the same write rather than letting this
      // grow forever.
      const trimmed = { [key]: next[key] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return trimmed;
    });
  }

  return {
    morningSeenToday: Boolean(entry.morning),
    eveningSeenToday: Boolean(entry.evening),
    markMorningSeen: () => mark("morning"),
    markEveningSeen: () => mark("evening"),
  };
}
