import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { IconX } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
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

export interface SheetProps extends Omit<DialogPrimitive.Root.Props, "children"> {
  children?: ReactNode;
}

export function Sheet({ children, ...props }: SheetProps) {
  return (
    <DialogPrimitive.Root data-slot="sheet" {...props}>
      {children}
    </DialogPrimitive.Root>
  );
}
Sheet.displayName = "Sheet";

export interface SheetTriggerProps extends Omit<
  DialogPrimitive.Trigger.Props,
  "render"
> {
  /** @deprecated Base UI composes custom triggers with `render`. */
  asChild?: boolean;
  render?: DialogPrimitive.Trigger.Props["render"];
}

export const SheetTrigger = forwardRef<HTMLButtonElement, SheetTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;

    return (
      <DialogPrimitive.Trigger
        data-slot="sheet-trigger"
        {...props}
        ref={ref}
        render={child ?? render}
      >
        {child ? undefined : children}
      </DialogPrimitive.Trigger>
    );
  },
);
SheetTrigger.displayName = "SheetTrigger";

export interface SheetCloseProps extends Omit<
  DialogPrimitive.Close.Props,
  "render"
> {
  /** @deprecated Base UI composes custom close controls with `render`. */
  asChild?: boolean;
  render?: DialogPrimitive.Close.Props["render"];
}

export const SheetClose = forwardRef<HTMLButtonElement, SheetCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;

    return (
      <DialogPrimitive.Close
        data-slot="sheet-close"
        {...props}
        ref={ref}
        render={child ?? render}
      >
        {child ? undefined : children}
      </DialogPrimitive.Close>
    );
  },
);
SheetClose.displayName = "SheetClose";

export interface SheetPortalProps extends Omit<
  DialogPrimitive.Portal.Props,
  "keepMounted"
> {
  /** @deprecated Base UI calls this `keepMounted`. */
  forceMount?: boolean | undefined;
  keepMounted?: boolean | undefined;
}

export const SheetPortal = forwardRef<
  ComponentRef<typeof DialogPrimitive.Portal>,
  SheetPortalProps
>(({ forceMount, keepMounted, ...props }, ref) => (
  <DialogPrimitive.Portal
    data-slot="sheet-portal"
    {...props}
    keepMounted={keepMounted ?? forceMount}
    ref={ref}
  />
));
SheetPortal.displayName = "SheetPortal";

export const SheetOverlay = forwardRef<
  ComponentRef<typeof DialogPrimitive.Backdrop>,
  DialogPrimitive.Backdrop.Props
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    data-slot="sheet-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/30 transition-opacity duration-150 supports-backdrop-filter:backdrop-blur-[2px] data-starting-style:opacity-0 data-ending-style:opacity-0",
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = "SheetOverlay";

const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-5 bg-popover p-6 text-sm text-popover-foreground shadow-xl transition ease-in-out data-open:duration-200 data-closed:duration-150",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b border-border data-starting-style:-translate-y-full data-ending-style:-translate-y-full",
        bottom:
          "inset-x-0 bottom-0 border-t border-border data-starting-style:translate-y-full data-ending-style:translate-y-full",
        left: "inset-y-0 left-0 h-full w-3/4 border-r border-border data-starting-style:-translate-x-full data-ending-style:-translate-x-full sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l border-border data-starting-style:translate-x-full data-ending-style:translate-x-full sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  },
);

export interface SheetContentProps
  extends DialogPrimitive.Popup.Props,
    VariantProps<typeof sheetVariants> {
  /** @deprecated Base UI keeps the Portal mounted with `keepMounted`. */
  forceMount?: boolean | undefined;
}

export const SheetContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Popup>,
  SheetContentProps
>(({ side = "right", className, children, forceMount, ...props }, ref) => (
  <SheetPortal forceMount={forceMount}>
    <SheetOverlay />
    <DialogPrimitive.Popup
      ref={ref}
      data-slot="sheet-content"
      data-side={side}
      className={cn(sheetVariants({ side }), className)}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        data-slot="sheet-close"
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
  </SheetPortal>
));
SheetContent.displayName = "SheetContent";

export function SheetHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        "flex flex-col gap-1.5 pr-8 text-left",
        className,
      )}
      {...props}
    />
  );
}
SheetHeader.displayName = "SheetHeader";

export function SheetFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}
SheetFooter.displayName = "SheetFooter";

export const SheetTitle = forwardRef<
  ComponentRef<typeof DialogPrimitive.Title>,
  DialogPrimitive.Title.Props
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="sheet-title"
    className={cn(
      "font-heading text-base font-medium leading-none tracking-[-0.02em] text-foreground",
      className,
    )}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = forwardRef<
  ComponentRef<typeof DialogPrimitive.Description>,
  DialogPrimitive.Description.Props
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="sheet-description"
    className={cn("text-[13px] leading-5 text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";
