import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { Funnel } from "./Funnel.js";

function buildRouter(summary: DashboardSummary = sampleDashboardSummary) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard",
    component: () => <Funnel summary={summary} />,
  });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: jobsSearchSchema,
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([dashboardRoute, jobsRoute]),
    history: createMemoryHistory({ initialEntries: ["/dashboard"] }),
  });
}

describe("<Funnel>", () => {
  it("shows preparation as Discover while keeping diagnostics secondary", async () => {
    const router = buildRouter();

    render(<RouterProvider router={router} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /01 discover/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /02 apply/i })).toBeInTheDocument();
    expect(screen.queryByText(/^score$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^tailor$/i)).not.toBeInTheDocument();
    expect(screen.getByText("1 score update, 1 material update")).toBeInTheDocument();
  });

  it("keeps hidden preparation-stage failures visible when preparation work items exist", async () => {
    const summary: DashboardSummary = {
      ...sampleDashboardSummary,
      preparation: {
        ...sampleDashboardSummary.preparation!,
        workItems: { queued: 0, running: 0, failed: 0 },
      },
      funnel: [
        { stage: "discover", total: 3, succeeded: 3, running: 0, pending: 0, blocked: 0, failed: 0 },
        { stage: "score", total: 3, succeeded: 1, running: 1, pending: 0, blocked: 0, failed: 1 },
        { stage: "tailor", total: 2, succeeded: 0, running: 1, pending: 1, blocked: 0, failed: 0 },
        { stage: "cover", total: 1, succeeded: 0, running: 1, pending: 0, blocked: 0, failed: 0 },
        { stage: "apply", total: 1, succeeded: 0, running: 0, pending: 1, blocked: 0, failed: 0 },
      ],
    };
    const router = buildRouter(summary);

    render(<RouterProvider router={router} />);

    const discover = await screen.findByRole("button", { name: /01 discover/i });
    expect(discover).toHaveTextContent("1 failed");
    expect(discover).toHaveTextContent("3 running");
    expect(discover).toHaveTextContent("1 pending");
    expect(screen.queryByText(/^score$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^tailor$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^cover$/i)).not.toBeInTheDocument();
  });

  it("distinguishes blocked work from failures with a ban icon", async () => {
    const summary: DashboardSummary = {
      ...sampleDashboardSummary,
      funnel: sampleDashboardSummary.funnel.map((stage) =>
        stage.stage === "score" ? { ...stage, blocked: 1 } : stage,
      ),
    };
    const router = buildRouter(summary);

    render(<RouterProvider router={router} />);

    const blocked = await screen.findByText("1 blocked");
    expect(blocked.querySelector("svg")).toHaveClass("tabler-icon-ban");
    expect(screen.getByText("1 failed").querySelector("svg")).toHaveClass(
      "tabler-icon-circle-x",
    );
  });

  it("routes product-stage rows to the preserved jobs list search", async () => {
    const user = userEvent.setup();
    const router = buildRouter();

    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: /01 discover/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
    expect(router.state.location.search).toMatchObject({
      stage: "all",
      state: "all",
      deleted: "active",
      page: 1,
      pageSize: 50,
    });
  });
});
