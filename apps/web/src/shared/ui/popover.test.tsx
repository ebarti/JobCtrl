import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button.js";
import {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "./popover.js";

describe("Popover", () => {
  it("keeps positioning props on the Base UI positioner and supports a custom anchor", async () => {
    const getAnchorRect = () =>
      ({
        bottom: 70,
        height: 20,
        left: 100,
        right: 140,
        top: 50,
        width: 40,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;

    const { container } = render(
      <Popover defaultOpen>
        <PopoverTrigger>Open details</PopoverTrigger>
        <PopoverAnchor asChild>
          <span
            ref={(element) => {
              if (element) element.getBoundingClientRect = getAnchorRect;
            }}
            data-testid="custom-anchor"
          >
            Custom anchor
          </span>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          alignOffset={8}
          aria-label="Positioned details"
          avoidCollisions={false}
          className="custom-popover"
          data-testid="positioned-content"
          side="bottom"
          sideOffset={12}
        >
          Positioned content
        </PopoverContent>
      </Popover>,
    );

    const content = await screen.findByRole("dialog", {
      name: "Positioned details",
    });
    const positioner = content.parentElement;
    const anchor = screen.getByTestId("custom-anchor");

    expect(anchor).toHaveAttribute("data-slot", "popover-anchor");
    expect(anchor.parentElement).toBe(container);
    expect(content).toHaveAttribute("data-testid", "positioned-content");
    expect(content).toHaveClass(
      "z-50",
      "w-72",
      "rounded-lg",
      "border",
      "border-border",
      "bg-popover",
      "p-4",
      "text-popover-foreground",
      "shadow-[var(--shadow-panel)]",
      "outline-none",
      "custom-popover",
    );
    expect(positioner).toHaveClass("isolate", "z-50", "outline-none");
    expect(positioner).toHaveAttribute("data-side", "bottom");
    expect(positioner).toHaveAttribute("data-align", "start");
    expect(positioner).toHaveStyle({
      position: "fixed",
      transform: "translate(108px, 82px)",
    });
    expect(container).not.toContainElement(content);
  });

  it("keeps Radix's viewport collision boundary inside a clipping portal container", async () => {
    const documentElement = document.documentElement;
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      documentElement,
      "clientWidth",
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      documentElement,
      "clientHeight",
    );
    const originalDocumentRect = documentElement.getBoundingClientRect;
    const portalContainer = document.createElement("div");
    const rect = (x: number, y: number, width: number, height: number) =>
      ({
        bottom: y + height,
        height,
        left: x,
        right: x + width,
        top: y,
        width,
        x,
        y,
        toJSON: () => ({}),
      }) as DOMRect;

    Object.defineProperty(documentElement, "clientWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(documentElement, "clientHeight", {
      configurable: true,
      value: 768,
    });
    documentElement.getBoundingClientRect = () => rect(0, 0, 1024, 768);
    portalContainer.style.height = "40px";
    portalContainer.style.overflow = "hidden";
    portalContainer.style.transform = "translateZ(0)";
    portalContainer.style.width = "40px";
    Object.defineProperty(portalContainer, "clientWidth", {
      configurable: true,
      value: 40,
    });
    Object.defineProperty(portalContainer, "clientHeight", {
      configurable: true,
      value: 40,
    });
    portalContainer.getBoundingClientRect = () => rect(0, 0, 40, 40);
    document.body.append(portalContainer);

    const renderWithBoundary = (collisionBoundary?: "clipping-ancestors") =>
      render(
        <Popover defaultOpen>
          <PopoverTrigger>Open boundary details</PopoverTrigger>
          <PopoverAnchor asChild>
            <span
              ref={(element) => {
                if (element) {
                  element.getBoundingClientRect = () => rect(400, 200, 40, 20);
                }
              }}
            >
              Boundary anchor
            </span>
          </PopoverAnchor>
          <PopoverContent
            aria-label="Boundary details"
            collisionBoundary={collisionBoundary}
            container={portalContainer}
          >
            Boundary content
          </PopoverContent>
        </Popover>,
      );

    try {
      const defaultRender = renderWithBoundary();
      const defaultPositioner = (
        await screen.findByRole("dialog", { name: "Boundary details" })
      ).parentElement;
      await waitFor(() =>
        expect(
          defaultPositioner?.style.getPropertyValue("--available-width"),
        ).not.toBe(""),
      );
      const defaultAvailableWidth = Number.parseFloat(
        defaultPositioner?.style.getPropertyValue("--available-width") ?? "",
      );
      defaultRender.unmount();

      const clippedRender = renderWithBoundary("clipping-ancestors");
      const clippedPositioner = (
        await screen.findByRole("dialog", { name: "Boundary details" })
      ).parentElement;
      await waitFor(() =>
        expect(
          clippedPositioner?.style.getPropertyValue("--available-width"),
        ).not.toBe(""),
      );
      const clippedAvailableWidth = Number.parseFloat(
        clippedPositioner?.style.getPropertyValue("--available-width") ?? "",
      );

      expect(defaultAvailableWidth).toBeGreaterThan(clippedAvailableWidth);
      expect(defaultAvailableWidth).toBeGreaterThan(40);
      clippedRender.unmount();
    } finally {
      portalContainer.remove();
      documentElement.getBoundingClientRect = originalDocumentRect;
      if (originalClientWidth) {
        Object.defineProperty(
          documentElement,
          "clientWidth",
          originalClientWidth,
        );
      } else {
        delete (documentElement as { clientWidth?: number }).clientWidth;
      }
      if (originalClientHeight) {
        Object.defineProperty(
          documentElement,
          "clientHeight",
          originalClientHeight,
        );
      } else {
        delete (documentElement as { clientHeight?: number }).clientHeight;
      }
    }
  });

  it("preserves asChild composition, open callbacks, focus, and close behavior", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <Popover onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="outline">Edit filter</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Edit filter details">
          <label htmlFor="filter-name">Filter name</label>
          <input id="filter-name" />
          <PopoverClose asChild>
            <Button size="sm">Done</Button>
          </PopoverClose>
        </PopoverContent>
      </Popover>,
    );

    const trigger = screen.getByRole("button", { name: "Edit filter" });
    expect(trigger).toHaveAttribute("data-slot", "popover-trigger");

    await user.click(trigger);

    expect(
      await screen.findByRole("dialog", { name: "Edit filter details" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Filter name")).toHaveFocus(),
    );
    expect(onOpenChange).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: "trigger-press" }),
    );

    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit filter details" }),
      ).toBeNull(),
    );
    expect(trigger).toHaveFocus();
    expect(onOpenChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "close-press" }),
    );
  });

  it("maps prevented Radix escape dismissal onto Base UI cancellation", async () => {
    const user = userEvent.setup();
    const onEscapeKeyDown = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
    });
    const onOpenChange = vi.fn();

    render(
      <Popover defaultOpen onOpenChange={onOpenChange}>
        <PopoverTrigger>Open protected details</PopoverTrigger>
        <PopoverContent
          aria-label="Protected details"
          onEscapeKeyDown={onEscapeKeyDown}
        >
          <button type="button">Focusable content</button>
        </PopoverContent>
      </Popover>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Protected details" }),
    ).toBeInTheDocument();
    screen.getByRole("button", { name: "Focusable content" }).focus();

    await user.keyboard("{Escape}");

    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Protected details" }),
    ).toBeInTheDocument();
  });

  it("maps prevented focus-out dismissal onto Base UI cancellation", async () => {
    const user = userEvent.setup();
    const onFocusOutside = vi.fn(
      (event: CustomEvent<{ originalEvent: FocusEvent }>) => {
        event.preventDefault();
      },
    );
    const onInteractOutside = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <>
        <button type="button">Outside target</button>
        <Popover defaultOpen onOpenChange={onOpenChange}>
          <PopoverTrigger>Open focus-protected details</PopoverTrigger>
          <PopoverContent
            aria-label="Focus-protected details"
            onFocusOutside={onFocusOutside}
            onInteractOutside={onInteractOutside}
          >
            <button type="button">Inside target</button>
          </PopoverContent>
        </Popover>
      </>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Focus-protected details" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Inside target" }),
      ).toHaveFocus(),
    );
    await user.tab();

    await waitFor(() => expect(onFocusOutside).toHaveBeenCalledTimes(1));
    expect(onFocusOutside.mock.calls[0]?.[0]).toMatchObject({
      type: "dismissableLayer.focusOutside",
    });
    expect(
      onFocusOutside.mock.calls[0]?.[0].detail.originalEvent,
    ).toBeInstanceOf(FocusEvent);
    expect(onInteractOutside).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Focus-protected details" }),
    ).toBeInTheDocument();
  });

  it("does not relabel Base UI's intentional mouse click as pointerDownOutside", async () => {
    const sequence: string[] = [];
    const onPointerDownOutside = vi.fn();
    const onInteractOutside = vi.fn((event: CustomEvent) => {
      sequence.push("interact-outside");
      event.preventDefault();
    });
    const onOpenChange = vi.fn();

    render(
      <>
        <button type="button">Mouse outside target</button>
        <Popover defaultOpen onOpenChange={onOpenChange}>
          <PopoverTrigger>Open mouse-protected details</PopoverTrigger>
          <PopoverContent
            aria-label="Mouse-protected details"
            onInteractOutside={onInteractOutside}
            onPointerDownOutside={onPointerDownOutside}
          >
            Mouse-protected content
          </PopoverContent>
        </Popover>
      </>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Mouse-protected details" }),
    ).toBeInTheDocument();
    const outsideTarget = screen.getByRole("button", {
      name: "Mouse outside target",
    });
    outsideTarget.addEventListener(
      "pointerdown",
      () => sequence.push("native-pointerdown"),
      { once: true },
    );
    outsideTarget.addEventListener(
      "click",
      () => sequence.push("native-click"),
      { once: true },
    );

    fireEvent.pointerDown(outsideTarget, { pointerType: "mouse" });

    expect(sequence).toEqual(["native-pointerdown"]);
    expect(onPointerDownOutside).not.toHaveBeenCalled();
    expect(onInteractOutside).not.toHaveBeenCalled();

    fireEvent.click(outsideTarget);

    expect(sequence).toEqual([
      "native-pointerdown",
      "native-click",
      "interact-outside",
    ]);
    expect(onPointerDownOutside).not.toHaveBeenCalled();
    expect(onInteractOutside).toHaveBeenCalledTimes(1);
    expect(onInteractOutside.mock.calls[0]?.[0]).toMatchObject({
      cancelable: true,
      type: "popover.outsidePress",
    });
    expect(onInteractOutside.mock.calls[0]?.[0].detail.originalEvent).toEqual(
      expect.objectContaining({ type: "click" }),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Mouse-protected details" }),
    ).toBeInTheDocument();
  });

  it("reports focus-out before the final click for a real focusable outside interaction", async () => {
    const user = userEvent.setup();
    const sequence: string[] = [];
    const onPointerDownOutside = vi.fn();
    const onFocusOutside = vi.fn(
      (event: CustomEvent<{ originalEvent: FocusEvent }>) => {
        sequence.push(`focus-out:${event.detail.originalEvent.type}`);
      },
    );
    const onInteractOutside = vi.fn(
      (event: CustomEvent<{ originalEvent: Event }>) => {
        sequence.push(
          `interact:${event.type}:${event.detail.originalEvent.type}`,
        );
      },
    );
    const onOpenChange = vi.fn(
      (open: boolean, eventDetails: { event: Event; reason: string }) => {
        sequence.push(
          `open:${String(open)}:${eventDetails.reason}:${eventDetails.event.type}`,
        );
      },
    );

    render(
      <>
        <button type="button">Focusable outside target</button>
        <Popover defaultOpen onOpenChange={onOpenChange}>
          <PopoverTrigger>Open focus-order details</PopoverTrigger>
          <PopoverContent
            aria-label="Focus-order details"
            onFocusOutside={onFocusOutside}
            onInteractOutside={onInteractOutside}
            onPointerDownOutside={onPointerDownOutside}
          >
            <button type="button">Inside focus-order target</button>
          </PopoverContent>
        </Popover>
      </>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Focus-order details" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Inside focus-order target" }),
      ).toHaveFocus(),
    );
    const outsideTarget = screen.getByRole("button", {
      name: "Focusable outside target",
    });
    outsideTarget.addEventListener(
      "pointerdown",
      () => sequence.push("native-pointerdown"),
      { once: true },
    );
    outsideTarget.addEventListener(
      "click",
      () => sequence.push("native-click"),
      { once: true },
    );

    await user.click(outsideTarget);

    expect(sequence).toEqual([
      "native-pointerdown",
      "focus-out:focusout",
      "interact:dismissableLayer.focusOutside:focusout",
      "open:false:focus-out:focusout",
      "native-click",
      "interact:popover.outsidePress:click",
      "open:false:outside-press:click",
    ]);
    expect(onPointerDownOutside).not.toHaveBeenCalled();
    expect(onFocusOutside).toHaveBeenCalledTimes(1);
    expect(onInteractOutside).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("dialog", { name: "Focus-order details" }),
    ).toBeNull();
  });

  it("cancels both focus-out and final-click phases through onInteractOutside", async () => {
    const user = userEvent.setup();
    const sequence: string[] = [];
    const onPointerDownOutside = vi.fn();
    const onInteractOutside = vi.fn(
      (event: CustomEvent<{ originalEvent: Event }>) => {
        sequence.push(
          `interact:${event.type}:${event.detail.originalEvent.type}`,
        );
        event.preventDefault();
      },
    );
    const onOpenChange = vi.fn();

    render(
      <>
        <button type="button">Cancelable outside target</button>
        <Popover defaultOpen onOpenChange={onOpenChange}>
          <PopoverTrigger>Open cancel-order details</PopoverTrigger>
          <PopoverContent
            aria-label="Cancel-order details"
            onInteractOutside={onInteractOutside}
            onPointerDownOutside={onPointerDownOutside}
          >
            <button type="button">Inside cancel-order target</button>
          </PopoverContent>
        </Popover>
      </>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Cancel-order details" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Inside cancel-order target" }),
      ).toHaveFocus(),
    );
    const outsideTarget = screen.getByRole("button", {
      name: "Cancelable outside target",
    });
    outsideTarget.addEventListener(
      "pointerdown",
      () => sequence.push("native-pointerdown"),
      { once: true },
    );
    outsideTarget.addEventListener(
      "click",
      () => sequence.push("native-click"),
      { once: true },
    );

    await user.click(outsideTarget);

    expect(sequence).toEqual([
      "native-pointerdown",
      "interact:dismissableLayer.focusOutside:focusout",
      "native-click",
      "interact:popover.outsidePress:click",
    ]);
    expect(onPointerDownOutside).not.toHaveBeenCalled();
    expect(onInteractOutside).toHaveBeenCalledTimes(2);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Cancel-order details" }),
    ).toBeInTheDocument();
  });

  it("retains Radix-shaped pointerDownOutside for an actual Base UI pointerdown", async () => {
    const sequence: string[] = [];
    const onPointerDownOutside = vi.fn(
      (event: CustomEvent<{ originalEvent: PointerEvent }>) => {
        sequence.push("pointer-down-outside");
        event.preventDefault();
      },
    );
    const onInteractOutside = vi.fn(() => {
      sequence.push("interact-outside");
    });
    const onOpenChange = vi.fn();

    render(
      <>
        <button data-testid="pointer-outside-target" type="button">
          Pointer outside target
        </button>
        <Popover defaultOpen modal="trap-focus" onOpenChange={onOpenChange}>
          <PopoverTrigger>Open pointer-protected details</PopoverTrigger>
          <PopoverContent
            aria-label="Pointer-protected details"
            onInteractOutside={onInteractOutside}
            onPointerDownOutside={onPointerDownOutside}
          >
            Pointer-protected content
          </PopoverContent>
        </Popover>
      </>,
    );

    expect(
      await screen.findByRole("dialog", {
        name: "Pointer-protected details",
      }),
    ).toBeInTheDocument();
    const outsideTarget = screen.getByTestId("pointer-outside-target");
    outsideTarget.addEventListener(
      "pointerdown",
      () => sequence.push("native-pointerdown"),
      { once: true },
    );

    fireEvent.pointerDown(outsideTarget, { pointerType: "mouse" });

    expect(sequence).toEqual([
      "native-pointerdown",
      "pointer-down-outside",
      "interact-outside",
    ]);
    expect(onPointerDownOutside).toHaveBeenCalledTimes(1);
    const pointerOutsideEvent = onPointerDownOutside.mock.calls[0]![0];
    expect(pointerOutsideEvent).toMatchObject({
      cancelable: true,
      type: "dismissableLayer.pointerDownOutside",
    });
    expect(pointerOutsideEvent.detail.originalEvent).toEqual(
      expect.objectContaining({ type: "pointerdown" }),
    );
    expect(onInteractOutside).toHaveBeenCalledWith(pointerOutsideEvent);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "Pointer-protected details",
      }),
    ).toBeInTheDocument();
  });

  it("preserves prevented open autofocus and forced mounting", async () => {
    const onOpenAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { unmount } = render(
      <Popover defaultOpen>
        <PopoverTrigger>Open focus details</PopoverTrigger>
        <PopoverContent
          aria-label="Focus details"
          onOpenAutoFocus={onOpenAutoFocus}
        >
          <input aria-label="Autofocus candidate" />
        </PopoverContent>
      </Popover>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Focus details" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(onOpenAutoFocus).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Autofocus candidate")).not.toHaveFocus();

    unmount();
    render(
      <Popover>
        <PopoverTrigger>Closed trigger</PopoverTrigger>
        <PopoverContent
          forceMount
          aria-label="Forced details"
          data-testid="forced-content"
        >
          Forced content
        </PopoverContent>
      </Popover>,
    );

    const forcedContent = screen.getByTestId("forced-content");
    expect(forcedContent).toBeInTheDocument();
    expect(forcedContent).toHaveAttribute("data-closed");
  });

  it("adds an accessible escape control when modal focus trapping is requested", async () => {
    render(
      <Popover defaultOpen modal>
        <PopoverTrigger>Open modal details</PopoverTrigger>
        <PopoverContent aria-label="Modal details">
          Modal content
        </PopoverContent>
      </Popover>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Modal details" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close popover" })).toHaveClass(
      "sr-only",
    );
  });
});
