import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ProfileImportState {
  filename: string;
  pdfBase64: string;
  importProfile: boolean;
  importStyle: boolean;
  setUpload: (filename: string, pdfBase64: string) => void;
  setOptions: (importProfile: boolean, importStyle: boolean) => void;
  reset: () => void;
}

const initialState = {
  filename: "",
  pdfBase64: "",
  importProfile: true,
  importStyle: true,
};

export const useProfileImportStore = create<ProfileImportState>()(
  persist(
    (set) => ({
      ...initialState,
      setUpload: (filename, pdfBase64) => set({ filename, pdfBase64 }),
      setOptions: (importProfile, importStyle) => set({ importProfile, importStyle }),
      reset: () => set({ ...initialState }),
    }),
    {
      name: "jh:profile-import",
      version: 1,
    },
  ),
);
