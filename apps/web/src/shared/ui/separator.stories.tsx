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
      <p className="text-sm text-muted-foreground">Grouped content</p>
      <Separator className="my-2" />
      <p className="text-sm">Alpha · Beta · Gamma</p>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-12 items-center gap-3">
      <span>Today</span>
      <Separator orientation="vertical" />
      <span>5 updated</span>
      <Separator orientation="vertical" />
      <span>2 paused</span>
    </div>
  ),
};

export const DenseToolbar: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-sm">
      <span>One</span>
      <Separator orientation="vertical" />
      <span>Two</span>
      <Separator orientation="vertical" />
      <span>Three</span>
    </div>
  ),
};
