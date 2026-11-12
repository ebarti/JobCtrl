import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";

import { LocalStorageAdapter } from "../adapters/local/LocalStorageAdapter.js";
import type { StoragePort } from "../ports/StoragePort.js";

import { isColorScheme, isFontScheme, type ColorScheme, type FontScheme } from "./appearance-options.js";

export type Theme = "light" | "dark";
export type Density = "compact" | "regular" | "comfy";

interface UiPreferencesState {
  theme: Theme;
  density: Density;
  colorScheme: ColorScheme;
  fontScheme: FontScheme;
  sidebarOpen: boolean;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setColorScheme: (colorScheme: ColorScheme) => void;
  setFontScheme: (fontScheme: FontScheme) => void;
  resetAppearance: () => void;
  setSidebarOpen: (sidebarOpen: boolean) => void;
}

// The empty prefix retains the existing jh:ui-preferences browser key.
const preferenceStorage: StoragePort = new LocalStorageAdapter("");

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      theme: "light",
      density: "regular",
      colorScheme: "graphite",
      fontScheme: "geist",
      sidebarOpen: true,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setColorScheme: (colorScheme) => set({ colorScheme }),
      setFontScheme: (fontScheme) => set({ fontScheme }),
      resetAppearance: () => set({ colorScheme: "graphite", fontScheme: "geist" }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    }),
    {
      name: "jh:ui-preferences",
      version: 1,
      storage: {
        getItem: (name) => preferenceStorage.get<StorageValue<UiPreferencesState>>(name),
        setItem: (name, value) => preferenceStorage.set(name, value),
        removeItem: (name) => preferenceStorage.remove(name),
      },
      // Existing version-one preferences contain only theme, density and rail
      // state. Merge their values while rejecting unknown appearance IDs.
      merge: (persisted, current) => {
        const saved = persisted && typeof persisted === "object" ? persisted as Partial<UiPreferencesState> : {};
        return {
          ...current,
          theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : current.theme,
          density: saved.density === "compact" || saved.density === "regular" || saved.density === "comfy" ? saved.density : current.density,
          sidebarOpen: typeof saved.sidebarOpen === "boolean" ? saved.sidebarOpen : current.sidebarOpen,
          colorScheme: isColorScheme(saved.colorScheme) ? saved.colorScheme : current.colorScheme,
          fontScheme: isFontScheme(saved.fontScheme) ? saved.fontScheme : current.fontScheme,
        };
      },
    },
  ),
);
