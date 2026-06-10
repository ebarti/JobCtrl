import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { sampleHealthResponse } from "../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../test/render.js";
import { FakeEventStreamPort, buildTestPorts } from "../../test/testPorts.js";
import { useUiPreferencesStore } from "../stores/ui-preferences.js";
import { Topbar } from "./Topbar.js";

const ROUTES = [
  "/dashboard",
  "/apply-review",
  "/jobs",
  "/pipelines",
  "/discovery",
  "/runs",
  "/debug",
  "/artifacts",
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

describe("<Topbar>", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiPreferencesStore.setState({ theme: "light", density: "regular" });
  });

  it("renders the existing navigation labels and density options", async () => {
    renderTopbar();

    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument());
    for (const label of [
      "Dashboard",
      "Apply review",
      "Jobs",
      "Pipelines",
      "Discovery",
      "Runs",
      "Debug",
      "Artifacts",
      "Profile",
      "Preferences",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }

    const density = screen.getByRole("combobox", { name: "Row density" });
    expect(density).toHaveDisplayValue("regular");
    expect(screen.getByRole("option", { name: "compact" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "regular" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "comfy" })).toBeInTheDocument();
  });

  it("keeps global search Enter navigation scoped to non-empty trimmed queries", async () => {
    const user = userEvent.setup();
    const { router } = renderTopbar();
    const search = await screen.findByRole("textbox", { name: "Global search" });

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
    const density = await screen.findByRole("combobox", { name: "Row density" });

    await user.selectOptions(density, "compact");
    expect(useUiPreferencesStore.getState().density).toBe("compact");

    await user.selectOptions(density, "comfy");
    expect(useUiPreferencesStore.getState().density).toBe("comfy");
  });
});
