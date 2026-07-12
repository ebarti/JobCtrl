import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PortsProvider,
  type Ports,
} from "../../shared/providers/PortsProvider.js";
import { FakeTelemetryPort, buildTestPorts } from "../../test/testPorts.js";
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

function createGuideRouter() {
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
  return createRouter({
    routeTree: root.addChildren([
      dashboard,
      jobs,
      artifacts,
      applyReview,
      runs,
    ]),
    history: createMemoryHistory({ initialEntries: ["/dashboard"] }),
  });
}

async function createWorkspace() {
  const workspace = new DemoWorkspaceRepository({
    store: new InMemoryDemoWorkspaceStore(),
    createWorkspaceId: () => "guide-workspace",
  });
  await workspace.initialize();
  return workspace;
}

async function renderGuide(
  options: {
    workspace?: DemoWorkspaceRepository | null;
    ports?: Ports;
  } = {},
) {
  const workspace =
    options.workspace === undefined
      ? await createWorkspace()
      : options.workspace;
  const ports = options.ports ?? buildTestPorts();
  const router = createGuideRouter();
  const user = userEvent.setup();
  const view = render(
    <PortsProvider ports={ports}>
      <DemoWorkspaceProvider workspace={workspace}>
        <RouterProvider router={router} />
      </DemoWorkspaceProvider>
    </PortsProvider>,
  );
  await router.load();
  return { ...view, ports, router, user, workspace };
}

describe("<DemoGuide>", () => {
  it("renders only for the admitted demo workspace", async () => {
    await renderGuide({ workspace: null });

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("shows the seeded synthetic shortcuts and records a typed feature CTA", async () => {
    const { ports, router, user } = await renderGuide();

    await user.click(screen.getByRole("button", { name: "Open demo guide" }));

    expect(screen.getByRole("complementary")).toHaveTextContent(
      "Every record and action in this demo is simulated and synthetic",
    );
    expect(
      screen.getByRole("link", { name: "Inspect synthetic scoring evidence" }),
    ).toHaveAttribute("href", "/jobs/job-northwind-platform");
    expect(
      screen.getByRole("link", { name: "Review synthetic tailored materials" }),
    ).toHaveAttribute("href", "/artifacts/artifact-tailored-resume");
    expect(
      screen.getByRole("link", {
        name: "Open simulated Apply Review and dry run",
      }),
    ).toHaveAttribute("href", "/apply-review?jobKey=job-northwind-platform");
    expect(
      screen.getByRole("link", { name: "See simulated run history" }),
    ).toHaveAttribute("href", "/runs");

    await user.click(
      screen.getByRole("link", { name: "Inspect synthetic scoring evidence" }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        "/jobs/job-northwind-platform",
      );
    });
    expect((ports.telemetry as FakeTelemetryPort).event).toHaveBeenCalledWith(
      "demo_feature_opened",
      { route: "dashboard", feature: "scoring" },
    );
    expect(screen.getByRole("button", { name: "Open demo guide" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open demo guide" })).toHaveFocus();
  });

  it("keeps the compact control available after the panel is dismissed", async () => {
    const { ports, user } = await renderGuide();

    expect(screen.getByRole("button", { name: "Open demo guide" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open demo guide" }));
    expect(screen.getByRole("button", { name: "Hide demo guide" })).toHaveFocus();
    expect(screen.getByRole("complementary")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Hide demo guide" }));
    expect(
      screen.getByRole("button", { name: "Open demo guide" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Open demo guide" })).toHaveFocus();
    expect(ports.storage.get("demo.guide.state")).toEqual({ open: false });

    await user.click(screen.getByRole("button", { name: "Open demo guide" }));
    expect(screen.getByRole("complementary")).toBeVisible();
    expect(ports.storage.get("demo.guide.state")).toEqual({ open: true });
  });

  it("confirms and visibly completes a reset through the workspace authority", async () => {
    const { ports, router, user, workspace } = await renderGuide();
    if (!workspace)
      throw new Error("The demo workspace is required for this test.");
    const before = await workspace.snapshot();
    await router.navigate({ to: "/runs" });

    await user.click(screen.getByRole("button", { name: "Open demo guide" }));
    await user.click(
      screen.getByRole("button", { name: "Reset synthetic demo data" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Reset synthetic demo data?" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reset demo data" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Synthetic demo data reset. The seeded examples are ready again.",
    );
    await waitFor(async () => {
      expect((await workspace.snapshot()).resetEpoch).toBe(
        before.resetEpoch + 1,
      );
    });
    expect((ports.telemetry as FakeTelemetryPort).event).toHaveBeenCalledWith(
      "demo_workspace_reset",
      { route: "runs" },
    );
    expect(router.state.location.pathname).toBe("/dashboard");
  });

  it("closes the modal and reports a reset failure without navigating", async () => {
    const workspace = await createWorkspace();
    vi.spyOn(workspace, "reset").mockRejectedValueOnce(new Error("quota"));
    const { router, user } = await renderGuide({ workspace });
    await router.navigate({ to: "/runs" });

    await user.click(screen.getByRole("button", { name: "Open demo guide" }));
    await user.click(
      screen.getByRole("button", { name: "Reset synthetic demo data" }),
    );
    await user.click(screen.getByRole("button", { name: "Reset demo data" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Demo data could not be reset. Try again.",
    );
    expect(
      screen.queryByRole("dialog", { name: "Reset synthetic demo data?" }),
    ).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/runs");
  });
});
