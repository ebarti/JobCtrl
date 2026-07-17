import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark";
export type Density = "compact" | "regular" | "comfy";

interface UiPreferencesState {
  theme: Theme;
  density: Density;
  sidebarOpen: boolean;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setSidebarOpen: (sidebarOpen: boolean) => void;
}

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      theme: "light",
      density: "regular",
      sidebarOpen: true,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    }),
    {
      name: "jh:ui-preferences",
      version: 1,
    },
  ),
);
