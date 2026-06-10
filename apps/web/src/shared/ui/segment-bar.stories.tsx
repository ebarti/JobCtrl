import type { Meta, StoryObj } from "@storybook/react-vite";

import { SegmentBar } from "./segment-bar.js";

const meta = {
  title: "Shared/UI/SegmentBar",
  component: SegmentBar,
} satisfies Meta<typeof SegmentBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Funnel: Story = {
  args: {
    total: 12,
    values: [
      ["done", 8],
      ["running", 2],
      ["pending", 1],
      ["failed", 1],
    ],
  },
};

export const Empty: Story = {
  args: {
    total: 0,
    values: [
      ["done", 0],
      ["pending", 0],
    ],
  },
};
