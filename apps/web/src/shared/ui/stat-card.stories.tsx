import type { Meta, StoryObj } from "@storybook/react-vite";

import { Badge } from "./badge.js";
import { StatCard } from "./stat-card.js";

const meta = {
  title: "Shared/UI/StatCard",
  component: StatCard,
} satisfies Meta<typeof StatCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Up: Story = {
  args: {
    label: "Applications sent",
    value: "128",
    delta: "+12 this week",
    deltaTone: "up",
    className: "w-[240px]",
  },
};

export const WithTag: Story = {
  args: {
    label: "Response rate",
    value: "34%",
    tag: <Badge>on track</Badge>,
    delta: "+4 pts vs last month",
    deltaTone: "up",
    className: "w-[240px]",
  },
};

export const Warn: Story = {
  args: {
    label: "Stale scores",
    value: "17",
    tag: <Badge variant="outline">attention</Badge>,
    delta: "5 older than 30 days",
    deltaTone: "warn",
    className: "w-[240px]",
  },
};

export const Down: Story = {
  args: {
    label: "Interviews",
    value: "3",
    delta: "-2 vs last month",
    deltaTone: "down",
    className: "w-[240px]",
  },
};

export const ValueOnly: Story = {
  args: {
    label: "Jobs tracked",
    value: "1,204",
    className: "w-[240px]",
  },
};

export const ValueTone: Story = {
  args: {
    label: "Failures",
    value: "3",
    valueTone: "down",
    delta: "needs retry",
    className: "w-[240px]",
  },
};

export const AsLink: Story = {
  args: {
    asChild: true,
    label: "Ready",
    value: "12",
    valueTone: "up",
    delta: "ready queue",
    className: "w-[240px]",
    children: <a href="#ready" />,
  },
};
