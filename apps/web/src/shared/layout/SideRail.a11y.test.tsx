import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { SideRail } from "./SideRail.js";
import { SidebarProvider } from "../ui/sidebar.js";

const NAV_PATHS = [
  "/dashboard",
  "/analytics",
  "/jobs",
  "/apply-review",
  "/pipelines",
  "/discovery",
  "/artifacts",
  "/evidence-map",
  "/outreach",
  "/runs",
  "/debug",
  "/profile",
  "/preferences",
  "/settings",
] as const;

function TestRail() {
  return (
    <SidebarProvider>
      <SideRail />
    </SidebarProvider>
  );
}

function renderRail() {
  const rootRoute = createRootRoute({ component: TestRail });
  const childRoutes = NAV_PATHS.map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(childRoutes),
    history: createMemoryHistory({ initialEntries: ["/dashboard"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("<SideRail> accessibility", () => {
  it("has no axe violations for the grouped navigation rail", async () => {
    const view = renderRail();
    await waitFor(() =>
      expect(
        screen.getByRole("navigation", { name: "Main navigation" }),
      ).toBeInTheDocument(),
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
