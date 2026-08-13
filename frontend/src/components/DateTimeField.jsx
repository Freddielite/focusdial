import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatDateValue,
  formatDateDisplay,
  formatTimeDisplay,
  formatTimeValue,
  parseDateValue,
  parseTimeValue,
} from "../format.js";

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Shared trigger-button + portaled-popup positioning, same approach as
// Dropdown.jsx (fixed coords measured off the trigger, flips above when
// there isn't room below) so every custom field in the app behaves
// identically regardless of which kind of value it edits.
function usePopover() {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  function measure(panelHeight) {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < panelHeight && rect.top > spaceBelow;
    setCoords({
      left: Math.min(rect.left, window.innerWidth - 300),
      minWidth: rect.width,
      top: flipUp ? undefined : rect.bottom + 6,
      bottom: flipUp ? window.innerHeight - rect.top + 6 : undefined,
    });
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure(360);
    function onScrollOrResize() {
      measure(360);
    }
    function onDocPointerDown(e) {
      if (triggerRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("mousedown", onDocPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("mousedown", onDocPointerDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { open, setOpen, coords, triggerRef, panelRef };
}

// Calendar grid for a single month. Pure display + click -- the caller
// owns what "selecting a day" means (commit-and-close for DatePicker,
// stay-open for DateTimePicker's combined panel).
function CalendarGrid({ selected, onSelect }) {
  const today = new Date();
  const [viewDate, setViewDate] = useState(() => selected || today);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  function goMonth(delta) {
    setViewDate(new Date(year, month + delta, 1));
  }

  return (
    <div className="fd-datefield__calendar">
      <div className="fd-datefield__cal-head">
        <button type="button" className="fd-datefield__nav" onClick={() => goMonth(-1)} aria-label="Previous month">
          ‹
        </button>
        <span className="fd-datefield__cal-title">
          {MONTH_LABELS[month]} {year}
        </span>
        <button type="button" className="fd-datefield__nav" onClick={() => goMonth(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="fd-datefield__weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="fd-datefield__grid">
        {cells.map((d, i) =>
          d ? (
            <button
              type="button"
              key={i}
              className={[
                "fd-datefield__day",
                sameDay(d, today) ? "fd-datefield__day--today" : "",
                sameDay(d, selected) ? "fd-datefield__day--selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelect(d)}
            >
              {d.getDate()}
            </button>
          ) : (
            <span key={i} />
          )
        )}
      </div>
      <button type="button" className="fd-link-btn fd-datefield__today-btn" onClick={() => onSelect(today)}>
        Today
      </button>
    </div>
  );
}

// Three scrollable columns (hour / minute / AM-PM), the same shape as
// a native mobile time wheel but styled to match the app instead of
// the OS. Selecting any column updates immediately; there's no
// separate "confirm" step for the column itself, only for the popup
// as a whole (via the Done button in TimePicker/DateTimePicker).
function TimeColumns({ hour24, minute, onChange }) {
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const isPM = hour24 >= 12;

  function setHour12(h12) {
    const newHour24 = isPM ? (h12 % 12) + 12 : h12 % 12;
    onChange(newHour24, minute);
  }
  function setPM(pm) {
    const newHour24 = pm ? (hour24 % 12) + 12 : hour24 % 12;
    onChange(newHour24, minute);
  }

  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const minutes = Array.from({ length: 60 }, (_, i) => i);

  return (
    <div className="fd-datefield__time-columns">
      <div className="fd-datefield__time-col">
        {hours.map((h) => (
          <button
            type="button"
            key={h}
            className={`fd-datefield__time-opt ${h === hour12 ? "fd-datefield__time-opt--selected" : ""}`}
            onClick={() => setHour12(h)}
          >
            {h}
          </button>
        ))}
      </div>
      <div className="fd-datefield__time-col">
        {minutes.map((m) => (
          <button
            type="button"
            key={m}
            className={`fd-datefield__time-opt ${m === minute ? "fd-datefield__time-opt--selected" : ""}`}
            onClick={() => onChange(hour24, m)}
          >
            {String(m).padStart(2, "0")}
          </button>
        ))}
      </div>
      <div className="fd-datefield__time-col fd-datefield__time-col--ampm">
        <button
          type="button"
          className={`fd-datefield__time-opt ${!isPM ? "fd-datefield__time-opt--selected" : ""}`}
          onClick={() => setPM(false)}
        >
          AM
        </button>
        <button
          type="button"
          className={`fd-datefield__time-opt ${isPM ? "fd-datefield__time-opt--selected" : ""}`}
          onClick={() => setPM(true)}
        >
          PM
        </button>
      </div>
    </div>
  );
}

// Drop-in replacement for <input type="date">. Same value ("YYYY-MM-DD")
// / onChange({ target: { value } }) contract, so call sites don't
// change beyond swapping the tag.
export function DatePicker({ value, onChange, required, className = "", placeholder = "Select date" }) {
  const { open, setOpen, coords, triggerRef, panelRef } = usePopover();
  const selected = parseDateValue(value);

  function commit(date) {
    onChange({ target: { value: formatDateValue(date) } });
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`fd-dropdown__trigger fd-datefield__trigger ${className}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-required={required || undefined}
      >
        <span className={`fd-dropdown__value ${!value ? "fd-datefield__placeholder" : ""}`}>
          {value ? formatDateDisplay(value) : placeholder}
        </span>
        <CalendarGlyph />
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            className="fd-datefield__popover"
            style={{ left: coords.left, minWidth: coords.minWidth, top: coords.top, bottom: coords.bottom }}
          >
            <CalendarGrid selected={selected} onSelect={commit} />
          </div>,
          document.body
        )}
    </>
  );
}

// Drop-in replacement for <input type="time">. Value is "HH:MM" (24h),
// same as the native input.
export function TimePicker({ value, onChange, className = "", placeholder = "Select time" }) {
  const { open, setOpen, coords, triggerRef, panelRef } = usePopover();
  const t = parseTimeValue(value) || { hour24: 9, minute: 0 };

  function handleChange(hour24, minute) {
    onChange({ target: { value: formatTimeValue(hour24, minute) } });
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`fd-dropdown__trigger fd-datefield__trigger ${className}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={`fd-dropdown__value ${!value ? "fd-datefield__placeholder" : ""}`}>
          {value ? formatTimeDisplay(value) : placeholder}
        </span>
        <ClockGlyph />
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            className="fd-datefield__popover fd-datefield__popover--time"
            style={{ left: coords.left, minWidth: coords.minWidth, top: coords.top, bottom: coords.bottom }}
          >
            <TimeColumns hour24={t.hour24} minute={t.minute} onChange={handleChange} />
            <button type="button" className="fd-btn fd-btn--start fd-datefield__done" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

// Drop-in replacement for <input type="datetime-local">. Value is
// "YYYY-MM-DDTHH:MM", same as the native input -- callers that do
// `new Date(value)` or split on "T" keep working untouched.
export function DateTimePicker({ value, onChange, required, className = "", placeholder = "Select date & time" }) {
  const { open, setOpen, coords, triggerRef, panelRef } = usePopover();
  const [datePart, timePart] = value ? value.split("T") : [null, null];
  const selectedDate = parseDateValue(datePart);
  const t = parseTimeValue(timePart) || { hour24: 9, minute: 0 };

  function commit(nextDatePart, nextTimePart) {
    onChange({ target: { value: `${nextDatePart}T${nextTimePart}` } });
  }

  function handleDaySelect(date) {
    commit(formatDateValue(date), timePart || formatTimeValue(t.hour24, t.minute));
  }

  function handleTimeChange(hour24, minute) {
    commit(datePart || formatDateValue(new Date()), formatTimeValue(hour24, minute));
  }

  const display = value
    ? `${formatDateDisplay(datePart)} · ${formatTimeDisplay(timePart)}`
    : placeholder;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`fd-dropdown__trigger fd-datefield__trigger ${className}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-required={required || undefined}
      >
        <span className={`fd-dropdown__value ${!value ? "fd-datefield__placeholder" : ""}`}>{display}</span>
        <CalendarGlyph />
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            className="fd-datefield__popover fd-datefield__popover--combo"
            style={{ left: coords.left, minWidth: coords.minWidth, top: coords.top, bottom: coords.bottom }}
          >
            <CalendarGrid selected={selectedDate} onSelect={handleDaySelect} />
            <div className="fd-datefield__divider" />
            <TimeColumns hour24={t.hour24} minute={t.minute} onChange={handleTimeChange} />
            <button type="button" className="fd-btn fd-btn--start fd-datefield__done" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

export function CalendarGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
