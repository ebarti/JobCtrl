import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";

const meta = {
  title: "Shared/UI/Button",
  component: Button,
  args: {
    children: "Open run",
  },
  argTypes: {
    variant: {
      control: { type: "select" },
      options: ["default", "destructive", "outline", "secondary", "ghost", "link"],
    },
    size: {
      control: { type: "select" },
      options: ["default", "sm", "lg", "icon"],
    },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Destructive: Story = {
  args: { variant: "destructive", children: "Delete job" },
};

export const Outline: Story = {
  args: { variant: "outline", children: "Mark applied" },
};

export const Secondary: Story = {
  args: { variant: "secondary", children: "Open in OS" },
};

export const Ghost: Story = {
  args: { variant: "ghost", children: "Cancel" },
};

export const Link: Story = {
  args: { variant: "link", children: "View job" },
};

export const Small: Story = {
  args: { size: "sm", children: "Retry" },
};

export const Large: Story = {
  args: { size: "lg", children: "Generate materials" },
};

export const Disabled: Story = {
  args: { disabled: true, children: "Apply" },
};

export const IconOnly: Story = {
  args: {
    "aria-label": "Add item",
    children: <span aria-hidden="true">+</span>,
    size: "icon",
    variant: "outline",
  },
};

export const FocusVisible: Story = {
  args: {
    autoFocus: true,
    children: "Save changes",
  },
};
