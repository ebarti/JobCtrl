import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { runsSearchSchema } from "../../routes/-runs.search.js";
import { makeWorkflowRunDetail } from "../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
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
  it("renders one full-width run workspace with failure facts owned by the failed timeline event", async () => {
    const harness = buildProviderHarness();
    const router = buildRouter();
    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    const workspace = await screen.findByRole("article", {
      name: "Workflow run details",
    });

    expect(
      within(workspace).getByRole("heading", {
        level: 1,
        name: "Job pipeline workflow",
      }),
    ).toHaveAttribute("data-typography", "page-title");
    expect(
      within(workspace)
        .getByRole("link", { name: "Back to workflow runs" })
        .getAttribute("href"),
    ).toContain("status=failed");
    expect(
      within(workspace).getAllByText("failed", { exact: true }),
    ).toHaveLength(1);

    const grid = workspace.querySelector(".route-workspace__grid");
    expect(grid).toHaveAttribute("data-has-inspector", "false");
    expect(
      within(workspace).queryByLabelText(
        "Workflow run facts and failure details",
      ),
    ).not.toBeInTheDocument();

    const timeline = within(workspace).getByRole("list", {
      name: "Workflow lifecycle",
    });
    expect(
      within(workspace).getByRole("heading", { level: 2, name: "Timeline" }),
    ).toBeInTheDocument();
    expect(
      within(timeline).getByRole("listitem", { name: "Workflow started" }),
    ).toBeInTheDocument();
    const failedEvent = within(timeline).getByRole("listitem", {
      name: "Workflow failed",
    });
    const failure = within(failedEvent).getByRole("region", {
      name: "Failure details",
    });
    expect(
      within(failure).getByRole("heading", {
        level: 3,
        name: "Failure details",
      }),
    ).toBeInTheDocument();
    expect(within(failure).getByText("activity_error")).toBeInTheDocument();
    expect(within(failure).getByText("Yes")).toBeInTheDocument();
    expect(
      within(failedEvent).getAllByText("discover activity failed"),
    ).toHaveLength(1);

    const metadataHeading = within(workspace).getByRole("heading", {
      level: 2,
      name: "Run details",
    });
    const metadata = metadataHeading.closest("section");
    expect(metadata).not.toBeNull();
    expect(within(metadata!).getByText("run-pipeline-1")).toBeInTheDocument();
    expect(within(metadata!).getByText("temporal-run-1")).toBeInTheDocument();
    expect(
      within(metadata!).queryByText("Status", { exact: true }),
    ).not.toBeInTheDocument();

    expect(
      within(workspace).getByRole("link", {
        name: "Open workflow run-pipeline-1 in Temporal Web UI",
      }),
    ).toHaveAttribute(
      "href",
      "http://127.0.0.1:8233/namespaces/default/workflows/run-pipeline-1",
    );
    expect(
      within(workspace).getByRole("link", { name: "Review activity" }),
    ).toHaveAttribute("href", expect.stringContaining("q=run-pipeline-1"));
    expect(
      within(workspace).getByRole("link", { name: "Open pipeline controls" }),
    ).toHaveAttribute("href", "/pipelines");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("copies both run identities through the clipboard port", async () => {
    const user = userEvent.setup();
    const harness = buildProviderHarness();
    const router = buildRouter();
    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    const workspace = await screen.findByRole("article", {
      name: "Workflow run details",
    });
    await user.click(
      within(workspace).getByRole("button", { name: "Copy workflow id" }),
    );
    await user.click(
      within(workspace).getByRole("button", { name: "Copy Temporal run id" }),
    );

    expect(harness.ports.clipboard.write).toHaveBeenNthCalledWith(
      1,
      "run-pipeline-1",
    );
    expect(harness.ports.clipboard.write).toHaveBeenNthCalledWith(
      2,
      "temporal-run-1",
    );
  });

  it("keeps projected failure facts in the timeline when lifecycle events are missing", async () => {
    const workflowRun = vi.fn(async () =>
      makeWorkflowRunDetail({ events: [] }),
    );
    const ports = buildTestPorts({ api: { workflowRun } });
    const harness = buildProviderHarness({ ports });
    const router = buildRouter();
    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    const workspace = await screen.findByRole("article", {
      name: "Workflow run details",
    });
    const failureEvent = within(workspace).getByRole("listitem", {
      name: "Workflow failure recorded",
    });
    expect(failureEvent).toHaveAttribute("data-synthetic", "true");
    expect(
      within(failureEvent).getByRole("region", { name: "Failure details" }),
    ).toHaveTextContent("activity_error");
    expect(failureEvent).toHaveTextContent(
      "Reconstructed from the run failure record",
    );
  });
});
