import type { Meta, StoryObj } from "@storybook/react-vite";

import { Badge } from "./badge.js";

const meta = {
  title: "Shared/UI/Badge",
  component: Badge,
  args: {
    children: "queued",
  },
  argTypes: {
    variant: {
      control: { type: "select" },
      options: ["default", "secondary", "destructive", "outline"],
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Secondary: Story = {
  args: { variant: "secondary", children: "running" },
};

export const Destructive: Story = {
  args: { variant: "destructive", children: "failed" },
};

export const Outline: Story = {
  args: { variant: "outline", children: "pending" },
};
