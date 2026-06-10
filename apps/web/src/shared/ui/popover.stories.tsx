import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";

// Radix Popover portal exposes role="dialog" content whose role/ARIA
// requires inner labelling. Upstream primitive behaviour, deferred.
const meta = {
  title: "Shared/UI/Popover",
  component: Popover,
  parameters: {
    // a11y deferred — Radix Popover portal role/ARIA labelling requirements; see meta comment above.
    a11y: { test: "off" },
  },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FilterPicker: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Filter by company</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="grid gap-2">
          <p className="text-sm font-medium">Recent companies</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>Acme Corp</li>
            <li>Globex</li>
            <li>Initech</li>
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="outline">Help</Button>
      </PopoverTrigger>
      <PopoverContent>Per stage retries up to 3 attempts.</PopoverContent>
    </Popover>
  ),
};
