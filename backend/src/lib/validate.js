// Shared input checks for the authenticated API, field-based rather than
// per-route so a new route that accepts one of these fields is covered
// automatically. The type checks matter beyond tidy 400s: before them, a
// number where a string was expected (e.g. {"name": 5}) reached
// name.trim() and threw.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RECURRENCES = new Set(["none", "daily", "weekly", "monthly"]);
const QUALITIES = new Set(["focused", "neutral", "distracted"]);

const ID_RESOURCES = new Set(["tags", "sessions", "budgets", "deadlines", "reminders", "tasks"]);
const LITERAL_SEGMENTS = new Set(["running", "start", "history", "export", "completed"]);

// Max lengths, in characters. Generous for real use, bounded so a single
// request can't store megabytes in a field that's rendered in a chip.
const STRING_FIELDS = {
  title: 200,
  name: 80,
  note: 2000,
  device_name: 80,
  email: 254,
  endpoint: 2048,
};

// Positive finite numbers with a sane ceiling.
const POSITIVE_NUMBERS = { estimated_hours: 10_000, hours: 1_000, weekly_target_hours: 168 };

const STATUS_BY_RESOURCE = {
  deadlines: new Set(["active", "done", "archived"]),
  tasks: new Set(["open", "done"]),
};

const BOOLEAN_FIELDS = ["archived", "add_as_task"];

function isPresent(v) {
  return v !== undefined && v !== null && v !== "";
}

function isValidTimestamp(v) {
  return typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

export function isValidDate(v) {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function checkBody(req, resource) {
  const body = req.body;
  if (body === undefined) return null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";

  for (const [field, max] of Object.entries(STRING_FIELDS)) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return `${field} must be a string`;
    if (v.length > max) return `${field} must be ${max} characters or fewer`;
  }
  for (const [field, max] of Object.entries(POSITIVE_NUMBERS)) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) {
      return `${field} must be a number greater than 0 and at most ${max}`;
    }
  }
  if (body.estimate_minutes !== undefined && body.estimate_minutes !== null) {
    const v = body.estimate_minutes;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100_000) {
      return "estimate_minutes must be a number of minutes greater than 0";
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "boolean") return `${field} must be true or false`;
  }
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
  if (isPresent(body.quality) && !QUALITIES.has(body.quality)) return "quality must be focused, neutral, or distracted";
  if (isPresent(body.color) && (typeof body.color !== "string" || !COLOR_RE.test(body.color))) {
    return "color must be a hex color like #E0A93D";
  }
  if (isPresent(body.status) && STATUS_BY_RESOURCE[resource] && !STATUS_BY_RESOURCE[resource].has(body.status)) {
    return `status must be one of: ${[...STATUS_BY_RESOURCE[resource]].join(", ")}`;
  }
  if (isPresent(body.auto_source_type) && !["deadline_risk", "budget_risk"].includes(body.auto_source_type)) {
    return "auto_source_type must be deadline_risk or budget_risk";
  }
  if (isPresent(body.auto_source_id) && (typeof body.auto_source_id !== "string" || !UUID_RE.test(body.auto_source_id))) {
    return "auto_source_id must be a UUID";
  }
  if (resource === "settings" && "timezone" in body && body.timezone !== null) {
    if (typeof body.timezone !== "string" || !isValidTimeZone(body.timezone)) return "timezone must be a valid IANA time zone name";
  }
  if (resource === "settings" && "timezone_offset_minutes" in body) {
    const v = body.timezone_offset_minutes;
    if (typeof v !== "number" || !Number.isInteger(v) || v < -840 || v > 840) {
      return "timezone_offset_minutes must be a whole number between -840 and 840";
    }
  }
  return null;
}

export function validateInput(req, res, next) {
  const [, resource, id] = req.path.split("/");
  if (ID_RESOURCES.has(resource) && id && !LITERAL_SEGMENTS.has(id) && !UUID_RE.test(id)) {
    return res.status(404).json({ error: `${resource.replace(/s$/, "")} not found` });
  }

  for (const key of ["from", "to"]) {
    const v = req.query?.[key];
    if (isPresent(v) && !isValidTimestamp(v)) return res.status(400).json({ error: `${key} must be a valid date/time` });
  }
  for (const key of ["tag_id", "task_id"]) {
    const v = req.query?.[key];
    if (isPresent(v) && (typeof v !== "string" || !UUID_RE.test(v))) return res.status(400).json({ error: `${key} must be a UUID` });
  }
  if (req.query?.q !== undefined && (typeof req.query.q !== "string" || req.query.q.length > 200)) {
    return res.status(400).json({ error: "q must be a string of 200 characters or fewer" });
  }
  if (req.query?.status !== undefined && resource === "deadlines" && !STATUS_BY_RESOURCE.deadlines.has(req.query.status)) {
    return res.status(400).json({ error: "status must be active, done, or archived" });
  }

  if (["POST", "PATCH", "PUT"].includes(req.method)) {
    const error = checkBody(req, resource);
    if (error) return res.status(400).json({ error });
  }
  next();
}
