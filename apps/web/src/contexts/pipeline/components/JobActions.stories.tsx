import type { Meta, StoryObj } from "@storybook/react-vite";

import { JobActions } from "./JobActions.js";

const meta = {
  title: "Contexts/Pipeline/JobActions",
  component: JobActions,
  args: {
    jobId: "job-1",
    currentStage: "tailor",
  },
} satisfies Meta<typeof JobActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithNextAction: Story = {
  args: {
    nextAction: "Tailoring resume…",
  },
};

export const ApplyStage: Story = {
  args: {
    currentStage: "apply",
    nextAction: "Submitting application…",
  },
};
