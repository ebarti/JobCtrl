import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";

const meta = {
  title: "Shared/UI/Popover",
  component: Popover,
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FilterPicker: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Filter options</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Saved filter options" className="w-64">
        <div className="grid gap-2">
          <p className="text-sm font-medium text-popover-foreground">Saved filters</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>Updated recently</li>
            <li>Owned by reviewer</li>
            <li>Needs decision</li>
          </ul>
          <Button disabled size="sm" variant="outline">
            Disabled action
          </Button>
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
      <PopoverContent aria-label="Help details" className="w-64">
        <div className="grid gap-2 text-sm">
          <p className="font-medium text-popover-foreground">Open popover</p>
          <p className="text-muted-foreground">
            This open fixture keeps the popover surface, foreground, border, and
            focus tokens visible over the Storybook canvas.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  ),
};
