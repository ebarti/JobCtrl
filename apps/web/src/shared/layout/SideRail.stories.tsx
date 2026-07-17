import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo, type CSSProperties } from "react";

import { SidebarProvider } from "../ui/sidebar.js";
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

function SideRailStoryHost({
  initialEntry,
}: {
  readonly initialEntry: string;
}) {
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
    <SidebarProvider
      className="app-shell"
      style={
        {
          minHeight: 520,
          "--sidebar-width": "var(--rail-width)",
          "--sidebar-width-icon": "var(--rail-width-collapsed)",
        } as CSSProperties
      }
    >
      <RouterProvider router={router} />
    </SidebarProvider>
  );
}

async function assertStoryRail(
  canvasElement: HTMLElement,
  activeLabel: string,
) {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const navigation = canvasElement.querySelector<HTMLElement>(
    'nav[aria-label="Main navigation"]',
  );
  const activeLink = navigation?.querySelector<HTMLAnchorElement>(
    'a[aria-current="page"]',
  );
  if (!navigation || activeLink?.getAttribute("aria-label") !== activeLabel) {
    throw new Error(`Expected the ${activeLabel} SideRail story to render.`);
  }
}

const meta = {
  title: "Layout/SideRail",
  component: SideRail,
  tags: ["side-rail-context"],
} satisfies Meta<typeof SideRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DashboardActive: Story = {
  render: () => <SideRailStoryHost initialEntry="/dashboard" />,
  play: ({ canvasElement }) => assertStoryRail(canvasElement, "Dashboard"),
};

export const JobsActive: Story = {
  render: () => <SideRailStoryHost initialEntry="/jobs" />,
  play: ({ canvasElement }) => assertStoryRail(canvasElement, "Jobs"),
};
