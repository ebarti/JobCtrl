import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { axe } from "jest-axe";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { JobDetailDrawer } from "./JobDetailDrawer.js";

describe("<JobDetailDrawer> a11y", () => {
  it("has no critical axe violations when populated from MSW", async () => {
    const harness = buildProviderHarness();
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const jobsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/jobs",
      validateSearch: jobsSearchSchema,
      component: () => <JobDetailDrawer jobId="job-1" />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([jobsRoute]),
      history: createMemoryHistory({
        initialEntries: ["/jobs?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50"],
      }),
    });
    const view = render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
    await waitFor(() => expect(view.container.querySelector("[role='dialog'].drawer")).not.toBeNull());
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
