import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

const { capturedPositionerProps } = vi.hoisted(() => ({
  capturedPositionerProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@base-ui/react/tooltip", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@base-ui/react/tooltip")>();
  const React = await import("react");
  const CapturingPositioner = React.forwardRef<
    HTMLDivElement,
    ComponentProps<typeof original.Tooltip.Positioner>
  >((props, ref) => {
    capturedPositionerProps.push(props as Record<string, unknown>);
    return React.createElement(original.Tooltip.Positioner, { ...props, ref });
  });

  return {
    ...original,
    Tooltip: { ...original.Tooltip, Positioner: CapturingPositioner },
  };
});

import { Button } from "./button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip.js";

function TestTooltip({
  defaultOpen = false,
  delayDuration,
}: {
  defaultOpen?: boolean;
  delayDuration?: number;
}) {
  return (
    <Tooltip
      defaultOpen={defaultOpen}
      {...(delayDuration === undefined ? {} : { delayDuration })}
    >
      <TooltipTrigger render={<Button variant="outline" />}>
        Show details
      </TooltipTrigger>
      <TooltipContent data-testid="content">Helpful details</TooltipContent>
    </Tooltip>
  );
}

describe("Tooltip", () => {
  it("preserves Radix collision defaults across Positioner renders", async () => {
    capturedPositionerProps.length = 0;
    const { rerender } = render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Collision trigger</TooltipTrigger>
          <TooltipContent>Collision content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Collision content",
    );
    const firstPositionerProps = capturedPositionerProps.at(-1);
    const collisionBoundary = firstPositionerProps?.collisionBoundary;
    expect(firstPositionerProps?.collisionAvoidance).toEqual({
      fallbackAxisSide: "none",
    });
    expect(collisionBoundary).toEqual([]);

    rerender(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Collision trigger</TooltipTrigger>
          <TooltipContent>Updated collision content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Updated collision content",
    );
    expect(capturedPositionerProps.at(-1)?.collisionBoundary).toBe(
      collisionBoundary,
    );
  });

  it("renders semantic metadata typography in a positioned Base UI portal", async () => {
    const { container } = render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger
            aria-describedby="persistent-help"
            render={<Button variant="outline" />}
          >
            Positioned trigger
          </TooltipTrigger>
          <span id="persistent-help">Persistent help</span>
          <TooltipContent
            align="start"
            alignOffset={8}
            avoidCollisions={false}
            className="custom-tooltip"
            data-testid="positioned-content"
            id="positioned-tooltip"
            side="bottom"
            sideOffset={12}
          >
            Positioned content
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const content = await screen.findByRole("tooltip");
    const positioner = content.parentElement;
    const trigger = screen.getByRole("button", { name: "Positioned trigger" });

    expect(content).toHaveAttribute("data-testid", "positioned-content");
    expect(content).toHaveClass(
      "z-50",
      "max-w-xs",
      "overflow-hidden",
      "rounded-md",
      "bg-foreground",
      "px-2.5",
      "py-1.5",
      "text-background",
      "shadow-lg",
      "custom-tooltip",
    );
    expect(content).toHaveAttribute("data-typography", "metadata");
    expect(positioner).toHaveClass("isolate", "z-50");
    expect(positioner).toHaveStyle({ position: "fixed" });
    expect(positioner).toHaveAttribute("data-side", "bottom");
    expect(positioner).toHaveAttribute("data-align", "start");
    expect(positioner).toHaveStyle({ transform: "translate(8px, 12px)" });
    expect(content).toHaveAttribute("id", "positioned-tooltip");
    expect(trigger).toHaveAttribute(
      "aria-describedby",
      "persistent-help positioned-tooltip",
    );
    expect(container).not.toContainElement(content);
  });

  it("opens on hover with the Radix-compatible root delay and closes on Escape", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <TooltipProvider>
        <Tooltip delayDuration={0} onOpenChange={onOpenChange}>
          <TooltipTrigger render={<Button variant="outline" />}>
            Hover trigger
          </TooltipTrigger>
          <TooltipContent>Hover content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole("button", { name: "Hover trigger" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Hover content",
    );
    expect(onOpenChange).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: "trigger-hover" }),
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Hover trigger" }),
    ).not.toHaveAttribute("aria-describedby");
    expect(onOpenChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "escape-key" }),
    );
  });

  it("opens immediately on keyboard focus and composes the existing Button", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <TestTooltip />
      </TooltipProvider>,
    );

    await user.tab();

    expect(screen.getByRole("button", { name: "Show details" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Helpful details",
    );
  });

  it("does not expose an ARIA description when a consumer cancels opening", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <TooltipProvider>
        <Tooltip
          onOpenChange={(nextOpen, eventDetails) => {
            onOpenChange(nextOpen, eventDetails);
            if (nextOpen) eventDetails.cancel();
          }}
        >
          <TooltipTrigger>Canceled trigger</TooltipTrigger>
          <TooltipContent>Canceled content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.tab();

    const trigger = screen.getByRole("button", { name: "Canceled trigger" });
    expect(trigger).toHaveFocus();
    expect(onOpenChange).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: "trigger-focus" }),
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("aria-describedby");
  });

  it("keeps the popup and ARIA description when a consumer cancels closing", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <TooltipProvider>
        <Tooltip
          defaultOpen
          onOpenChange={(nextOpen, eventDetails) => {
            onOpenChange(nextOpen, eventDetails);
            if (!nextOpen) eventDetails.cancel();
          }}
        >
          <TooltipTrigger>Canceled close trigger</TooltipTrigger>
          <TooltipContent id="canceled-close-tooltip">
            Canceled close content
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const tooltip = await screen.findByRole("tooltip");
    const trigger = screen.getByRole("button", {
      name: "Canceled close trigger",
    });
    expect(trigger).toHaveAttribute(
      "aria-describedby",
      "canceled-close-tooltip",
    );

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "escape-key" }),
    );
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    expect(trigger).toHaveAttribute(
      "aria-describedby",
      "canceled-close-tooltip",
    );
  });

  it("maps the Radix-compatible provider delay to Base UI hover timing", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>Provider delay trigger</TooltipTrigger>
          <TooltipContent>Provider delay content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(
      screen.getByRole("button", { name: "Provider delay trigger" }),
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Provider delay content",
    );
  });

  it("maps provider hoverability and forced mounting compatibility props", async () => {
    const { rerender } = render(
      <TooltipProvider disableHoverableContent>
        <TestTooltip defaultOpen />
      </TooltipProvider>,
    );

    const openContent = await screen.findByTestId("content");
    expect(openContent.parentElement).toHaveStyle({ pointerEvents: "none" });

    rerender(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Closed trigger</TooltipTrigger>
          <TooltipContent forceMount data-testid="forced-content">
            Forced content
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const forcedContent = screen.getByTestId("forced-content");
    expect(forcedContent).toBeInTheDocument();
    expect(forcedContent.parentElement).toHaveAttribute("hidden");
  });
});
