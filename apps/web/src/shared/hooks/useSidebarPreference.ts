import { useUiPreferencesStore } from "../stores/ui-preferences.js";

export function useSidebarPreference(): {
  sidebarOpen: boolean;
  setSidebarOpen: (sidebarOpen: boolean) => void;
} {
  const sidebarOpen = useUiPreferencesStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiPreferencesStore((state) => state.setSidebarOpen);
  return { sidebarOpen, setSidebarOpen };
}
