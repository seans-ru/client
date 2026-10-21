import { useEffect } from "react";
import { applyTheme, setTheme } from "./theme";

/**
 * Dark-only product: force `data-theme="dark"` on mount.
 * Preference helpers in `theme.ts` stay for storage compatibility.
 */
export function useThemePreference(): {
  preference: "dark";
  cycle: () => void;
} {
  useEffect(() => {
    setTheme("dark");
    applyTheme("dark");
  }, []);

  return { preference: "dark", cycle: () => undefined };
}
