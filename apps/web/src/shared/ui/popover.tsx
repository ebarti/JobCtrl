"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRender } from "@base-ui/react/use-render";
import {
  Children,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "../lib/cn.js";

type PopoverDismissEventHandler<TEvent extends Event = Event> = (
  event: TEvent,
) => void;

type PopoverFocusOutsideEvent = CustomEvent<{
  originalEvent: FocusEvent;
}>;
type PopoverPointerDownOutsideEvent = CustomEvent<{
  originalEvent: PointerEvent;
}>;
type PopoverPressOutsideEvent = CustomEvent<{
  originalEvent: MouseEvent | PointerEvent | TouchEvent;
}>;
type PopoverInteractOutsideEvent =
  | PopoverFocusOutsideEvent
  | PopoverPointerDownOutsideEvent
  | PopoverPressOutsideEvent;

interface PopoverDismissHandlers {
  onEscapeKeyDown?: PopoverDismissEventHandler<KeyboardEvent> | undefined;
  onFocusOutside?:
    | PopoverDismissEventHandler<PopoverFocusOutsideEvent>
    | undefined;
  onInteractOutside?:
    | PopoverDismissEventHandler<PopoverInteractOutsideEvent>
    | undefined;
  onPointerDownOutside?:
    | PopoverDismissEventHandler<PopoverPointerDownOutsideEvent>
    | undefined;
}

interface PopoverCompatibilityContextValue {
  anchor: Element | null;
  dismissHandlersRef: RefObject<PopoverDismissHandlers | null>;
  modal: PopoverPrimitive.Root.Props["modal"];
  setAnchor: (anchor: Element | null) => void;
}

const PopoverCompatibilityContext = createContext<
  PopoverCompatibilityContextValue | undefined
>(undefined);

const noCollisionAvoidance = {
  align: "none",
  fallbackAxisSide: "none",
  side: "none",
} as const;

const radixCollisionAvoidance = {
  fallbackAxisSide: "none",
} as const;

const radixCollisionBoundary: Element[] = [];

function dispatchCompatibilityOutsideEvent<TEvent extends Event>(
  name: string,
  originalEvent: TEvent,
  handler:
    | PopoverDismissEventHandler<
        CustomEvent<{
          originalEvent: TEvent;
        }>
      >
    | undefined,
  interactHandler:
    | PopoverDismissEventHandler<
        CustomEvent<{
          originalEvent: TEvent;
        }>
      >
    | undefined,
) {
  const event = new CustomEvent(name, {
    bubbles: false,
    cancelable: true,
    detail: { originalEvent },
  });
  const invokeHandlers = () => {
    handler?.(event);
    interactHandler?.(event);
  };
  const target = originalEvent.target;

  if (target) {
    target.addEventListener(name, invokeHandlers, { once: true });
    target.dispatchEvent(event);
  } else {
    invokeHandlers();
  }

  return event.defaultPrevented;
}

function isPointerDownEvent(event: Event): event is PointerEvent {
  return event.type === "pointerdown";
}

function preventDismissWhenHandled(
  eventDetails: PopoverPrimitive.Root.ChangeEventDetails,
  handlers: PopoverDismissHandlers | null,
) {
  if (!handlers) return false;

  const { event, reason } = eventDetails;
  let prevented = false;

  if (reason === "escape-key") {
    handlers.onEscapeKeyDown?.(event as KeyboardEvent);
  } else if (reason === "outside-press") {
    if (isPointerDownEvent(event)) {
      prevented = dispatchCompatibilityOutsideEvent(
        "dismissableLayer.pointerDownOutside",
        event,
        handlers.onPointerDownOutside,
        handlers.onInteractOutside,
      );
    } else {
      prevented = dispatchCompatibilityOutsideEvent(
        "popover.outsidePress",
        event as MouseEvent | PointerEvent | TouchEvent,
        undefined,
        handlers.onInteractOutside,
      );
    }
  } else if (reason === "focus-out") {
    prevented = dispatchCompatibilityOutsideEvent(
      "dismissableLayer.focusOutside",
      event as FocusEvent,
      handlers.onFocusOutside,
      handlers.onInteractOutside,
    );
  }

  if (!prevented && !event.defaultPrevented) return false;

  eventDetails.cancel();
  return true;
}

function Popover({
  modal = false,
  onOpenChange,
  ...props
}: PopoverPrimitive.Root.Props) {
  const [anchor, setAnchor] = useState<Element | null>(null);
  const dismissHandlersRef = useRef<PopoverDismissHandlers | null>(null);

  const handleOpenChange = useCallback<
    NonNullable<PopoverPrimitive.Root.Props["onOpenChange"]>
  >(
    (open, eventDetails) => {
      if (
        !open &&
        preventDismissWhenHandled(eventDetails, dismissHandlersRef.current)
      ) {
        return;
      }

      onOpenChange?.(open, eventDetails);
    },
    [onOpenChange],
  );

  const compatibilityContext = useMemo<PopoverCompatibilityContextValue>(
    () => ({ anchor, dismissHandlersRef, modal, setAnchor }),
    [anchor, modal],
  );

  return (
    <PopoverCompatibilityContext.Provider value={compatibilityContext}>
      <PopoverPrimitive.Root
        {...props}
        modal={modal}
        onOpenChange={handleOpenChange}
      />
    </PopoverCompatibilityContext.Provider>
  );
}

export interface PopoverTriggerProps extends Omit<
  PopoverPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: PopoverPrimitive.Trigger.Props["render"];
}

