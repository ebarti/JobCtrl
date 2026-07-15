import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { IconX } from "@tabler/icons-react";
import {
  Children,
  forwardRef,
  type ComponentRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn.js";

export interface DialogProps
  extends Omit<DialogPrimitive.Root.Props, "children"> {
  children?: ReactNode;
}

export function Dialog({ children, ...props }: DialogProps) {
  return <DialogPrimitive.Root {...props}>{children}</DialogPrimitive.Root>;
}
Dialog.displayName = "Dialog";

export interface DialogTriggerProps extends Omit<
  DialogPrimitive.Trigger.Props,
  "render"
> {
  /** @deprecated Base UI composes custom triggers with `render`. */
  asChild?: boolean;
  render?: DialogPrimitive.Trigger.Props["render"];
}

export const DialogTrigger = forwardRef<HTMLButtonElement, DialogTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;

    return (
      <DialogPrimitive.Trigger
        {...props}
        ref={ref}
        render={child ?? render}
      >
        {child ? undefined : children}
      </DialogPrimitive.Trigger>
    );
  },
);
DialogTrigger.displayName = "DialogTrigger";

export interface DialogPortalProps extends Omit<
  DialogPrimitive.Portal.Props,
  "keepMounted"
> {
  /** @deprecated Base UI calls this `keepMounted`. */
  forceMount?: boolean | undefined;
  keepMounted?: boolean | undefined;
}

export const DialogPortal = forwardRef<
  ComponentRef<typeof DialogPrimitive.Portal>,
  DialogPortalProps
>(({ forceMount, keepMounted, ...props }, ref) => (
  <DialogPrimitive.Portal
    {...props}
    keepMounted={keepMounted ?? forceMount}
    ref={ref}
  />
));
DialogPortal.displayName = "DialogPortal";

export interface DialogCloseProps extends Omit<
  DialogPrimitive.Close.Props,
  "render"
> {
  /** @deprecated Base UI composes custom close controls with `render`. */
  asChild?: boolean;
  render?: DialogPrimitive.Close.Props["render"];
}

export const DialogClose = forwardRef<HTMLButtonElement, DialogCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;

    return (
      <DialogPrimitive.Close {...props} ref={ref} render={child ?? render}>
        {child ? undefined : children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = "DialogClose";

export const DialogOverlay = forwardRef<
  ComponentRef<typeof DialogPrimitive.Backdrop>,
  DialogPrimitive.Backdrop.Props
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/35 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

export interface DialogContentProps extends DialogPrimitive.Popup.Props {
  /** @deprecated Base UI keeps the Portal mounted with `keepMounted`. */
  forceMount?: boolean | undefined;
}

export const DialogContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Popup>,
  DialogContentProps
>(({ className, children, forceMount, ...props }, ref) => (
  <DialogPortal forceMount={forceMount}>
    <DialogOverlay />
    <DialogPrimitive.Popup
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-popover p-6 text-popover-foreground shadow-lg duration-200 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 sm:rounded-lg",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <IconX className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Popup>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        className,
      )}
      {...props}
    />
  );
}
DialogHeader.displayName = "DialogHeader";

export function DialogFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
        className,
      )}
      {...props}
    />
  );
}
DialogFooter.displayName = "DialogFooter";

export const DialogTitle = forwardRef<
  ComponentRef<typeof DialogPrimitive.Title>,
  DialogPrimitive.Title.Props
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = forwardRef<
  ComponentRef<typeof DialogPrimitive.Description>,
  DialogPrimitive.Description.Props
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";
