import { createFileRoute, Outlet } from "@tanstack/react-router";

import { jobsKeys } from "../contexts/operations/jobsKeys.js";
import { fetchJobsList } from "../contexts/operations/jobsListQuery.js";
import { jobsListInput } from "../views/jobs/jobStageFilters.js";
import { jobsSearchSchema } from "./-jobs.search.js";

export const Route = createFileRoute("/jobs")({
  validateSearch: (search) => jobsSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps, context }) => {
    const input = jobsListInput(deps.search);
    return context.queryClient.prefetchQuery({
      queryKey: jobsKeys.list(context.tenantId, input),
      queryFn: () => fetchJobsList(context.ports.api, input),
    });
  },
  component: Outlet,
});
