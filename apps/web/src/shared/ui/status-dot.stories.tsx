import type { Meta, StoryObj } from "@storybook/react-vite";

import { StatusDot } from "./status-dot.js";

const meta = {
  title: "Shared/UI/StatusDot",
  component: StatusDot,
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Succeeded: Story = {
  args: { state: "succeeded" },
};

export const Running: Story = {
  args: { state: "running" },
};

export const Failed: Story = {
  args: { state: "failed" },
};
