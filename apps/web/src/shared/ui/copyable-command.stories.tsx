import type { Meta, StoryObj } from "@storybook/react-vite";

import { CopyableCommand } from "./copyable-command.js";

const meta = {
  title: "Shared/UI/CopyableCommand",
  component: CopyableCommand,
} satisfies Meta<typeof CopyableCommand>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    command: "pnpm web:storybook",
  },
};

export const LongCommand: Story = {
  args: {
    command: "pnpm --filter @jobctrl/web storybook:build -o ../../dist/web-storybook",
  },
};
