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
    const user = userEvent.setup();
    const { container } = renderOutreachView();
    await waitFor(() => expect(screen.getByText("Dana Reyes")).toBeInTheDocument());

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
});
