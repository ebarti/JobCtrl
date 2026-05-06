import type { Meta, StoryObj } from "@storybook/react-vite";

import { Skeleton } from "./skeleton.js";

const meta = {
  title: "Shared/UI/Skeleton",
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Line: Story = {
  args: { className: "h-4 w-48" },
};

export const Block: Story = {
  args: { className: "h-32 w-72" },
};

export const TextStack: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-56" />
    </div>
  ),
};
