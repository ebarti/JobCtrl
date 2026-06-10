import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ApplyRunsCard } from "./ApplyRunsCard.js";

const meta = {
  title: "Views/Dashboard/ApplyRunsCard",
  component: ApplyRunsCard,
  parameters: {
    withRouter: true,
    initialPath: "/dashboard",
  },
  args: {
    summary: sampleDashboardSummary,
  },
} satisfies Meta<typeof ApplyRunsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const MixedStatuses: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      applyRuns: [
        {
          runId: "run-1",
          jobKey: "job-1",
          title: "Staff Software Engineer",
          company: "Acme Corp",
          status: "running",
          dryRun: false,
          startedAt: "2026-05-06T07:00:00Z",
          events: [],
        },
        {
          runId: "run-2",
          jobKey: "job-2",
          title: "Principal Platform Engineer",
          company: "Globex",
          status: "succeeded",
          dryRun: false,
          startedAt: "2026-05-06T06:00:00Z",
          events: [],
        },
        {
          runId: "run-3",
          jobKey: "job-3",
          title: "Director of Platform",
          company: "Initech",
          status: "failed",
          dryRun: true,
          startedAt: "2026-05-05T22:30:00Z",
          events: [],
        },
        {
          runId: "run-4",
          jobKey: "job-4",
          title: "Engineering Manager",
          company: "Umbrella",
          status: "captcha",
          dryRun: false,
          startedAt: "2026-05-05T21:30:00Z",
          events: [],
        },
        {
          runId: "run-5",
          jobKey: "job-5",
          title: "Staff Infrastructure Engineer",
          company: "Hooli",
          status: "dry_run_complete",
          dryRun: true,
          startedAt: "2026-05-05T20:30:00Z",
          events: [],
        },
      ],
    },
  },
};

export const Empty: Story = {
  args: {
    summary: { ...sampleDashboardSummary, applyRuns: [] },
  },
};
