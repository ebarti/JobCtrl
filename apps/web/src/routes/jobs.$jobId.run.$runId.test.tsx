import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { makeWorkflowRunDetail } from "../test/fixtures/projections.js";
import { server } from "../test/msw/server.js";
import { buildProviderHarness } from "../test/render.js";
import { JobRunTimelineWorkspace } from "./jobs.$jobId.run.$runId.js";

function buildRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    component: () => <Outlet />,
  });
  const jobRoute = createRoute({
    getParentRoute: () => jobsRoute,
    path: "/$jobId",
    component: () => <Outlet />,
  });
  const runRoute = createRoute({
    getParentRoute: () => jobRoute,
    path: "/run/$runId",
    component: () => <JobRunTimelineWorkspace jobId="job-1" runId="run-1" />,
  });

  return createRouter({
    routeTree: rootRoute.addChildren([
      jobsRoute.addChildren([jobRoute.addChildren([runRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/jobs/job-1/run/run-1"] }),
  });
}

describe("<JobRunTimelineWorkspace>", () => {
  it("renders the nested timeline as a complete route workspace", async () => {
    server.use(
      http.get("*/v1/workflow-runs/:runId", () =>
        HttpResponse.json(
          makeWorkflowRunDetail({
            workflowId: "run-1",
            runId: "run-1",
            workflowType: "ApplyWorkflow",
            status: "in_progress",
            jobKey: "job-1",
            title: "Staff Software Engineer",
            company: "Acme",
            dryRun: true,
            errorCode: null,
            errorMessage: null,
            retryable: false,
            temporalRunId: "temporal-apply-1",
            events: [
              {
                eventType: "WorkflowStarted",
                occurredAt: "2026-05-06T07:45:00Z",
                status: "in_progress",
                message: "Apply agent acquired job",
              },
            ],
          }),
        ),
      ),
    );
    const harness = buildProviderHarness();
    const router = buildRouter();
    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    const workspace = await screen.findByRole("article", {
      name: "Apply run details",
    });

    expect(
      within(workspace).getByRole("heading", {
        level: 1,
        name: "Apply run timeline",
      }),
    ).toBeInTheDocument();
    expect(
      within(workspace).getByRole("link", { name: "Back to job details" }),
    ).toHaveAttribute("href", "/jobs/job-1");
    expect(within(workspace).getByText("in progress")).toBeInTheDocument();
    expect(
      within(workspace).getByText("Staff Software Engineer"),
    ).toBeInTheDocument();
    expect(within(workspace).getAllByText("run-1").length).toBeGreaterThan(0);
    expect(within(workspace).getByText("temporal-apply-1")).toBeInTheDocument();
    expect(within(workspace).getByText("Workflow Started")).toBeInTheDocument();
    expect(
      within(workspace).getByText("Apply agent acquired job"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
