import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

let dropdownIdCounter = 0;

// Drop-in replacement for a native <select>: pass the same <option>
// children and the same value/onChange contract. Rendered as its own
// styled trigger + list instead of the OS's native picker, so it looks
// like the rest of the app (and looks the same across browsers/devices).
//
// The option list is portaled to <body> and positioned with fixed
// coordinates measured from the trigger. That's what lets it show
// above scrollable modals (fd-modal-panel etc.) without being clipped,
// and it flips above the trigger when there isn't room below.
export default function Dropdown({ className = "", value, onChange, disabled = false, name, children }) {
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => ({
      value: child.props.value ?? "",
      label: child.props.children,
      disabled: !!child.props.disabled,
    }));

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const idRef = useRef(`fd-dd-${++dropdownIdCounter}`);

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  function measure() {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const listHeight = Math.min(280, options.length * 38 + 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < listHeight && rect.top > spaceBelow;
    setCoords({
      left: rect.left,
      // Floor, not fixed width — a trigger that's shrink-wrapped to a
      // short selected value (e.g. "None") would otherwise force every
      // option in the list to that same narrow width, clipping options
      // with longer labels even when there's plenty of room to grow.
      minWidth: rect.width,
      top: flipUp ? undefined : rect.bottom + 4,
      bottom: flipUp ? window.innerHeight - rect.top + 4 : undefined,
      maxHeight: flipUp ? Math.min(280, rect.top - 12) : Math.min(280, spaceBelow - 12),
    });
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    listRef.current?.focus();
    setHighlighted(selectedIndex);

    function onScrollOrResize() {
      measure();
    }
    function onDocPointerDown(e) {
      if (triggerRef.current?.contains(e.target)) return;
      if (listRef.current?.contains(e.target)) return;
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

  function commit(index) {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    if (opt.value !== value) onChange({ target: { value: opt.value, name } });
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(highlighted);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`fd-dropdown__trigger ${className}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="fd-dropdown__value">{selected ? selected.label : ""}</span>
        <svg
          className={`fd-dropdown__chevron ${open ? "fd-dropdown__chevron--open" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        coords &&
        createPortal(
          <ul
            className="fd-dropdown__list"
            role="listbox"
            ref={listRef}
            tabIndex={-1}
            onKeyDown={onListKeyDown}
            aria-activedescendant={`${idRef.current}-${highlighted}`}
            style={{
              left: coords.left,
              minWidth: coords.minWidth,
              maxWidth: `calc(100vw - ${coords.left * 2}px)`,
              top: coords.top,
              bottom: coords.bottom,
              maxHeight: coords.maxHeight,
            }}
          >
            {options.map((opt, i) => (
              <li
                key={`${opt.value}-${i}`}
                id={`${idRef.current}-${i}`}
                role="option"
                aria-selected={opt.value === value}
                className={[
                  "fd-dropdown__option",
                  opt.value === value ? "fd-dropdown__option--selected" : "",
                  i === highlighted ? "fd-dropdown__option--active" : "",
                  opt.disabled ? "fd-dropdown__option--disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => commit(i)}
              >
                {opt.label}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
