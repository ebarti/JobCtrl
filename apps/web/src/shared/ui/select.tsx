import { DirectionProvider } from "@base-ui/react/direction-provider";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { IconCheck, IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import {
  Children,
  forwardRef,
  isValidElement,
  type ComponentRef,
  type ReactNode,
  useRef,
} from "react";

import { cn } from "../lib/cn.js";

type BaseSelectRootProps = SelectPrimitive.Root.Props<string, false>;

export interface SelectProps extends Omit<
  BaseSelectRootProps,
  "children" | "defaultValue" | "items" | "onValueChange" | "value"
> {
  children?: ReactNode;
  defaultValue?: string | undefined;
  dir?: "ltr" | "rtl" | undefined;
  items?: BaseSelectRootProps["items"];
  onValueChange?: ((value: string) => void) | undefined;
  value?: string | undefined;
}

type SelectItemDefinition = {
  label: ReactNode;
  value: string;
};

function collectItemDefinitions(children: ReactNode): SelectItemDefinition[] {
  const items: SelectItemDefinition[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; value?: unknown }>(child)) {
      return;
    }

    if (child.type === SelectItem && typeof child.props.value === "string") {
      items.push({ label: child.props.children, value: child.props.value });
      return;
    }

    items.push(...collectItemDefinitions(child.props.children));
  });

  return items;
}

function itemDefinitionsMatch(
  current: SelectItemDefinition[],
  next: SelectItemDefinition[],
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (item, index) =>
        item.value === next[index]?.value && item.label === next[index]?.label,
    )
  );
}

export function Select({
  children,
  defaultValue,
  dir,
  items,
  onValueChange,
  value,
  ...props
}: SelectProps) {
  const nextInferredItems = collectItemDefinitions(children);
  const inferredItemsRef = useRef(nextInferredItems);
  if (!itemDefinitionsMatch(inferredItemsRef.current, nextInferredItems)) {
    inferredItemsRef.current = nextInferredItems;
  }
  const resolvedItems =
    items ??
    (inferredItemsRef.current.length === 0
      ? undefined
      : inferredItemsRef.current);
  const root = (
    <SelectPrimitive.Root<string>
      defaultValue={defaultValue}
      items={resolvedItems}
      onValueChange={
        onValueChange === undefined
          ? undefined
          : (nextValue) => {
              if (nextValue !== null) {
                onValueChange(nextValue);
              }
            }
      }
      value={value}
      {...props}
    >
      {children}
    </SelectPrimitive.Root>
  );

  return dir === undefined ? (
    root
  ) : (
    <DirectionProvider direction={dir}>{root}</DirectionProvider>
  );
}

export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ComponentRef<typeof SelectPrimitive.Trigger>,
  SelectPrimitive.Trigger.Props
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-card px-3 text-left text-[13px] shadow-none transition-[color,background-color,border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon
      render={<IconChevronDown className="size-4 opacity-50" />}
    />
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

export const SelectScrollUpButton = forwardRef<
  ComponentRef<typeof SelectPrimitive.ScrollUpArrow>,
  SelectPrimitive.ScrollUpArrow.Props
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpArrow
    ref={ref}
    className={cn(
      "top-0 flex w-full cursor-default items-center justify-center py-1",
      className,
    )}
    {...props}
  >
    <IconChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpArrow>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpArrow.displayName;

export const SelectScrollDownButton = forwardRef<
  ComponentRef<typeof SelectPrimitive.ScrollDownArrow>,
  SelectPrimitive.ScrollDownArrow.Props
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownArrow
    ref={ref}
    className={cn(
      "bottom-0 flex w-full cursor-default items-center justify-center py-1",
      className,
    )}
    {...props}
  >
    <IconChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownArrow>
));
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownArrow.displayName;

type SelectPositionerProps = Pick<
  SelectPrimitive.Positioner.Props,
  | "align"
  | "alignItemWithTrigger"
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

export interface SelectContentProps
  extends SelectPrimitive.Popup.Props, SelectPositionerProps {
  avoidCollisions?: boolean | undefined;
  hideWhenDetached?: boolean | undefined;
  position?: "item-aligned" | "popper" | undefined;
  sticky?: boolean | "always" | "partial" | undefined;
}

const viewportCollisionBoundary: Element[] = [];
const disabledCollisionAvoidance: NonNullable<
  SelectPrimitive.Positioner.Props["collisionAvoidance"]
> = { align: "none", fallbackAxisSide: "none", side: "none" };

export const SelectContent = forwardRef<
  ComponentRef<typeof SelectPrimitive.Popup>,
  SelectContentProps
>(
  (
    {
      align = "start",
      alignItemWithTrigger,
      alignOffset = 0,
      anchor,
      arrowPadding = 0,
      avoidCollisions = true,
      children,
      className,
      collisionAvoidance,
      collisionBoundary = viewportCollisionBoundary,
      collisionPadding = 10,
      disableAnchorTracking,
      hideWhenDetached = false,
      position = "popper",
      positionMethod = "fixed",
      side = "bottom",
      sideOffset = 0,
      sticky = "partial",
      ...props
    },
    ref,
  ) => {
    const alignsSelectedItem =
      alignItemWithTrigger ?? position === "item-aligned";
    const resolvedCollisionAvoidance =
      avoidCollisions || collisionAvoidance !== undefined
        ? collisionAvoidance
        : disabledCollisionAvoidance;

    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align={align}
          alignItemWithTrigger={alignsSelectedItem}
          alignOffset={alignOffset}
          anchor={anchor}
          arrowPadding={arrowPadding}
          collisionAvoidance={resolvedCollisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          disableAnchorTracking={disableAnchorTracking}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
          sticky={sticky === true || sticky === "always"}
          className={cn(hideWhenDetached && "data-anchor-hidden:invisible")}
        >
          <SelectPrimitive.Popup
            ref={ref}
            data-align-trigger={alignsSelectedItem}
            className={cn(
              "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-[0_8px_20px_rgb(0_0_0_/_0.1)]",
              !alignsSelectedItem &&
                "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
              className,
            )}
            {...props}
          >
            <SelectScrollUpButton />
            <SelectPrimitive.List
              className={cn(
                "p-1",
                !alignsSelectedItem &&
                  "h-[var(--anchor-height)] w-full min-w-[var(--anchor-width)]",
              )}
            >
              {children}
            </SelectPrimitive.List>
            <SelectScrollDownButton />
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    );
  },
);
SelectContent.displayName = SelectPrimitive.Popup.displayName;

export const SelectLabel = forwardRef<
  ComponentRef<typeof SelectPrimitive.GroupLabel>,
  SelectPrimitive.GroupLabel.Props
>(({ className, ...props }, ref) => (
  <SelectPrimitive.GroupLabel
    ref={ref}
    className={cn("px-2 py-1.5 text-[11px] font-semibold tracking-[0.02em] text-muted-foreground", className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.GroupLabel.displayName;

export interface SelectItemProps extends Omit<
  SelectPrimitive.Item.Props,
  "label" | "value"
> {
  label?: string | undefined;
  textValue?: string | undefined;
  value: string;
}

export const SelectItem = forwardRef<
  ComponentRef<typeof SelectPrimitive.Item>,
  SelectItemProps
>(({ className, children, label, textValue, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-[13px] outline-none focus:bg-muted focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
      className,
    )}
    label={label ?? textValue}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator
      render={
        <span className="absolute right-2 flex size-3.5 items-center justify-center" />
      }
    >
      <IconCheck className="size-4" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export const SelectSeparator = forwardRef<
  ComponentRef<typeof SelectPrimitive.Separator>,
  SelectPrimitive.Separator.Props
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;
