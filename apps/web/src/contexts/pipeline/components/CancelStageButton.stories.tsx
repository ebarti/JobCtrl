import type { Meta, StoryObj } from "@storybook/react-vite";

import { CancelStageButton } from "./CancelStageButton.js";

const meta = {
  title: "Contexts/Pipeline/CancelStageButton",
  component: CancelStageButton,
  args: {
    jobId: "job-1",
    stage: "apply",
  },
} satisfies Meta<typeof CancelStageButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TailorStage: Story = {
  args: { stage: "tailor" },
};
