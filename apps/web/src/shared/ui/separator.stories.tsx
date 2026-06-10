import type { Meta, StoryObj } from "@storybook/react-vite";

import { Separator } from "./separator.js";

const meta = {
  title: "Shared/UI/Separator",
  component: Separator,
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="w-72">
      <p className="text-sm text-muted-foreground">Filters</p>
      <Separator className="my-2" />
      <p className="text-sm">Apply state · Stage · Company</p>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-12 items-center gap-3">
      <span>Today</span>
      <Separator orientation="vertical" />
      <span>5 applied</span>
      <Separator orientation="vertical" />
      <span>2 dry-run</span>
    </div>
  ),
};
