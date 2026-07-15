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
import { Button } from "./button.js";

export interface DialogProps
  extends Omit<DialogPrimitive.Root.Props, "children"> {
  children?: ReactNode;
}

export function Dialog({ children, ...props }: DialogProps) {
  return (
    <DialogPrimitive.Root data-slot="dialog" {...props}>
      {children}
    </DialogPrimitive.Root>
  );
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
        data-slot="dialog-trigger"
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
    data-slot="dialog-portal"
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
      <DialogPrimitive.Close
        data-slot="dialog-close"
        {...props}
        ref={ref}
        render={child ?? render}
      >
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
    data-slot="dialog-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/30 duration-150 supports-backdrop-filter:backdrop-blur-[2px] data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0",
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
      data-slot="dialog-content"
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-5 rounded-[10px] border border-border bg-popover p-5 text-sm text-popover-foreground shadow-xl outline-none duration-150 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 sm:max-w-lg",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        data-slot="dialog-close"
        render={
          <Button
            className="absolute right-3 top-3 size-8 bg-muted/60 text-muted-foreground shadow-none"
            size="icon"
            variant="ghost"
          />
        }
      >
        <IconX aria-hidden size={16} />
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
      data-slot="dialog-header"
      className={cn(
        "flex flex-col gap-1.5 pr-8 text-left",
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
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
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
    data-slot="dialog-title"
    className={cn(
      "font-heading text-base font-medium leading-none tracking-[-0.02em]",
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
    data-slot="dialog-description"
    className={cn(
      "text-[13px] leading-5 text-muted-foreground *:[a]:underline *:[a]:underline-offset-4 *:[a]:hover:text-foreground",
      className,
    )}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";
