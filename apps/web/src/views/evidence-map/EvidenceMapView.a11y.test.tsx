import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { evidenceMapSearchSchema } from "../../routes/-evidence-map.search.js";
import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { EvidenceMapView } from "./EvidenceMapView.js";

function renderEvidenceMap() {
  const harness = buildProviderHarness();
  const root = createRootRoute({ component: () => <Outlet /> });
  const evidenceMap = createRoute({
    getParentRoute: () => root,
    path: "/evidence-map",
    validateSearch: (search) => evidenceMapSearchSchema.parse(search),
    component: EvidenceMapView,
  });
  const artifacts = createRoute({
    getParentRoute: () => root,
    path: "/artifacts",
    validateSearch: (search) => artifactsSearchSchema.parse(search),
    component: () => <Outlet />,
  });
  const artifactDetail = createRoute({
    getParentRoute: () => artifacts,
    path: "$artifactId",
    component: () => null,
  });
  const jobs = createRoute({
    getParentRoute: () => root,
    path: "/jobs",
    validateSearch: (search) => jobsSearchSchema.parse(search),
    component: () => <Outlet />,
  });
  const jobDetail = createRoute({
    getParentRoute: () => jobs,
    path: "$jobId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      evidenceMap,
      artifacts.addChildren([artifactDetail]),
      jobs.addChildren([jobDetail]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/evidence-map"] }),
  });
  return render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
}

describe("<EvidenceMapView> a11y", () => {
  it("has no axe violations when populated", async () => {
    const view = renderEvidenceMap();
    expect(
      await screen.findByRole("heading", { name: "Career evidence map" }),
    ).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
