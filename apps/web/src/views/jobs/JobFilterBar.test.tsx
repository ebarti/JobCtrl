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
import { JobFilterBar } from "./JobFilterBar.js";

function buildRouter(initialPath = "/jobs?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50") {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: jobsSearchSchema,
    component: () => {
      const search = jobsRoute.useSearch();
      return (
        <div>
          <span data-testid="stage-value">{search.stage}</span>
          <JobFilterBar search={search} />
        </div>
      );
    },
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, jobsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("<JobFilterBar>", () => {
  it("updates the stage URL search-param when the user picks a stage", async () => {
    const user = userEvent.setup();
    const router = buildRouter();
    const view = render(<RouterProvider router={router} />);

    await waitFor(() => expect(screen.getByTestId("stage-value")).toHaveTextContent("all"));
    const stageSelect = view.container.querySelectorAll("select")[0]!;
    await user.selectOptions(stageSelect, "tailor");
    await waitFor(() => expect(screen.getByTestId("stage-value")).toHaveTextContent("tailor"));
  });

  it("renders an option per stage", async () => {
    const router = buildRouter();
    const view = render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId("stage-value")).toHaveTextContent("all"));
    const stageSelect = view.container.querySelectorAll("select")[0]!;
    const options = stageSelect.querySelectorAll("option");
    expect(options.length).toBeGreaterThanOrEqual(7);
  });
});
