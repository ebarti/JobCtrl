import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

interface OutreachImportState {
  format: "csv" | "vcard";
  filename: string;
  content: string;
  setUpload: (format: "csv" | "vcard", filename: string, content: string) => void;
  reset: () => void;
}

const initialState = {
  format: "csv" as const,
  filename: "",
  content: "",
};

function createMemoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const fallbackStorage = createMemoryStorage();

function getStorage(): StateStorage {
  if (typeof window === "undefined") {
    return fallbackStorage;
  }
  const storage = window.localStorage as Partial<StateStorage> | undefined;
  if (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  ) {
    return storage as StateStorage;
  }
  return fallbackStorage;
}

export const useOutreachImportStore = create<OutreachImportState>()(
  persist(
    (set) => ({
      ...initialState,
      setUpload: (format, filename, content) => set({ format, filename, content }),
      reset: () => set({ ...initialState }),
    }),
    {
      name: "jh:outreach-import",
      storage: createJSONStorage(getStorage),
      version: 2,
    },
  ),
);
