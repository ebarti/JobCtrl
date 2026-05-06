import type { Meta, StoryObj } from "@storybook/react-vite";

import { RelativeTime } from "./relative-time.js";

const meta = {
  title: "Shared/UI/RelativeTime",
  component: RelativeTime,
} satisfies Meta<typeof RelativeTime>;

export default meta;
type Story = StoryObj<typeof meta>;

const TODAY = new Date("2026-05-06T12:00:00Z");

export const JustNow: Story = {
  args: { value: new Date(TODAY.getTime() - 30 * 1000).toISOString() },
};

export const Hours: Story = {
  args: { value: new Date(TODAY.getTime() - 3 * 60 * 60 * 1000).toISOString() },
};

export const Days: Story = {
  args: { value: new Date(TODAY.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString() },
};

export const Empty: Story = {
  args: { value: null, fallback: "never" },
};

export const Invalid: Story = {
  args: { value: "not-a-date" },
};
