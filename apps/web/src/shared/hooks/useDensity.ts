import { useUiPreferencesStore, type Density } from "../stores/ui-preferences.js";

export function useDensity(): { density: Density; setDensity: (density: Density) => void } {
  const density = useUiPreferencesStore((state) => state.density);
  const setDensity = useUiPreferencesStore((state) => state.setDensity);
  return { density, setDensity };
}
