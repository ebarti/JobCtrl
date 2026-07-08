import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo } from "react";

import { SideRail } from "./SideRail.js";

const NAV_PATHS = [
  "/dashboard",
  "/analytics",
  "/jobs",
  "/apply-review",
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

function SideRailStoryHost({ initialEntry }: { readonly initialEntry: string }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: SideRail });
    const children = NAV_PATHS.map((path) =>
      createRoute({ getParentRoute: () => root, path, component: () => null }),
    );
    return createRouter({
      routeTree: root.addChildren(children),
      history: createMemoryHistory({ initialEntries: [initialEntry] }),
    });
  }, [initialEntry]);
  return (
    <div className="app-shell" style={{ minHeight: 520 }}>
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Layout/SideRail",
  component: SideRail,
} satisfies Meta<typeof SideRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DashboardActive: Story = {
  render: () => <SideRailStoryHost initialEntry="/dashboard" />,
};

export const JobsActive: Story = {
  render: () => <SideRailStoryHost initialEntry="/jobs" />,
};
