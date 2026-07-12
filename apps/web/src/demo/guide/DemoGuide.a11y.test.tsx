import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { expect, it } from "vitest";

import { PortsProvider } from "../../shared/providers/PortsProvider.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { DemoWorkspaceProvider } from "../workspace/DemoWorkspaceProvider.js";
import { DemoWorkspaceRepository } from "../workspace/DemoWorkspaceRepository.js";
import { InMemoryDemoWorkspaceStore } from "../workspace/storage.js";
import { DemoGuide } from "./DemoGuide.js";

function GuideShell() {
  return (
    <>
      <DemoGuide />
      <Outlet />
    </>
  );
}

it("has no automated accessibility violations", async () => {
  const workspace = new DemoWorkspaceRepository({
    store: new InMemoryDemoWorkspaceStore(),
    createWorkspaceId: () => "guide-a11y-workspace",
  });
  await workspace.initialize();
  const root = createRootRoute({ component: GuideShell });
  const dashboard = createRoute({
    getParentRoute: () => root,
    path: "/dashboard",
    component: () => <main>Dashboard</main>,
  });
  const jobs = createRoute({
    getParentRoute: () => root,
    path: "/jobs/$jobId",
    component: () => <main>Job detail</main>,
  });
  const artifacts = createRoute({
    getParentRoute: () => root,
    path: "/artifacts/$artifactId",
    component: () => <main>Artifact detail</main>,
  });
  const applyReview = createRoute({
    getParentRoute: () => root,
    path: "/apply-review",
    component: () => <main>Apply review</main>,
  });
  const runs = createRoute({
    getParentRoute: () => root,
    path: "/runs",
    component: () => <main>Runs</main>,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      dashboard,
      jobs,
      artifacts,
      applyReview,
      runs,
    ]),
    history: createMemoryHistory({ initialEntries: ["/dashboard"] }),
  });
  const view = render(
    <PortsProvider ports={buildTestPorts()}>
      <DemoWorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </DemoWorkspaceProvider>
    </PortsProvider>,
  );
  await router.load();
  await userEvent.setup().click(
    screen.getByRole("button", { name: "Open demo guide" }),
  );

  expect(await axe(view.container)).toHaveNoViolations();
});
