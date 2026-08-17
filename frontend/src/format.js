// Reduces a stored display name down to just its first word, for every
// spot the app addresses someone directly (greeting, weekly review
// title, streak-congratulation message, push notifications) -- "Freddie
// Elite" reads as a nickname/title combo, not a first+last name a
// greeting should spell out in full. A plain space-split rather than
// anything fancier (no honorific stripping, no locale-aware name
// parsing): this app only ever collects one free-text display-name
// field, so "first word" is the only signal available, and it's the
// same signal a person would use reading it themselves.
export function firstName(name) {
  if (!name) return name;
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.split(/\s+/)[0];
}

export function formatDuration(totalSeconds) {
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0 && m === 0) return "0m";
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Formats a Date as the value a `datetime-local` input expects, in the
// browser's local timezone (not UTC/toISOString, which would shift the
// displayed time). Shared between ManualEntryForm and SessionEditModal.
export function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

// Breaks the gap between `nowMs` and `targetDate` into whole
// days/hours/minutes/seconds for a live ticking countdown. `overdue` is
// true once the target has passed -- callers use that to swap the label
// (e.g. "left" -> "overdue by") rather than showing a negative countdown.
export function formatCountdown(targetDate, nowMs) {
  const diffMs = new Date(targetDate).getTime() - nowMs;
  const overdue = diffMs <= 0;
  const totalSeconds = Math.floor(Math.abs(diffMs) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const parts = days > 0 ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return { overdue, days, hours, minutes, seconds, text: parts };
}

export function formatHour(hour) {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${period}`;
}

// ---- Shared parsing/formatting for the custom Date/Time/DateTime
// pickers (DateTimeField.jsx). These keep the exact same string
// contracts native inputs use, so every call site that already does
// `new Date(value)` or `value.split("T")` keeps working untouched --
// only the widget rendering the field changes, not what value it
// produces.

// "YYYY-MM-DD" -> local Date at midnight. Parsing manually (not
// `new Date("YYYY-MM-DD")`) avoids that string being read as UTC
// midnight, which would then display as the previous day in any
// timezone behind UTC.
export function parseDateValue(value) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function formatDateValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "HH:MM" (24h, what a native time input stores) -> { hour24, minute }
export function parseTimeValue(value) {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { hour24: h, minute: m };
}

export function formatTimeValue(hour24, minute) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hour24)}:${pad(minute)}`;
}

export function formatDateDisplay(value, opts = {}) {
  const date = parseDateValue(value);
  if (!date) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: opts.withYear === false ? undefined : "numeric",
  });
}

export function formatTimeDisplay(value) {
  const t = parseTimeValue(value);
  if (!t) return "";
  const period = t.hour24 < 12 ? "AM" : "PM";
  const h12 = t.hour24 % 12 === 0 ? 12 : t.hour24 % 12;
  return `${h12}:${String(t.minute).padStart(2, "0")} ${period}`;
}
