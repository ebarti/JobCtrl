import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentRef,
  type Dispatch,
  type SetStateAction,
} from "react";

import { cn } from "../lib/cn.js";

const radixDefaultOpenDelay = 700;
const radixDefaultSkipDelay = 300;

interface TooltipProviderCompatibilityValue {
  readonly delay: number;
  readonly disableHoverableContent: boolean;
}

const TooltipProviderCompatibilityContext =
  createContext<TooltipProviderCompatibilityValue>({
    delay: radixDefaultOpenDelay,
    disableHoverableContent: false,
  });

interface TooltipRootCompatibilityValue {
  readonly contentId: string;
  readonly delay: number;
  readonly generatedContentId: string;
  readonly open: boolean;
  readonly setContentId: Dispatch<SetStateAction<string>>;
}

const TooltipRootCompatibilityContext =
  createContext<TooltipRootCompatibilityValue>({
    contentId: "",
    delay: radixDefaultOpenDelay,
    generatedContentId: "",
    open: false,
    setContentId: () => undefined,
  });

export interface TooltipProviderProps extends TooltipPrimitive.Provider.Props {
  /** @deprecated Use `delay` instead. */
  delayDuration?: number;
  /** @deprecated Use `timeout` instead. */
  skipDelayDuration?: number;
  /** @deprecated Set `disableHoverablePopup` on each Tooltip instead. */
  disableHoverableContent?: boolean;
}

export function TooltipProvider({
  children,
  delay,
  delayDuration,
  timeout,
  skipDelayDuration,
  disableHoverableContent = false,
  ...props
}: TooltipProviderProps) {
  const effectiveDelay = delay ?? delayDuration ?? radixDefaultOpenDelay;
  const effectiveTimeout =
    timeout ?? skipDelayDuration ?? radixDefaultSkipDelay;
  const compatibilityValue = useMemo(
    () => ({ delay: effectiveDelay, disableHoverableContent }),
    [disableHoverableContent, effectiveDelay],
  );

  return (
    <TooltipProviderCompatibilityContext.Provider value={compatibilityValue}>
      <TooltipPrimitive.Provider
        delay={effectiveDelay}
        timeout={effectiveTimeout}
        {...props}
      >
        {children}
      </TooltipPrimitive.Provider>
    </TooltipProviderCompatibilityContext.Provider>
  );
}

export interface TooltipProps<Payload = unknown> extends TooltipPrimitive.Root
  .Props<Payload> {
  /** @deprecated Set `delay` on TooltipTrigger instead. */
  delayDuration?: number;
  /** @deprecated Use `disableHoverablePopup` instead. */
  disableHoverableContent?: boolean;
}

export function Tooltip<Payload = unknown>({
  children,
  defaultOpen = false,
  delayDuration,
  disabled = false,
  disableHoverableContent,
  disableHoverablePopup,
  onOpenChange,
  open,
  ...props
}: TooltipProps<Payload>) {
  const provider = useContext(TooltipProviderCompatibilityContext);
  const generatedContentId = useId();
  const [contentId, setContentId] = useState(generatedContentId);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const effectiveDelay = delayDuration ?? provider.delay;
  const effectiveDisableHoverablePopup =
    disableHoverablePopup ??
    disableHoverableContent ??
    provider.disableHoverableContent;
  const effectiveOpen = !disabled && (open ?? uncontrolledOpen);
  const compatibilityValue = useMemo(
    () => ({
      contentId,
      delay: effectiveDelay,
      generatedContentId,
      open: effectiveOpen,
      setContentId,
    }),
    [contentId, effectiveDelay, effectiveOpen, generatedContentId],
  );

  return (
    <TooltipRootCompatibilityContext.Provider value={compatibilityValue}>
      <TooltipPrimitive.Root
        defaultOpen={defaultOpen}
        disabled={disabled}
        disableHoverablePopup={effectiveDisableHoverablePopup}
        onOpenChange={(nextOpen, eventDetails) => {
          onOpenChange?.(nextOpen, eventDetails);
          if (open === undefined && !eventDetails.isCanceled) {
            setUncontrolledOpen(nextOpen);
          }
        }}
        open={open}
        {...props}
      >
        {children}
      </TooltipPrimitive.Root>
    </TooltipRootCompatibilityContext.Provider>
  );
}

export const TooltipTrigger = forwardRef<
  HTMLButtonElement,
  TooltipPrimitive.Trigger.Props
>(({ delay, ...props }, ref) => {
  const root = useContext(TooltipRootCompatibilityContext);
  const ariaDescribedBy = [
    props["aria-describedby"],
    root.open ? root.contentId : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <TooltipPrimitive.Trigger
      {...props}
      aria-describedby={ariaDescribedBy || undefined}
      delay={delay ?? root.delay}
      ref={ref}
    />
  );
});
TooltipTrigger.displayName = "TooltipTrigger";

type TooltipPositionerProps = Pick<
  TooltipPrimitive.Positioner.Props,
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

export interface TooltipContentProps
  extends
    Omit<TooltipPrimitive.Popup.Props, "className">,
    TooltipPositionerProps {
  className?: string;
  /** @deprecated Base UI uses `collisionAvoidance`. */
  avoidCollisions?: boolean;
  /** Keeps the Base UI Portal mounted while the tooltip is closed. */
  forceMount?: boolean;
  /** Hides the Positioner when Base UI reports that its anchor is hidden. */
  hideWhenDetached?: boolean;
}

const radixCollisionAvoidance = {
  fallbackAxisSide: "none",
} as const;

const noCollisionAvoidance = {
  side: "none",
  align: "none",
  fallbackAxisSide: "none",
} as const;

const radixCollisionBoundary: Element[] = [];

export const TooltipContent = forwardRef<
  ComponentRef<typeof TooltipPrimitive.Popup>,
  TooltipContentProps
>(
  (
    {
      align = "center",
      alignOffset = 0,
      anchor,
      arrowPadding = 0,
      avoidCollisions = true,
      className,
      collisionAvoidance,
      collisionBoundary = radixCollisionBoundary,
      collisionPadding = 0,
      disableAnchorTracking,
      forceMount,
      hideWhenDetached = false,
      id,
      positionMethod = "fixed",
      role = "tooltip",
      side = "top",
      sideOffset = 4,
      ...props
    },
    ref,
  ) => {
    const root = useContext(TooltipRootCompatibilityContext);
    const effectiveId = id ?? root.generatedContentId;

    useLayoutEffect(() => {
      root.setContentId(effectiveId);
      return () => {
        root.setContentId((currentId) =>
          currentId === effectiveId ? root.generatedContentId : currentId,
        );
      };
    }, [effectiveId, root.generatedContentId, root.setContentId]);

    return (
      <TooltipPrimitive.Portal keepMounted={forceMount}>
        <TooltipPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          anchor={anchor}
          arrowPadding={arrowPadding}
          className={cn(
            "isolate z-50",
            hideWhenDetached && "data-[anchor-hidden]:invisible",
          )}
          collisionAvoidance={
            collisionAvoidance ??
            (avoidCollisions ? radixCollisionAvoidance : noCollisionAvoidance)
          }
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          disableAnchorTracking={disableAnchorTracking}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
        >
          <TooltipPrimitive.Popup
            ref={ref}
            data-slot="tooltip-content"
            className={cn(
              "z-50 max-w-xs origin-(--transform-origin) overflow-hidden rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-4 text-background shadow-lg outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              className,
            )}
            id={effectiveId}
            role={role}
            {...props}
          />
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = "TooltipContent";
