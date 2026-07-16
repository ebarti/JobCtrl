import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Button } from "./button.js";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "./popover.js";

const meta = {
  title: "Shared/UI/Popover",
  component: Popover,
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FilterPicker: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>
        Filter options
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Saved filter options"
        className="w-64"
      >
        <div className="grid gap-2">
          <p className="text-sm font-medium text-popover-foreground">
            Saved filters
          </p>
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
      <PopoverTrigger render={<Button variant="outline" />}>
        Help
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

export const ControlledModal: Story = {
  render: function ControlledModalPopover() {
    const [open, setOpen] = useState(false);

    return (
      <div className="flex items-center gap-3">
        <Popover modal open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<Button variant="outline" />}>
            Controlled popover
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label="Controlled popover details"
            className="w-64"
            side="right"
            sideOffset={8}
          >
            <p className="text-sm text-muted-foreground">
              This state exercises controlled open callbacks, modal focus,
              custom positioning, and the close part.
            </p>
            <PopoverClose render={<Button size="sm" variant="outline" />}>
              Close
            </PopoverClose>
          </PopoverContent>
        </Popover>
        <span className="text-sm text-muted-foreground">
          {open ? "Open" : "Closed"}
        </span>
      </div>
    );
  },
};
