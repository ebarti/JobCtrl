import type { Meta, StoryObj } from "@storybook/react-vite";

import { ApplyRunTimeline } from "./ApplyRunTimeline.js";

const meta = {
  title: "Contexts/Apply/ApplyRunTimeline",
  component: ApplyRunTimeline,
  args: {
    runId: "run-1",
  },
} satisfies Meta<typeof ApplyRunTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
