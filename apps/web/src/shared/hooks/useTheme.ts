import { useUiPreferencesStore, type Theme } from "../stores/ui-preferences.js";

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const theme = useUiPreferencesStore((state) => state.theme);
  const setTheme = useUiPreferencesStore((state) => state.setTheme);
  return { theme, setTheme };
}
