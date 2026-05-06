import type { Meta, StoryObj } from "@storybook/react-vite";

import { Textarea } from "./textarea.js";

const meta = {
  title: "Shared/UI/Textarea",
  component: Textarea,
  args: {
    placeholder: "Score reasoning...",
    rows: 4,
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithValue: Story = {
  args: {
    defaultValue: "Strong fit on platform reliability and SRE leadership.",
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "Read-only" },
};
