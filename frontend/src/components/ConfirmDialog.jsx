import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const ConfirmContext = createContext(null);

// Usage from anywhere under <ConfirmProvider>:
//   const confirm = useConfirm();
//   const ok = await confirm({ title: "Delete this session?" });
//   if (!ok) return;
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolveRef = useRef(null);

  const confirm = useCallback(
    ({ title, body, confirmLabel = "Delete", cancelLabel = "Cancel", danger = true }) => {
      setDialog({ title, body, confirmLabel, cancelLabel, danger });
      return new Promise((resolve) => {
        resolveRef.current = resolve;
      });
    },
    []
  );

  function choose(result) {
    setDialog(null);
    resolveRef.current?.(result);
    resolveRef.current = null;
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {dialog && (
          // Clicking the backdrop cancels, same as the Cancel button -
          // matches how SessionEditModal's overlay already behaves.
          <motion.div
            className="fd-modal-overlay fd-modal-overlay--sheet"
            onClick={() => choose(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              className="fd-panel fd-modal-panel fd-modal-panel--sheet fd-confirm-panel"
              onClick={(e) => e.stopPropagation()}
              // Slides up from the bottom edge rather than popping in
              // from the center - see the App.css comment on
              // .fd-modal-panel--sheet for why. No opacity fade on the
              // panel itself: solid background, so fading it in over the
              // (also still-fading) backdrop would briefly show its text
              // through both layers.
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
            >
              <div className="fd-modal-panel--sheet__handle" />
              <div className="fd-panel__label">{dialog.title}</div>
              {dialog.body && <div className="fd-confirm-body">{dialog.body}</div>}
              <div className="fd-confirm-actions">
                <button type="button" className="fd-link-btn" onClick={() => choose(false)}>
                  {dialog.cancelLabel}
                </button>
                <button
                  type="button"
                  className={`fd-btn ${dialog.danger ? "fd-btn--danger" : "fd-btn--start"}`}
                  onClick={() => choose(true)}
                  autoFocus
                >
                  {dialog.confirmLabel}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  );
}
