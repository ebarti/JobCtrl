import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NAV_GROUPS, SideRail } from "./SideRail.js";
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

function renderRail(initialEntry = "/dashboard") {
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
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("<SideRail>", () => {
  it("renders all fourteen nav links grouped under section labels", async () => {
    renderRail();

    await waitFor(() =>
      expect(
        screen.getByRole("navigation", { name: "Main navigation" }),
      ).toBeInTheDocument(),
    );

    for (const label of [
      "Overview",
      "Pipeline",
      "Library",
      "Activity",
      "Setup",
    ]) {
      expect(screen.getByText(label)).toHaveAttribute("data-typography", "label");
    }

    const expectedLabels = NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => item.label),
    );
    expect(expectedLabels).toHaveLength(14);
    for (const label of expectedLabels) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute(
        "data-typography",
        "control",
      );
    }
  });

  it("exposes the brand link, local-mode status, and legal attribution", async () => {
    renderRail();

    expect(
      await screen.findByRole("link", { name: "JobCtrl" }),
    ).toHaveAttribute("href", "/dashboard");
    expect(screen.getByText("Local mode — all data stays on device")).toHaveAttribute(
      "data-typography",
      "metadata",
    );
    expect(screen.getByText("Copyright © 2026 Eloi Barti")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "AGPL-3.0-only" })).toHaveAttribute(
      "href",
      "https://github.com/ebarti/JobCtrl/blob/main/LICENSE",
    );
    expect(screen.getByRole("link", { name: "Source code" })).toHaveAttribute(
      "href",
      "https://github.com/ebarti/JobCtrl",
    );
  });

  it("marks the current route active with aria-current for accent styling", async () => {
    renderRail("/jobs");

    const jobsLink = await screen.findByRole("link", { name: "Jobs" });
    await waitFor(() =>
      expect(jobsLink).toHaveAttribute("aria-current", "page"),
    );
    expect(jobsLink.className).toContain("on");

    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink).not.toHaveAttribute("aria-current", "page");
  });

  it("keeps an accessible name on every link so the collapsed icon-only rail stays labelled", async () => {
    renderRail();

    const expectedLabels = NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => item.label),
    );
    for (const label of expectedLabels) {
      const link = await screen.findByRole("link", { name: label });
      expect(link).toHaveAttribute("aria-label", label);
      expect(link).toHaveAttribute("title", label);
    }
  });
});
