import {
  forwardRef,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type HTMLAttributes,
} from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "../lib/cn.js";

export function Drawer({
  shouldScaleBackground = true,
  ...props
}: ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root shouldScaleBackground={shouldScaleBackground} {...props} />;
}
Drawer.displayName = "Drawer";

export const DrawerTrigger = DrawerPrimitive.Trigger;
export const DrawerPortal = DrawerPrimitive.Portal;
export const DrawerClose = DrawerPrimitive.Close;

export const DrawerOverlay = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Overlay
    ref={ref}
    data-slot="drawer-overlay"
    className={cn(
      "fixed inset-0 isolate bg-foreground/20 supports-backdrop-filter:backdrop-blur-[2px]",
      className,
    )}
    {...props}
  />
));
DrawerOverlay.displayName = "DrawerOverlay";

export const DrawerContent = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DrawerPortal>
    <DrawerOverlay />
    <DrawerPrimitive.Content
      ref={ref}
      data-slot="drawer-content"
      className={cn(
        "fixed inset-x-0 bottom-0 mt-24 flex h-auto flex-col rounded-t-[10px] border border-border bg-popover text-sm text-popover-foreground shadow-xl",
        className,
      )}
      {...props}
    >
      <div
        aria-hidden
        data-slot="drawer-handle"
        className="mx-auto mt-3 h-1 w-9 rounded-full bg-muted-foreground/35"
      />
      {children}
    </DrawerPrimitive.Content>
  </DrawerPortal>
));
DrawerContent.displayName = "DrawerContent";

export function DrawerHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("grid gap-1.5 p-5 text-center sm:text-left", className)}
      {...props}
    />
  );
}
DrawerHeader.displayName = "DrawerHeader";

export function DrawerFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-5", className)}
      {...props}
    />
  );
}
DrawerFooter.displayName = "DrawerFooter";

export const DrawerTitle = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Title
    ref={ref}
    data-slot="drawer-title"
    className={cn(
      "font-heading text-base font-medium leading-none tracking-[-0.02em]",
      className,
    )}
    {...props}
  />
));
DrawerTitle.displayName = "DrawerTitle";

export const DrawerDescription = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Description
    ref={ref}
    data-slot="drawer-description"
    className={cn("text-[13px] leading-5 text-muted-foreground", className)}
    {...props}
  />
));
DrawerDescription.displayName = "DrawerDescription";
