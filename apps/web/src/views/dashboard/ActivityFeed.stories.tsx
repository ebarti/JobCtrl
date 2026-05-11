import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ActivityFeed } from "./ActivityFeed.js";

const meta = {
  title: "Views/Dashboard/ActivityFeed",
  component: ActivityFeed,
  parameters: {
    withRouter: true,
    initialPath: "/dashboard",
  },
  args: {
    summary: sampleDashboardSummary,
  },
} satisfies Meta<typeof ActivityFeed>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const ErrorActivity: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      activity: [
        {
          eventId: "evt-2",
          eventType: "StageFailed",
          jobKey: "job-1",
          title: "Staff Software Engineer",
          company: "Acme Corp",
          stage: "tailor",
          level: "error",
          message: "tailor.failed: LLM quota exceeded",
          at: "2026-05-06T07:55:00Z",
        },
      ],
    },
  },
};

export const Empty: Story = {
  args: {
    summary: { ...sampleDashboardSummary, activity: [] },
  },
};
