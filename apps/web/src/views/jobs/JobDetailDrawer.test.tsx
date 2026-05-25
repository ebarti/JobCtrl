import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { JobDetailDrawer } from "./JobDetailDrawer.js";

function renderJobDetailDrawer(jobId: string) {
  const harness = buildProviderHarness();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: jobsSearchSchema,
    component: () => <Outlet />,
  });
  const detailRoute = createRoute({
    getParentRoute: () => jobsRoute,
    path: "/$jobId",
    component: () => <JobDetailDrawer jobId={jobId} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([jobsRoute.addChildren([detailRoute])]),
    history: createMemoryHistory({
      initialEntries: [
        `/jobs/${encodeURIComponent(jobId)}?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50`,
      ],
    }),
  });
  return {
    router,
    ...render(<RouterProvider router={router} />, { wrapper: harness.Wrapper }),
  };
}

describe("<JobDetailDrawer>", () => {
  it("shows a not-found state instead of the raw API 404 for missing jobs", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json({ ok: false, error: "job_not_found" }, { status: 404 }),
      ),
    );

    renderJobDetailDrawer("https://example.com/jobs/missing-parent");

    await waitFor(() => expect(screen.getByText("Job not found.")).toBeInTheDocument());
    expect(screen.queryByText(/JobHunter API request failed: 404/i)).not.toBeInTheDocument();
  });

  it("closes when clicking the backdrop without treating drawer content as backdrop", async () => {
    const user = userEvent.setup();
    const { container, router } = renderJobDetailDrawer("job-1");

    await waitFor(() => expect(screen.getByLabelText("Job details")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Job details"));
    expect(router.state.location.pathname).toBe("/jobs/job-1");

    const backdrop = container.querySelector(".drawer-backdrop");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
  });
});
