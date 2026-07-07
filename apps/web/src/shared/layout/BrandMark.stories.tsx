import type { Meta, StoryObj } from "@storybook/react-vite";

import { BrandMark } from "./BrandMark.js";

const meta = {
  title: "Layout/BrandMark",
  component: BrandMark,
} satisfies Meta<typeof BrandMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Lockup: Story = { args: { showWordmark: true } };
export const WithTagline: Story = { args: { showWordmark: true, showTagline: true } };
export const MarkOnly: Story = { args: { showWordmark: false } };
