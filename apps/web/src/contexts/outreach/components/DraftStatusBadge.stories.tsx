import type { Meta, StoryObj } from "@storybook/react-vite";

import { DraftStatusBadge } from "./DraftStatusBadge.js";

const meta = {
  title: "Contexts/Outreach/DraftStatusBadge",
  component: DraftStatusBadge,
  args: { status: "candidate" },
} satisfies Meta<typeof DraftStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Candidate: Story = { args: { status: "candidate" } };
export const Approved: Story = { args: { status: "approved" } };
export const Rejected: Story = { args: { status: "rejected" } };
export const Superseded: Story = { args: { status: "superseded" } };
