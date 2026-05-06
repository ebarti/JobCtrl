import type { Meta, StoryObj } from "@storybook/react-vite";

import { OpenArtifactButton } from "./OpenArtifactButton.js";

const meta = {
  title: "Contexts/Materials/OpenArtifactButton",
  component: OpenArtifactButton,
  args: { artifactId: "artifact-1" },
} satisfies Meta<typeof OpenArtifactButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};

export const CustomLabel: Story = {
  args: { label: "open in OS" },
};
