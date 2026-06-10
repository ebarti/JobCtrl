import { useToastStore } from "../stores/toasts.js";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast.js";

export function Toaster({ viewportLabel }: { viewportLabel?: string } = {}) {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <ToastProvider>
      {toasts.map(({ id, title, message, variant, durationMs }) => (
        <Toast
          key={id}
          variant={variant === "error" ? "destructive" : "default"}
          duration={durationMs}
          onOpenChange={(open) => {
            if (!open) {
              dismiss(id);
            }
          }}
        >
          <div className="grid gap-1">
            {title ? <ToastTitle>{title}</ToastTitle> : null}
            <ToastDescription>{message}</ToastDescription>
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport {...(viewportLabel ? { label: viewportLabel } : {})} />
    </ToastProvider>
  );
}
