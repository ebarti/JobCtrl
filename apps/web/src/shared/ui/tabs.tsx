import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import {
  createContext,
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";

import { cn } from "../lib/cn.js";

type TabsActivationMode = "automatic" | "manual";

const TabsActivationModeContext =
  createContext<TabsActivationMode>("automatic");

export interface TabsProps extends Omit<
  TabsPrimitive.Root.Props,
  "defaultValue" | "dir" | "onValueChange" | "value"
> {
  activationMode?: TabsActivationMode | undefined;
  defaultValue?: string | undefined;
  dir?: "ltr" | "rtl" | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  value?: string | undefined;
}

export const Tabs = forwardRef<
  ComponentRef<typeof TabsPrimitive.Root>,
  TabsProps
>(
  (
    {
      activationMode = "automatic",
      defaultValue,
      dir,
      onValueChange,
      value,
      ...props
    },
    ref,
  ) => {
    const root = (
      <TabsPrimitive.Root
        ref={ref}
        defaultValue={
          value === undefined && defaultValue === undefined
            ? null
            : defaultValue
        }
        dir={dir}
        onValueChange={
          onValueChange === undefined
            ? undefined
            : (nextValue) => {
                if (typeof nextValue === "string") {
                  onValueChange(nextValue);
                }
              }
        }
        value={value}
        {...props}
      />
    );

    return (
      <TabsActivationModeContext.Provider value={activationMode}>
        {dir === undefined ? (
          root
        ) : (
          <DirectionProvider direction={dir}>{root}</DirectionProvider>
        )}
      </TabsActivationModeContext.Provider>
    );
  },
);
Tabs.displayName = TabsPrimitive.Root.displayName;

export interface TabsListProps extends ComponentPropsWithoutRef<
  typeof TabsPrimitive.List
> {
  loop?: boolean | undefined;
}

export const TabsList = forwardRef<
  ComponentRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ activateOnFocus, className, loop, loopFocus, ...props }, ref) => {
  const activationMode = useContext(TabsActivationModeContext);

  return (
    <TabsPrimitive.List
      ref={ref}
      activateOnFocus={activateOnFocus ?? activationMode === "automatic"}
      loopFocus={loopFocus ?? loop}
      className={cn(
        "inline-flex h-9 items-center justify-start gap-1 border-b border-border bg-transparent p-0 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

export type TabsTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof TabsPrimitive.Tab>,
  "value"
> & {
  value: string;
};

export const TabsTrigger = forwardRef<
  ComponentRef<typeof TabsPrimitive.Tab>,
  TabsTriggerProps
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Tab
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium transition-[color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:border-primary data-active:text-foreground",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Tab.displayName;

export type TabsContentProps = Omit<
  ComponentPropsWithoutRef<typeof TabsPrimitive.Panel>,
  "value"
> & {
  forceMount?: true | undefined;
  value: string;
};

export const TabsContent = forwardRef<
  ComponentRef<typeof TabsPrimitive.Panel>,
  TabsContentProps
>(({ className, forceMount, keepMounted, ...props }, ref) => (
  <TabsPrimitive.Panel
    ref={ref}
    keepMounted={keepMounted ?? forceMount}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Panel.displayName;
