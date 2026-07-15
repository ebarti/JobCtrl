"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { IconCheck, IconChevronRight, IconCircle } from "@tabler/icons-react";
import {
  forwardRef,
  type ComponentRef,
  type HTMLAttributes,
} from "react";

import { cn } from "../lib/cn.js";

const noCollisionAvoidance = {
  align: "none",
  fallbackAxisSide: "none",
  side: "none",
} as const;

const radixCollisionAvoidance = {
  fallbackAxisSide: "none",
} as const;

const radixCollisionBoundary: Element[] = [];

export function DropdownMenu({
  loopFocus = false,
  ...props
}: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root loopFocus={loopFocus} {...props} />;
}

export const DropdownMenuTrigger = forwardRef<
  HTMLButtonElement,
  MenuPrimitive.Trigger.Props
>((props, ref) => (
  <MenuPrimitive.Trigger
    data-slot="dropdown-menu-trigger"
    ref={ref}
    {...props}
  />
));
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

export const DropdownMenuGroup = forwardRef<
  ComponentRef<typeof MenuPrimitive.Group>,
  MenuPrimitive.Group.Props
>((props, ref) => (
  <MenuPrimitive.Group
    data-slot="dropdown-menu-group"
    ref={ref}
    {...props}
  />
));
DropdownMenuGroup.displayName = "DropdownMenuGroup";

export interface DropdownMenuPortalProps
  extends Omit<MenuPrimitive.Portal.Props, "keepMounted"> {
  forceMount?: boolean;
  keepMounted?: MenuPrimitive.Portal.Props["keepMounted"];
}

export function DropdownMenuPortal({
  forceMount,
  keepMounted,
  ...props
}: DropdownMenuPortalProps) {
  return (
    <MenuPrimitive.Portal
      keepMounted={keepMounted ?? forceMount}
      {...props}
    />
  );
}

export function DropdownMenuSub({
  loopFocus = false,
  ...props
}: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot loopFocus={loopFocus} {...props} />;
}

export const DropdownMenuRadioGroup = forwardRef<
  ComponentRef<typeof MenuPrimitive.RadioGroup>,
  MenuPrimitive.RadioGroup.Props
>((props, ref) => <MenuPrimitive.RadioGroup ref={ref} {...props} />);
DropdownMenuRadioGroup.displayName = "DropdownMenuRadioGroup";

export const DropdownMenuSubTrigger = forwardRef<
  ComponentRef<typeof MenuPrimitive.SubmenuTrigger>,
  MenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }
