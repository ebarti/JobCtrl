import type { Meta, StoryObj } from "@storybook/react-vite";

import { RetryStageButton } from "./RetryStageButton.js";

const meta = {
  title: "Contexts/Pipeline/RetryStageButton",
  component: RetryStageButton,
  args: {
    jobId: "job-1",
    stage: "tailor",
  },
} satisfies Meta<typeof RetryStageButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ResetAndRunAfter: Story = {
  args: { resetAttempts: true, runAfter: true, label: "retry from scratch" },
};

export const DryRun: Story = {
  args: { dryRun: true, label: "retry (dry-run)" },
};
