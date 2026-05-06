import type { Meta, StoryObj } from "@storybook/react-vite";

import { ArtifactStatusBadge } from "./ArtifactStatusBadge.js";

const meta = {
  title: "Contexts/Materials/ArtifactStatusBadge",
  component: ArtifactStatusBadge,
} satisfies Meta<typeof ArtifactStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Approved: Story = { args: { status: "approved" } };
export const Pending: Story = { args: { status: "pending" } };
export const Rejected: Story = { args: { status: "rejected" } };
export const Stale: Story = { args: { status: "stale" } };
