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
import {
  makeJobsPage,
  sampleJob,
  sampleSecondaryJob,
} from "../../test/fixtures/projections.js";
import { JobsView } from "./JobsView.js";

const meta = {
  title: "Views/Jobs/JobsView",
  component: JobsView,
} satisfies Meta<typeof JobsView>;

export default meta;
type Story = StoryObj<typeof meta>;

function JobsViewStoryHost() {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const jobs = createRoute({
      getParentRoute: () => root,
      path: "/jobs",
      validateSearch: (search) => jobsSearchSchema.parse(search),
      component: JobsView,
    });
    const jobDetail = createRoute({
      getParentRoute: () => jobs,
      path: "$jobId",
      component: () => null,
    });
    return createRouter({
      routeTree: root.addChildren([jobs.addChildren([jobDetail])]),
      history: createMemoryHistory({ initialEntries: ["/jobs"] }),
    });
  }, []);
  return <RouterProvider router={router} />;
}

export const Populated: Story = {
  render: () => <JobsViewStoryHost />,
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/jobs", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(makeJobsPage());
        }),
      ],
    },
  },
  render: () => <JobsViewStoryHost />,
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/jobs", () => HttpResponse.json(makeJobsPage([]))),
      ],
    },
  },
  render: () => <JobsViewStoryHost />,
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/jobs", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
  render: () => <JobsViewStoryHost />,
};

export const ManyResults: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/jobs", () =>
          HttpResponse.json(
            makeJobsPage(
              Array.from({ length: 20 }, (_, index) =>
                index % 2 === 0
                  ? { ...sampleJob, jobKey: `job-${index + 10}` }
                  : { ...sampleSecondaryJob, jobKey: `job-${index + 10}` },
              ),
            ),
          ),
        ),
      ],
    },
  },
  render: () => <JobsViewStoryHost />,
};
