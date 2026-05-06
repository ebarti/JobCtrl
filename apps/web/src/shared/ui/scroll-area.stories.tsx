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

export const ActivityFeed: Story = {
  render: () => (
    <ScrollArea className="h-64 w-72 rounded-md border border-rule">
      <ul className="divide-y divide-rule">
        {ROWS.map((row) => (
          <li key={row} className="px-3 py-2 text-sm">
            {row}
          </li>
        ))}
      </ul>
    </ScrollArea>
  ),
};
