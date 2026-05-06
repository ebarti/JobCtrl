import type { Meta, StoryObj } from "@storybook/react-vite";

import { StatusDot } from "./status-dot.js";

const meta = {
  title: "Shared/UI/StatusDot",
  component: StatusDot,
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: { state: "open" },
};

export const Connecting: Story = {
  args: { state: "connecting" },
};

export const Closed: Story = {
  args: { state: "closed" },
};
