import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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
  return render(<RouterProvider router={router} />, {
    wrapper: harness.Wrapper,
  });
}

describe("<EvidenceMapView> a11y", () => {
  it("has no axe violations when populated", async () => {
    const view = renderEvidenceMap();
    expect(
      await screen.findByRole("heading", { name: "Career evidence map" }),
    ).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("keeps the technical evidence disclosure keyboard-operable without axe violations", async () => {
    const user = userEvent.setup();
    const view = renderEvidenceMap();
    const detail = await screen.findByRole("complementary", {
      name: "Reduced incident response time through platform automation",
    });

    const trigger = within(detail).getByRole("button", {
      name: "Technical details",
    });
    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(within(detail).getByText("Claim confidence")).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
