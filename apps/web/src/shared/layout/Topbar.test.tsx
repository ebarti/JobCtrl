import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { sampleHealthResponse } from "../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../test/render.js";
import { FakeEventStreamPort, buildTestPorts } from "../../test/testPorts.js";
import { useUiPreferencesStore } from "../stores/ui-preferences.js";
import { AppShell } from "./AppShell.js";
import { Topbar } from "./Topbar.js";

const ROUTES = [
  "/dashboard",
  "/analytics",
  "/apply-review",
  "/jobs",
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

function buildTopbarRouter(initialEntry = "/dashboard") {
  const rootRoute = createRootRoute({ component: Topbar });
  const childRoutes = ROUTES.map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      ...(path === "/jobs" ? { validateSearch: jobsSearchSchema } : {}),
      component: () => null,
    }),
  );
  return createRouter({
    routeTree: rootRoute.addChildren(childRoutes),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

function renderTopbar(initialEntry?: string) {
  const eventStream = new FakeEventStreamPort();
  const ports = buildTestPorts({
    eventStream,
    api: { health: vi.fn(async () => sampleHealthResponse) },
  });
  const harness = buildProviderHarness({ ports, withEventStream: true });
  const router = buildTopbarRouter(initialEntry);
  render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
  return { eventStream, router };
}

function renderAppShell(initialEntry = "/dashboard") {
  const eventStream = new FakeEventStreamPort();
  const ports = buildTestPorts({
    eventStream,
    api: { health: vi.fn(async () => sampleHealthResponse) },
  });
  const harness = buildProviderHarness({ ports, withEventStream: true });
  const rootRoute = createRootRoute({ component: AppShell });
  const childRoutes = ROUTES.map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      ...(path === "/jobs" ? { validateSearch: jobsSearchSchema } : {}),
      component: () => null,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(childRoutes),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const result = render(<RouterProvider router={router} />, {
    wrapper: harness.Wrapper,
  });
  return { ...result, eventStream, router };
}

describe("<Topbar>", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiPreferencesStore.setState({ theme: "light", density: "regular" });
  });

  it("renders the search, density control, and no inline navigation rail", async () => {
    renderTopbar();

    expect(
      await screen.findByRole("textbox", { name: "Global search" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();

    const density = screen.getByRole("group", { name: "Row density" });
    expect(density).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "regular" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "compact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "comfy" })).toBeInTheDocument();
    expect(screen.getByText("Copyright © 2026 Eloi Barti")).toBeInTheDocument();
  });

  it("opens the responsive navigation sheet with the grouped nav links", async () => {
    const user = userEvent.setup();
    renderTopbar();

    await user.click(
      await screen.findByRole("button", { name: "Open navigation" }),
    );

    const nav = await screen.findByRole("navigation", {
      name: "Main navigation",
    });
    expect(screen.getAllByText("Copyright © 2026 Eloi Barti")).toHaveLength(2);
    for (const label of [
      "Dashboard",
      "Apply review",
      "Jobs",
      "Contacts",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("bg-sidebar", "text-sidebar-foreground");
    expect(
      within(dialog).getByText("Copyright © 2026 Eloi Barti"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "AGPL-3.0-only" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/ebarti/JobCtrl/blob/main/LICENSE",
    );
    expect(
      within(dialog).getByRole("link", { name: "Source code" }),
    ).toHaveAttribute("href", "https://github.com/ebarti/JobCtrl");
    expect(nav).toBeInTheDocument();
  });

  it("keeps global search Enter navigation scoped to non-empty trimmed queries", async () => {
    const user = userEvent.setup();
    const { router } = renderTopbar();
    const search = await screen.findByRole("textbox", {
      name: "Global search",
    });

    await user.type(search, "   {Enter}");
    expect(router.state.location.pathname).toBe("/dashboard");

    await user.clear(search);
    await user.type(search, "  staff platform  {Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
    expect(router.state.location.search).toMatchObject({
      q: "staff platform",
      page: 1,
    });
  });

  it("updates the persisted density store from the row density control", async () => {
    const user = userEvent.setup();
    renderTopbar();
    await user.click(await screen.findByRole("button", { name: "compact" }));
    expect(useUiPreferencesStore.getState().density).toBe("compact");

    await user.click(screen.getByRole("button", { name: "comfy" }));
    expect(useUiPreferencesStore.getState().density).toBe("comfy");
  });

  it("projects every density selection onto the app shell", async () => {
    const user = userEvent.setup();
    const { container } = renderAppShell();
    const appShell = await waitFor(() => {
      const element = container.querySelector(".app-shell");
      expect(element).toHaveAttribute("data-density", "regular");
      return element;
    });

    for (const density of ["compact", "comfy", "regular"] as const) {
      const control = screen.getByRole("button", { name: density });
      await user.click(control);

      await waitFor(() => {
        expect(control).toHaveAttribute("aria-pressed", "true");
        expect(appShell).toHaveAttribute("data-density", density);
      });
    }
  });
});
