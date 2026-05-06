import type { Meta, StoryObj } from "@storybook/react-vite";

import { GenerateMaterialsButton } from "./GenerateMaterialsButton.js";

const meta = {
  title: "Contexts/Materials/GenerateMaterialsButton",
  component: GenerateMaterialsButton,
  args: { jobId: "job-1" },
} satisfies Meta<typeof GenerateMaterialsButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DisabledByDefault: Story = {};

export const CustomLabel: Story = {
  args: { label: "rebuild materials" },
};
