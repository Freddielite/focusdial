import { useCallback, useEffect, useState } from "react";

// A rolling local log of the same events that already trigger an in-app
// toast (see App.jsx's notification orchestration). This is deliberately
// device-local rather than synced to the server: the app already has a
// real cross-device notification channel (Web Push), so this is just a
// glanceable "what did I miss" list, not a second source of truth. That
// keeps it a plain client-side concern — no migration, no endpoint, no
// extra request waking the free-tier backend on every load.
const STORAGE_KEY = "fd-notifications";
const MAX_ENTRIES = 30;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage full or unavailable (private browsing, etc.) — the bell
    // still works for the current session, it just won't persist.
  }
}

export function useNotifications() {
  const [items, setItems] = useState(load);

  useEffect(() => {
    save(items);
  }, [items]);

  const push = useCallback(({ title, body, tone = "default" }) => {
    setItems((prev) => {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title,
        body: body || "",
        tone,
        createdAt: Date.now(),
        read: false,
      };
      return [entry, ...prev].slice(0, MAX_ENTRIES);
    });
  }, []);

  const markRead = useCallback((id) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllRead = useCallback(() => {
    setItems((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
  }, []);

  const unreadCount = items.reduce((n, item) => n + (item.read ? 0 : 1), 0);

  return { items, unreadCount, push, markRead, markAllRead, clearAll };
}