const PopoverTrigger = forwardRef<HTMLButtonElement, PopoverTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;

    return (
      <PopoverPrimitive.Trigger
        {...props}
        ref={ref}
        render={child ?? render}
        data-slot="popover-trigger"
      >
        {child ? undefined : children}
      </PopoverPrimitive.Trigger>
    );
  },
);
PopoverTrigger.displayName = "PopoverTrigger";

export interface PopoverAnchorProps extends Omit<
  useRender.ComponentProps<"div">,
  "ref"
> {
  asChild?: boolean;
}

const PopoverAnchor = forwardRef<HTMLElement, PopoverAnchorProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const compatibilityContext = useContext(PopoverCompatibilityContext);
    const setAnchor = compatibilityContext?.setAnchor;
    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;
    const anchorChildren = child
      ? (child.props as { children?: ReactNode }).children
      : children;
    const setAnchorRef = useCallback(
      (element: HTMLElement | null) => {
        setAnchor?.(element);
      },
      [setAnchor],
    );

    return useRender<{}, HTMLElement>({
      defaultTagName: "div",
      ref: [ref, setAnchorRef],
      render: child ?? render,
      props: mergeProps(props, {
        "data-slot": "popover-anchor",
        children: anchorChildren,
      } as ComponentProps<"div">),
    });
  },
);
PopoverAnchor.displayName = "PopoverAnchor";

type PopoverPositioningProps = Pick<
  PopoverPrimitive.Positioner.Props,
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

export type PopoverContentProps = Omit<PopoverPrimitive.Popup.Props, "render"> &
  PopoverPositioningProps & {
    asChild?: boolean;
    avoidCollisions?: boolean;
    container?: PopoverPrimitive.Portal.Props["container"];
    forceMount?: boolean;
    hideWhenDetached?: boolean;
    keepMounted?: boolean;
    onCloseAutoFocus?: PopoverDismissEventHandler;
    onEscapeKeyDown?: PopoverDismissEventHandler<KeyboardEvent>;
    onFocusOutside?: PopoverDismissEventHandler<PopoverFocusOutsideEvent>;
    onInteractOutside?: PopoverDismissEventHandler<PopoverInteractOutsideEvent>;
    onOpenAutoFocus?: PopoverDismissEventHandler;
    onPointerDownOutside?: PopoverDismissEventHandler<PopoverPointerDownOutsideEvent>;
    render?: PopoverPrimitive.Popup.Props["render"];
    sticky?: boolean | "always" | "partial";
  };

