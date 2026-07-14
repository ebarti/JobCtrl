import { IconMoon, IconSun } from "@tabler/icons-react";

import { useTheme } from "../hooks/useTheme.js";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="tab"
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <IconSun aria-hidden="true" size={15} /> : <IconMoon aria-hidden="true" size={15} />}
      <span>{theme}</span>
    </button>
  );
}
