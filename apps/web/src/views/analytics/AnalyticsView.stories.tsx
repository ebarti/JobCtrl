import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { useMemo } from "react";

import { analyticsSearchSchema } from "../../routes/-analytics.search.js";
import { sampleOutcomeAnalyticsSummary } from "../../test/fixtures/projections.js";
import { AnalyticsView } from "./AnalyticsView.js";

const meta = {
  title: "Views/Analytics/AnalyticsView",
  component: AnalyticsView,
} satisfies Meta<typeof AnalyticsView>;

export default meta;
type Story = StoryObj<typeof meta>;

function AnalyticsViewStoryHost({ initialPath = "/analytics" }: { initialPath?: string }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const analytics = createRoute({
      getParentRoute: () => root,
      path: "/analytics",
      validateSearch: (search) => analyticsSearchSchema.parse(search),
      component: AnalyticsView,
    });
    return createRouter({
      routeTree: root.addChildren([analytics]),
      history: createMemoryHistory({ initialEntries: [initialPath] }),
    });
  }, [initialPath]);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <AnalyticsViewStoryHost initialPath="/analytics?dimension=fit_band" />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/analytics/outcomes", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(sampleOutcomeAnalyticsSummary);
        }),
      ],
    },
  },
  render: () => <AnalyticsViewStoryHost />,
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/analytics/outcomes", () =>
          HttpResponse.json({
            ...sampleOutcomeAnalyticsSummary,
            totals: {
              n: 0,
              applied: 0,
              reply: 0,
              interview: 0,
              offer: 0,
              rejection: 0,
              replyRate: null,
              interviewRate: null,
              offerRate: null,
              rejectionRate: null,
            },
            bySource: [],
            byScoreBand: [],
            byFitBand: [],
            byApplyMode: [],
          }),
        ),
      ],
    },
  },
  render: () => <AnalyticsViewStoryHost />,
};

export const SmallSample: Story = {
  render: () => <AnalyticsViewStoryHost initialPath="/analytics?dimension=source" />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/analytics/outcomes", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <AnalyticsViewStoryHost />,
};
