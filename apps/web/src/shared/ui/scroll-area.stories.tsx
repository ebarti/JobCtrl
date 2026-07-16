import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScrollArea } from "./scroll-area.js";

const meta = {
  title: "Shared/UI/ScrollArea",
  component: ScrollArea,
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const ROWS = Array.from(
  { length: 40 },
  (_, index) => `Activity event #${index + 1}`,
);

export const DenseList: Story = {
  render: () => (
    <ScrollArea className="h-64 w-72 rounded-md border border-border">
      <ul className="divide-y divide-border">
        {ROWS.map((row) => (
          <li key={row} className="px-3 py-1.5 text-sm">
            {row}
          </li>
        ))}
      </ul>
    </ScrollArea>
  ),
};

export const HorizontalOverflow: Story = {
  render: () => (
    <ScrollArea className="w-80 rounded-md border border-border">
      <div className="flex w-max gap-2 p-3">
        {Array.from({ length: 12 }, (_, index) => (
          <div
            key={index}
            className="w-28 rounded-md border border-border bg-card p-3 text-sm"
          >
            Item {index + 1}
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};

export const Geometry: Story = {
  tags: ["scroll-area-geometry"],
  render: () => (
    <ScrollArea className="h-48 w-72 rounded-md border border-border">
      <div className="h-96 w-[36rem] p-3 text-sm">
        Two-axis overflow geometry
      </div>
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const root = canvasElement.querySelector<HTMLElement>(
      '[data-slot="scroll-area"]',
    );
    const viewport = canvasElement.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const content = canvasElement.querySelector<HTMLElement>(
      '[data-slot="scroll-area-content"]',
    );
    const scrollbar = canvasElement.querySelector<HTMLElement>(
      '[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]',
    );

    if (!root || !viewport || !content || !scrollbar) {
      throw new Error("Missing ScrollArea geometry parts.");
    }

    const rootRect = root.getBoundingClientRect();
    const scrollbarRect = scrollbar.getBoundingClientRect();
    if (rootRect.width !== 288 || rootRect.height !== 192) {
      throw new Error(
        `Expected fixed 288x192 ScrollArea geometry, received ${rootRect.width}x${rootRect.height}.`,
      );
    }
    if (scrollbarRect.width !== 10) {
      throw new Error(
        `Expected a 10px vertical scrollbar, received ${scrollbarRect.width}px.`,
      );
    }
    if (viewport.firstElementChild !== content) {
      throw new Error("Expected Content to be the direct child of Viewport.");
    }
    if (
      viewport.scrollHeight <= viewport.clientHeight ||
      viewport.scrollWidth <= viewport.clientWidth
    ) {
      throw new Error("Expected the geometry story to overflow on both axes.");
    }
    if (viewport.tabIndex !== 0) {
      throw new Error(
        `Expected Base UI to make the overflowing viewport focusable, received ${viewport.tabIndex}.`,
      );
    }

    viewport.focus();
    if (document.activeElement !== viewport) {
      throw new Error(
        "Expected the overflowing viewport to receive keyboard focus.",
      );
    }
  },
};
