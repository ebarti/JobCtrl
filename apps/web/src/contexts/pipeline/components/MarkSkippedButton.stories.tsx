import type { Meta, StoryObj } from "@storybook/react-vite";

import { MarkSkippedButton } from "./MarkSkippedButton.js";

const meta = {
  title: "Contexts/Pipeline/MarkSkippedButton",
  component: MarkSkippedButton,
  args: { jobId: "job-1" },
} satisfies Meta<typeof MarkSkippedButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
