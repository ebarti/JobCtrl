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
>((props, ref) => <MenuPrimitive.Trigger ref={ref} {...props} />);
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

export const DropdownMenuGroup = forwardRef<
  ComponentRef<typeof MenuPrimitive.Group>,
  MenuPrimitive.Group.Props
>((props, ref) => <MenuPrimitive.Group ref={ref} {...props} />);
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
    className={cn(
      "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <IconChevronRight aria-hidden className="ml-auto size-4" />
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
              "z-50 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-panel)] outline-none",
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
        "z-50 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-panel)]",
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
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
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
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <MenuPrimitive.CheckboxItemIndicator>
        <IconCheck aria-hidden className="size-4" />
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
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <MenuPrimitive.RadioItemIndicator>
        <IconCircle aria-hidden className="size-2 fill-current" />
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
    className={cn(
      "px-2 py-1.5 text-sm font-semibold",
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
    className={cn("-mx-1 my-1 h-px bg-border", className)}
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
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";
