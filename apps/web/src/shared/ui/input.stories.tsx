import type { Meta, StoryObj } from "@storybook/react-vite";

import { Input } from "./input.js";

const meta = {
  title: "Shared/UI/Input",
  component: Input,
  args: {
    placeholder: "Search jobs...",
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithValue: Story = {
  args: { defaultValue: "platform engineer" },
};

export const Disabled: Story = {
  args: { disabled: true, placeholder: "Read-only field" },
};

export const TypePassword: Story = {
  args: { type: "password", placeholder: "API key" },
};

export const TypeNumber: Story = {
  args: { type: "number", placeholder: "Min fit score", min: 0, max: 10 },
};
