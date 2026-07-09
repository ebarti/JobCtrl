import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { DashboardView } from "./DashboardView.js";

const meta = {
  title: "Views/Dashboard/DashboardView",
  component: DashboardView,
  parameters: {
    withRouter: true,
    initialPath: "/dashboard",
  },
} satisfies Meta<typeof DashboardView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/dashboard/summary", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(sampleDashboardSummary);
        }),
      ],
    },
  },
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/dashboard/summary", () =>
          HttpResponse.json({
            ...sampleDashboardSummary,
            totals: {
              jobs: 0,
              jobsToday: 0,
              failures: 0,
              blocked: 0,
              ready: 0,
              applied: 0,
              appliedToday: 0,
              dryRuns: 0,
            },
            work: {
              active: 0,
              stuck: 0,
              stuckAfterSeconds: 150,
              stuckItems: [],
            },
            funnel: [],
            conversion: {
              totals: {
                applied: 0,
                reply: 0,
                interview: 0,
                offer: 0,
                rejection: 0,
                replyRate: null,
                interviewRate: null,
                offerRate: null,
                rejectionRate: null,
                costPerInterview: null,
              },
              bySource: [],
              byBand: [],
            },
            activity: [],
            applyRuns: [],
          }),
        ),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/dashboard/summary", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
};
