import type { Meta, StoryObj } from "@storybook/react-vite";

import { TitleStack } from "./title-stack.js";

const meta = {
  title: "Shared/UI/TitleStack",
  component: TitleStack,
} satisfies Meta<typeof TitleStack>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    primary: "Staff Software Engineer",
    secondary: "Acme Corp · Remote",
  },
};

export const PrimaryOnly: Story = {
  args: {
    primary: "Pipeline overview",
  },
};
