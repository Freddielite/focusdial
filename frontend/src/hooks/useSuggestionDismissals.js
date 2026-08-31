import { useState } from "react";

const STORAGE_KEY = "focusdial-suggestion-dismissals";

// Purely local, same reasoning as useDeviceName - a dismissed suggestion
// on this device shouldn't need a round trip to the backend just to
// suppress it for a day (SUGGESTION_COOLDOWN_HOURS, priorityWeights.js).
// If the account is used on a second device, that device simply hasn't
// seen the dismissal yet and may show the same suggestion again -
// an acceptable gap for what's a cooldown on a nudge, not account data.
export function useSuggestionDismissals() {
  const [dismissedAt, setDismissedAt] = useState(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  });

  function dismiss(key) {
    setDismissedAt((prev) => {
      const next = { ...prev, [key]: new Date().toISOString() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return [dismissedAt, dismiss];
}
