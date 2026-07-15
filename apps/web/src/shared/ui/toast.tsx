import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { IconX } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ComponentRef, type ReactElement } from "react";

import { cn } from "../lib/cn.js";

export interface ToastManagerData {
  closeLabel?: string;
  source?: "jobctrl-store";
  variant?: "info" | "success" | "warning" | "error";
}

export const toastManager =
  ToastPrimitive.createToastManager<ToastManagerData>();

export interface ToastProviderProps extends Omit<
  ToastPrimitive.Provider.Props,
  "limit" | "toastManager"
> {
  duration?: number | undefined;
}

export function ToastProvider({
  duration,
  timeout,
  ...props
}: ToastProviderProps) {
  const resolvedTimeout = timeout ?? duration;

  return (
    <ToastPrimitive.Provider
      toastManager={toastManager}
      limit={Number.POSITIVE_INFINITY}
      {...(resolvedTimeout === undefined ? {} : { timeout: resolvedTimeout })}
      {...props}
    />
  );
}

export const ToastPortal = ToastPrimitive.Portal;
export const useToastManager = ToastPrimitive.useToastManager;

export interface ToastViewportProps extends ToastPrimitive.Viewport.Props {
  label?: string | undefined;
}

export const ToastViewport = forwardRef<
  ComponentRef<typeof ToastPrimitive.Viewport>,
  ToastViewportProps
>(({ className, label, "aria-label": ariaLabel, ...props }, ref) => {
  const resolvedLabel = ariaLabel ?? label?.replace("{hotkey}", "F6");

  return (
    <ToastPrimitive.Viewport
      ref={ref}
      {...(resolvedLabel === undefined ? {} : { "aria-label": resolvedLabel })}
      className={cn(
        "fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]",
        className,
      )}
      {...props}
    />
  );
});
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between space-x-2 overflow-hidden rounded-lg border p-4 pr-6 shadow-lg transition-all",
  {
    variants: {
      variant: {
        default: "border-border bg-popover text-popover-foreground",
        destructive:
          "destructive group border-destructive bg-destructive text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface ToastProps
  extends ToastPrimitive.Root.Props, VariantProps<typeof toastVariants> {}

export const Toast = forwardRef<
  ComponentRef<typeof ToastPrimitive.Root>,
  ToastProps
>(({ className, swipeDirection = "right", variant, ...props }, ref) => (
  <ToastPrimitive.Root
    ref={ref}
    className={cn(toastVariants({ variant }), className)}
    swipeDirection={swipeDirection}
    {...props}
  />
));
Toast.displayName = ToastPrimitive.Root.displayName;

export const ToastContent = forwardRef<
  ComponentRef<typeof ToastPrimitive.Content>,
  ToastPrimitive.Content.Props
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Content
    ref={ref}
    className={cn("flex w-full items-center justify-between gap-2", className)}
    {...props}
  />
));
ToastContent.displayName = ToastPrimitive.Content.displayName;

export interface ToastActionProps extends ToastPrimitive.Action.Props {
  altText?: string | undefined;
}

export const ToastAction = forwardRef<
  ComponentRef<typeof ToastPrimitive.Action>,
  ToastActionProps
>(({ altText, "aria-label": ariaLabel, className, ...props }, ref) => (
  <ToastPrimitive.Action
    ref={ref}
    aria-label={ariaLabel ?? altText}
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border bg-transparent px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
ToastAction.displayName = ToastPrimitive.Action.displayName;

export const ToastClose = forwardRef<
  ComponentRef<typeof ToastPrimitive.Close>,
  ToastPrimitive.Close.Props
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    aria-label="Close"
    className={cn(
      "absolute right-1 top-1 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring group-hover:opacity-100",
      className,
    )}
    toast-close=""
    {...props}
  >
    <IconX className="size-4" />
  </ToastPrimitive.Close>
));
ToastClose.displayName = ToastPrimitive.Close.displayName;

export const ToastTitle = forwardRef<
  ComponentRef<typeof ToastPrimitive.Title>,
  ToastPrimitive.Title.Props
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title
    ref={ref}
    className={cn("text-sm font-semibold", className)}
    {...props}
  />
));
ToastTitle.displayName = ToastPrimitive.Title.displayName;

export const ToastDescription = forwardRef<
  ComponentRef<typeof ToastPrimitive.Description>,
  ToastPrimitive.Description.Props
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn("text-sm opacity-90", className)}
    {...props}
  />
));
ToastDescription.displayName = ToastPrimitive.Description.displayName;

export type ToastActionElement = ReactElement<typeof ToastAction>;
