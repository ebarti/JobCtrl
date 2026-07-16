import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { useMemo } from "react";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { ArtifactDetailPanel } from "./ArtifactDetailPanel.js";

const meta = {
  title: "Views/Artifacts/ArtifactDetailPanel",
  component: ArtifactDetailPanel,
  tags: ["a11y-regression"],
  args: { artifactId: "artifact-1" },
} satisfies Meta<typeof ArtifactDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function ArtifactDetailHost({ artifactId }: { artifactId: string }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const artifacts = createRoute({
      getParentRoute: () => root,
      path: "/artifacts",
      validateSearch: (search) => artifactsSearchSchema.parse(search),
      component: () => <ArtifactDetailPanel artifactId={artifactId} />,
    });
    return createRouter({
      routeTree: root.addChildren([artifacts]),
      history: createMemoryHistory({ initialEntries: ["/artifacts"] }),
    });
  }, [artifactId]);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <ArtifactDetailHost artifactId="artifact-1" />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/artifacts/:artifactId", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json({ ok: true });
        }),
      ],
    },
  },
  render: () => <ArtifactDetailHost artifactId="artifact-1" />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/artifacts/:artifactId", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <ArtifactDetailHost artifactId="artifact-1" />,
};
