import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import FocusMark from "./FocusMark.jsx";

const ToastContext = createContext(null);

// One-line access from anywhere under the provider:
//   const toast = useToast();
//   toast({ title: "Session logged", body: "45m added", tone: "success" });
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const DEFAULT_DURATION = 5000;

// Small inline glyphs per tone - kept as SVG rather than an icon
// dependency so the bundle stays lean and the strokes inherit the tone
// colour via currentColor.
function ToneIcon({ tone }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
  if (tone === "success") {
    return (
      <svg {...common}><path d="M20 6 9 17l-5-5" /></svg>
    );
  }
  if (tone === "warn") {
    return (
      <svg {...common}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
    );
  }
  if (tone === "danger") {
    return (
      <svg {...common}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>
    );
  }
  // default / info - the FocusMark reticle, tying toasts to the brand
  return <FocusMark size={18} strokeWidth={2} />;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    ({ title, body, tone = "default", duration = DEFAULT_DURATION, actionLabel, onAction }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, title, body, tone, actionLabel, onAction, duration }]);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        );
      }
      return id;
    },
    [dismiss]
  );

  // Attached to the returned function rather than changing useToast()'s
  // return shape (which every existing `const toast = useToast();
  // toast({...})` call site already assumes is a plain function) - this
  // way both the old calling convention and `toast.dismiss(id)` work.
  toast.dismiss = dismiss;

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fd-toast-region" role="region" aria-label="Notifications" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              className={`fd-toast fd-toast--${t.tone}`}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
            >
              <span className="fd-toast__icon"><ToneIcon tone={t.tone} /></span>
              <div className="fd-toast__body">
                <div className="fd-toast__title">{t.title}</div>
                {t.body && <div className="fd-toast__text">{t.body}</div>}
              </div>
              {t.actionLabel && (
                <button
                  className="fd-toast__action"
                  onClick={() => {
                    t.onAction?.();
                    dismiss(t.id);
                  }}
                >
                  {t.actionLabel}
                </button>
              )}
              <button className="fd-toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                ✕
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
