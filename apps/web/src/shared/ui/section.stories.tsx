import type { Meta, StoryObj } from "@storybook/react-vite";

import { Section } from "./section.js";

const meta = {
  title: "Shared/UI/Section",
  component: Section,
} satisfies Meta<typeof Section>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  args: {
    title: "Apply queue",
    children: <p className="text-sm text-muted">3 jobs ready, 1 dry-run pending review.</p>,
  },
};
