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

// Formats the gap between now and a due Date as a live countdown string.
// Shows seconds only once things get close (under an hour left) so the
// display doesn't jitter with a ticking seconds digit when the deadline
// is days out -- e.g. "3d 4h", "42m 10s", or once past due "2h 5m overdue".
export function formatCountdown(dueDate, now = new Date()) {
  const diffMs = dueDate.getTime() - now.getTime();
  const overdue = diffMs < 0;
  const totalSeconds = Math.floor(Math.abs(diffMs) / 1000);

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let text;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${minutes}m`;
  else text = `${minutes}m ${seconds}s`;

  return overdue ? `${text} overdue` : text;
}

export function formatHour(hour) {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${period}`;
}
