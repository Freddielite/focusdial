import { useState } from "react";

const STORAGE_KEY = "focusdial-device-name";

// Coarse browser + OS guess, good enough to tell two of *someone's own*
// devices apart at a glance ("Chrome on Mac" vs "Safari on iPhone") -
// not meant to be precise UA parsing, just a sane default so Settings
// doesn't open on an empty field. Falls back to a generic label if the
// UA string doesn't match anything recognized, rather than showing
// nothing.
function guessDeviceName() {
  if (typeof navigator === "undefined") return "This device";
  const ua = navigator.userAgent || "";
  let os = "Unknown OS";
  if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Mac OS X/.test(ua)) os = "Mac";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";

  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/CriOS\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";

  return `${browser} on ${os}`;
}

// Purely a local label for *this* browser - not synced to the account,
// not validated for uniqueness across someone's devices. Its only job
// is to travel along on POST /sessions/start (see api.js/TimerPanel.jsx)
// so the multi-device conflict banner can say which device is already
// running instead of the generic "another device" it said before this
// existed. Renaming it here only affects sessions started *after* the
// rename - already-running sessions keep whatever name they started
// with, same as any other snapshot-at-creation field elsewhere in this
// app (a tag's color at session time, etc.).
export function useDeviceName() {
  const [deviceName, setDeviceNameState] = useState(() => {
    if (typeof window === "undefined") return "This device";
    return localStorage.getItem(STORAGE_KEY) || guessDeviceName();
  });

  function setDeviceName(name) {
    const trimmed = name.trim() || guessDeviceName();
    setDeviceNameState(trimmed);
    localStorage.setItem(STORAGE_KEY, trimmed);
  }

  return [deviceName, setDeviceName];
}
