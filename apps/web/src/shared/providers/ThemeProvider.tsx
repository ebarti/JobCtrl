import { useEffect, type ReactNode } from "react";

import { useTheme } from "../hooks/useTheme.js";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);
  return <>{children}</>;
}
