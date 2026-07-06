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
import { evidenceMapSearchSchema } from "../../routes/-evidence-map.search.js";
import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { sampleEvidenceMapResponse } from "../../test/fixtures/projections.js";
import { EvidenceMapView } from "./EvidenceMapView.js";

const meta = {
  title: "Views/EvidenceMap/EvidenceMapView",
  component: EvidenceMapView,
} satisfies Meta<typeof EvidenceMapView>;

export default meta;
type Story = StoryObj<typeof meta>;

function EvidenceMapViewHost({ initialEntry = "/evidence-map" }: { readonly initialEntry?: string }) {
  const router = useMemo(() => {
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
    return createRouter({
      routeTree: root.addChildren([
        evidenceMap,
        artifacts.addChildren([artifactDetail]),
        jobs.addChildren([jobDetail]),
      ]),
      history: createMemoryHistory({ initialEntries: [initialEntry] }),
    });
  }, [initialEntry]);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <EvidenceMapViewHost />,
};

export const JobFiltered: Story = {
  render: () => <EvidenceMapViewHost initialEntry="/evidence-map?job=job-1" />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/evidence-map", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(sampleEvidenceMapResponse);
        }),
      ],
    },
  },
  render: () => <EvidenceMapViewHost />,
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/evidence-map", () =>
          HttpResponse.json({ ok: true, entries: [], gaps: [], generatedAt: "2026-07-05T12:30:00Z" }),
        ),
      ],
    },
  },
  render: () => <EvidenceMapViewHost />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/evidence-map", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <EvidenceMapViewHost />,
};
