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

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { JobDetailDrawer } from "./JobDetailDrawer.js";

const meta = {
  title: "Views/Jobs/JobDetailDrawer",
  component: JobDetailDrawer,
  args: { jobId: "job-1" },
} satisfies Meta<typeof JobDetailDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

function JobDetailDrawerHost({ jobId }: { jobId: string }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const jobs = createRoute({
      getParentRoute: () => root,
      path: "/jobs",
      validateSearch: (search) => jobsSearchSchema.parse(search),
      component: () => <JobDetailDrawer jobId={jobId} />,
    });
    return createRouter({
      routeTree: root.addChildren([jobs]),
      history: createMemoryHistory({ initialEntries: ["/jobs"] }),
    });
  }, [jobId]);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <JobDetailDrawerHost jobId="job-1" />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/jobs/:jobKey", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json({ ok: true });
        }),
      ],
    },
  },
  render: () => <JobDetailDrawerHost jobId="job-1" />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/jobs/:jobKey", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <JobDetailDrawerHost jobId="job-1" />,
};
