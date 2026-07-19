import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

interface ProfileImportState {
  filename: string;
  pdfBase64: string;
  importProfile: boolean;
  importStyle: boolean;
  setUpload: (filename: string, pdfBase64: string) => void;
  setOptions: (importProfile: boolean, importStyle: boolean) => void;
  reset: () => void;
}

type ProfileImportUploadState = Pick<
  ProfileImportState,
  "filename" | "pdfBase64"
>;

export function hasProfileImportUpload(
  state: ProfileImportUploadState,
): boolean {
  return state.filename.trim().length > 0 && state.pdfBase64.length > 0;
}

const initialState = {
  filename: "",
  pdfBase64: "",
  importProfile: true,
  importStyle: true,
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

export const useProfileImportStore = create<ProfileImportState>()(
  persist(
    (set) => ({
      ...initialState,
      setUpload: (filename, pdfBase64) => set({ filename, pdfBase64 }),
      setOptions: (importProfile, importStyle) =>
        set({ importProfile, importStyle }),
      reset: () => set({ ...initialState }),
    }),
    {
      name: "jh:profile-import",
      storage: createJSONStorage(getStorage),
      version: 1,
    },
  ),
);
