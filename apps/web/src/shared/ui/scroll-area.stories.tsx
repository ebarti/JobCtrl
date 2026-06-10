import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScrollArea } from "./scroll-area.js";

// Radix ScrollArea viewport flags scrollable-region-focusable; the fix
// requires tabIndex on the viewport which is upstream primitive
// behaviour. Deferred.
const meta = {
  title: "Shared/UI/ScrollArea",
  component: ScrollArea,
  parameters: {
    // a11y deferred — Radix ScrollArea viewport scrollable-region-focusable; see meta comment above.
    a11y: { test: "off" },
  },
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const ROWS = Array.from({ length: 40 }, (_, index) => `Activity event #${index + 1}`);

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
          <div key={index} className="w-28 rounded-md border border-border bg-card p-3 text-sm">
            Item {index + 1}
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};