const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      align = "center",
      alignOffset = 0,
      anchor,
      arrowPadding = 0,
      asChild = false,
      avoidCollisions = true,
      children,
      className,
      collisionAvoidance,
      collisionBoundary = radixCollisionBoundary,
      collisionPadding = 0,
      container,
      disableAnchorTracking,
      finalFocus,
      forceMount = false,
      hideWhenDetached = false,
      initialFocus,
      keepMounted,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onFocusOutside,
      onInteractOutside,
      onOpenAutoFocus,
      onPointerDownOutside,
      positionMethod = "fixed",
      render,
      side = "bottom",
      sideOffset = 4,
      sticky = "partial",
      ...props
    },
    ref,
  ) => {
    const compatibilityContext = useContext(PopoverCompatibilityContext);
    const dismissHandlers = useMemo<PopoverDismissHandlers>(
      () => ({
        onEscapeKeyDown,
        onFocusOutside,
        onInteractOutside,
        onPointerDownOutside,
      }),
      [
        onEscapeKeyDown,
        onFocusOutside,
        onInteractOutside,
        onPointerDownOutside,
      ],
    );
    const handleInitialFocus = useCallback(() => {
      const event = new Event("openAutoFocus", { cancelable: true });
      onOpenAutoFocus?.(event);
      return event.defaultPrevented ? false : true;
    }, [onOpenAutoFocus]);
    const handleFinalFocus = useCallback(() => {
      const event = new Event("closeAutoFocus", { cancelable: true });
      onCloseAutoFocus?.(event);
      return event.defaultPrevented ? false : true;
    }, [onCloseAutoFocus]);

    useEffect(() => {
      const dismissHandlersRef = compatibilityContext?.dismissHandlersRef;
      if (!dismissHandlersRef) return undefined;

      dismissHandlersRef.current = dismissHandlers;

      return () => {
        if (dismissHandlersRef.current === dismissHandlers) {
          dismissHandlersRef.current = null;
        }
      };
    }, [compatibilityContext?.dismissHandlersRef, dismissHandlers]);

    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;
    const popupChildren = child
      ? (child.props as { children?: ReactNode }).children
      : children;
    const resolvedAnchor =
      anchor !== undefined ? anchor : compatibilityContext?.anchor;
    const resolvedCollisionAvoidance =
      collisionAvoidance ??
      (avoidCollisions ? radixCollisionAvoidance : noCollisionAvoidance);
    const resolvedSticky =
      sticky === "always" ? true : sticky === "partial" ? false : sticky;

    return (
      <PopoverPrimitive.Portal
        container={container}
        keepMounted={keepMounted ?? forceMount}
      >
        <PopoverPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          anchor={resolvedAnchor}
          arrowPadding={arrowPadding}
          className={cn(
            "isolate z-50 outline-none",
            hideWhenDetached && "data-[anchor-hidden]:invisible",
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
          <PopoverPrimitive.Popup
            {...props}
            ref={ref}
            render={child ?? render}
            data-slot="popover-content"
            initialFocus={
              initialFocus ?? (onOpenAutoFocus ? handleInitialFocus : undefined)
            }
            finalFocus={
              finalFocus ?? (onCloseAutoFocus ? handleFinalFocus : undefined)
            }
            className={cn(
              "z-50 w-72 origin-(--transform-origin) rounded-[10px] border border-border bg-popover p-4 text-sm text-popover-foreground shadow-xl outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              className,
            )}
          >
            {popupChildren}
            {compatibilityContext?.modal ? (
              <PopoverPrimitive.Close
                aria-label="Close popover"
                className="sr-only"
              >
                Close popover
              </PopoverPrimitive.Close>
            ) : null}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = "PopoverContent";

const PopoverArrow = forwardRef<HTMLDivElement, PopoverPrimitive.Arrow.Props>(
  ({ ...props }, ref) => (
    <PopoverPrimitive.Arrow data-slot="popover-arrow" ref={ref} {...props} />
  ),
);
PopoverArrow.displayName = "PopoverArrow";

export interface PopoverCloseProps extends Omit<
  PopoverPrimitive.Close.Props,
  "render"
> {
  asChild?: boolean;
  render?: PopoverPrimitive.Close.Props["render"];
}

const PopoverClose = forwardRef<HTMLButtonElement, PopoverCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild
      ? (Children.only(children) as ReactElement)
      : undefined;

    return (
      <PopoverPrimitive.Close
        {...props}
        ref={ref}
        render={child ?? render}
        data-slot="popover-close"
      >
        {child ? undefined : children}
      </PopoverPrimitive.Close>
    );
  },
);
PopoverClose.displayName = "PopoverClose";

const PopoverPortal = PopoverPrimitive.Portal;
const PopoverPositioner = PopoverPrimitive.Positioner;
const PopoverPopup = PopoverPrimitive.Popup;

export {
  Popover,
  PopoverAnchor,
  PopoverArrow,
  PopoverClose,
  PopoverContent,
  PopoverPortal,
  PopoverPositioner,
  PopoverPopup,
  PopoverTrigger,
};
