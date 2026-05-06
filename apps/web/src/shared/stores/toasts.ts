import { create } from "zustand";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastEntry {
  id: string;
  variant: ToastVariant;
  message: string;
  title?: string;
  durationMs: number;
}

export interface ToastInput {
  variant?: ToastVariant;
  message: string;
  title?: string;
  durationMs?: number;
}

interface ToastsState {
  toasts: ToastEntry[];
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

let toastSeq = 0;
const nextId = () => `t-${Date.now().toString(36)}-${(toastSeq++).toString(36)}`;

export const useToastStore = create<ToastsState>((set) => ({
  toasts: [],
  toast: ({ variant = "info", message, title, durationMs = 5000 }) => {
    const id = nextId();
    const entry: ToastEntry = title === undefined
      ? { id, variant, message, durationMs }
      : { id, variant, message, title, durationMs };
    set((state) => ({ toasts: [...state.toasts, entry] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
