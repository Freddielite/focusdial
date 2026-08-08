import { useRef } from "react";
import { useToast } from "../components/Toast.jsx";

// How long a delete sits reversible before it actually happens. Matches
// the toast's own visible duration so the countdown the person sees is
// the real window, not just decorative.
const UNDO_WINDOW_MS = 3000;

// Shared "hide immediately, delay the real delete, offer Undo in the
// toast" pattern used by every delete action in the app. Deliberately
// doesn't own any list state itself — different components hold their
// items differently (some as local state, some as props re-fetched from
// App.jsx via onDataChanged) — so the caller supplies onHide/onRestore
// for whatever its own optimistic-hide mechanism is, and this hook only
// owns the timing/toast/undo mechanics that are identical everywhere.
//
// Nothing is sent to the server until the window closes with no Undo —
// there's no soft-delete/restore-on-the-backend involved, which is what
// keeps this simple: Undo just means "the pending request never fires,"
// not "reverse a completed one."
export function useUndoableDelete() {
  const toast = useToast();
  const timers = useRef(new Map());

  function requestDelete({ id, label, onHide, onRestore, deleteFn, afterCommit }) {
    onHide();

    const timer = setTimeout(async () => {
      timers.current.delete(id);
      try {
        await deleteFn();
        afterCommit?.();
      } catch (err) {
        // The window closed and the delete itself failed server-side —
        // restore what was optimistically hidden rather than leaving the
        // UI showing something gone that's actually still there.
        onRestore();
        toast({ title: `Couldn't delete ${label}`, body: err.message, tone: "danger" });
      }
    }, UNDO_WINDOW_MS);
    timers.current.set(id, timer);

    toast({
      title: `${label} deleted`,
      duration: UNDO_WINDOW_MS,
      actionLabel: "Undo",
      onAction: () => {
        const pending = timers.current.get(id);
        if (pending) {
          clearTimeout(pending);
          timers.current.delete(id);
          onRestore();
        }
      },
    });
  }

  return requestDelete;
}
