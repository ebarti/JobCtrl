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
import {
  makeArtifactsPage,
  sampleArtifact,
} from "../../test/fixtures/projections.js";
import { ArtifactsView } from "./ArtifactsView.js";

const meta = {
  title: "Views/Artifacts/ArtifactsView",
  component: ArtifactsView,
} satisfies Meta<typeof ArtifactsView>;

export default meta;
type Story = StoryObj<typeof meta>;

function ArtifactsViewHost() {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const artifacts = createRoute({
      getParentRoute: () => root,
      path: "/artifacts",
      validateSearch: (search) => artifactsSearchSchema.parse(search),
      component: ArtifactsView,
    });
    const detail = createRoute({
      getParentRoute: () => artifacts,
      path: "$artifactId",
      component: () => null,
    });
    return createRouter({
      routeTree: root.addChildren([artifacts.addChildren([detail])]),
      history: createMemoryHistory({ initialEntries: ["/artifacts"] }),
    });
  }, []);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <ArtifactsViewHost />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/artifacts", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(makeArtifactsPage());
        }),
      ],
    },
  },
  render: () => <ArtifactsViewHost />,
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/artifacts", () =>
          HttpResponse.json(makeArtifactsPage([])),
        ),
      ],
    },
  },
  render: () => <ArtifactsViewHost />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/artifacts", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <ArtifactsViewHost />,
};

export const ManyResults: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/artifacts", () =>
          HttpResponse.json(
            makeArtifactsPage(
              Array.from({ length: 12 }, (_, index) => ({
                ...sampleArtifact,
                artifactId: `artifact-${index + 10}`,
              })),
            ),
          ),
        ),
      ],
    },
  },
  render: () => <ArtifactsViewHost />,
};
