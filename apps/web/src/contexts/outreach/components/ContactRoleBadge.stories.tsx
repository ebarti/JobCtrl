import type { Meta, StoryObj } from "@storybook/react-vite";

import { ContactRoleBadge } from "./ContactRoleBadge.js";

const meta = {
  title: "Contexts/Outreach/ContactRoleBadge",
  component: ContactRoleBadge,
  args: { role: "recruiter" },
} satisfies Meta<typeof ContactRoleBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Recruiter: Story = { args: { role: "recruiter" } };
export const HiringManager: Story = { args: { role: "hiring_manager" } };
export const Referrer: Story = { args: { role: "referrer" } };
export const WarmIntro: Story = { args: { role: "warm_intro" } };
export const Other: Story = { args: { role: "other" } };
