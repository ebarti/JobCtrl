import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { ArtifactsView } from "./ArtifactsView.js";

function renderArtifactsViewWithError() {
  const harness = buildProviderHarness({
    ports: buildTestPorts({
      api: {
        artifacts: async () => {
          throw new Error("JobCtrl API request failed: 500");
        },
      },
    }),
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const artifactsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/artifacts",
    validateSearch: (search) => artifactsSearchSchema.parse(search),
    component: () => <ArtifactsView />,
  });
  const artifactDetailRoute = createRoute({
    getParentRoute: () => artifactsRoute,
    path: "$artifactId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      artifactsRoute.addChildren([artifactDetailRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/artifacts"] }),
  });

  render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
}

describe("<ArtifactsView>", () => {
  it("renders API failures with a destructive alert and meaningful icon", async () => {
    renderArtifactsViewWithError();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Artifacts could not be loaded");
    expect(alert).toHaveTextContent("JobCtrl API request failed: 500");
    expect(alert.querySelector("svg")).toBeInTheDocument();
  });
});
