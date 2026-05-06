import { useToastStore, type ToastInput } from "../stores/toasts.js";

export function useToast(): {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
} {
  const toast = useToastStore((state) => state.toast);
  const dismiss = useToastStore((state) => state.dismiss);
  return { toast, dismiss };
}
