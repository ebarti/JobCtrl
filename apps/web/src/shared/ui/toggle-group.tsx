"use client";

import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn.js";
import { toggleVariants } from "./toggle.js";

type ToggleGroupSharedProps = Omit<
  ToggleGroupPrimitive.Props<string>,
  | "className"
  | "defaultValue"
  | "loopFocus"
  | "multiple"
  | "onValueChange"
  | "orientation"
  | "style"
  | "value"
> &
  VariantProps<typeof toggleVariants> & {
    children?: React.ReactNode;
    className?: string;
    orientation?: "horizontal" | "vertical";
    spacing?: number;
    style?: React.CSSProperties;
  };

type ToggleGroupSingleProps = ToggleGroupSharedProps & {
  defaultValue?: string;
  loop?: boolean;
  onValueChange?: (value: string) => void;
  type: "single";
  value?: string;
};

type ToggleGroupMultipleProps = ToggleGroupSharedProps & {
  defaultValue?: readonly string[];
  loop?: boolean;
  onValueChange?: (value: string[]) => void;
  type: "multiple";
  value?: readonly string[];
};

type ToggleGroupProps = ToggleGroupSingleProps | ToggleGroupMultipleProps;

type ToggleGroupContextValue = VariantProps<typeof toggleVariants> & {
  orientation?: "horizontal" | "vertical";
  selectedValues: readonly string[];
  spacing?: number;
};

const ToggleGroupContext = React.createContext<ToggleGroupContextValue>({
  orientation: "horizontal",
  selectedValues: [],
  size: "default",
  spacing: 2,
  variant: "default",
});

function selectionForSingleValue(value: string | undefined): readonly string[] {
  return value ? [value] : [];
}

function assignRef<T>(ref: React.ForwardedRef<T>, node: T | null) {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}

/**
 * Base UI's ToggleGroup owns its roving tab stop independently from its value.
 * Recreate that state when a controlled single selection changes before the
 * group is focused, so entering the group starts on the newly selected item.
 */
function useControlledSingleValueRovingFocus(
  rootRef: React.RefObject<HTMLDivElement | null>,
  value: string | undefined,
  enabled: boolean,
) {
  const [instanceKey, setInstanceKey] = React.useState(0);
  const previous = React.useRef({ enabled, value });

  React.useLayoutEffect(() => {
    const previousSelection = previous.current;
    previous.current = { enabled, value };

    if (
      !enabled ||
      !previousSelection.enabled ||
      previousSelection.value === value
    ) {
      return;
    }

    const root = rootRef.current;
    if (!root || root.contains(root.ownerDocument.activeElement)) {
      return;
    }

    setInstanceKey((key) => key + 1);
  }, [enabled, rootRef, value]);

  return instanceKey;
}

const ToggleGroup = React.forwardRef<HTMLDivElement, ToggleGroupProps>(
  function ToggleGroup(props, forwardedRef) {
    const {
      children,
      className,
      defaultValue,
      loop,
      onValueChange,
      orientation = "horizontal",
      size,
      spacing = 2,
      style,
      type,
      value,
      variant,
      ...rootProps
    } = props;
    const rootRef = React.useRef<HTMLDivElement>(null);
    const setRootRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node;
        assignRef(forwardedRef, node);
      },
      [forwardedRef],
    );

    const isSingle = type === "single";
    const isControlled = value !== undefined;
    const controlledValues =
      type === "single" ? selectionForSingleValue(value) : (value ?? []);
    const initialDefaultValues =
      type === "single"
        ? selectionForSingleValue(defaultValue)
        : (defaultValue ?? []);
    const [uncontrolledValues, setUncontrolledValues] = React.useState<
      readonly string[]
    >(() => initialDefaultValues);
    const selectedValues = isControlled ? controlledValues : uncontrolledValues;
    const instanceKey = useControlledSingleValueRovingFocus(
      rootRef,
      type === "single" ? value : undefined,
      isSingle && isControlled,
    );

    const handleValueChange = React.useCallback(
      (nextValue: string[]) => {
        if (!isControlled) {
          setUncontrolledValues(nextValue);
        }

        if (type === "single") {
          onValueChange?.(nextValue[0] ?? "");
        } else {
          onValueChange?.(nextValue);
        }
      },
      [isControlled, onValueChange, type],
    );

    return (
      <ToggleGroupPrimitive
        key={instanceKey}
        ref={setRootRef}
        data-orientation={orientation}
        data-size={size}
        data-slot="toggle-group"
        data-spacing={spacing}
        data-variant={variant}
        defaultValue={isControlled ? undefined : initialDefaultValues}
        loopFocus={loop}
        multiple={!isSingle}
        orientation={orientation}
        value={isControlled ? controlledValues : undefined}
        onValueChange={handleValueChange}
        style={{ "--gap": spacing, ...style } as React.CSSProperties}
        className={cn(
          "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] data-[spacing=0]:data-[variant=outline]:rounded-3xl data-vertical:flex-col data-vertical:items-stretch",
          className,
        )}
        {...rootProps}
      >
        <ToggleGroupContext.Provider
          value={{
            orientation,
            selectedValues,
            size,
            spacing,
            variant,
          }}
        >
          {children}
        </ToggleGroupContext.Provider>
      </ToggleGroupPrimitive>
    );
  },
);
ToggleGroup.displayName = "ToggleGroup";

type ToggleGroupItemProps = Omit<
  TogglePrimitive.Props<string>,
  "className" | "defaultPressed" | "onPressedChange" | "pressed" | "value"
> &
  VariantProps<typeof toggleVariants> & {
    children?: React.ReactNode;
    className?: string;
    value: string;
  };

const ToggleGroupItem = React.forwardRef<
  HTMLButtonElement,
  ToggleGroupItemProps
>(function ToggleGroupItem(
  { className, children, size = "default", value, variant = "default", ...props },
  ref,
) {
  const context = React.useContext(ToggleGroupContext);
  const selected = context.selectedValues.includes(value);

  return (
    <TogglePrimitive
      ref={ref}
      data-composite-item-active={selected ? "" : undefined}
      data-size={context.size || size}
      data-slot="toggle-group-item"
      data-spacing={context.spacing}
      data-state={selected ? "on" : "off"}
      data-variant={context.variant || variant}
      value={value}
      className={cn(
        "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-3 group-data-[spacing=0]/toggle-group:shadow-none focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-2.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-2.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-3xl group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-3xl group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-3xl group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-3xl data-pressed:bg-muted group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          size: context.size || size,
          variant: context.variant || variant,
        }),
        className,
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
});
ToggleGroupItem.displayName = "ToggleGroupItem";

export {
  ToggleGroup,
  ToggleGroupItem,
  type ToggleGroupItemProps,
  type ToggleGroupMultipleProps,
  type ToggleGroupProps,
  type ToggleGroupSingleProps,
};
