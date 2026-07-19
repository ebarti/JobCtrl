import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../demo/ports.js";
import { outreachSearchSchema } from "../../routes/-outreach.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { OutreachView } from "./OutreachView.js";

function renderOutreachView(
  initialPath = "/outreach",
  ports = buildTestPorts(),
) {
  const harness = buildProviderHarness({ ports });
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
    routeTree: rootRoute.addChildren([
      outreachRoute.addChildren([contactRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return render(<RouterProvider router={router} />, {
    wrapper: harness.Wrapper,
  });
}

describe("<OutreachView>", () => {
  it("lists contacts from the read model", async () => {
    renderOutreachView();
    await waitFor(() =>
      expect(screen.getByText("Dana Reyes")).toBeInTheDocument(),
    );
    expect(screen.getByText("Morgan Blake")).toBeInTheDocument();
  });

  it("exposes contact create and CSV import actions", async () => {
    const user = userEvent.setup();
    const { container } = renderOutreachView();
    await waitFor(() =>
      expect(screen.getByText("Dana Reyes")).toBeInTheDocument(),
    );

    const pageActions = container.querySelector<HTMLElement>(
      '[data-slot="page-head-actions"]',
    );
    expect(pageActions).not.toBeNull();
    expect(
      within(pageActions!).getByRole("button", { name: "New contact" }),
    ).toBeInTheDocument();
    expect(
      within(pageActions!).getByRole("button", { name: "Import CSV" }),
    ).toBeInTheDocument();

    const filters = screen.getByRole("group", { name: "Contact filters" });
    expect(
      within(filters).getByRole("textbox", { name: "Employer" }),
    ).toBeInTheDocument();
    expect(
      within(filters).getByRole("textbox", { name: "Job" }),
    ).toBeInTheDocument();
    expect(
      within(filters).queryByRole("button", { name: "New contact" }),
    ).not.toBeInTheDocument();
    expect(
      within(filters).queryByRole("button", { name: "Import CSV" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(pageActions!).getByRole("button", { name: "New contact" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Add contact" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add contact" }),
      ).not.toBeInTheDocument(),
    );

    await user.click(
      within(pageActions!).getByRole("button", { name: "Import CSV" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Import contacts from CSV" }),
    ).toBeInTheDocument();
  });

  it("wires the empty-state actions to the existing create and import flows", async () => {
    const user = userEvent.setup();
    const listContacts = vi.fn(async () => ({ ok: true as const, items: [] }));
    renderOutreachView("/outreach", buildTestPorts({ api: { listContacts } }));

    const emptyTitle = await screen.findByText("No contacts yet.");
    const emptyState = emptyTitle.closest(".contacts-empty-state");
    expect(emptyState).not.toBeNull();

    await user.click(
      within(emptyState as HTMLElement).getByRole("button", {
        name: "New contact",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Add contact" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add contact" }),
      ).not.toBeInTheDocument(),
    );

    await user.click(
      within(emptyState as HTMLElement).getByRole("button", {
        name: "Import CSV",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Import contacts from CSV" }),
    ).toBeInTheDocument();
    expect(listContacts).toHaveBeenCalled();
  });

  it("blocks personal CSV entry in the demo and points to the local app", async () => {
    const importContacts = vi.fn();
    const ports = buildTestPorts({ api: { importContacts } });
    ports.featureFlags = new DemoFeatureFlagAdapter();
    renderOutreachView("/outreach", ports);

    await waitFor(() =>
      expect(screen.getByText("Dana Reyes")).toBeInTheDocument(),
    );

    const importButton = screen.getByRole("button", { name: "Import CSV" });
    expect(importButton).toBeDisabled();
    expect(importButton).toHaveAccessibleDescription(
      /CSV import is available in the local app.*never accepts personal contact data/i,
    );
    expect(
      screen.getByRole("link", { name: "Install JobCtrl" }),
    ).toHaveAttribute("href", "https://jobctrl.dev/user/getting-started");
    expect(
      screen.queryByRole("heading", { name: "Import contacts from CSV" }),
    ).not.toBeInTheDocument();
    expect(importContacts).not.toHaveBeenCalled();
  });
});
