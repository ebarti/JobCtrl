import { useEffect, type ReactNode } from "react";

import { useTheme } from "../hooks/useTheme.js";
import { useUiPreferencesStore } from "../stores/ui-preferences.js";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const colorScheme = useUiPreferencesStore((state) => state.colorScheme);
  const fontScheme = useUiPreferencesStore((state) => state.fontScheme);
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.dataset["colorScheme"] = colorScheme;
    document.documentElement.dataset["fontScheme"] = fontScheme;
  }, [theme, colorScheme, fontScheme]);
  return <>{children}</>;
}
