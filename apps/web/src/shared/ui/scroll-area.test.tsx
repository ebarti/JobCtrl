import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScrollArea, ScrollBar } from "./scroll-area.js";

if (typeof HTMLElement.prototype.getAnimations !== "function") {
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
}

const metric = (
  element: HTMLElement,
  name: "clientHeight" | "clientWidth" | "scrollHeight" | "scrollWidth",
) => {
  if (element.dataset["slot"] !== "scroll-area-viewport") return 0;

  return name.startsWith("client") ? 100 : 240;
};

const mockOverflowingViewport = () => {
  for (const name of [
    "clientHeight",
    "clientWidth",
    "scrollHeight",
    "scrollWidth",
  ] as const) {
    vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return metric(this, name);
    });
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<ScrollArea>", () => {
  it("composes the Base UI parts and makes an overflowing viewport keyboard focusable", async () => {
    mockOverflowingViewport();
    const rootRef = createRef<HTMLDivElement>();

    render(
      <ScrollArea ref={rootRef} data-testid="scroll-area-root">
        <p>Scrollable content</p>
      </ScrollArea>,
    );

    const root = screen.getByTestId("scroll-area-root");
    const viewport = root.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const content = root.querySelector<HTMLElement>(
      '[data-slot="scroll-area-content"]',
    );

    expect(rootRef.current).toBe(root);
    expect(root).toHaveClass("relative", "overflow-hidden");
    expect(viewport?.firstElementChild).toBe(content);
    expect(content).toHaveTextContent("Scrollable content");
    expect(content).toHaveStyle({ minWidth: "fit-content" });

    await waitFor(() => {
      const scrollbar = root.querySelector(
        '[data-slot="scroll-area-scrollbar"]',
      );

      expect(viewport).toHaveAttribute("tabindex", "0");
      expect(scrollbar).toHaveAttribute("data-orientation", "vertical");
      expect(scrollbar).toHaveClass(
        "h-full",
        "w-2.5",
        "border-l",
        "border-l-transparent",
        "p-[1px]",
      );
      expect(
        root.querySelector('[data-slot="scroll-area-thumb"]'),
      ).not.toBeNull();
      expect(
        root.querySelector('[data-slot="scroll-area-corner"]'),
      ).not.toBeNull();
    });

    viewport?.focus();
    expect(viewport).toHaveFocus();
  });

  it("leaves a non-overflowing viewport out of the tab order", () => {
    render(<ScrollArea>Static content</ScrollArea>);

    expect(
      document.querySelector('[data-slot="scroll-area-viewport"]'),
    ).toHaveAttribute("tabindex", "-1");
  });

  it("preserves horizontal ScrollBar orientation, styling, and ref forwarding", () => {
    const scrollbarRef = createRef<HTMLDivElement>();

    render(
      <ScrollAreaPrimitive.Root>
        <ScrollAreaPrimitive.Viewport>
          <ScrollAreaPrimitive.Content>
            Scrollable content
          </ScrollAreaPrimitive.Content>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar
          ref={scrollbarRef}
          data-testid="horizontal-scrollbar"
          orientation="horizontal"
          keepMounted
        />
      </ScrollAreaPrimitive.Root>,
    );

    const scrollbar = screen.getByTestId("horizontal-scrollbar");

    expect(scrollbarRef.current).toBe(scrollbar);
    expect(scrollbar).toHaveAttribute("data-orientation", "horizontal");
    expect(scrollbar).toHaveClass(
      "h-2.5",
      "flex-col",
      "border-t",
      "border-t-transparent",
      "p-[1px]",
    );
    expect(
      scrollbar.querySelector('[data-slot="scroll-area-thumb"]'),
    ).not.toBeNull();
  });
});
