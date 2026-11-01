import { create } from "zustand";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastEntry {
  id: string;
  variant: ToastVariant;
  message: string;
  title?: string;
  durationMs: number;
  /** Scoped notices are rendered by their owning surface, not the global toaster. */
  scope?: string;
}

export interface ToastInput {
  variant?: ToastVariant;
  message: string;
  title?: string;
  durationMs?: number;
  scope?: string;
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
  toast: ({ variant = "info", message, title, durationMs = 5000, scope }) => {
    const id = nextId();
    const entry: ToastEntry = { id, variant, message, durationMs,
      ...(title === undefined ? {} : { title }), ...(scope === undefined ? {} : { scope }) };
    set((state) => ({ toasts: [...state.toasts, entry] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
