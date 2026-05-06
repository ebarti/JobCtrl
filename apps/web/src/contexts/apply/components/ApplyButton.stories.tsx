import type { Meta, StoryObj } from "@storybook/react-vite";

import { ApplyButton } from "./ApplyButton.js";

const meta = {
  title: "Contexts/Apply/ApplyButton",
  component: ApplyButton,
  args: { jobId: "job-1" },
} satisfies Meta<typeof ApplyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Custom: Story = {
  args: { className: "tab on", label: "submit application" },
};
