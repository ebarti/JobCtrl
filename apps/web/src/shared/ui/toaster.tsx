import { useEffect } from "react";

import { useToastStore } from "../stores/toasts.js";
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  useToastManager,
  type ToastManagerData,
} from "./toast.js";

function ToastStoreBridge() {
  const entries = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);
  const { add, close, toasts } = useToastManager<ToastManagerData>();

  useEffect(() => {
    const managerIds = new Set(toasts.map((toast) => toast.id));

    for (const entry of entries) {
      if (managerIds.has(entry.id)) {
        continue;
      }

      add({
        id: entry.id,
        title: entry.title,
        description: entry.message,
        type: entry.variant,
        timeout: entry.durationMs,
        data: {
          source: "jobctrl-store",
          variant: entry.variant,
        },
        onClose: () => dismiss(entry.id),
      });
    }

    const entryIds = new Set(entries.map((entry) => entry.id));
    for (const toast of toasts) {
      if (
        toast.data?.source === "jobctrl-store" &&
        !entryIds.has(toast.id) &&
        toast.transitionStatus !== "ending"
      ) {
        close(toast.id);
      }
    }
  }, [add, close, dismiss, entries, toasts]);

  return null;
}

export function ToastList() {
  const { toasts } = useToastManager<ToastManagerData>();

  return toasts.map((toast) => (
    <Toast
      key={toast.id}
      toast={toast}
      variant={
        toast.data?.variant === "error" || toast.type === "error"
          ? "destructive"
          : "default"
      }
      data-toast-id={toast.id}
    >
      <ToastContent>
        <div
          className="flex min-w-0 flex-1 flex-col gap-0.5"
          data-slot="toast-copy"
        >
          <ToastTitle />
          <ToastDescription />
        </div>
        <ToastAction />
        <ToastClose aria-label={toast.data?.closeLabel ?? "Close"} />
      </ToastContent>
    </Toast>
  ));
}

export function Toaster({ viewportLabel }: { viewportLabel?: string } = {}) {
  return (
    <ToastProvider>
      <ToastStoreBridge />
      <ToastPortal>
        <ToastViewport {...(viewportLabel ? { label: viewportLabel } : {})}>
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}
