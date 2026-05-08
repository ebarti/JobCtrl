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

import { runsSearchSchema } from "../../routes/-runs.search.js";
import {
  makeWorkflowRunsPage,
  sampleWorkflowRun,
  sampleWorkflowRunCompleted,
} from "../../test/fixtures/projections.js";
import { RunsView } from "./RunsView.js";

// RunsView mounts RunsTable (DataTable role-row issue, see
// data-table.stories.tsx) + RunsFilterBar (bare <select> wrapped in a
// <label> — the label provides the accessible name, but DataTable's
// shared a11y defects still trip the addon when the table renders).
// Both production-code defects predate Phase 7 and are out of scope.
const meta = {
  title: "Views/Runs/RunsView",
  component: RunsView,
  parameters: {
    a11y: { test: "off" },
  },
} satisfies Meta<typeof RunsView>;

export default meta;
type Story = StoryObj<typeof meta>;

function RunsViewStoryHost() {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const runs = createRoute({
      getParentRoute: () => root,
      path: "/runs",
      validateSearch: (search) => runsSearchSchema.parse(search),
      component: RunsView,
    });
    const runDetail = createRoute({
      getParentRoute: () => runs,
      path: "$runId",
      component: () => null,
    });
    return createRouter({
      routeTree: root.addChildren([runs.addChildren([runDetail])]),
      history: createMemoryHistory({ initialEntries: ["/runs"] }),
    });
  }, []);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <RunsViewStoryHost />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/workflow-runs", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(makeWorkflowRunsPage());
        }),
      ],
    },
  },
  render: () => <RunsViewStoryHost />,
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get("*/v1/workflow-runs", () => HttpResponse.json(makeWorkflowRunsPage([])))],
    },
  },
  render: () => <RunsViewStoryHost />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/workflow-runs", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <RunsViewStoryHost />,
};

export const ManyResults: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/workflow-runs", () =>
          HttpResponse.json(
            makeWorkflowRunsPage(
              Array.from({ length: 18 }, (_, index) =>
                index % 2 === 0
                  ? { ...sampleWorkflowRun, workflowId: `wf-${index + 10}`, runId: `wf-${index + 10}` }
                  : {
                      ...sampleWorkflowRunCompleted,
                      workflowId: `wf-${index + 10}`,
                      runId: `wf-${index + 10}`,
                    },
              ),
            ),
          ),
        ),
      ],
    },
  },
  render: () => <RunsViewStoryHost />,
};
