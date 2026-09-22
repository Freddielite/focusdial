import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
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
//
// `estimatedHeight` is only a first-paint guess, used before the panel
// itself has rendered (so there's nothing real to measure yet). It used
// to be a single hardcoded 360 shared by all three pickers, which badly
// underestimated the combined date+time popover (calendar + divider +
// time columns + Done button comfortably clears 500px) -- so that one
// could get told "there's room below" when there wasn't, and render
// clipped off the bottom of the screen instead of flipping up. Once the
// panel actually mounts, a second pass below re-measures its real
// height and re-flips if the estimate was wrong.
function usePopover(estimatedHeight = 360, forceSheet = false) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  function measure(panelHeight) {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // visualViewport reflects the actual visible area and shrinks when the
    // on-screen keyboard opens; window.innerHeight doesn't reliably update
    // for that on iOS Safari, so a panel positioned against it can end up
    // placed behind/clipped by the keyboard instead of above it - matters
    // here since Note sits right above these fields in ManualEntryForm.
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    // Below ~480px wide there's rarely enough room in either direction to
    // anchor a popover beside its trigger without it overflowing the
    // screen. DateTimePicker also forces this unconditionally (see its
    // usePopover(580, true) call below) regardless of width, since its
    // combined calendar+time-columns panel is tall enough (~580px) that
    // trying to anchor it beside a trigger caused it to render off-screen
    // or run below the fold on real devices even when the width check
    // above should have caught it -- centering it outright removes the
    // guesswork instead of chasing more breakpoint edge cases.
    if (forceSheet || viewportWidth <= 480) {
      setCoords({ sheet: true });
      return;
    }
    const spaceBelow = viewportHeight - rect.bottom;
    const flipUp = spaceBelow < panelHeight && rect.top > spaceBelow;
    setCoords({
      left: Math.min(rect.left, window.innerWidth - 300),
      minWidth: rect.width,
      top: flipUp ? undefined : rect.bottom + 6,
      bottom: flipUp ? viewportHeight - rect.top + 6 : undefined,
    });
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure(estimatedHeight);
    function onScrollOrResize() {
      measure(panelRef.current?.getBoundingClientRect().height || estimatedHeight);
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
    window.visualViewport?.addEventListener("resize", onScrollOrResize);
    window.visualViewport?.addEventListener("scroll", onScrollOrResize);
    document.addEventListener("mousedown", onDocPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      window.visualViewport?.removeEventListener("resize", onScrollOrResize);
      window.visualViewport?.removeEventListener("scroll", onScrollOrResize);
      document.removeEventListener("mousedown", onDocPointerDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Second pass: now that the panel has actually rendered, measure its
  // real height and re-flip if the first-paint estimate above was wrong
  // in either direction (under, as with the combo popover, or over).
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const realHeight = panelRef.current.getBoundingClientRect().height;
    if (realHeight > 0) measure(realHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, coords?.top, coords?.bottom]);

  return { open, setOpen, coords, triggerRef, panelRef };
}

// Shared animated portal shell for all three pickers below - same
// spring-pop feel as Dropdown.jsx's menu (they're both fixed-position
// popovers measured off a trigger, so it made sense to match rather
// than invent a second popover animation style) and as
// NotificationBell's panel, which is where that style first came from.
// Kept in one place rather than repeated three times so the three
// pickers can't quietly drift out of sync with each other's motion feel.
function PopoverPanel({ open, coords, panelRef, className, onClose, children }) {
  // AnimatePresence has to live INSIDE the portaled subtree, not wrapped
  // around the createPortal(...) call - see the matching comment in
  // Dropdown.jsx. createPortal returns a ReactPortal, which
  // React.isValidElement (used internally by AnimatePresence to track
  // its children) treats as false, so AnimatePresence silently drops it
  // and nothing ever reaches document.body: the trigger's `open` state
  // still flips (chevron rotates, aria-expanded updates) but the panel
  // itself never mounts.
  const isSheet = coords?.sheet;

  const panel = open && coords ? (
    <motion.div
      ref={panelRef}
      className={`${className} ${isSheet ? "fd-datefield__popover--sheet" : ""}`}
      // Sheet mode centers via the backdrop's flexbox below, not CSS
      // transform -- Framer Motion writes its own `transform` (scale/y)
      // straight onto this same element's inline style every frame,
      // which would silently clobber a CSS `transform: translateY(-50%)`
      // centering trick placed here instead. Keeping the two mechanisms
      // on separate elements is what actually makes centering stick.
      style={isSheet ? undefined : { left: coords.left, minWidth: coords.minWidth, top: coords.top, bottom: coords.bottom }}
      onClick={isSheet ? (e) => e.stopPropagation() : undefined}
      // No opacity fade on this panel - it has a solid background, so
      // fading it in from 0 makes it translucent for a couple of frames,
      // during which its own text visibly overlaps whatever's behind it.
      // Not an issue in sheet mode (the backdrop already dims everything
      // behind it before the panel's content is legible), but very
      // visible for the anchored (non-sheet) case where it pops in
      // directly over other on-screen text/buttons with nothing behind
      // it to mask the overlap. Scale + position alone still pops in
      // clearly without ever being see-through.
      initial={{ scale: 0.92, y: isSheet ? 0 : coords.bottom != null ? 6 : -6 }}
      animate={{ scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: isSheet ? 0 : coords.bottom != null ? 4 : -4 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
    >
      {children}
    </motion.div>
  ) : null;

  return createPortal(
    <AnimatePresence>
      {open && coords && isSheet && (
        // Mobile: the backdrop doubles as the centering container (flex
        // align/justify-center in CSS) so the panel needs no transform
        // math of its own for position, only for its own enter/exit
        // scale+fade. It also blocks scroll-chaining and outside taps
        // from reaching the app behind it - see the earlier comment on
        // .fd-datefield__backdrop in App.css for why that matters here.
        // Desktop keeps the lighter click-outside-to-close behavior in
        // usePopover instead of a full-screen dim, which would be
        // visually heavy-handed for a small dropdown.
        <motion.div
          className="fd-datefield__backdrop"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {panel}
        </motion.div>
      )}
      {open && coords && !isSheet && panel}
    </AnimatePresence>,
    document.body
  );
}

// Calendar grid for a single month. Pure display + click -- the caller
// owns what "selecting a day" means (commit-and-close for DatePicker,
// stay-open for DateTimePicker's combined panel).
//
// `maxDate`, when passed, disables every day after it (cell renders
// unclickable and dimmed) and disables navigating to a month that would
// only contain such days -- otherwise "no future days" would still let
// someone flip forward into an all-disabled month and stare at it.
function CalendarGrid({ selected, onSelect, maxDate = null }) {
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

  const maxMonthStart = maxDate ? new Date(maxDate.getFullYear(), maxDate.getMonth(), 1) : null;
  const viewMonthStart = new Date(year, month, 1);
  const nextMonthDisabled = maxMonthStart ? viewMonthStart >= maxMonthStart : false;

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
        <button
          type="button"
          className="fd-datefield__nav"
          onClick={() => goMonth(1)}
          disabled={nextMonthDisabled}
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div className="fd-datefield__weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="fd-datefield__grid">
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const disabled = maxDate ? d > maxDate : false;
          return (
            <button
              type="button"
              key={i}
              className={[
                "fd-datefield__day",
                sameDay(d, today) ? "fd-datefield__day--today" : "",
                sameDay(d, selected) ? "fd-datefield__day--selected" : "",
                disabled ? "fd-datefield__day--disabled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              disabled={disabled}
              onClick={() => onSelect(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
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
// `maxHour24`/`maxMinute`, when passed (only meaningful when the
// selected day is today), disable any hour/minute/AM-PM combination
// that would land after that ceiling, and clamp the value down to it if
// the caller changes something that would otherwise push the time past
// it (e.g. flipping PM on at 11:47am when "now" is 11:30am).
function TimeColumns({ hour24, minute, onChange, maxHour24 = null, maxMinute = null }) {
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const isPM = hour24 >= 12;
  const hasMax = maxHour24 != null;

  function exceedsMax(h24, m) {
    if (!hasMax) return false;
    return h24 > maxHour24 || (h24 === maxHour24 && m > maxMinute);
  }
  function clampToMax(h24, m) {
    if (!exceedsMax(h24, m)) return { h24, m };
    return { h24: maxHour24, m: maxMinute };
  }

  function setHour12(h12) {
    const newHour24 = isPM ? (h12 % 12) + 12 : h12 % 12;
    const clamped = clampToMax(newHour24, minute);
    onChange(clamped.h24, clamped.m);
  }
  function setPM(pm) {
    const newHour24 = pm ? (hour24 % 12) + 12 : hour24 % 12;
    const clamped = clampToMax(newHour24, minute);
    onChange(clamped.h24, clamped.m);
  }
  function setMinute(m) {
    const clamped = clampToMax(hour24, m);
    onChange(clamped.h24, clamped.m);
  }

  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const minutes = Array.from({ length: 60 }, (_, i) => i);

  return (
    <div className="fd-datefield__time-columns">
      <div className="fd-datefield__time-col">
        {hours.map((h) => {
          const candidateHour24 = isPM ? (h % 12) + 12 : h % 12;
          // A hour is only truly unreachable if every minute within it
          // would exceed the ceiling (i.e. the hour itself is past
          // maxHour24) -- otherwise minute 00 through maxMinute are
          // still fine, so the hour stays clickable and only the
          // minutes past the ceiling get disabled below.
          const disabled = hasMax && candidateHour24 > maxHour24;
          return (
            <button
              type="button"
              key={h}
              className={`fd-datefield__time-opt ${h === hour12 ? "fd-datefield__time-opt--selected" : ""}`}
              disabled={disabled}
              onClick={() => setHour12(h)}
            >
              {h}
            </button>
          );
        })}
      </div>
      <div className="fd-datefield__time-col">
        {minutes.map((m) => {
          const disabled = exceedsMax(hour24, m);
          return (
            <button
              type="button"
              key={m}
              className={`fd-datefield__time-opt ${m === minute ? "fd-datefield__time-opt--selected" : ""}`}
              disabled={disabled}
              onClick={() => setMinute(m)}
            >
              {String(m).padStart(2, "0")}
            </button>
          );
        })}
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
          disabled={hasMax && maxHour24 < 12}
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
export function DatePicker({
  value,
  onChange,
  required,
  className = "",
  placeholder = "Select date",
  restrictFuture = false,
}) {
  const { open, setOpen, coords, triggerRef, panelRef } = usePopover(340);
  const selected = parseDateValue(value);
  const maxDate = restrictFuture ? new Date() : null;

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
      <PopoverPanel open={open} coords={coords} panelRef={panelRef} className="fd-datefield__popover" onClose={() => setOpen(false)}>
        <CalendarGrid selected={selected} onSelect={commit} maxDate={maxDate} />
      </PopoverPanel>
    </>
  );
}

// Drop-in replacement for <input type="time">. Value is "HH:MM" (24h),
// same as the native input.
export function TimePicker({ value, onChange, className = "", placeholder = "Select time" }) {
  const { open, setOpen, coords, triggerRef, panelRef } = usePopover(260);
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
      <PopoverPanel
        open={open}
        coords={coords}
        panelRef={panelRef}
        className="fd-datefield__popover fd-datefield__popover--time"
        onClose={() => setOpen(false)}
      >
        <TimeColumns hour24={t.hour24} minute={t.minute} onChange={handleChange} />
        <button type="button" className="fd-btn fd-btn--start fd-datefield__done" onClick={() => setOpen(false)}>
          Done
        </button>
      </PopoverPanel>
    </>
  );
}

// Drop-in replacement for <input type="datetime-local">. Value is
// "YYYY-MM-DDTHH:MM", same as the native input -- callers that do
// `new Date(value)` or split on "T" keep working untouched.
export function DateTimePicker({
  value,
  onChange,
  required,
  className = "",
  placeholder = "Select date & time",
  restrictFuture = false,
}) {
  const { open, setOpen, coords, triggerRef, panelRef } = usePopover(580, true);
  const [datePart, timePart] = value ? value.split("T") : [null, null];
  const selectedDate = parseDateValue(datePart);
  const t = parseTimeValue(timePart) || { hour24: 9, minute: 0 };

  const now = restrictFuture ? new Date() : null;
  const maxDate = now;
  // The hour/minute ceiling only applies when the selected day IS
  // today -- picking yesterday still allows 11pm, only today's own
  // remaining hours are capped against the clock.
  const onSelectedDayIsToday = now && selectedDate && sameDay(selectedDate, now);
  const maxHour24 = onSelectedDayIsToday ? now.getHours() : null;
  const maxMinute = onSelectedDayIsToday ? now.getMinutes() : null;

  function commit(nextDatePart, nextTimePart) {
    onChange({ target: { value: `${nextDatePart}T${nextTimePart}` } });
  }

  function handleDaySelect(date) {
    let nextHour24 = t.hour24;
    let nextMinute = t.minute;
    // Switching the date to today while a later time was already
    // selected (e.g. was on "tomorrow, 11pm", jump back to "today")
    // would otherwise leave that now-future time in place; clamp it
    // down to the current moment instead of silently letting a
    // future time survive the day change.
    if (restrictFuture && sameDay(date, now) && (nextHour24 > now.getHours() || (nextHour24 === now.getHours() && nextMinute > now.getMinutes()))) {
      nextHour24 = now.getHours();
      nextMinute = now.getMinutes();
    }
    commit(formatDateValue(date), formatTimeValue(nextHour24, nextMinute));
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
      <PopoverPanel
        open={open}
        coords={coords}
        panelRef={panelRef}
        className="fd-datefield__popover fd-datefield__popover--combo"
        onClose={() => setOpen(false)}
      >
        <CalendarGrid selected={selectedDate} onSelect={handleDaySelect} maxDate={maxDate} />
        <div className="fd-datefield__divider" />
        <TimeColumns
          hour24={t.hour24}
          minute={t.minute}
          onChange={handleTimeChange}
          maxHour24={maxHour24}
          maxMinute={maxMinute}
        />
        <button type="button" className="fd-btn fd-btn--start fd-datefield__done" onClick={() => setOpen(false)}>
          Done
        </button>
      </PopoverPanel>
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
