import type { Meta, StoryObj } from "@storybook/react-vite";

import { CancelApplyButton } from "./CancelApplyButton.js";

const meta = {
  title: "Contexts/Apply/CancelApplyButton",
  component: CancelApplyButton,
  args: { jobId: "job-1" },
} satisfies Meta<typeof CancelApplyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TargetingRun: Story = {
  args: { runId: "run-1" },
};
