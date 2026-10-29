// Timezone helpers shared by the cron job and the Google integration.
// Prefer a real IANA zone name (settings.timezone, DST-aware via Node's
// built-in Intl); fall back to the fixed UTC offset older settings rows
// only have.

// Returns a Date whose UTC fields equal the user's local wall-clock time.
export function shiftToLocal(date, tz) {
  const timezone = tz?.timezone;
  const offsetMinutes = tz?.offsetMinutes ?? 0;
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(date);
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      let hour = Number(map.hour);
      if (hour === 24) hour = 0;
      return new Date(
        Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second), date.getUTCMilliseconds())
      );
    } catch {
      // invalid zone name: fall through to the offset
    }
  }
  return new Date(date.getTime() + offsetMinutes * 60000);
}

// Converts a local wall-clock time (expressed as a Date whose UTC fields
// are the wall-clock fields) back to the real instant. Iterates because
// the offset itself depends on the instant (DST).
export function localToUtc(localWall, tz) {
  let guess = new Date(localWall.getTime());
  for (let i = 0; i < 3; i++) {
    const offsetMs = shiftToLocal(guess, tz).getTime() - guess.getTime();
    const next = new Date(localWall.getTime() - offsetMs);
    if (next.getTime() === guess.getTime()) break;
    guess = next;
  }
  return guess;
}

// Today at `hour`:00 local time, as a real instant.
export function zonedTimeToday(now, hour, timezone, offsetMinutes) {
  const tz = { timezone, offsetMinutes };
  const local = shiftToLocal(now, tz);
  return localToUtc(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour)), tz);
}

// Next occurrence of a recurring reminder, stepped in the user's *local*
// calendar: a daily 9am reminder stays at 9am local across a DST change
// (adding 24h in UTC would move it to 8am or 10am).
export function nextOccurrenceLocal(date, recurrence, tz) {
  const local = shiftToLocal(date, tz);
  if (recurrence === "daily") local.setUTCDate(local.getUTCDate() + 1);
  else if (recurrence === "weekly") local.setUTCDate(local.getUTCDate() + 7);
  else if (recurrence === "monthly") local.setUTCMonth(local.getUTCMonth() + 1);
  else return new Date(date);
  return localToUtc(local, tz);
}

export function localDateISO(localDate) {
  const y = localDate.getUTCFullYear();
  const m = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(localDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function localHour(localDate) {
  return localDate.getUTCHours();
}

export function localWeekKey(localDate) {
  const day = localDate.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return localDateISO(new Date(localDate.getTime() + diff * 24 * 60 * 60 * 1000));
}
