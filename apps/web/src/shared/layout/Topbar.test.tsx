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

describe("<Topbar>", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiPreferencesStore.setState({ theme: "light", density: "regular" });
  });

  it("renders the search, density control, and no inline navigation rail", async () => {
    renderTopbar();

    expect(await screen.findByRole("textbox", { name: "Global search" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();

    const density = screen.getByRole("combobox", { name: "Row density" });
    expect(density).toHaveDisplayValue("regular");
    expect(screen.getByRole("option", { name: "compact" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "regular" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "comfy" })).toBeInTheDocument();
    expect(
      screen.getByText("Copyright © 2026 Eloi Barti", { selector: ".legal-notice--topbar span" }),
    ).toBeInTheDocument();
  });

  it("opens the responsive navigation sheet with the grouped nav links", async () => {
    const user = userEvent.setup();
    renderTopbar();

    await user.click(await screen.findByRole("button", { name: "Open navigation" }));

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    for (const label of ["Dashboard", "Apply review", "Jobs", "Contacts", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Copyright © 2026 Eloi Barti")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "AGPL-3.0-only" })).toHaveAttribute(
      "href",
      "https://github.com/ebarti/JobCtrl/blob/main/LICENSE",
    );
    expect(within(dialog).getByRole("link", { name: "Source code" })).toHaveAttribute(
      "href",
      "https://github.com/ebarti/JobCtrl",
    );
    expect(within(dialog).getByRole("combobox", { name: "Row density" })).toHaveTextContent(
      "Regular",
    );
    expect(within(dialog).getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
    expect(await within(dialog).findByText("LLM $0.12 / $25.00")).toBeInTheDocument();
    expect(within(dialog).getByText("Local mode — all data stays on device")).toBeInTheDocument();
    expect(nav).toBeInTheDocument();
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
