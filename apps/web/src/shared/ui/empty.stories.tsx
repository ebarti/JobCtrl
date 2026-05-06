import type { Meta, StoryObj } from "@storybook/react-vite";

import { Empty } from "./empty.js";

const meta = {
  title: "Shared/UI/Empty",
  component: Empty,
} satisfies Meta<typeof Empty>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoJobs: Story = {
  args: { title: "No jobs match the current filter." },
};

export const NoArtifacts: Story = {
  args: { title: "No artifacts generated yet." },
};
