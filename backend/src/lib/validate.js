// Shared input checks for the authenticated API. Before this, a malformed
// value in any of these fields went straight into a Postgres query, which
// rejected it ("invalid input syntax for type uuid/date/time", or a CHECK
// constraint violation) - and every route's catch block turned that into
// a generic 500 "failed to ...". The client got no hint what was wrong,
// and the server logs filled with what were really just bad requests.
//
// Field-based rather than per-route so a new route that accepts one of
// these fields is covered without anyone remembering to add a check.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RECURRENCES = new Set(["none", "daily", "weekly", "monthly"]);

// Resources whose second path segment is a row id, minus the literal
// sub-routes that share that position.
const ID_RESOURCES = new Set(["tags", "sessions", "budgets", "deadlines", "reminders", "tasks"]);
const LITERAL_SEGMENTS = new Set(["running", "start", "history", "export", "completed"]);

const MAX_NAME_LENGTH = 80;

function isPresent(v) {
  return v !== undefined && v !== null && v !== "";
}

function isValidTimestamp(v) {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function isValidDate(v) {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Rejects 2026-02-31 etc., which the regex alone lets through.
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function checkBody(req) {
  const body = req.body;
  if (!body || typeof body !== "object") return null;

  for (const field of ["started_at", "ended_at", "remind_at"]) {
    if (isPresent(body[field]) && !isValidTimestamp(body[field])) return `${field} must be a valid date/time`;
  }
  if (isPresent(body.due_date) && !isValidDate(body.due_date)) return "due_date must be a valid YYYY-MM-DD date";
  if (isPresent(body.due_time) && (typeof body.due_time !== "string" || !TIME_RE.test(body.due_time))) {
    return "due_time must be HH:MM";
  }
  if (isPresent(body.recurrence) && !RECURRENCES.has(body.recurrence)) {
    return "recurrence must be none, daily, weekly, or monthly";
  }
  if (isPresent(body.color) && (typeof body.color !== "string" || !COLOR_RE.test(body.color))) {
    return "color must be a hex color like #E0A93D";
  }
  // Tag and budget names are shown in chips, dropdowns and notifications
  // throughout the app; an unbounded name breaks those layouts.
  if (/^\/(tags|budgets)(\/|$)/.test(req.path) && typeof body.name === "string" && body.name.trim().length > MAX_NAME_LENGTH) {
    return `name must be ${MAX_NAME_LENGTH} characters or fewer`;
  }
  if (req.path === "/settings" && isPresent(body.timezone) && (typeof body.timezone !== "string" || !isValidTimeZone(body.timezone))) {
    return "timezone must be a valid IANA time zone name";
  }
  return null;
}

export function validateInput(req, res, next) {
  // Malformed row id in the URL: that row can't exist, so 404 - same as
  // a well-formed id that belongs to nobody (or someone else).
  const [, resource, id] = req.path.split("/");
  if (ID_RESOURCES.has(resource) && id && !LITERAL_SEGMENTS.has(id) && !UUID_RE.test(id)) {
    return res.status(404).json({ error: `${resource.replace(/s$/, "")} not found` });
  }

  // Session Log date-range filter (GET /sessions?from=&to=).
  for (const key of ["from", "to"]) {
    const v = req.query?.[key];
    if (isPresent(v) && !isValidTimestamp(v)) {
      return res.status(400).json({ error: `${key} must be a valid date/time` });
    }
  }

  if (["POST", "PATCH", "PUT"].includes(req.method)) {
    const error = checkBody(req);
    if (error) return res.status(400).json({ error });
  }
  next();
}
