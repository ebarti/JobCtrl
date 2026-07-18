import { IconMoon, IconSun } from "@tabler/icons-react";

import { useTheme } from "../hooks/useTheme.js";
import { Button } from "../ui/button.js";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button
      className="topbar__theme-toggle"
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
      size="sm"
      type="button"
      variant="ghost"
    >
      {theme === "dark" ? <IconSun aria-hidden="true" size={14} /> : <IconMoon aria-hidden="true" size={14} />}
      <span aria-hidden="true">{theme === "dark" ? "Dark" : "Light"}</span>
    </Button>
  );
}
