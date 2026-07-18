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
import { describe, expect, it } from "vitest";

import { debugSearchSchema } from "../../routes/-debug.search.js";
import { makeActivityPage, sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { DebugView } from "./DebugView.js";

function buildRouter(harness: ReturnType<typeof buildProviderHarness>, initialEntry = "/debug") {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const debugRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/debug",
    validateSearch: debugSearchSchema,
    component: () => <DebugView />,
  });
  const activityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/activity/$eventId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([debugRoute, activityRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return { router, Wrapper: harness.Wrapper };
}

describe("<DebugView>", () => {
  it("renders the top-level activity table from the debug activity endpoint", async () => {
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("1 activity events")).toBeInTheDocument());
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
    expect(screen.getByText("Job scored 8/10")).toBeInTheDocument();
  });

  it("surfaces an error banner when the debug activity endpoint fails", async () => {
    server.use(
      http.get("*/v1/debug/activity", () =>
        HttpResponse.json({ ok: false, error: "boom" }, { status: 500 }),
      ),
    );
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() =>
      expect(screen.getByText(/JobCtrl API request failed: 500/i)).toBeInTheDocument(),
    );
  });

  it("keeps pagination in the URL search state", async () => {
    server.use(
      http.get("*/v1/debug/activity", () =>
        HttpResponse.json(makeActivityPage(sampleDashboardSummary.activity, 2, 50, 51)),
      ),
    );
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness, "/debug?page=2&pageSize=50");
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("Page 2 of 2 · 51 rows")).toBeInTheDocument());
  });
});
