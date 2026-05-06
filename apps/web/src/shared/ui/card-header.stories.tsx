import type { Meta, StoryObj } from "@storybook/react-vite";

import { CardHeader } from "./card-header.js";

const meta = {
  title: "Shared/UI/CardHeader (legacy)",
  component: CardHeader,
} satisfies Meta<typeof CardHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = {
  args: { title: "Open jobs" },
};

export const WithMeta: Story = {
  args: { title: "Open jobs", meta: "12 total · 3 applied" },
};
