import { useEffect, useState } from "react";

const STORAGE_KEY = "focusdial-theme";

// Three states: 'system' (default — no override, CSS's own
// prefers-color-scheme media query handles it with zero JS), 'light',
// and 'dark' (both applied via a data-theme attribute on <html>, which
// wins over the media query in App.css purely through CSS specificity —
// see the comment there).
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "system";
    return localStorage.getItem(STORAGE_KEY) || "system";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
      localStorage.removeItem(STORAGE_KEY);
    } else {
      root.setAttribute("data-theme", theme);
      localStorage.setItem(STORAGE_KEY, theme);
    }
  }, [theme]);

  return [theme, setTheme];
}
