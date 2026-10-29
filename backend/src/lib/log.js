// Minimal structured (one JSON object per line) logger. Render, Fly and
// most log drains index JSON fields, so "every 500 for user X in the last
// hour" becomes a search instead of a scroll. Anything that looks like a
// credential is redacted before it is written - see REDACT_KEYS.
const REDACT_KEYS = /pass(word)?|secret|token|authorization|cookie|code|totp|p256dh|auth$/i;

function redact(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  return out;
}

function write(level, msg, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact(fields || {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields),
};

// Strips query-string secrets (e.g. the legacy ?secret= on /cron/tick) and
// reset tokens out of logged paths.
export function safePath(url) {
  return String(url).replace(/([?&](secret|token|code|state)=)[^&]*/gi, "$1[redacted]");
}
