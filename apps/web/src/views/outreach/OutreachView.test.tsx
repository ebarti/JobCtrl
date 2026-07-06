import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { outreachSearchSchema } from "../../routes/-outreach.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { OutreachView } from "./OutreachView.js";

function renderOutreachView(initialPath = "/outreach") {
  const harness = buildProviderHarness();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const outreachRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/outreach",
    validateSearch: (search) => outreachSearchSchema.parse(search),
    component: OutreachView,
  });
  const contactRoute = createRoute({
    getParentRoute: () => outreachRoute,
    path: "$contactId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([outreachRoute.addChildren([contactRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
}

describe("<OutreachView>", () => {
  it("lists contacts from the read model", async () => {
    renderOutreachView();
    await waitFor(() => expect(screen.getByText("Dana Reyes")).toBeInTheDocument());
    expect(screen.getByText("Morgan Blake")).toBeInTheDocument();
  });

  it("exposes contact create and CSV import actions", async () => {
    renderOutreachView();
    await waitFor(() => expect(screen.getByText("Dana Reyes")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "add contact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "import CSV" })).toBeInTheDocument();
  });
});
