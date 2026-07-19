import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useSearch,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  artifactsSearchSchema,
  type ArtifactsSearch,
} from "../../routes/-artifacts.search.js";
import { ArtifactFilterBar } from "./ArtifactFilterBar.js";

function FilterBarRoute() {
  const search = useSearch({ from: "/artifacts" }) as ArtifactsSearch;
  return <ArtifactFilterBar search={search} />;
}

function renderFilterBar(initialEntry = "/artifacts") {
  const rootRoute = createRootRoute();
  const artifactsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/artifacts",
    validateSearch: (search) => artifactsSearchSchema.parse(search),
    component: FilterBarRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([artifactsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("<ArtifactFilterBar>", () => {
  it("keeps visible search and status labels and persists a trimmed query", async () => {
    const user = userEvent.setup();
    const router = renderFilterBar();

    expect(await screen.findByLabelText("Search")).toHaveAttribute(
      "placeholder",
      "Title, company, or type",
    );
    expect(screen.getByLabelText("Status")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), "  resume  ");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        q: "resume",
        page: 1,
      }),
    );
  });
});
