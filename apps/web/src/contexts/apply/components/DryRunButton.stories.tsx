import type { Meta, StoryObj } from "@storybook/react-vite";

import { DryRunButton } from "./DryRunButton.js";

const meta = {
  title: "Contexts/Apply/DryRunButton",
  component: DryRunButton,
  args: { jobId: "job-1" },
} satisfies Meta<typeof DryRunButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
