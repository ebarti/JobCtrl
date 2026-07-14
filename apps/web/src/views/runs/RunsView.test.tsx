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

import { runsSearchSchema } from "../../routes/-runs.search.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { RunsView } from "./RunsView.js";

function buildRouter(
  harness: ReturnType<typeof buildProviderHarness>,
  initialEntries: readonly string[] = ["/runs"],
) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const runsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/runs",
    validateSearch: runsSearchSchema,
    component: () => <RunsView />,
  });
  const detailRoute = createRoute({
    getParentRoute: () => runsRoute,
    path: "/$runId",
    component: () => <h1>Workflow run detail route</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([runsRoute.addChildren([detailRoute])]),
    history: createMemoryHistory({ initialEntries: [...initialEntries] }),
  });
  return { router, queryClient: harness.queryClient, Wrapper: harness.Wrapper };
}

describe("<RunsView>", () => {
  it("renders the workflow runs from the API and links each row to the Temporal Web UI", async () => {
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("2 total")).toBeInTheDocument());

    expect(screen.getByText(/Staff Software Engineer/i)).toBeInTheDocument();
    expect(screen.getByText(/Principal Platform Engineer/i)).toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: /Open workflow .* in Temporal Web UI/i });
    expect(links.length).toBe(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(
        /^http:\/\/127\.0\.0\.1:8233\/namespaces\/default\/workflows\/apply-run-/,
      );
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });

  it("renders the empty state when no workflow runs exist", async () => {
    server.use(
      http.get("*/v1/workflow-runs", () =>
        HttpResponse.json({
          ok: true,
          items: [],
          pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
          sort: { field: "started_at", dir: "desc" },
          filter: { status: "all" },
        }),
      ),
    );
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("0 total")).toBeInTheDocument());
    expect(screen.getByText(/No workflow runs/i)).toBeInTheDocument();
  });

  it("surfaces an error banner when the workflow-runs endpoint fails", async () => {
    server.use(
      http.get("*/v1/workflow-runs", () =>
        new HttpResponse(JSON.stringify({ ok: false, error: "boom" }), { status: 500 }),
      ),
    );
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() =>
      expect(screen.getByText(/JobCtrl API request failed: 500/i)).toBeInTheDocument(),
    );
  });

  it("hides the parent list while a route-level run workspace is open", async () => {
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness, [
      "/runs/run-pipeline-1?status=failed&page=2",
    ]);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Workflow run detail route",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Workflow runs" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Runs table")).not.toBeInTheDocument();
  });
});
