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

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { KpiGrid, kpiSearchFor } from "./KpiGrid.js";

function buildRouter(summary = sampleDashboardSummary) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard",
    component: () => <KpiGrid summary={summary} />,
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

describe("kpiSearchFor", () => {
  it("renders blocked KPI copy that describes the required operator action", async () => {
    const router = buildRouter();

    render(<RouterProvider router={router} />);

    await waitFor(() => expect(screen.getByRole("link", { name: /blocked/i })).toBeInTheDocument());
    expect(screen.getByText("needs review")).toBeInTheDocument();
    expect(screen.queryByText("upstream missing")).not.toBeInTheDocument();
  });

  it("renders live dashboard today counts instead of static KPI copy", async () => {
    const router = buildRouter({
      ...sampleDashboardSummary,
      totals: {
        ...sampleDashboardSummary.totals,
        jobsToday: 4,
        appliedToday: 2,
      },
    });

    render(<RouterProvider router={router} />);

    await waitFor(() => expect(screen.getByText("+4 today")).toBeInTheDocument());
    expect(screen.getByText("+2 today")).toBeInTheDocument();
    expect(screen.queryByText("+0 today")).not.toBeInTheDocument();
  });

  it("builds a complete failed-jobs search for the failures KPI", () => {
    expect(kpiSearchFor("failed")).toEqual({
      q: "",
      stage: "all",
      state: "failed",
      applyStatus: "all",
      deleted: "active",
      sort: "discovered_at",
      dir: "desc",
      page: 1,
      pageSize: 50,
    });
  });

  it("builds a complete applied-jobs search for the applied KPI", () => {
    expect(kpiSearchFor("applied")).toEqual({
      q: "",
      stage: "all",
      state: "all",
      applyStatus: "applied",
      deleted: "active",
      sort: "discovered_at",
      dir: "desc",
      page: 1,
      pageSize: 50,
    });
  });

  it("routes the failures KPI to the failed jobs list", async () => {
    const user = userEvent.setup();
    const router = buildRouter();

    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByRole("link", { name: /failures/i })).toBeInTheDocument());
    await user.click(screen.getByRole("link", { name: /failures/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
    expect(router.state.location.search).toMatchObject({
      state: "failed",
      applyStatus: "all",
      deleted: "active",
      page: 1,
      pageSize: 50,
    });
  });

  it("routes the applied KPI to the applied jobs list", async () => {
    const user = userEvent.setup();
    const router = buildRouter();

    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByRole("link", { name: /applied/i })).toBeInTheDocument());
    await user.click(screen.getByRole("link", { name: /applied/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
    expect(router.state.location.search).toMatchObject({
      applyStatus: "applied",
      deleted: "active",
      page: 1,
      pageSize: 50,
    });
  });
});