>(({ className, inset, children, ...props }, ref) => (
  <MenuPrimitive.SubmenuTrigger
    ref={ref}
    data-slot="dropdown-menu-sub-trigger"
    className={cn(
      "flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:bg-muted focus:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <IconChevronRight aria-hidden className="ml-auto" size={16} />
  </MenuPrimitive.SubmenuTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

type DropdownMenuPositioningProps = Pick<
  MenuPrimitive.Positioner.Props,
  | "align"
  | "alignOffset"
  | "anchor"
  | "arrowPadding"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "disableAnchorTracking"
  | "positionMethod"
  | "side"
  | "sideOffset"
>;

export type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  DropdownMenuPositioningProps & {
    avoidCollisions?: boolean;
    container?: MenuPrimitive.Portal.Props["container"];
    forceMount?: boolean;
    hideWhenDetached?: boolean;
    keepMounted?: MenuPrimitive.Portal.Props["keepMounted"];
    sticky?: boolean | "always" | "partial";
  };

export const DropdownMenuContent = forwardRef<
  ComponentRef<typeof MenuPrimitive.Popup>,
  DropdownMenuContentProps
>(
  (
    {
      align = "center",
      alignOffset = 0,
      anchor,
      arrowPadding = 0,
      avoidCollisions = true,
      children,
      className,
      collisionAvoidance,
      collisionBoundary = radixCollisionBoundary,
      collisionPadding = 0,
      container,
      disableAnchorTracking,
      forceMount,
      hideWhenDetached = false,
      keepMounted,
      positionMethod = "fixed",
      side = "bottom",
      sideOffset = 4,
      sticky = "partial",
      ...props
    },
    ref,
  ) => {
    const resolvedCollisionAvoidance =
      collisionAvoidance ??
      (avoidCollisions ? radixCollisionAvoidance : noCollisionAvoidance);
    const resolvedSticky =
      sticky === "always" ? true : sticky === "partial" ? false : sticky;

    return (
      <MenuPrimitive.Portal
        container={container}
        keepMounted={keepMounted ?? forceMount}
      >
        <MenuPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          anchor={anchor}
          arrowPadding={arrowPadding}
          className={cn(
            "isolate z-50 outline-none",
            hideWhenDetached && "data-anchor-hidden:invisible",
          )}
          collisionAvoidance={resolvedCollisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          disableAnchorTracking={disableAnchorTracking}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
          sticky={resolvedSticky}
        >
          <MenuPrimitive.Popup
            ref={ref}
            data-slot="dropdown-menu-content"
            className={cn(
              "z-50 min-w-40 origin-(--transform-origin) overflow-hidden rounded-[10px] border border-border bg-popover p-1.5 text-popover-foreground shadow-xl outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              className,
            )}
            {...props}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    );
  },
);
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuSubContent = forwardRef<
  ComponentRef<typeof MenuPrimitive.Popup>,
  DropdownMenuContentProps
>(
  (
    {
      align = "start",
      alignOffset = -3,
      className,
      side = "right",
      sideOffset = 0,
      ...props
    },
    ref,
  ) => (
    <DropdownMenuContent
      ref={ref}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-40 overflow-hidden rounded-[10px] border border-border bg-popover p-1.5 text-popover-foreground shadow-xl",
        className,
      )}
      data-slot="dropdown-menu-sub-content"
      {...props}
    />
  ),
);
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

export const DropdownMenuItem = forwardRef<
  ComponentRef<typeof MenuPrimitive.Item>,
  MenuPrimitive.Item.Props & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    data-slot="dropdown-menu-item"
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:bg-muted focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:shrink-0",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = forwardRef<
  ComponentRef<typeof MenuPrimitive.CheckboxItem>,
  MenuPrimitive.CheckboxItem.Props
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.CheckboxItem
    ref={ref}
    data-slot="dropdown-menu-checkbox-item"
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2.5 text-[13px] outline-none transition-colors focus:bg-muted focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <MenuPrimitive.CheckboxItemIndicator data-slot="dropdown-menu-item-indicator">
        <IconCheck aria-hidden size={16} />
      </MenuPrimitive.CheckboxItemIndicator>
    </span>
    {children}
  </MenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuRadioItem = forwardRef<
  ComponentRef<typeof MenuPrimitive.RadioItem>,
  MenuPrimitive.RadioItem.Props
>(({ className, children, ...props }, ref) => (
  <MenuPrimitive.RadioItem
    ref={ref}
    data-slot="dropdown-menu-radio-item"
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2.5 text-[13px] outline-none transition-colors focus:bg-muted focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <MenuPrimitive.RadioItemIndicator data-slot="dropdown-menu-item-indicator">
        <IconCircle aria-hidden className="fill-current" size={8} />
      </MenuPrimitive.RadioItemIndicator>
    </span>
    {children}
  </MenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

export const DropdownMenuLabel = forwardRef<
  ComponentRef<typeof MenuPrimitive.GroupLabel>,
  MenuPrimitive.GroupLabel.Props & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <MenuPrimitive.GroupLabel
    ref={ref}
    data-slot="dropdown-menu-label"
    className={cn(
      "px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = forwardRef<
  ComponentRef<typeof MenuPrimitive.Separator>,
  MenuPrimitive.Separator.Props
>(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator
    ref={ref}
    data-slot="dropdown-menu-separator"
    className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export function DropdownMenuShortcut({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-[11px] tracking-wider text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";
