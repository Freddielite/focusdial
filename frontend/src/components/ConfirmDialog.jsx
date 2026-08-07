import { createContext, useCallback, useContext, useRef, useState } from "react";

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
      {dialog && (
        // Clicking the backdrop cancels, same as the Cancel button —
        // matches how SessionEditModal's overlay already behaves.
        <div className="fd-modal-overlay" onClick={() => choose(false)}>
          <div className="fd-panel fd-modal-panel fd-confirm-panel" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
