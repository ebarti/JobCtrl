import type { Meta, StoryObj } from "@storybook/react-vite";

import { MarkAppliedButton } from "./MarkAppliedButton.js";

const meta = {
  title: "Contexts/Pipeline/MarkAppliedButton",
  component: MarkAppliedButton,
  args: { jobId: "job-1" },
} satisfies Meta<typeof MarkAppliedButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
