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

function buildRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard",
    component: () => <KpiGrid summary={sampleDashboardSummary} />,
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

    await waitFor(() => expect(screen.getByRole("button", { name: /blocked/i })).toBeInTheDocument());
    expect(screen.getByText("needs review")).toBeInTheDocument();
    expect(screen.queryByText("upstream missing")).not.toBeInTheDocument();
  });

  it("builds a complete failed-jobs search for the failures KPI", () => {
    expect(kpiSearchFor("failed")).toEqual({
      q: "",
      stage: "all",
      state: "failed",
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
    await waitFor(() => expect(screen.getByRole("button", { name: /failures/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /failures/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
    expect(router.state.location.search).toMatchObject({
      state: "failed",
      deleted: "active",
      page: 1,
      pageSize: 50,
    });
  });
});
