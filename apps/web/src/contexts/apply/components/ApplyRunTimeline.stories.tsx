import type { Meta, StoryObj } from "@storybook/react-vite";

import { ApplyRunTimeline } from "./ApplyRunTimeline.js";

const meta = {
  title: "Contexts/Apply/ApplyRunTimeline",
  component: ApplyRunTimeline,
  args: {
    runId: "run-1",
    events: [
      {
        at: "2026-05-06T08:00:00Z",
        type: "ApplyRunStarted",
        level: "info",
        message: "Apply agent acquired job",
        data: {},
      },
      {
        at: "2026-05-06T08:01:00Z",
        type: "ApplicationFailed",
        level: "error",
        message: "Browser automation stopped before submission.",
        data: {},
      },
    ],
  },
} satisfies Meta<typeof ApplyRunTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
