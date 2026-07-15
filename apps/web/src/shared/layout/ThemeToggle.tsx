import { IconMoon, IconSun } from "@tabler/icons-react";

import { useTheme } from "../hooks/useTheme.js";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="tab topbar__theme-toggle"
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <IconSun aria-hidden="true" size={14} /> : <IconMoon aria-hidden="true" size={14} />}
      <span aria-hidden="true">{theme}</span>
    </button>
  );
}
