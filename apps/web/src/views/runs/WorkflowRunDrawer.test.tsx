import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { runsSearchSchema } from "../../routes/-runs.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { WorkflowRunDrawer } from "./WorkflowRunDrawer.js";

function buildRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const runsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/runs",
    validateSearch: runsSearchSchema,
    component: () => <Outlet />,
  });
  const detailRoute = createRoute({
    getParentRoute: () => runsRoute,
    path: "/$runId",
    component: () => <WorkflowRunDrawer runId="run-pipeline-1" />,
  });

  return createRouter({
    routeTree: rootRoute.addChildren([runsRoute.addChildren([detailRoute])]),
    history: createMemoryHistory({
      initialEntries: ["/runs/run-pipeline-1?status=failed&page=2"],
    }),
  });
}

describe("<WorkflowRunDrawer>", () => {
  it("renders the run as a route workspace without dropping detail or failure facts", async () => {
    const harness = buildProviderHarness();
    const router = buildRouter();
    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    const workspace = await screen.findByRole("article", {
      name: "Workflow run details",
    });

    expect(
      within(workspace).getByRole("heading", {
        level: 1,
        name: "JobPipelineWorkflow",
      }),
    ).toHaveAttribute("data-typography", "page-title");
    expect(
      within(workspace)
        .getByRole("link", { name: "Back to workflow runs" })
        .getAttribute("href"),
    ).toContain("status=failed");
    expect(within(workspace).getAllByText("failed").length).toBeGreaterThan(0);
    expect(within(workspace).getByText("run-pipeline-1")).toBeInTheDocument();
    expect(within(workspace).getByText("temporal-run-1")).toBeInTheDocument();
    expect(within(workspace).getByText("activity_error")).toBeInTheDocument();
    expect(within(workspace).getByText("yes")).toBeInTheDocument();
    expect(within(workspace).getByText("WorkflowStarted")).toBeInTheDocument();
    expect(within(workspace).getByText("WorkflowFailed")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
